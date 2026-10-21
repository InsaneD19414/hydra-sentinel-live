// H.A.I.L. Sentinel - app controller (command center + camera station).
import { Store, Vault, randomId } from './store.js';
import { encodePayload, decodePayload } from './codec.js';
import { MediaSession, iceServersFrom, cameraConstraints, videoConstraints, QUALITY_BPS } from './rtc.js';
import { Broker, waitFor, DEFAULT_BROKER } from './signal.js';
import { drawQr, decodeCanvas, QrScanner } from './qr.js';
import { nextDelay, makeCode, normalizeCode, formatCode, codePeerId, feedState } from './backoff.js';
import { Wake, iosVersion } from './wake.js';
import { Guard, hashPin } from './guard.js';
import { beep, buzz, unlockAudio, MotionProbe } from './alerts.js';

export const VERSION = '2.1.0';
const APP_URL = 'https://insaned19414.github.io/hydra-sentinel-live/';
// Absolute https deep link: the iOS Camera app opens it straight into Sentinel. Payload rides in the #fragment (never sent to the server).
function pairLink(payload) { const base = location.protocol === 'https:' ? location.origin + location.pathname : APP_URL; return base + '#p=' + encodeURIComponent(payload); }
function extractPayload(text) { text = (text || '').trim(); const m = /[#?&]p(?:air)?=([^&#\s]+)/.exec(text); return m ? decodeURIComponent(m[1]) : text; }
const RETRY_DELAYS = [1, 2, 5, 10, 20, 30];   // seconds, per spec
const STALE_MS = 3000;
const PAIR_TTL_MS = 5 * 60 * 1000;
const HEALTH_POLL_MS = 20000;
const RANK = { live: 0, stale: 1, reconnecting: 2, offline: 3 };

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'never';

const S = {
  settings: Store.settings(), id: Store.identity().peerId, broker: null,
  health: {},            // stationId -> {state, since, attention, retry}
  live: null,            // active live view
  station: { active: false, cam: null, sessions: new Set(), wake: null },
  offline: null,         // pending offline exchange
  pairTimer: null, history: [],
  feeds: new Map(),      // stationId -> feed (command center)
  monitor: false,        // monitor grid open
  alerts: [], wake: new Wake(), guard: null, brokerAttempt: 0, brokerP: null,
  standby: false,        // station: remote standby (camera off, listening, guard on)
  remote: {}, remoteMsg: {},   // command center: last camera state from acks, per-station status line
};
const ICON = {
  gear: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  full: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
};

// ---------- UI helpers ----------
function show(id, push = true) {
  const cur = $('.screen.active');
  if (cur && cur.id === id) return;
  if (cur && push) S.history.push(cur.id);
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
  document.dispatchEvent(new CustomEvent('screen', { detail: id }));
}
function back() {
  const prev = S.history.pop() || (S.settings.role === 'station' ? 'stationHome' : 'home');
  if ($('#scan').classList.contains('active')) stopScanner();
  clearInterval(S.pairTimer);
  show(prev, false); render();
}
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function deviceName() { return S.settings.deviceName || (S.settings.role === 'station' ? 'Camera Station' : 'Command Center'); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function countdown(el, exp, onEnd) {
  clearInterval(S.pairTimer);
  const tick = () => {
    const left = Math.max(0, exp - Date.now());
    el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    if (!left) { clearInterval(S.pairTimer); onEnd && onEnd(); }
  };
  tick(); S.pairTimer = setInterval(tick, 500);
}
function setBrokerChips(status) {
  const map = { online: ['live', 'Broker online'], connecting: ['reconnecting', 'Broker…'], reconnecting: ['reconnecting', 'Broker…'], error: ['offline', 'Broker error'], idle: ['offline', S.settings.signaling === 'offline' ? 'Offline QR mode' : 'Broker off'] };
  const [cls, label] = map[status] || map.idle;
  ['#brokerChip', '#brokerChip2', '#brokerChip3'].forEach(s => { const e = $(s); if (e) { e.className = 'chip ' + cls; e.textContent = label; } });
}

// ---------- Broker ----------
async function startBroker() {
  if (S.broker) { S.broker.destroy(); S.broker = null; }
  setBrokerChips('idle');
  if (S.settings.signaling !== 'peerjs') return null;
  const b = new Broker(S.settings, S.id, iceServersFrom(S.settings));
  b.addEventListener('status', e => {
    const st = e.detail.status; setBrokerChips(st);
    if (S.broker !== b) return;
    if (st === 'online') { S.brokerAttempt = 0; clearTimeout(S.brokerT); if (S.settings.role === 'command') { pollAll(); for (const F of S.feeds.values()) if (!F.session && !F.connecting) retryNow(F, false); } }
    if (st === 'error' && e.detail.info !== 'peer-unavailable') { // self-heal: rebuild the broker connection with backoff
      clearTimeout(S.brokerT); const d = nextDelay(S.brokerAttempt++);
      S.brokerT = setTimeout(() => { if (S.broker === b && b.status === 'error') ensureBroker(true); }, d);
    }
  });
  b.addEventListener('connection', e => S.settings.role === 'command' ? ccIncoming(e.detail) : stIncoming(e.detail));
  S.broker = b;
  try { await b.start(); } catch (e) { console.warn('broker', e && (e.type || e.message)); }
  return b;
}
// Single-flight broker start: many feeds can ask at once without tearing each other's connection down.
async function ensureBroker(force = false) {
  if (S.settings.signaling !== 'peerjs') return null;
  if (!force && S.broker && S.broker.status === 'online') return S.broker;
  if (S.brokerP) return S.brokerP;
  if (!force && S.broker && S.broker.status === 'reconnecting') { S.broker.nudge(); await sleep(2500); if (S.broker && S.broker.status === 'online') return S.broker; }
  S.brokerP = startBroker().finally(() => { S.brokerP = null; });
  return S.brokerP;
}

// =====================================================================
// COMMAND CENTER
// =====================================================================
function health(stId) { return S.health[stId] || (S.health[stId] = { state: 'offline', since: 0, attention: false, retry: 0 }); }
function setHealth(stId, state, extra = {}) {
  const h = health(stId);
  if (h.state !== state) { h.since = Date.now(); h.attention = true; setTimeout(() => { if (Date.now() - h.since >= 120000) { h.attention = false; render(); } }, 120500); }
  h.state = state; Object.assign(h, extra);
  const st = Store.stations().find(s => s.id === stId);
  if (st) { const p = { id: stId, lastHealth: state }; if (state === 'live' || state === 'stale') p.lastSeen = Date.now(); Store.upsertStation(p); }
  render();
}
function assigned() { return Store.stations().filter(s => s.deviceId && Store.devices().some(d => d.id === s.deviceId)); }
export function pickStation(stations = assigned()) {
  return stations.slice().sort((a, b) => {
    const ha = health(a.id), hb = health(b.id);
    return (RANK[ha.state] - RANK[hb.state]) || ((hb.attention ? 1 : 0) - (ha.attention ? 1 : 0)) || ((b.lastSelected || 0) - (a.lastSelected || 0)) || a.name.localeCompare(b.name);
  })[0] || null;
}
function liveButtonState() {
  const list = assigned();
  if (!list.length) return { label: 'Connect a station', sub: 'Pair your spare iPhone by QR', action: 'pair' };
  const best = pickStation(list); const h = health(best.id).state;
  if (S.settings.signaling === 'offline') return { label: 'Live view', sub: best.name + ' · offline QR exchange', action: 'live', station: best };
  if (h === 'live' || h === 'stale') return { label: 'Live view', sub: best.name + ' · ' + h.toUpperCase(), action: 'live', station: best };
  if (h === 'reconnecting') return { label: 'Reconnect and view', sub: best.name + ' · reconnecting', action: 'live', station: best };
  return { label: 'View last status', sub: 'All stations offline', action: 'status', station: best };
}
function onLiveButton() {
  const s = liveButtonState();
  if (s.action === 'pair') return openPair();
  if (s.action === 'status') return openStatus();
  return startLive(s.station.id);
}

// ----- pairing (PeerJS): QR = peer id + one-time token + 5 min expiry -----
async function openPair() {
  if (S.settings.signaling === 'offline') return openOffline();
  show('pair');
  const tok = randomId(16), exp = Date.now() + PAIR_TTL_MS;
  const tokens = Store.pendingTokens().filter(t => t.exp > Date.now()); tokens.push({ tok, exp }); Store.savePendingTokens(tokens);
  const b = S.settings.broker; const custom = JSON.stringify(b) !== JSON.stringify(DEFAULT_BROKER);
  const payload = await encodePayload('HAIL1P', { v: 1, cc: S.id, n: deviceName(), tok, exp, ...(custom ? { br: b } : {}) });
  S.pairPayload = payload;
  const link = pairLink(payload); S.pairLink = link;
  const info = drawQr($('#pairQr'), link, 'M');
  $('#pairQr').dataset.payload = link; $('#pairQr').dataset.version = info.version;
  startPairCode(payload, exp);
  $('#pairStatus').textContent = S.broker && S.broker.status === 'online' ? 'Single-use code. Waiting for the station to approve…' : 'Broker is offline. Pairing needs the broker, or use offline pairing.';
  countdown($('#pairCountdown'), exp, () => { $('#pairStatus').textContent = 'Code expired. Tap New code.'; $('#pairQr').style.opacity = .15; });
  $('#pairQr').style.opacity = 1;
}
// Short typed code: the command center listens on a throwaway broker ID derived from the code and hands the
// one-time invite to whoever connects (max 3 times, 5 min). The station still has to tap Approve, and the
// token inside the invite is single-use, so the code only shortens typing; it adds no new trust.
let pairCodePeer = null;
async function startPairCode(payload, exp, tries = 0) {
  stopPairCode();
  $('#pairCode').textContent = '······'; $('#pairCodeWrap').hidden = S.settings.signaling !== 'peerjs';
  if (S.settings.signaling !== 'peerjs') return;
  const code = makeCode(); let given = 0;
  const b = new Broker(S.settings, codePeerId(code), iceServersFrom(S.settings)); pairCodePeer = b;
  b.addEventListener('connection', e => {
    const conn = e.detail;
    conn.on('open', () => { if (given < 3 && Date.now() < exp) { given++; conn.send({ t: 'invite', payload }); } else conn.send({ t: 'invite-expired' }); setTimeout(() => { try { conn.close(); } catch { } }, 3000); });
  });
  try { await b.start(12000); if (pairCodePeer !== b) return b.destroy(); $('#pairCode').textContent = formatCode(code); S.pairCode = code; window.SentinelDebug.pairCode = code; }
  catch (e) { if (pairCodePeer === b) { b.destroy(); pairCodePeer = null; if (tries < 2 && $('#pair').classList.contains('active')) return startPairCode(payload, exp, tries + 1); $('#pairCode').textContent = 'n/a'; } }
}
function stopPairCode() { if (pairCodePeer) { pairCodePeer.destroy(); pairCodePeer = null; } S.pairCode = null; }
async function joinByCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return toast('Enter the 6-character code shown on the command center');
  $('#codeJoin').disabled = true; $('#codeJoin').textContent = 'Connecting…';
  try {
    await ensureBroker();
    if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline. Check internet, or use the QR code.');
    const conn = await S.broker.connect(codePeerId(code), 9000);
    const m = await waitFor(conn, ['invite', 'invite-expired'], 6000); try { conn.close(); } catch { }
    if (m.t !== 'invite') throw new Error('That code has expired. Tap New code on the command center.');
    $('#codeInput').value = '';
    await handleScan(m.payload);
  } catch (e) { toast(/unreachable|timeout/i.test(e.message) ? 'Code not found. Check it on the command center (codes last 5 minutes).' : e.message, 4200); }
  finally { $('#codeJoin').disabled = false; $('#codeJoin').textContent = 'Pair with code'; }
}
function consumeToken(tok) {
  const now = Date.now(); const list = Store.pendingTokens();
  const t = list.find(x => x.tok === tok);
  Store.savePendingTokens(list.filter(x => x.tok !== tok && x.exp > now)); // single use: removed whether valid or not
  if (!t) return 'unknown-or-used';
  if (t.exp <= now) return 'expired';
  return 'ok';
}
function addPairedDevice(dev) {
  Store.upsertDevice(dev);
  const stations = Store.stations();
  if (!stations.some(s => s.deviceId === dev.id)) {
    const free = stations.find(s => !s.deviceId || !Store.devices().some(d => d.id === s.deviceId));
    if (free) Store.upsertStation({ id: free.id, deviceId: dev.id });
    else Store.upsertStation({ id: 'st-' + randomId(4), name: dev.n && !/^camera station$/i.test(dev.n) ? dev.n : 'Station ' + (stations.length + 1), deviceId: dev.id, created: Date.now() });
  }
}
function ccIncoming(conn) {
  conn.on('data', async msg => {
    if (!msg || !msg.t) return;
    if (msg.t === 'pair-req') {
      const r = consumeToken(msg.tok);
      if (r !== 'ok') { conn.send({ t: 'pair-fail', reason: r }); return; }
      addPairedDevice({ id: msg.id, n: msg.n || 'Camera Station', secret: msg.secret, mode: 'peerjs', pairedAt: Date.now() });
      conn.send({ t: 'pair-ok', cc: S.id, n: deviceName() });
      clearInterval(S.pairTimer); stopPairCode();
      toast(`${msg.n || 'Station'} paired · connecting to it now`, 3500);
      const st = Store.stations().find(s => s.deviceId === msg.id);
      if (st) setHealth(st.id, 'reconnecting');
      // One-tap: jump straight into the live view; it keeps retrying until the station's camera is on.
      if ($('#pair').classList.contains('active') && st) { S.history = ['home']; startLive(st.id); }
      render();
    } else if (msg.t === 'pair-deny') {
      consumeToken(msg.tok); $('#pairStatus').textContent = 'The station denied pairing.'; toast('Station denied pairing');
    }
  });
}

// ----- background health polling -----
async function pingStation(st) {
  const dev = Store.devices().find(d => d.id === st.deviceId);
  if (!dev || dev.mode !== 'peerjs' || !S.broker || S.broker.status !== 'online') return false;
  if (S.feeds.has(st.id)) return true; // an open feed is its own health check
  let conn;
  try {
    conn = await S.broker.connect(dev.id, 8000);
    conn.send({ t: 'ping', cc: S.id, secret: dev.secret });
    const r = await waitFor(conn, ['pong', 'denied'], 6000);
    if (r.t === 'denied') { setHealth(st.id, 'offline', { note: 'Station no longer recognises this command center. Pair again.' }); return false; }
    setHealth(st.id, r.cam ? 'live' : 'stale', { note: r.cam ? '' : 'Station app open, camera not started', retry: 0 });
    return true;
  } catch (e) {
    const h = health(st.id);
    if (h.state === 'live' || h.state === 'stale' || (h.state === 'reconnecting' && h.retry < RETRY_DELAYS.length)) {
      const i = h.state === 'reconnecting' ? h.retry : 0;
      setHealth(st.id, 'reconnecting', { retry: i + 1 });
      clearTimeout(h.timer); h.timer = setTimeout(() => pingStation(st), RETRY_DELAYS[i] * 1000);
    } else setHealth(st.id, 'offline', { retry: 0 });
    return false;
  } finally { try { conn && conn.close(); } catch { } }
}
let pollT;
function pollAll() {
  clearTimeout(pollT);
  if (S.settings.role !== 'command') return;
  assigned().forEach(st => { const h = health(st.id); if (h.state !== 'reconnecting') pingStation(st); });
  pollT = setTimeout(pollAll, HEALTH_POLL_MS);
}

// ----- offline QR exchange (no server) -----
async function openOffline(stationId = null) {
  show('offline');
  if (S.offline && S.offline.session) S.offline.session.close();
  const session = new MediaSession('viewer', S.settings);
  const tok = randomId(8), exp = Date.now() + PAIR_TTL_MS;
  S.offline = { session, tok, exp, stationId };
  $('#offerInfo').textContent = 'Gathering network candidates…';
  const sdp = await session.createOffer();
  const payload = await encodePayload('HAIL1O', { v: 1, id: S.id, n: deviceName(), tok, exp, sdp });
  S.offline.payload = payload;
  $('#offerText').value = payload;
  try {
    const info = drawQr($('#offerQr'), payload, 'L');
    $('#offerQr').dataset.payload = payload;
    $('#offerInfo').textContent = `QR version ${info.version} · ${payload.length} chars · expires in 5 min`;
  } catch (e) { $('#offerInfo').textContent = 'Offer too large for one QR on this network. Use Copy offer code.'; }
  return payload;
}
async function ccHandleAnswer(data) {
  const o = S.offline;
  if (!o || data.tok !== o.tok) return toast('This answer does not match the current offer. Start again.');
  if (Date.now() > o.exp) return toast('Offer expired. Start again.');
  await o.session.acceptAnswer(data.sdp);
  addPairedDevice({ id: data.id, n: data.n || 'Camera Station', secret: data.secret, mode: 'offline', pairedAt: Date.now() });
  const st = (o.stationId && Store.stations().find(s => s.id === o.stationId)) || Store.stations().find(s => s.deviceId === data.id);
  if (st && st.deviceId !== data.id) Store.upsertStation({ id: st.id, deviceId: data.id });
  const session = o.session; S.offline = null;
  startLive(st.id, session);
}

// ----- feeds: one auto-reconnecting WebRTC session per station; the live view focuses one, the monitor grid shows all -----
const HB_MS = 2000, HB_DEAD_MS = 8000, OFFLINE_AFTER = 6, OFFLINE_ALERT_MS = 10000, MOTION_COOLDOWN_MS = 30000;
const MOTION_TH = { low: 0.12, medium: 0.06, high: 0.03 };
function devFor(stationId) { const st = Store.stations().find(s => s.id === stationId); return st && Store.devices().find(d => d.id === st.deviceId); }
function openFeed(stationId, offlineSession = null) {
  let F = S.feeds.get(stationId);
  if (F && !offlineSession) { if (!F.session && !F.connecting && !F.retryT && !F.denied) connectFeed(F); return F; }
  if (F) closeFeed(stationId);
  F = { stationId, attempt: 0, session: null, conn: null, lastFrame: 0, frames: 0, framesDecoded: -1, rtt: null, hbRtt: null, lastHbAck: 0, hbSupported: false,
    offline: !!offlineSession, probe: new MotionProbe(), motionAt: 0, downSince: 0, wasLive: false, alerted: false, recorder: null, listen: false, iceRestarts: 0, opened: Date.now() };
  S.feeds.set(stationId, F);
  Store.upsertStation({ id: stationId, lastSelected: Date.now() });
  if (offlineSession) attachSession(F, offlineSession); else { setHealth(stationId, 'reconnecting', { retry: 0 }); connectFeed(F); }
  updateWake(); renderGrid();
  return F;
}
function closeFeed(stationId) {
  const F = S.feeds.get(stationId); if (!F) return;
  F.closing = true;
  if (F.recorder) stopRecording(F);
  clearTimeout(F.retryT); clearTimeout(F.discT);
  if (F.session) F.session.close();
  if (F.conn) try { F.conn.close(); } catch { }
  S.feeds.delete(stationId);
  if (S.live === F) { S.live = null; $('#liveVideo').srcObject = null; $('#liveVideo')._feed = null; }
  if (health(stationId).state !== 'offline') setHealth(stationId, 'offline', { retry: 0 });
  updateWake(); renderGrid();
}
function closeAllFeeds() { for (const id of Array.from(S.feeds.keys())) closeFeed(id); }
async function connectFeed(F) {
  if (S.feeds.get(F.stationId) !== F || F.connecting) return;
  const dev = devFor(F.stationId);
  if (!dev) { F.note = 'No device assigned to this station.'; setHealth(F.stationId, 'offline'); return; }
  if (dev.mode === 'offline') { F.note = 'Offline-QR device: tap to exchange codes'; F.offline = true; setHealth(F.stationId, 'offline'); return; }
  F.connecting = true; F.note = ''; health(F.stationId).note = '';
  try {
    if (navigator.onLine === false) throw new Error('No internet');
    await ensureBroker();
    if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline');
    const conn = await S.broker.connect(dev.id, 9000);
    if (S.feeds.get(F.stationId) !== F) { conn.close(); return; }
    F.conn = conn;
    conn.send({ t: 'hello', cc: S.id, secret: dev.secret, n: deviceName() });
    const h = await waitFor(conn, ['hello-ok', 'denied', 'not-active'], 8000);
    if (h.t === 'denied') { F.denied = true; F.note = 'Station refused this command center. Pair again.'; setHealth(F.stationId, 'offline', { note: F.note }); return; }
    if (h.t === 'not-active') { F.note = h.standby ? 'Camera in standby · tap Start' : 'Station app is open but not started. Tap Start (or START STATION on it).'; F.standby = !!h.standby; setHealth(F.stationId, 'stale', { note: F.note }); throw new Error('not active'); }
    const session = new MediaSession('viewer', S.settings);
    const sdp = await session.createOffer();
    conn.send({ t: 'offer', sid: session.sid, sdp });
    const ans = await waitFor(conn, ['answer', 'error'], 15000);
    if (ans.t === 'error') { session.close(); throw new Error('Station error: ' + ans.error); }
    if (ans.sid !== session.sid) throw new Error('stale answer');
    await session.acceptAnswer(ans.sdp);
    conn.on('close', () => { if (S.feeds.get(F.stationId) === F && F.session === session && session.state !== 'connected' && !F.restarting) scheduleReconnect(F, 'signal closed'); });
    attachSession(F, session);
  } catch (e) {
    console.warn('connectFeed', e && e.message);
    if (S.feeds.get(F.stationId) === F) scheduleReconnect(F, e.message);
  } finally { F.connecting = false; }
}
function attachVideo(v, F) {
  v._feed = F;
  const stream = F && F.session ? F.session.remoteStream : null;
  if (v.srcObject !== stream) v.srcObject = stream;
  if (stream) v.play().catch(() => { });
  if (!v._rvfc && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    v._rvfc = true;
    const cb = () => { const f = v._feed; if (f && v.srcObject) { f.lastFrame = Date.now(); f.frames++; } v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
}
function attachSession(F, session) {
  if (S.feeds.get(F.stationId) !== F) return session.close();
  F.session = session; F.lastHbAck = Date.now();
  const tile = tileFor(F.stationId); if (tile) attachVideo(tile.querySelector('video'), F);
  if (S.live === F) { const v = $('#liveVideo'); attachVideo(v, F); v.muted = !F.listen; window.SentinelDebug.session = session; }
  session.addEventListener('message', e => {
    const m = e.detail;
    if (m.t === 'hb-ack') { F.hbSupported = true; F.lastHbAck = Date.now(); F.hbRtt = Math.round(performance.now() - m.ts); }
    if (m.t === 'camera' && S.live === F) toast('Station camera: ' + (m.facing === 'user' ? 'front' : 'back'));
    if (m.t === 'bye') scheduleReconnect(F, 'station ended session');
  });
  session.addEventListener('state', e => {
    const s = e.detail;
    if (S.feeds.get(F.stationId) !== F || F.session !== session) return;
    if (s === 'connected') { F.attempt = 0; F.restarting = false; F.note = ''; clearTimeout(F.discT); F.lastHbAck = Date.now(); Object.assign(health(F.stationId), { retry: 0, note: '' }); Store.upsertDevice({ id: devFor(F.stationId)?.id, lastConnected: Date.now() }); }
    else if (s === 'failed') tryIceRestart(F, session, 'failed');
    else if (s === 'closed') scheduleReconnect(F, 'closed');
    else if (s === 'disconnected') { clearTimeout(F.discT); F.discT = setTimeout(() => { if (session.state === 'disconnected') tryIceRestart(F, session, 'disconnected'); }, 2500); }
  });
  window.SentinelDebug.session = window.SentinelDebug.session || session;
  renderGrid();
}
// ICE restart keeps the same session (new network path, e.g. Wi-Fi -> cellular). Falls back to a fresh session.
async function tryIceRestart(F, session, why) {
  if (F.restarting || F.session !== session) return;
  if (F.offline || !F.conn || F.conn.open === false) return scheduleReconnect(F, why);
  F.restarting = true; F.iceRestarts++;
  setHealth(F.stationId, 'reconnecting', { retry: F.attempt });
  try {
    const sdp = await session.createRestartOffer();
    F.conn.send({ t: 'offer', sid: session.sid, sdp, restart: true });
    const ans = await waitFor(F.conn, ['answer', 'error'], 10000);
    if (ans.t === 'error') throw new Error(ans.error);
    await session.acceptAnswer(ans.sdp);
    const ok = await new Promise(res => { if (session.state === 'connected') return res(true); const t = setTimeout(() => res(false), 7000); session.addEventListener('state', function h(e) { if (e.detail === 'connected') { clearTimeout(t); session.removeEventListener('state', h); res(true); } }); });
    F.restarting = false;
    if (!ok) scheduleReconnect(F, 'ice restart timed out');
  } catch (e) { F.restarting = false; scheduleReconnect(F, 'ice restart: ' + e.message); }
}
function scheduleReconnect(F, reason) {
  if (S.feeds.get(F.stationId) !== F || F.closing) return;
  if (F.recorder) stopRecording(F);
  if (F.session) { const s = F.session; F.session = null; s.close(); }
  if (F.conn) { try { F.conn.close(); } catch { } F.conn = null; }
  clearTimeout(F.retryT); F.retryT = null; F.restarting = false;
  F.lastReason = reason;
  if (F.offline) { F.note = 'Session ended. Offline mode needs a new QR exchange.'; setHealth(F.stationId, 'offline'); renderGrid(); return; }
  if (F.denied) return;
  const d = nextDelay(F.attempt); F.attempt++;
  F.nextAt = Date.now() + d;
  setHealth(F.stationId, F.attempt > OFFLINE_AFTER ? 'offline' : 'reconnecting', { retry: F.attempt });
  F.retryT = setTimeout(() => { F.retryT = null; connectFeed(F); }, d);
}
function retryNow(F, resetAttempts = true) {
  if (!F || F.connecting || (F.session && F.session.state === 'connected')) return;
  if (F.offline) return openOffline(F.stationId);
  clearTimeout(F.retryT); F.retryT = null; F.denied = false; if (resetAttempts) F.attempt = 0;
  connectFeed(F);
}
// Network came back / app returned to the foreground: reconnect now instead of waiting out the backoff.
function reconnectEverything(why) {
  if (S.broker) S.broker.nudge();
  if (S.settings.signaling === 'peerjs' && (!S.broker || S.broker.status === 'error' || S.broker.status === 'idle')) ensureBroker();
  for (const F of S.feeds.values()) {
    if (F.session && F.session.state === 'connected') { if (F.hbSupported && Date.now() - F.lastHbAck > HB_DEAD_MS) tryIceRestart(F, F.session, why); continue; }
    if (!F.offline && !F.denied) retryNow(F);
  }
  if (S.settings.role === 'command') setTimeout(pollAll, 1500);
}
// Heartbeat over the data channel: proves the path end-to-end and measures round trip.
function heartbeat() {
  for (const F of S.feeds.values()) {
    const s = F.session; if (!s) continue;
    s.send({ t: 'hb', ts: performance.now() });
    if (s.state === 'connected' && F.hbSupported && Date.now() - F.lastHbAck > HB_DEAD_MS) tryIceRestart(F, s, 'heartbeat lost');
  }
}
setInterval(heartbeat, HB_MS);

// ----- remote control (command center side): authenticated commands over the broker link -----
async function sendCmd(stationId, cmd, args = {}, timeoutMs = 20000) {
  const dev = devFor(stationId);
  if (!dev) throw new Error('No device assigned to this station');
  if (dev.mode === 'offline') throw new Error('Remote control needs broker mode (this camera was paired with offline QR)');
  await ensureBroker();
  if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline');
  const conn = await S.broker.connect(dev.id, 9000);
  try {
    const id = randomId(6);
    conn.send({ t: 'cmd', id, cmd, args, cc: S.id, secret: dev.secret, n: deviceName() });
    const r = await waitFor(conn, ['cmd-ack', 'denied'], timeoutMs);
    if (r.t === 'denied') throw new Error('Camera refused: pair again');
    if (r.state) { F_state(stationId, r.state); }
    if (!r.ok) throw new Error(r.error || 'failed');
    return r;
  } finally { setTimeout(() => { try { conn.close(); } catch { } }, 200); }
}
function F_state(stationId, st) { S.remote[stationId] = Object.assign(S.remote[stationId] || {}, st, { at: Date.now() }); }
async function remoteStart(stationId) {
  const st = Store.stations().find(s => s.id === stationId); const name = st ? st.name : 'Camera';
  setRemoteMsg(stationId, 'Starting camera…');
  try {
    await sendCmd(stationId, 'start', {}, 25000);
    setRemoteMsg(stationId, '');
    const F = S.feeds.get(stationId) || openFeed(stationId); F.note = ''; F.standby = false; retryNow(F);
    return true;
  } catch (e) { setRemoteMsg(stationId, 'Start failed: ' + e.message); toast(`${name}: ${e.message}`, 4000); return false; }
}
async function remoteStop(stationId) {
  try { await sendCmd(stationId, 'stop'); closeFeed(stationId); setRemoteMsg(stationId, 'Camera in standby'); return true; }
  catch (e) { toast('Stop failed: ' + e.message, 4000); return false; }
}
async function startMonitoring() {
  unlockAudio();
  if (!S.monitor) openMonitor();
  const list = assigned().filter(st => devFor(st.id)?.mode !== 'offline');
  if (!list.length) return toast('No broker-paired cameras yet. Tap + Add a camera.');
  $('#monStart').disabled = true;
  const res = await Promise.all(list.map(st => remoteStart(st.id)));
  $('#monStart').disabled = false;
  const ok = res.filter(Boolean).length;
  toast(`${ok}/${list.length} camera${list.length === 1 ? '' : 's'} started`);
}
async function stopMonitoring() {
  const list = assigned().filter(st => devFor(st.id)?.mode !== 'offline');
  await Promise.all(list.map(st => remoteStop(st.id)));
}
function setRemoteMsg(stationId, m) { S.remoteMsg[stationId] = m; renderGrid(); }

// Remote settings dialog
let camDlgStation = null;
function fillCamDlg(st) {
  const s = st.settings || {};
  $$('#camDlg [data-k]').forEach(el => {
    const k = el.dataset.k; const v = s[k];
    if (el.type === 'checkbox') el.checked = !!v; else if (v !== undefined) el.value = String(v);
  });
  $('#cdDimVal').textContent = ($('#cd_guardDim').value || 100) + '%';
  const e = st.effective || {};
  $('#cdState').innerHTML = `${st.active ? '<span class="dot on"></span>Streaming' : st.standby ? '<span class="dot"></span>Standby' : '<span class="dot"></span>Camera off'} · ${st.viewers || 0} viewer(s)${e.width ? ` · <span class="mono">${e.width}×${e.height} @ ${e.frameRate || '?'} fps</span>` : ''} · mic ${st.mic ? 'on' : 'off'} · guard ${st.guard ? 'on' : 'off'} · screen ${esc(st.wake || '')}`;
}
async function openCamDlg(stationId) {
  camDlgStation = stationId;
  const st = Store.stations().find(x => x.id === stationId);
  $('#cdTitle').textContent = (st ? st.name : 'Camera') + ' settings';
  $('#cdAck').textContent = 'Reading settings from the camera…'; $('#cdAck').className = 'cd-ack muted small';
  $('#cdApply').disabled = true; $('#camDlg').showModal();
  try { const r = await sendCmd(stationId, 'get'); fillCamDlg(r.state); $('#cdAck').textContent = 'Current settings loaded from the camera.'; $('#cdApply').disabled = false; }
  catch (e) { $('#cdAck').textContent = 'Camera not reachable: ' + e.message; $('#cdAck').className = 'cd-ack err small'; $('#cdApply').disabled = false; }
}
async function applyCamDlg() {
  const id = camDlgStation; if (!id) return;
  const args = {};
  $$('#camDlg [data-k]').forEach(el => { const k = el.dataset.k; args[k] = el.type === 'checkbox' ? el.checked : (['camFps', 'guardDim'].includes(k) ? Number(el.value) : el.value); });
  $('#cdApply').disabled = true; $('#cdAck').textContent = 'Sending…'; $('#cdAck').className = 'cd-ack muted small';
  try {
    const r = await sendCmd(id, 'settings', args);
    fillCamDlg(r.state);
    const e = r.state.effective || {};
    $('#cdAck').innerHTML = `&#10003; Applied on ${esc(r.state.name)} at ${new Date(r.at).toLocaleTimeString()}${e.width ? ` · now ${e.width}×${e.height} @ ${e.frameRate || '?'} fps` : ''} · ${r.state.settings.facing === 'user' ? 'front' : 'back'} camera`;
    $('#cdAck').className = 'cd-ack ok small';
    window.SentinelDebug.lastAck = r;
  } catch (e) { $('#cdAck').textContent = '✗ Not applied: ' + e.message; $('#cdAck').className = 'cd-ack err small'; window.SentinelDebug.lastAck = { ok: false, error: e.message }; }
  finally { $('#cdApply').disabled = false; }
}

// ----- focused live view (fullscreen of one feed) -----
async function startLive(stationId, offlineSession = null) {
  const st = Store.stations().find(s => s.id === stationId);
  if (!st) return;
  const dev = devFor(stationId);
  const existing = S.feeds.get(stationId);
  if (!offlineSession && (S.settings.signaling === 'offline' || (dev && dev.mode === 'offline')) && !(existing && existing.session)) return openOffline(stationId);
  const prev = S.live;
  if (prev && prev.stationId !== stationId && !S.monitor) closeFeed(prev.stationId);
  const F = openFeed(stationId, offlineSession);
  focusFeed(F);
}
function focusFeed(F) {
  const st = Store.stations().find(s => s.id === F.stationId);
  S.live = F;
  $('#liveTitle').textContent = st ? st.name : 'Station';
  const v = $('#liveVideo'); attachVideo(v, F); v.muted = !F.listen;
  $('#btnListen').classList.toggle('on', !!F.listen);
  $('#btnRecord').classList.toggle('rec-on', !!F.recorder); $('#recBadge').hidden = !F.recorder;
  if (F.session) window.SentinelDebug.session = F.session;
  renderStrip(); show('live'); paintFocused();
}
function stopLive() {
  const F = S.live; if (!F) { show(S.monitor ? 'monitor' : 'home', false); return; }
  S.live = null; $('#liveVideo').srcObject = null; $('#liveVideo')._feed = null;
  if (F.recorder) stopRecording(F);
  if (S.monitor) { show('monitor', false); renderGrid(); return; }
  closeFeed(F.stationId);
  show(S.settings.role === 'station' ? 'stationHome' : 'home', false); S.history = []; render(); setTimeout(pollAll, 1500);
}
function setBadge(cls, text) { const b = $('#liveBadge'); b.className = 'badge ' + cls; b.textContent = text; }

// ----- monitor grid -----
function openMonitor() {
  S.monitor = true; S.history = ['home']; show('monitor', false);
  assigned().forEach(st => openFeed(st.id));
  renderGrid(); updateWake();
}
function leaveMonitor() { S.monitor = false; closeAllFeeds(); show('home', false); S.history = []; render(); setTimeout(pollAll, 1500); }
function tileFor(stId) { return document.querySelector(`#grid .tile[data-st="${CSS.escape(stId)}"]`); }
function renderGrid() {
  const grid = $('#grid'); if (!grid) return;
  const list = S.monitor ? Store.stations() : [];
  const want = new Set(list.map(s => s.id));
  grid.querySelectorAll('.tile').forEach(t => { if (!want.has(t.dataset.st)) t.remove(); });
  for (const st of list) {
    let t = tileFor(st.id);
    if (!t) {
      t = document.createElement('div'); t.className = 'tile'; t.dataset.st = st.id;
      t.innerHTML = `<video playsinline autoplay muted></video><div class="t-top"><span class="t-name"></span><span class="t-chip"></span></div><div class="t-msg"></div><div class="t-bot"><span class="t-info mono"></span><button class="btn icon t-cam"></button><button class="btn icon ghost t-gear" aria-label="Camera settings">${ICON.gear}</button><button class="btn icon t-act"></button><button class="btn icon ghost t-full" aria-label="Fullscreen">${ICON.full}</button></div>`;
      t.querySelector('.t-cam').onclick = () => { const live = ['live', 'stale'].includes(health(st.id).state) && S.feeds.get(st.id)?.session; live ? remoteStop(st.id) : remoteStart(st.id); };
      t.querySelector('.t-gear').onclick = () => openCamDlg(st.id);
      t.querySelector('video').addEventListener('click', () => { const F = S.feeds.get(st.id); if (F && F.session) focusFeed(F); else if (F && F.offline) openOffline(st.id); else if (F) retryNow(F); });
      t.querySelector('.t-full').onclick = () => { const F = S.feeds.get(st.id) || openFeed(st.id); focusFeed(F); };
      t.querySelector('.t-act').onclick = () => { const F = S.feeds.get(st.id); if (F) closeFeed(st.id); else openFeed(st.id); };
      grid.appendChild(t);
    }
    t.querySelector('.t-name').textContent = st.name;
    const F = S.feeds.get(st.id);
    const v = t.querySelector('video'); if (F) attachVideo(v, F); else { v.srcObject = null; v._feed = null; }
    t.querySelector('.t-act').textContent = F ? 'Disconnect' : 'Connect';
    t.querySelector('.t-cam').textContent = F && F.session && ['live', 'stale'].includes(health(st.id).state) ? 'Stop cam' : 'Start cam';
    paintTile(t, st, F);
  }
  $('#gridEmpty').hidden = list.length > 0;
  const live = Array.from(S.feeds.values()).filter(f => health(f.stationId).state === 'live').length;
  $('#monSummary').innerHTML = `<span class="dot ${live ? 'on' : ''}"></span>${live}/${list.length} live`;
}
function feedText(F, stId) {
  const rm = S.remoteMsg[stId || (F && F.stationId)]; if (rm) return rm;
  if (!F) return 'Disconnected';
  const h = health(F.stationId).state;
  if (h === 'live' || h === 'stale') return '';
  if (F.note) return F.note;
  if (F.restarting) return 'Restoring network path…';
  if (F.retryT && F.nextAt) return `${F.attempt > OFFLINE_AFTER ? 'Offline' : 'Reconnecting'} · retry ${F.attempt} in ${Math.max(0, Math.ceil((F.nextAt - Date.now()) / 1000))}s`;
  return 'Connecting…';
}
function feedInfo(F) {
  if (!F) return '';
  const p = [];
  const rtt = F.rtt ?? F.hbRtt; if (rtt != null) p.push(rtt + ' ms');
  if (F.lastFrame) { const age = Date.now() - F.lastFrame; p.push(age < 2000 ? 'frame now' : 'frame ' + Math.round(age / 1000) + 's ago'); }
  if (F.fps) p.push(Math.round(F.fps) + ' fps');
  if (F.relay) p.push('TURN');
  return p.join(' · ');
}
function paintTile(t, st, F) {
  const h = F ? health(st.id).state : 'offline';
  const sb = (F && F.standby && !['live', 'stale'].includes(h)) || (!F && /standby/i.test(S.remoteMsg[st.id] || ''));
  t.querySelector('.t-chip').innerHTML = sb ? chip('offline', 'Standby') : chip(F ? h : 'offline', F ? null : 'Off');
  t.dataset.state = h;
  const msg = feedText(F, st.id); const m = t.querySelector('.t-msg'); m.textContent = msg; m.hidden = !msg;
  t.querySelector('.t-info').textContent = feedInfo(F);
}
function paintFocused() {
  const F = S.live; if (!F) return;
  const h = health(F.stationId).state;
  const age = F.lastFrame ? Date.now() - F.lastFrame : Infinity;
  const stale = h === 'stale' && F.frames > 0;
  $('#staleOverlay').classList.toggle('show', stale);
  if (stale) $('#staleInfo').textContent = `No new frames for ${Math.floor(age / 1000)}s · last ${new Date(F.lastFrame).toLocaleTimeString()}`;
  if (h === 'live') { setBadge('live', 'LIVE'); $('#liveMsg').hidden = true; }
  else if (stale) setBadge('stale', 'STALE');
  else if (F.offline && !F.session) {
    setBadge('wait', 'ENDED');
    if (!$('#liveRedo')) { $('#liveMsg').hidden = false; $('#liveMsg').innerHTML = 'Session ended. Offline mode needs a new QR exchange.<br><br><button class="btn gold" id="liveRedo">New QR exchange</button>'; $('#liveRedo').onclick = () => { const id = F.stationId; S.monitor = false; stopLive(); openOffline(id); }; }
  } else {
    const off = h === 'offline';
    setBadge('wait', off ? 'OFFLINE' : (F.attempt ? 'RECONNECTING' : 'CONNECTING'));
    const txt = feedText(F) || 'CONNECTING…';
    $('#liveMsg').hidden = false;
    if (F.attempt) { if (!$('#liveRetry')) $('#liveMsg').innerHTML = '<span id="liveMsgTxt"></span><br><br><button class="btn gold" id="liveRetry">Retry now</button> <button class="btn" id="liveLast">View last status</button>'; $('#liveMsgTxt').textContent = txt.toUpperCase(); $('#liveRetry').onclick = () => retryNow(F); $('#liveLast').onclick = () => { S.monitor = false; stopLive(); openStatus(); }; }
    else $('#liveMsg').textContent = txt.toUpperCase();
  }
  $('#liveInfo').textContent = feedInfo(F);
  if (F.recorder) $('#recTime').textContent = fmtDur(Date.now() - F.recStart);
}

// One loop for every feed: frame freshness (getStats framesDecoded + requestVideoFrameCallback), state, alerts, snapshots.
let tickN = 0;
setInterval(async () => {
  tickN++;
  for (const F of Array.from(S.feeds.values())) {
    const s = F.session;
    if (s && tickN % 2 === 0) {
      const st = await s.stats();
      if (st.framesDecoded != null) { if (F.framesDecoded >= 0 && st.framesDecoded > F.framesDecoded) { F.lastFrame = Date.now(); F.frames++; } F.framesDecoded = st.framesDecoded; }
      F.rtt = st.rtt; F.fps = st.fps; F.relay = st.relay;
    }
    if (S.feeds.get(F.stationId) !== F) continue;
    const prev = health(F.stationId).state;
    if (s && s.state === 'connected') {
      const next = feedState({ pcState: 'connected', frames: F.frames, frameAgeMs: F.lastFrame ? Date.now() - F.lastFrame : Infinity, attempt: F.attempt, staleMs: STALE_MS });
      if (next !== 'connecting' && next !== prev) setHealth(F.stationId, next); // connected but no frame yet: not LIVE
    }
    const h = health(F.stationId).state;
    if (h === 'live') {
      F.downSince = 0; F.alerted = false; F.wasLive = true; if (S.remoteMsg[F.stationId]) S.remoteMsg[F.stationId] = '';
      if (!F.snapAt || Date.now() - F.snapAt > 10000) { F.snapAt = Date.now(); snapshot(F); }
      if (S.settings.alertMotion && tickN % 2 === 0) {
        const v = S.live === F ? $('#liveVideo') : tileFor(F.stationId)?.querySelector('video');
        const frac = F.probe.sample(v);
        if (frac > (MOTION_TH[S.settings.motionSens] || MOTION_TH.medium) && Date.now() - F.motionAt > MOTION_COOLDOWN_MS && Date.now() - F.opened > 5000) { F.motionAt = Date.now(); raiseAlert(F, 'motion'); }
      }
    } else if (h !== 'stale') {
      if (!F.downSince) F.downSince = Date.now();
      if (F.wasLive && !F.alerted && S.settings.alertOffline && Date.now() - F.downSince > OFFLINE_ALERT_MS) { F.alerted = true; raiseAlert(F, 'offline'); }
    }
  }
  if (S.monitor && $('#monitor').classList.contains('active')) for (const st of Store.stations()) { const t = tileFor(st.id); if (t) paintTile(t, st, S.feeds.get(st.id)); }
  if (S.live) paintFocused();
}, 500);
function raiseAlert(F, kind) {
  const st = Store.stations().find(s => s.id === F.stationId); const name = st ? st.name : 'Station';
  const when = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const text = kind === 'motion' ? `Motion · ${name} · ${when}` : `${name} went offline · ${when}`;
  S.alerts.unshift({ kind, text, at: Date.now(), stationId: F.stationId }); S.alerts.length = Math.min(S.alerts.length, 20);
  const bar = $('#alertBar'); bar.textContent = text; bar.dataset.kind = kind; bar.classList.add('show');
  clearTimeout(S.alertT); S.alertT = setTimeout(() => bar.classList.remove('show'), 12000);
  const t = tileFor(F.stationId); if (t) { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
  if (S.settings.alertSound) beep(kind);
  if (S.settings.alertVibrate) buzz(kind === 'motion' ? [120, 80, 120] : [300, 120, 300]);
  if (S.guard && S.guard.on) { S.guard.poke(); S.guard.tick(); }
  window.SentinelDebug.lastAlert = { kind, text };
}
function snapshot(F) {
  const v = S.live === F ? $('#liveVideo') : tileFor(F.stationId)?.querySelector('video');
  if (!v || !v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = 240; c.height = Math.round(240 * v.videoHeight / v.videoWidth);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  try { Store.upsertStation({ id: F.stationId, lastSnapshot: c.toDataURL('image/jpeg', 0.6), lastSeen: Date.now() }); } catch { }
}
const fmtDur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ----- recording (MediaRecorder -> IndexedDB vault). mp4 first (iOS), webm fallback -----
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}
function startRecording() {
  const L = S.live; if (!L || !L.session) return toast('Not connected yet');
  if (!L.session.remoteStream.getTracks().some(t => t.readyState === 'live')) return toast('No video yet');
  const mime = pickMime(); if (mime === null) return toast('Recording is not supported on this browser');
  const stream = new MediaStream(L.session.remoteStream.getTracks().filter(t => t.readyState === 'live'));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_000_000 } : {});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const st = Store.stations().find(s => s.id === L.stationId);
  rec.onstop = async () => {
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const rec2 = { id: 'rec-' + Date.now(), stationId: L.stationId, stationName: st ? st.name : 'Station', created: L.recStart, durationMs: Date.now() - L.recStart, mime: type, size: blob.size, blob };
    if (blob.size) { await Vault.add(rec2); toast(`Saved to vault (${(blob.size / 1024).toFixed(0)} KB)`); }
    else toast('Recording was empty');
    window.SentinelDebug.lastRecording = { id: rec2.id, size: blob.size, mime: type, durationMs: rec2.durationMs };
    document.dispatchEvent(new CustomEvent('recording-saved', { detail: window.SentinelDebug.lastRecording }));
  };
  rec.start(1000);
  L.recorder = rec; L.recStart = Date.now();
  $('#btnRecord').classList.add('rec-on'); $('#recBadge').hidden = false;
}
function stopRecording(F = S.live) {
  const L = F; if (!L || !L.recorder) return;
  try { L.recorder.stop(); } catch { }
  L.recorder = null; if (S.live === L || !S.live) { $('#btnRecord').classList.remove('rec-on'); $('#recBadge').hidden = true; }
}

// ----- last status -----
function openStatus() {
  const list = Store.stations();
  $('#statusList').innerHTML = list.map(st => `<div class="card"><div class="row"><b class="grow">${esc(st.name)}</b><span class="chip ${health(st.id).state}">${health(st.id).state}</span></div>
    ${st.lastSnapshot ? `<div style="position:relative;margin-top:8px"><img src="${st.lastSnapshot}" style="width:100%;border-radius:10px;opacity:.7" alt="last frame"><span class="badge stale" style="position:absolute;left:8px;top:8px">LAST FRAME · NOT LIVE</span></div>` : '<p class="muted small">No frame received yet.</p>'}
    <p class="muted small">Last seen: ${fmtTime(st.lastSeen)}${health(st.id).note ? ' · ' + esc(health(st.id).note) : ''}</p></div>`).join('') || '<p class="muted">No stations yet.</p>';
  show('status');
}

// =====================================================================
// CAMERA STATION
// =====================================================================
async function ensureCamera() {
  const C = S.station;
  if (C.cam && C.cam.getVideoTracks().some(t => t.readyState === 'live')) return C.cam;
  C.cam = await navigator.mediaDevices.getUserMedia(cameraConstraints(S.settings.facing || 'environment', true, S.settings.camRes, S.settings.camFps));
  C.cam.getVideoTracks()[0].addEventListener('ended', () => renderStationStatus());
  C.cam.getAudioTracks().forEach(t => { t.enabled = S.settings.camMic !== false; });
  $('#stationPreview').srcObject = C.cam;
  for (const s of C.sessions) { await s.setVideoTrack(C.cam.getVideoTracks()[0]); }
  return C.cam;
}
// Keep the screen awake while anything is being watched or streamed (and the user has not turned it off).
function watching() { return S.station.active || S.standby || S.feeds.size > 0 || (S.guard && S.guard.on); }
function updateWake() { if (S.settings.keepAwake && watching()) S.wake.enable(); else if (S.wake.wanted) S.wake.disable(); paintWake(); }
function requestWake() { updateWake(); } // fire-and-forget: never blocks camera start
function wakeLabel() {
  const w = S.wake;
  if (!S.settings.keepAwake) return ['off', 'Keep screen awake: OFF'];
  if (!watching()) return ['idle', 'Keep screen awake: ON (when monitoring)'];
  return { on: ['on', 'Screen awake · Wake Lock'], fallback: ['on', 'Screen awake · video fallback'], denied: ['warn', 'Tap screen to keep awake'], paused: ['idle', 'Screen awake (paused while hidden)'] }[w.state] || ['idle', 'Keep screen awake: starting…'];
}
function paintWake() {
  const [cls, txt] = wakeLabel();
  $$('.wake-toggle').forEach(b => { b.dataset.state = cls; b.querySelector('span').textContent = txt; b.setAttribute('aria-pressed', String(!!S.settings.keepAwake)); });
  S.station.wakeNote = S.settings.keepAwake ? (S.wake.detail || txt) : 'Off (you turned keep-awake off)';
  if ($('#stationActive').classList.contains('active')) renderStationStatus();
}
function toggleWake() { unlockAudio(); S.settings = Store.patchSettings({ keepAwake: !S.settings.keepAwake }); updateWake(); toast(S.settings.keepAwake ? 'Screen will stay awake while monitoring' : 'Screen may sleep normally'); }
async function startStation() {
  try { await ensureCamera(); }
  catch (e) { toast('Camera blocked: allow Camera and Microphone for Sentinel in Settings'); return false; }
  S.station.active = true;
  try { const a = $('#talkAudio'); a.muted = true; const p = a.play(); a.muted = false; if (p) p.catch(() => { }); } catch { } // unlock audio output with this tap (never await: play() on an empty element can stay pending)
  requestWake();
  show('stationActive');
  renderStationStatus();
  if (S.settings.signaling === 'peerjs' && (!S.broker || S.broker.status !== 'online')) startBroker();
  return true;
}
function stopStation(keepStandby = false) {
  if (!keepStandby) S.standby = false;
  const C = S.station; C.active = false;
  for (const s of C.sessions) s.close(); C.sessions.clear();
  if (C.cam) C.cam.getTracks().forEach(t => t.stop()); C.cam = null;
  if (S.guard && S.guard.on) S.guard.release();
  updateWake();
  show('stationHome', false); S.history = []; render();
}
async function stationSwitchCamera(target) {
  const C = S.station;
  const facing = target || ((S.settings.facing === 'user') ? 'environment' : 'user');
  const old = C.cam && C.cam.getVideoTracks()[0];
  if (old) { old.stop(); C.cam.removeTrack(old); }
  const s = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, false, S.settings.camRes, S.settings.camFps));
  const v = s.getVideoTracks()[0];
  if (!C.cam) C.cam = s; else C.cam.addTrack(v);
  $('#stationPreview').srcObject = C.cam;
  for (const x of C.sessions) await x.setVideoTrack(v);
  S.settings = Store.patchSettings({ facing });
  renderStationStatus();
  return facing;
}
function wireStationSession(session, ccName) {
  const C = S.station; C.sessions.add(session);
  session.addEventListener('message', async e => {
    const m = e.detail;
    if (m.t === 'switch-camera') { try { const f = await stationSwitchCamera(); session.send({ t: 'camera', facing: f }); } catch (err) { session.send({ t: 'camera-error', error: String(err) }); } }
    if (m.t === 'talk') {
      $('#talkIndicator').hidden = !m.on;
      const a = $('#talkAudio');
      if (m.on && session.talkStream) { a.srcObject = session.talkStream; a.play().catch(() => toast('Tap the screen to allow talk-back audio')); }
      window.SentinelDebug.talkOn = !!m.on;
    }
    if (m.t === 'hb') { session.lastHb = Date.now(); session.send({ t: 'hb-ack', ts: m.ts }); }
    if (m.t === 'bye') session.close();
  });
  session.addEventListener('state', e => {
    if (['closed', 'failed'].includes(e.detail)) { C.sessions.delete(session); if (!C.sessions.size) $('#talkIndicator').hidden = true; }
    renderStationStatus();
  });
  window.SentinelDebug.stationSession = session;
  renderStationStatus();
}
// Station watchdog: a viewer that sent heartbeats and then went silent for 20 s is gone; free its session.
setInterval(() => {
  for (const s of S.station.sessions) if (s.lastHb && Date.now() - s.lastHb > 20000 && s.state !== 'connected') s.close();
  if ($('#stationActive').classList.contains('active')) renderStationStatus();
}, 5000);
// ---------- remote control (station side) ----------
// Standby = Sentinel open, camera off, screen kept awake behind Guard mode, listening for the monitor.
function enterStandby() {
  S.standby = true;
  if (S.station.active) stopStation(true);
  show('stationHome', false); S.history = []; render();
  S.guard.engage(); updateWake();
}
function leaveStandby() { S.standby = false; updateWake(); render(); }
// Strict check for commands: the command center must be paired AND present its per-device secret.
function cmdAuth(ccId, secret) { return Store.devices().find(d => d.id === ccId && typeof d.secret === 'string' && d.secret.length >= 16 && d.secret === secret) || null; }
const REMOTE_SCHEMA = {
  facing: v => ['user', 'environment'].includes(v), camRes: v => ['sd', 'hd', 'fhd'].includes(v), camFps: v => [10, 15, 24, 30].includes(Number(v)),
  camQuality: v => ['low', 'medium', 'high'].includes(v), camMic: v => typeof v === 'boolean', stationSound: v => typeof v === 'boolean',
  keepAwake: v => typeof v === 'boolean', guard: v => typeof v === 'boolean', guardDim: v => Number(v) >= 50 && Number(v) <= 100,
};
function stationSnapshot() {
  const C = S.station; const v = C.cam && C.cam.getVideoTracks()[0]; const a = C.cam && C.cam.getAudioTracks()[0];
  let eff = {}; try { const g = v && v.readyState === 'live' ? v.getSettings() : {}; eff = { width: g.width, height: g.height, frameRate: g.frameRate ? Math.round(g.frameRate) : undefined }; } catch { }
  const st = S.settings;
  return { active: !!C.active, standby: !!S.standby, guard: !!(S.guard && S.guard.on), wake: S.wake.state, viewers: Array.from(C.sessions).filter(x => x.state === 'connected').length,
    mic: a ? a.enabled : st.camMic !== false, effective: eff, name: deviceName(),
    settings: { facing: st.facing || 'environment', camRes: st.camRes, camFps: Number(st.camFps), camQuality: st.camQuality, camMic: st.camMic !== false, stationSound: st.stationSound !== false, keepAwake: !!st.keepAwake, guard: !!(S.guard && S.guard.on), guardDim: Number(st.guardDim) || 100 } };
}
async function applyRemoteSettings(args) {
  const bad = Object.keys(args || {}).filter(k => !REMOTE_SCHEMA[k] || !REMOTE_SCHEMA[k](args[k]));
  if (bad.length) throw new Error('rejected: ' + bad.join(', '));
  const C = S.station; const p = {};
  for (const k of ['camRes', 'camQuality', 'camMic', 'stationSound', 'keepAwake']) if (k in args) p[k] = args[k];
  if ('camFps' in args) p.camFps = Number(args.camFps);
  if ('guardDim' in args) p.guardDim = Number(args.guardDim);
  S.settings = Store.patchSettings(p);
  if (C.cam) {
    if ('facing' in args && args.facing !== (S.settings.facing || 'environment')) await stationSwitchCamera(args.facing);
    else if ('facing' in args) S.settings = Store.patchSettings({ facing: args.facing });
    const v = C.cam.getVideoTracks()[0];
    if (v && ('camRes' in args || 'camFps' in args)) await v.applyConstraints(videoConstraints(S.settings.camRes, S.settings.camFps)).catch(e => { throw new Error('camera refused ' + S.settings.camRes + '@' + S.settings.camFps + ': ' + e.name); });
    C.cam.getAudioTracks().forEach(t => { t.enabled = S.settings.camMic !== false; });
  } else if ('facing' in args) S.settings = Store.patchSettings({ facing: args.facing });
  if ('camQuality' in args || C.cam) for (const x of C.sessions) await x.setMaxBitrate(QUALITY_BPS[S.settings.camQuality] || QUALITY_BPS.medium);
  if ('guard' in args) { if (args.guard && !S.guard.on) S.guard.engage(); else if (!args.guard && S.guard.on) S.guard.release(); }
  if (S.guard.on) S.guard.applyDim();
  updateWake(); renderStationStatus();
}
async function stHandleCmd(conn, msg) {
  const cc = cmdAuth(msg.cc, msg.secret);
  if (!cc) { conn.send({ t: 'cmd-ack', id: msg.id, ok: false, error: 'denied: not a paired monitor' }); return; }
  if (S.settings.role !== 'station') { conn.send({ t: 'cmd-ack', id: msg.id, ok: false, error: 'this device is not a camera station' }); return; }
  if (S.settings.stationSound !== false && msg.cmd !== 'get') beep('cmd');
  try {
    if (msg.cmd === 'start') {
      S.standby = false;
      if (S.guard.on) S.guard.release(); // undim
      if (!S.station.active) { const ok = await startStation(); if (!ok) throw new Error('camera blocked: allow Camera for Sentinel on the camera device'); }
      else show('stationActive');
      toast(`Started remotely by ${cc.n || 'command center'}`);
    } else if (msg.cmd === 'stop') {
      enterStandby(); toast(`Stopped remotely by ${cc.n || 'command center'} · standby`);
    } else if (msg.cmd === 'settings') {
      await applyRemoteSettings(msg.args || {}); toast(`Settings changed by ${cc.n || 'command center'}`);
    } else if (msg.cmd !== 'get') throw new Error('unknown command');
    conn.send({ t: 'cmd-ack', id: msg.id, ok: true, cmd: msg.cmd, state: stationSnapshot(), at: Date.now() });
  } catch (e) { conn.send({ t: 'cmd-ack', id: msg.id, ok: false, cmd: msg.cmd, error: e.message, state: stationSnapshot(), at: Date.now() }); }
  window.SentinelDebug.lastCmd = { cmd: msg.cmd, from: cc.n };
}
function pairedCC(ccId, secret) { return Store.devices().find(d => d.id === ccId && (!d.secret || d.secret === secret)); }
function stIncoming(conn) {
  let authed = null; const bySid = new Map();
  conn.on('data', async msg => {
    if (!msg || !msg.t) return;
    if (msg.t === 'ping') {
      const cc = pairedCC(msg.cc, msg.secret);
      conn.send(cc ? { t: 'pong', cam: S.station.active && !!S.station.cam, standby: !!S.standby, n: deviceName(), facing: S.settings.facing } : { t: 'denied' });
    } else if (msg.t === 'cmd') {
      stHandleCmd(conn, msg);
    } else if (msg.t === 'hello') {
      const cc = pairedCC(msg.cc, msg.secret);
      if (!cc) return conn.send({ t: 'denied' });
      if (!S.station.active) return conn.send({ t: 'not-active', standby: !!S.standby });
      authed = cc; conn.send({ t: 'hello-ok' });
    } else if (msg.t === 'offer' && authed && msg.restart && bySid.has(msg.sid) && !bySid.get(msg.sid).closed) {
      try { conn.send({ t: 'answer', sid: msg.sid, sdp: await bySid.get(msg.sid).reanswer(msg.sdp) }); } // ICE restart on the live session
      catch (e) { conn.send({ t: 'error', error: String(e) }); }
    } else if (msg.t === 'offer' && authed) {
      try {
        const cam = await ensureCamera();
        const session = new MediaSession('camera', S.settings);
        const sdp = await session.answerOffer(msg.sdp, cam);
        wireStationSession(session, authed.n); bySid.set(msg.sid, session);
        session.addEventListener('state', e => { if (e.detail === 'connected') session.setMaxBitrate(QUALITY_BPS[S.settings.camQuality] || QUALITY_BPS.medium); });
        conn.send({ t: 'answer', sid: msg.sid, sdp });
      } catch (e) { conn.send({ t: 'error', error: String(e) }); }
    }
  });
}
// pairing from the station side
async function stHandleInvite(kind, data) {
  if (Date.now() > data.exp) { toast('This code has expired. Ask for a new one.'); return showStationHome(); }
  S.pendingInvite = { kind, data };
  $('#approveName').textContent = data.n || 'Command center';
  $('#approveDetail').textContent = kind === 'HAIL1O' ? 'Offline pairing (no server)' : 'Pairing via broker';
  show('approve');
  countdown($('#approveCountdown'), data.exp, () => { toast('Pairing code expired'); S.pendingInvite = null; showStationHome(); });
}
async function stApprove() {
  const inv = S.pendingInvite; if (!inv) return; S.pendingInvite = null; clearInterval(S.pairTimer);
  const { kind, data } = inv;
  if (Date.now() > data.exp) { toast('Code expired'); return showStationHome(); }
  const secret = randomId(16);
  if (kind === 'HAIL1P') {
    try {
      if (data.br) S.settings = Store.patchSettings({ broker: data.br });
      await ensureBroker();
      if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline. Try offline pairing.');
      const conn = await S.broker.connect(data.cc, 10000);
      conn.send({ t: 'pair-req', tok: data.tok, id: S.id, n: deviceName(), secret });
      const r = await waitFor(conn, ['pair-ok', 'pair-fail'], 10000);
      conn.close();
      if (r.t === 'pair-fail') { toast('Pairing refused: ' + r.reason); window.SentinelDebug.lastPair = r; return showStationHome(); }
      Store.upsertDevice({ id: data.cc, n: r.n || data.n, secret, mode: 'peerjs', pairedAt: Date.now() });
      window.SentinelDebug.lastPair = r;
      toast('Paired with ' + (r.n || data.n) + ' · starting camera');
      showStationHome();
      if (!S.station.active) startStation(); // one-tap: approving also turns this station on
    } catch (e) { toast('Pairing failed: ' + e.message); window.SentinelDebug.lastPair = { t: 'error', error: e.message }; showStationHome(); }
  } else {
    try {
      const cam = await ensureCamera();
      S.station.active = true;
      const session = new MediaSession('camera', S.settings);
      const sdp = await session.answerOffer(data.sdp, cam);
      const payload = await encodePayload('HAIL1A', { v: 1, id: S.id, n: deviceName(), tok: data.tok, secret, sdp });
      Store.upsertDevice({ id: data.id, n: data.n, secret, mode: 'offline', pairedAt: Date.now() });
      wireStationSession(session, data.n);
      $('#answerText').value = payload;
      show('answer');
      try { const info = drawQr($('#answerQr'), payload, 'L'); $('#answerQr').dataset.payload = payload; $('#answerInfo').textContent = `QR version ${info.version} · ${payload.length} chars`; }
      catch { $('#answerInfo').textContent = 'Answer too large for one QR here. Use Copy answer code.'; }
      window.SentinelDebug.lastAnswer = payload;
      session.addEventListener('state', e => { if (e.detail === 'connected') { requestWake(); show('stationActive'); renderStationStatus(); } });
    } catch (e) { toast('Could not start camera: ' + e.message); showStationHome(); }
  }
}
async function stDeny() {
  const inv = S.pendingInvite; S.pendingInvite = null; clearInterval(S.pairTimer);
  if (inv && inv.kind === 'HAIL1P' && S.broker && S.broker.status === 'online') {
    try { const c = await S.broker.connect(inv.data.cc, 5000); c.send({ t: 'pair-deny', tok: inv.data.tok }); setTimeout(() => c.close(), 500); } catch { }
  }
  toast('Pairing denied'); showStationHome();
}
function showStationHome() { S.history = []; show('stationHome', false); render(); }

// ---------- scanning ----------
let scanner = null;
function openScanner(hint) {
  show('scan');
  $('#scanHint').textContent = hint || 'Point the camera at the Sentinel QR code.';
  scanner = new QrScanner($('#scanVideo'), text => { scanner = null; handleScan(text); });
  scanner.start().catch(() => $('#scanHint').textContent = 'Camera unavailable. Allow camera access, or paste the code below.');
}
function stopScanner() { if (scanner) scanner.stop(); scanner = null; }
export async function handleScan(text) {
  stopScanner();
  let p;
  try { p = await decodePayload(extractPayload(text)); } catch { toast('That is not a Sentinel code'); return back(); }
  if (!S.settings.role && (p.kind === 'HAIL1P' || p.kind === 'HAIL1O')) applyRole('station');
  const role = S.settings.role;
  if (role === 'station' && (p.kind === 'HAIL1P' || p.kind === 'HAIL1O')) return stHandleInvite(p.kind, p.data);
  if (role === 'command' && p.kind === 'HAIL1A') { S.history = ['home']; return ccHandleAnswer(p.data); }
  toast(role === 'command' ? 'Scan this code with the camera station instead' : 'Scan this code with the command center instead');
  back();
}

// ---------- rendering ----------
function chip(state, label) { return `<span class="chip ${state}">${label || { live: 'Live', reconnecting: 'Connecting', stale: 'Stale', offline: 'Offline' }[state]}</span>`; }
function render() {
  const role = S.settings.role;
  if (role === 'command') {
    const s = liveButtonState();
    $('#liveBtnLabel').textContent = s.label.toUpperCase(); $('#liveBtnSub').textContent = s.sub || '';
    $('#liveBtn').dataset.state = s.label;
    const list = Store.stations();
    $('#homeStations').innerHTML = list.map(st => {
      const dev = Store.devices().find(d => d.id === st.deviceId);
      return `<li data-st="${esc(st.id)}"><img class="thumb" ${st.lastSnapshot ? `src="${st.lastSnapshot}"` : ''} alt=""><div class="grow"><div class="name">${esc(st.name)}</div><div class="muted small">${dev ? esc(dev.n) : 'No device assigned'}</div></div>${chip(health(st.id).state)}</li>`;
    }).join('') || '<li class="muted small">No stations yet. Tap CONNECT A STATION.</li>';
    $$('#homeStations li[data-st]').forEach(li => li.onclick = () => startLive(li.dataset.st));
    $('#monitorBtn').hidden = !assigned().length;
    $('#monitorBtn small').textContent = `${assigned().length} camera${assigned().length === 1 ? '' : 's'} · grid · alerts`;
    if (S.monitor) renderGrid();
    if ($('#stations').classList.contains('active')) renderStations();
    if ($('#live').classList.contains('active')) renderStrip();
  } else if (role === 'station') {
    const cc = Store.devices();
    $('#startStation').classList.toggle('pulse', cc.length > 0 && !S.station.active);
    $('#ccList').innerHTML = cc.map(d => `<li><div class="grow"><div class="name">${esc(d.n)}</div><div class="muted small">${d.mode === 'offline' ? 'Offline QR' : 'Broker'} · paired ${fmtTime(d.pairedAt)}</div></div><button class="btn icon" data-unpair="${esc(d.id)}">Unpair</button></li>`).join('') || '<li class="muted small">Not paired yet.</li>';
    $$('[data-unpair]').forEach(b => b.onclick = () => { if (confirm('Unpair this command center?')) { Store.removeDevice(b.dataset.unpair); render(); } });
  }
}
function renderStrip() {
  const L = S.live; const list = assigned();
  $('#stationStrip').innerHTML = list.length > 1 ? list.map(st => `<button class="btn icon ${L && st.id === L.stationId ? 'gold' : ''}" data-sw="${esc(st.id)}">${esc(st.name)} ${chip(health(st.id).state)}</button>`).join('') : '';
  $$('[data-sw]').forEach(b => b.onclick = () => { if (!S.live || b.dataset.sw !== S.live.stationId) startLive(b.dataset.sw); });
}
function renderStations() {
  const devs = Store.devices();
  $('#stationList').innerHTML = Store.stations().map(st => `<div class="card" data-st="${esc(st.id)}">
    <div class="row"><input class="grow" data-rename value="${esc(st.name)}" aria-label="Station name">${chip(health(st.id).state)}</div>
    <label>Device serving this station</label>
    <select data-assign><option value="">Unassigned</option>${devs.map(d => `<option value="${esc(d.id)}" ${d.id === st.deviceId ? 'selected' : ''}>${esc(d.n)} (${d.mode === 'offline' ? 'offline QR' : 'broker'})</option>`).join('')}</select>
    <div class="row" style="margin-top:8px"><span class="muted small grow">Last seen: ${fmtTime(st.lastSeen)}</span><button class="btn icon ghost" data-del>Delete</button></div></div>`).join('') || '<p class="muted small">No stations yet.</p>';
  $$('#stationList [data-st]').forEach(card => {
    const id = card.dataset.st;
    card.querySelector('[data-rename]').onchange = e => { Store.upsertStation({ id, name: e.target.value.trim() || 'Station' }); render(); };
    card.querySelector('[data-assign]').onchange = e => {
      const dev = e.target.value || null;
      // one device serves one station: unassign it elsewhere
      if (dev) Store.stations().filter(s => s.deviceId === dev && s.id !== id).forEach(s => Store.upsertStation({ id: s.id, deviceId: null }));
      Store.upsertStation({ id, deviceId: dev }); renderStations(); pollAll(); render();
    };
    card.querySelector('[data-del]').onclick = () => { if (confirm('Delete this station?')) { Store.removeStation(id); renderStations(); render(); } };
  });
  $('#deviceList').innerHTML = devs.map(d => `<li><div class="grow"><div class="name">${esc(d.n)}</div><div class="muted small">${d.mode === 'offline' ? 'Offline QR' : 'Broker'} · paired ${fmtTime(d.pairedAt)}</div></div><button class="btn icon" data-ren="${esc(d.id)}">Rename</button><button class="btn icon ghost" data-unp="${esc(d.id)}">Unpair</button></li>`).join('') || '<li class="muted small">No paired devices.</li>';
  $$('[data-ren]').forEach(b => b.onclick = () => { const d = Store.devices().find(x => x.id === b.dataset.ren); const n = prompt('Device name', d.n); if (n) { Store.upsertDevice({ id: d.id, n }); renderStations(); render(); } });
  $$('[data-unp]').forEach(b => b.onclick = () => { if (confirm('Unpair this device?')) { Store.removeDevice(b.dataset.unp); Store.stations().filter(s => s.deviceId === b.dataset.unp).forEach(s => Store.upsertStation({ id: s.id, deviceId: null })); renderStations(); render(); } });
}
async function renderVault() {
  const list = await Vault.list();
  $('#vaultList').innerHTML = list.map(r => `<li data-id="${esc(r.id)}"><div class="grow"><div class="name">${esc(r.stationName)}</div><div class="muted small num">${fmtTime(r.created)} · ${fmtDur(r.durationMs)} · ${(r.size / 1048576).toFixed(2)} MB · ${esc((r.mime || '').split(';')[0])}</div>
    <div class="row" style="margin-top:6px;flex-wrap:wrap"><button class="btn icon" data-a="play">Play</button><button class="btn icon" data-a="dl">Download</button><button class="btn icon" data-a="share">Share</button><button class="btn icon ghost" data-a="del">Delete</button></div></div></li>`).join('') || '<li class="muted small">No recordings yet. Tap RECORD in live view.</li>';
  $$('#vaultList li[data-id]').forEach(li => li.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
    const r = await Vault.get(li.dataset.id); if (!r) return;
    const ext = /mp4/.test(r.mime) ? 'mp4' : 'webm';
    const fname = `hail-sentinel-${r.stationName.replace(/\W+/g, '-').toLowerCase()}-${new Date(r.created).toISOString().replace(/[:.]/g, '-')}.${ext}`;
    const a = b.dataset.a;
    if (a === 'play') { const v = $('#playVideo'); v.src = URL.createObjectURL(r.blob); $('#playDlg').showModal(); v.play().catch(() => { }); }
    if (a === 'dl') { const u = URL.createObjectURL(r.blob); const x = document.createElement('a'); x.href = u; x.download = fname; document.body.appendChild(x); x.click(); x.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); }
    if (a === 'share') {
      const file = new File([r.blob], fname, { type: r.mime.split(';')[0] });
      if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: 'Sentinel recording' }).catch(() => { });
      else toast('Sharing files is not supported here. Use Download.');
    }
    if (a === 'del' && confirm('Delete this recording?')) { await Vault.remove(r.id); renderVault(); }
  }));
}
function renderSettings() {
  const s = S.settings;
  $$('#segRole button').forEach(b => b.classList.toggle('on', b.dataset.v === s.role));
  $$('#segSig button').forEach(b => b.classList.toggle('on', b.dataset.v === s.signaling));
  $('#setName').value = s.deviceName || '';
  $('#bHost').value = s.broker.host; $('#bPort').value = s.broker.port; $('#bPath').value = s.broker.path; $('#bKey').value = s.broker.key; $('#bSecure').value = String(s.broker.secure !== false);
  $('#sStun').value = s.stun; $('#sTurn').value = s.turnUrl; $('#sTurnU').value = s.turnUser; $('#sTurnP').value = s.turnPass;
  for (const k of ['keepAwake', 'autoStart', 'autoStandby', 'autoMonitor', 'alertOffline', 'alertMotion', 'alertSound', 'alertVibrate']) $('#set_' + k).checked = !!s[k];
  $('#setGuardDim').value = Number(s.guardDim) || (s.guardStyle === 'dim' ? 88 : 100); $('#rowAutoStandby').hidden = s.role !== 'station';
  $('#setSens').value = s.motionSens || 'medium';
  $('#pinState').textContent = s.guardPinHash ? `PIN set (${s.guardPinLen} digits)` : 'No PIN: unlock by press-and-hold';
  $('#setPin').value = ''; $('#clearPin').hidden = !s.guardPinHash;
  $('#rowAutoStart').hidden = s.role !== 'station'; $('#rowAutoMonitor').hidden = s.role !== 'command';
  $('#vibNote').textContent = 'vibrate' in navigator ? '' : '(not supported on iPhone/iPad Safari)';
  $('#aboutBox').innerHTML = `H.A.I.L. Sentinel v${VERSION} · ${isStandalone() ? 'Running as Home Screen app' : 'Running in a browser tab'}<br>Device ID: <span class="num">${esc(S.id)}</span><br>PeerJS 1.5.5 · jsQR 1.4.0 · qrcode-generator 2.0.4 (vendored)<br>Wake Lock: ${'wakeLock' in navigator ? 'available' : 'not available (video fallback)'}${iosVersion() ? ' · iOS ' + iosVersion() : ''} · Recording: ${esc(pickMime() || 'n/a')}`;
}
function renderStationStatus() {
  const C = S.station; const v = C.cam && C.cam.getVideoTracks()[0];
  const viewers = Array.from(C.sessions).filter(s => s.state === 'connected').length;
  $('#stationLine').textContent = viewers ? `Streaming to ${viewers} command center${viewers > 1 ? 's' : ''}` : 'Waiting for command center';
  const hb = Array.from(C.sessions).map(s => s.lastHb).filter(Boolean).sort().pop();
  $('#stationStatus').innerHTML = `Camera: <b>${v && v.readyState === 'live' ? (S.settings.facing === 'user' ? 'front' : 'back') + ' · on' : 'stopped'}</b><br>Screen: <b>${esc(C.wakeNote || '…')}</b><br>Signaling: <b>${S.settings.signaling === 'offline' ? 'offline QR' : 'PeerJS broker · ' + esc(S.broker ? S.broker.status : 'off')}</b><br>Viewers: <b>${viewers}</b>${hb ? ` · heartbeat <span class="mono">${Math.round((Date.now() - hb) / 1000)}s ago</span>` : ''}<br>Device: <span class="num">${esc(deviceName())}</span>`;
}

// ---------- init / routing ----------
function applyRole(role) {
  S.settings = Store.patchSettings({ role });
  S.history = [];
  if (role === 'command') { show('home', false); } else { show('stationHome', false); }
  startBroker(); render();
}
function wire() {
  $$('[data-role]').forEach(b => b.onclick = () => applyRole(b.dataset.role));
  $$('[data-back]').forEach(b => b.onclick = back);
  $$('[data-go]').forEach(b => b.onclick = () => { const g = b.dataset.go; show(g); if (g === 'stations') renderStations(); if (g === 'vault') renderVault(); if (g === 'settings') renderSettings(); });
  $('#liveBtn').onclick = onLiveButton;
  $('#homePair').onclick = openPair; $('#stationsPair').onclick = openPair;
  $('#pairRefresh').onclick = () => { S.history.pop(); openPair(); };
  $('#pairShare').onclick = () => { const l = S.pairLink; if (!l) return; if (navigator.share) navigator.share({ title: 'Pair Sentinel', url: l }).catch(() => { }); else navigator.clipboard.writeText(l).then(() => toast('Pairing link copied')); };
  $('#pairUseOffline').onclick = () => openOffline();
  $('#addStation').onclick = () => { const n = prompt('Station name', 'Front Door'); if (n) { Store.upsertStation({ id: 'st-' + randomId(4), name: n, deviceId: null, created: Date.now() }); renderStations(); render(); } };
  $('#scanAnswer').onclick = () => openScanner('Scan the answer code shown on the camera station.');
  $('#copyOffer').onclick = () => navigator.clipboard.writeText($('#offerText').value).then(() => toast('Copied'));
  $('#useAnswer').onclick = () => handleScan($('#answerPaste').value);
  $('#copyAnswer').onclick = () => navigator.clipboard.writeText($('#answerText').value).then(() => toast('Copied'));
  $('#answerCancel').onclick = () => { for (const s of S.station.sessions) if (s.state !== 'connected') s.close(); showStationHome(); };
  $('#scanPasteUse').onclick = () => handleScan($('#scanPaste').value);
  $('#liveClose').onclick = () => stopLive();
  $('#btnRecord').onclick = () => (S.live && S.live.recorder) ? stopRecording() : startRecording();
  $('#btnListen').onclick = () => { if (!S.live) return; S.live.listen = !S.live.listen; $('#liveVideo').muted = !S.live.listen; $('#btnListen').classList.toggle('on', S.live.listen); };
  $('#btnSwitch').onclick = () => { if (S.live && S.live.session) S.live.session.send({ t: 'switch-camera' }); };
  const talk = $('#btnTalk');
  const talkOn = e => { e.preventDefault(); if (!S.live || !S.live.session) return; talk.classList.add('on'); S.live.session.talk(true).catch(() => { talk.classList.remove('on'); toast('Microphone blocked: allow it in Settings'); }); };
  const talkOff = () => { if (!talk.classList.contains('on')) return; talk.classList.remove('on'); if (S.live && S.live.session) S.live.session.talk(false); };
  talk.addEventListener('pointerdown', talkOn); ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => talk.addEventListener(t, talkOff));
  talk.addEventListener('contextmenu', e => e.preventDefault());
  $('#statusRetry').onclick = () => { assigned().forEach(st => setHealth(st.id, 'reconnecting', { retry: 0 })); assigned().forEach(st => pingStation(st)); back(); };
  $('#playClose').onclick = () => { const v = $('#playVideo'); v.pause(); URL.revokeObjectURL(v.src); $('#playDlg').close(); };
  $$('#segRole button').forEach(b => b.onclick = () => { $$('#segRole button').forEach(x => x.classList.toggle('on', x === b)); });
  $$('#segSig button').forEach(b => b.onclick = () => { $$('#segSig button').forEach(x => x.classList.toggle('on', x === b)); });
  $('#saveSettings').onclick = async () => {
    const role = $('#segRole button.on')?.dataset.v || S.settings.role;
    S.settings = Store.patchSettings({
      deviceName: $('#setName').value.trim(), signaling: $('#segSig button.on')?.dataset.v || 'peerjs',
      broker: { host: $('#bHost').value.trim() || DEFAULT_BROKER.host, port: Number($('#bPort').value) || 443, path: $('#bPath').value.trim() || '/', key: $('#bKey').value.trim() || 'peerjs', secure: $('#bSecure').value === 'true' },
      stun: $('#sStun').value.trim(), turnUrl: $('#sTurn').value.trim(), turnUser: $('#sTurnU').value.trim(), turnPass: $('#sTurnP').value,
      guardDim: Number($('#setGuardDim').value) || 100,
      ...Object.fromEntries(['keepAwake', 'autoStart', 'autoStandby', 'autoMonitor', 'alertOffline', 'alertMotion', 'alertSound', 'alertVibrate'].map(k => [k, $('#set_' + k).checked])),
      motionSens: $('#setSens').value,
    });
    const pin = $('#setPin').value.trim();
    if (pin) {
      if (!/^\d{4,8}$/.test(pin)) return toast('PIN must be 4 to 8 digits');
      const salt = randomId(8); S.settings = Store.patchSettings({ guardPinSalt: salt, guardPinHash: await hashPin(pin, salt), guardPinLen: pin.length });
    }
    unlockAudio(); updateWake();
    toast('Saved'); applyRole(role);
  };
  $('#resetAll').onclick = async () => { if (confirm('Erase all pairings, stations and settings on this device? Recordings stay in the vault.')) { Store.clearAll(); location.href = location.pathname; } };
  $('#startStation').onclick = startStation;
  $('#stationScan').onclick = () => openScanner('Scan the pairing code on the command center.');
  $('#approveYes').onclick = stApprove; $('#approveNo').onclick = stDeny;
  $('#stopStation').onclick = () => stopStation();
  $('#standbyBtn').onclick = () => { unlockAudio(); enterStandby(); };
  $$('[data-guard]').forEach(b => b.onclick = () => { unlockAudio(); S.guard.engage(); });
  $$('.wake-toggle').forEach(b => b.onclick = toggleWake);
  $$('[data-help]').forEach(b => b.onclick = () => show('help'));
  $('#monitorBtn').onclick = () => { unlockAudio(); openMonitor(); };
  $('#monStart').onclick = startMonitoring; $('#monStop').onclick = stopMonitoring;
  $('#liveGear').onclick = () => { if (S.live) openCamDlg(S.live.stationId); };
  $('#cdApply').onclick = applyCamDlg; $('#cdClose').onclick = () => $('#camDlg').close();
  $('#cd_guardDim').oninput = e => { $('#cdDimVal').textContent = e.target.value + '%'; };
  $('#monBack').onclick = leaveMonitor;
  $('#monConnectAll').onclick = () => { assigned().forEach(st => { const F = S.feeds.get(st.id); F ? retryNow(F) : openFeed(st.id); }); };
  $('#monDisconnectAll').onclick = () => closeAllFeeds();
  $('#gridPair').onclick = openPair;
  $('#liveGrid').onclick = () => { if (!S.monitor) { const keep = S.live; S.monitor = true; S.live = null; assigned().forEach(st => openFeed(st.id)); show('monitor', false); S.history = ['home']; renderGrid(); if (keep) attachVideo(tileFor(keep.stationId)?.querySelector('video'), keep); } else stopLive(); };
  $('#alertBar').onclick = () => { const a = S.alerts[0]; $('#alertBar').classList.remove('show'); const F = a && S.feeds.get(a.stationId); if (F && F.session) focusFeed(F); };
  $('#codeJoin').onclick = () => joinByCode($('#codeInput').value);
  $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode($('#codeInput').value); });
  $('#codeInput').addEventListener('input', e => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); e.target.value = v.length > 3 ? v.slice(0, 3) + '-' + v.slice(3) : v; });
  $('#pairCopy').onclick = () => { if (S.pairLink) navigator.clipboard.writeText(S.pairLink).then(() => toast('Pairing link copied')).catch(() => toast('Copy blocked: use Share')); };
  $('#clearPin').onclick = () => { S.settings = Store.patchSettings({ guardPinHash: '', guardPinSalt: '', guardPinLen: 0 }); renderSettings(); toast('PIN removed'); };
  document.addEventListener('screen', e => { if (e.detail !== 'pair') stopPairCode(); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (S.settings.role === 'station' && S.station.active) { try { await ensureCamera(); } catch { } } // iOS kills the camera in the background: restart it on return
    updateWake();
    reconnectEverything('visible');
  });
  window.addEventListener('online', () => { $('#netBar').classList.remove('show'); toast('Back online · reconnecting'); reconnectEverything('online'); });
  window.addEventListener('offline', () => $('#netBar').classList.add('show'));
  window.addEventListener('pageshow', e => { if (e.persisted) reconnectEverything('pageshow'); });
  S.wake.addEventListener('change', () => { paintWake(); if (S.guard && S.guard.on) S.guard.tick(); });
}
function guardStatus() {
  const a = S.alerts[0] && Date.now() - S.alerts[0].at < 60000 ? `<div class="g-alert">${esc(S.alerts[0].text)}</div>` : '';
  const awake = S.wake.state === 'on' || S.wake.state === 'fallback' ? 'screen awake' : 'screen may sleep';
  if (S.settings.role === 'station' && S.standby && !S.station.active) return `<span class="dot"></span>STANDBY · waiting for the monitor · ${awake}${a}`;
  if (S.settings.role === 'station') { const n = Array.from(S.station.sessions).filter(s => s.state === 'connected').length; return `<span class="dot ${S.station.active ? 'on' : ''}"></span>${S.station.active ? 'STATION ACTIVE' : 'STATION STOPPED'} · ${n} viewer${n === 1 ? '' : 's'} · ${awake}${a}`; }
  const live = Array.from(S.feeds.values()).filter(f => health(f.stationId).state === 'live').length;
  return `<span class="dot ${live ? 'on' : ''}"></span>${live}/${S.feeds.size} cameras live · ${awake}${a}`;
}
function handleDeepLink() {
  const hp = /[#&]p=([^&]+)/.exec(location.hash);
  if (hp) { history.replaceState(null, '', location.pathname); const code = decodeURIComponent(hp[1]); setTimeout(() => handleScan(code), 300); return; }
  const q = new URLSearchParams(location.search);
  const role = q.get('role'), action = q.get('action');
  if (role === 'station' || role === 'command') { if (S.settings.role !== role) applyRole(role); }
  if (!S.settings.role) { show('role', false); return; }
  if (action === 'live') { if (S.settings.role === 'command') setTimeout(onLiveButton, S.settings.signaling === 'peerjs' ? 1800 : 0); else toast('Tap START STATION to turn the camera on'); }
  if (action === 'monitor' && S.settings.role === 'command') setTimeout(openMonitor, 300);
  if (action === 'pair') { if (S.settings.role === 'command') openPair(); else openScanner('Scan the pairing code on the command center.'); }
  if (role || action) history.replaceState(null, '', location.pathname);
}

window.SentinelDebug = {
  S, Store, Vault, handleScan, pickStation, liveButtonState, openPair, openOffline, startLive, stopLive, pickMime,
  openMonitor, leaveMonitor, sendCmd, remoteStart, remoteStop, startMonitoring, openCamDlg, enterStandby, closeFeed, openFeed, retryNow, reconnectEverything, tryIceRestart, joinByCode, updateWake, raiseAlert, nextDelay,
  stopCameraTrack() { const t = S.station.cam && S.station.cam.getVideoTracks()[0]; if (t) t.stop(); return !!t; },
  decodeQrCanvas(sel) { return decodeCanvas(document.querySelector(sel)); },
};

async function boot() {
  S.guard = new Guard($('#guard'), () => S.settings, guardStatus);
  S.guard.addEventListener('engage', updateWake); S.guard.addEventListener('release', updateWake);
  wire();
  if (navigator.onLine === false) $('#netBar').classList.add('show');
  if (S.settings.role === 'command') show('home', false);
  else if (S.settings.role === 'station') show('stationHome', false);
  else show('role', false);
  setTimeout(() => { const sp = document.getElementById('splash'); if (sp) { sp.classList.add('hide'); setTimeout(() => sp.remove(), 600); } }, 900);
  handleDeepLink();
  if (S.settings.role && !S.broker) ensureBroker();
  render(); paintWake();
  const q = new URLSearchParams(location.search);
  if (!q.has('action') && !location.hash) {
    if (S.settings.role === 'command' && S.settings.autoMonitor && assigned().length) setTimeout(openMonitor, 600);
    if (S.settings.role === 'station' && S.settings.autoStandby && !S.settings.autoStart && Store.devices().length) setTimeout(enterStandby, 600);
    if (S.settings.role === 'station' && S.settings.autoStart && Store.devices().length) setTimeout(() => startStation().then(ok => { if (!ok) toast('Tap START STATION to turn the camera on'); }), 600);
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(r => r.update().catch(() => { })).catch(e => console.warn('sw', e));
    // A new version took over: reload now if nothing is streaming, otherwise on the next return to the app.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!S.feeds.size && !S.station.active) location.reload();
      else { S.updatePending = true; toast('Sentinel update ready: it applies next time you open the app', 4000); }
    });
  }
  window.SentinelDebug.ready = true;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
