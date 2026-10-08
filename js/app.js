// H.A.I.L. Sentinel - app controller (command center + camera station).
import { Store, Vault, randomId } from './store.js';
import { encodePayload, decodePayload } from './codec.js';
import { MediaSession, iceServersFrom, cameraConstraints } from './rtc.js';
import { Broker, waitFor, DEFAULT_BROKER } from './signal.js';
import { drawQr, decodeCanvas, QrScanner } from './qr.js';

export const VERSION = '1.0.0';
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
  b.addEventListener('status', e => { setBrokerChips(e.detail.status); if (e.detail.status === 'online' && S.settings.role === 'command') pollAll(); });
  b.addEventListener('connection', e => S.settings.role === 'command' ? ccIncoming(e.detail) : stIncoming(e.detail));
  S.broker = b;
  try { await b.start(); } catch (e) { console.warn('broker', e); }
  return b;
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
  const info = drawQr($('#pairQr'), payload, 'M');
  $('#pairQr').dataset.payload = payload; $('#pairQr').dataset.version = info.version;
  $('#pairStatus').textContent = S.broker && S.broker.status === 'online' ? 'Single-use code. Waiting for the station to approve…' : 'Broker is offline. Pairing needs the broker, or use offline pairing.';
  countdown($('#pairCountdown'), exp, () => { $('#pairStatus').textContent = 'Code expired. Tap New code.'; $('#pairQr').style.opacity = .15; });
  $('#pairQr').style.opacity = 1;
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
      clearInterval(S.pairTimer);
      toast(`${msg.n || 'Station'} paired`);
      const st = Store.stations().find(s => s.deviceId === msg.id);
      if (st) setHealth(st.id, 'live');
      if ($('#pair').classList.contains('active')) { S.history = ['home']; show('stations', false); }
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
  if (S.live && S.live.stationId === st.id) return true;
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

// ----- live view -----
async function startLive(stationId, offlineSession = null) {
  stopLive(true);
  const st = Store.stations().find(s => s.id === stationId);
  if (!st) return;
  Store.upsertStation({ id: st.id, lastSelected: Date.now() });
  S.live = { stationId, attempt: 0, session: null, conn: null, lastFrame: 0, frames: 0, recorder: null, listen: false, offline: !!offlineSession };
  $('#liveTitle').textContent = st.name;
  $('#liveVideo').srcObject = null;
  setBadge('wait', 'CONNECTING'); $('#liveMsg').textContent = 'CONNECTING…'; $('#liveMsg').hidden = false;
  $('#staleOverlay').classList.remove('show');
  const dev = Store.devices().find(d => d.id === st.deviceId);
  if (!offlineSession && (S.settings.signaling === 'offline' || (dev && dev.mode === 'offline'))) { S.live = null; return openOffline(stationId); }
  renderStrip();
  show('live');
  startFrameMonitor();
  if (offlineSession) return attachSession(offlineSession);
  connectLive();
}
async function connectLive() {
  const L = S.live; if (!L) return;
  const st = Store.stations().find(s => s.id === L.stationId);
  const dev = st && Store.devices().find(d => d.id === st.deviceId);
  if (!dev) { $('#liveMsg').textContent = 'No device assigned to this station.'; return; }
  if (dev.mode === 'offline') { const id = L.stationId; S.live = null; stopFrameMonitor(); return openOffline(id); }
  try {
    if (!S.broker || S.broker.status !== 'online') await startBroker();
    if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline');
    const conn = await S.broker.connect(dev.id, 9000);
    if (S.live !== L) { conn.close(); return; }
    L.conn = conn;
    conn.send({ t: 'hello', cc: S.id, secret: dev.secret, n: deviceName() });
    const h = await waitFor(conn, ['hello-ok', 'denied', 'not-active'], 8000);
    if (h.t === 'denied') { $('#liveMsg').textContent = 'Station refused this command center. Pair again.'; setHealth(L.stationId, 'offline'); return; }
    if (h.t === 'not-active') { $('#liveMsg').textContent = 'Station app is open but not started. Tap START STATION on it.'; setHealth(L.stationId, 'stale'); throw new Error('not active'); }
    const session = new MediaSession('viewer', S.settings);
    const sdp = await session.createOffer();
    conn.send({ t: 'offer', sid: session.sid, sdp });
    const ans = await waitFor(conn, 'answer', 15000);
    if (ans.sid !== session.sid) throw new Error('stale answer');
    await session.acceptAnswer(ans.sdp);
    conn.on('close', () => { if (S.live === L && L.session === session && session.state !== 'connected') scheduleReconnect('signal closed'); });
    attachSession(session);
  } catch (e) {
    console.warn('connectLive', e);
    if (S.live === L) scheduleReconnect(e.message);
  }
}
function attachSession(session) {
  const L = S.live; if (!L) return session.close();
  L.session = session;
  const v = $('#liveVideo');
  v.srcObject = session.remoteStream; v.muted = !L.listen;
  v.play().catch(() => { });
  session.addEventListener('message', e => {
    const m = e.detail;
    if (m.t === 'camera') toast('Station camera: ' + (m.facing === 'user' ? 'front' : 'back'));
    if (m.t === 'bye') scheduleReconnect('station ended session');
  });
  let discT;
  session.addEventListener('state', e => {
    const s = e.detail;
    if (S.live !== L || L.session !== session) return;
    if (s === 'connected') { L.attempt = 0; clearTimeout(discT); $('#liveMsg').hidden = true; setHealth(L.stationId, 'live', { retry: 0 }); }
    else if (s === 'failed' || s === 'closed') scheduleReconnect('connection ' + s);
    else if (s === 'disconnected') { clearTimeout(discT); discT = setTimeout(() => { if (session.state === 'disconnected') scheduleReconnect('disconnected'); }, 4000); }
  });
  window.SentinelDebug.session = session;
}
function scheduleReconnect(reason) {
  const L = S.live; if (!L || L.closing) return;
  if (L.recorder) stopRecording();
  if (L.session) { const s = L.session; L.session = null; s.close(); }
  if (L.conn) { try { L.conn.close(); } catch { } L.conn = null; }
  clearTimeout(L.retryT);
  if (L.offline) {
    setHealth(L.stationId, 'offline'); setBadge('wait', 'ENDED');
    $('#liveMsg').hidden = false; $('#liveMsg').innerHTML = 'Session ended. Offline mode needs a new QR exchange.<br><br><button class="btn gold" id="liveRedo">New QR exchange</button>';
    $('#liveRedo').onclick = () => { const id = L.stationId; stopLive(); openOffline(id); };
    return;
  }
  if (L.attempt >= RETRY_DELAYS.length) {
    setHealth(L.stationId, 'offline'); setBadge('wait', 'OFFLINE');
    $('#liveMsg').hidden = false; $('#liveMsg').innerHTML = 'Station offline.<br><br><button class="btn gold" id="liveRetry">Retry</button> <button class="btn" id="liveLast">View last status</button>';
    $('#liveRetry').onclick = () => { L.attempt = 0; connectLive(); };
    $('#liveLast').onclick = () => { stopLive(); openStatus(); };
    return;
  }
  const d = RETRY_DELAYS[L.attempt++];
  setHealth(L.stationId, 'reconnecting', { retry: L.attempt });
  setBadge('wait', 'RECONNECTING');
  $('#liveMsg').hidden = false; $('#liveMsg').textContent = `RECONNECTING · attempt ${L.attempt}/${RETRY_DELAYS.length} in ${d}s`;
  L.retryT = setTimeout(() => { if (S.live === L) connectLive(); }, d * 1000);
  L.lastReason = reason;
}
function stopLive(silent) {
  const L = S.live; if (!L) return;
  L.closing = true;
  if (L.recorder) stopRecording();
  clearTimeout(L.retryT);
  if (L.session) L.session.close();
  if (L.conn) try { L.conn.close(); } catch { }
  stopFrameMonitor();
  $('#liveVideo').srcObject = null;
  S.live = null;
  if (!silent) { show(S.settings.role === 'station' ? 'stationHome' : 'home', false); S.history = []; render(); setTimeout(pollAll, 1500); }
}
function setBadge(cls, text) { const b = $('#liveBadge'); b.className = 'badge ' + cls; b.textContent = text; }

// STALE detection: requestVideoFrameCallback (Safari 15.4+, Chrome 83+), with getStats framesDecoded and
// currentTime polling as fallbacks. A frozen frame is never labelled LIVE.
let monT, rvfcOn = false;
function startFrameMonitor() {
  const v = $('#liveVideo'); stopFrameMonitor();
  let lastCT = 0, lastDecoded = -1;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    rvfcOn = true;
    const cb = (now, meta) => { if (!rvfcOn) return; if (S.live) { S.live.lastFrame = performance.now(); S.live.frames++; } v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
  let snapAt = 0;
  monT = setInterval(async () => {
    const L = S.live; if (!L) return;
    if (!rvfcOn && v.currentTime !== lastCT && v.videoWidth) { lastCT = v.currentTime; L.lastFrame = performance.now(); L.frames++; }
    if (L.session && L.session.videoTx) {
      try {
        const st = await L.session.videoTx.receiver.getStats();
        st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') { if (lastDecoded >= 0 && r.framesDecoded > lastDecoded && !rvfcOn) L.lastFrame = performance.now(); lastDecoded = r.framesDecoded; L.framesDecoded = r.framesDecoded; } });
      } catch { }
    }
    const age = L.lastFrame ? performance.now() - L.lastFrame : Infinity;
    const stale = L.frames > 0 && age >= STALE_MS;
    $('#staleOverlay').classList.toggle('show', stale);
    if (stale) {
      $('#staleInfo').textContent = `No new frames for ${Math.floor(age / 1000)}s`;
      setBadge('stale', 'STALE'); if (health(L.stationId).state === 'live') setHealth(L.stationId, 'stale');
    } else if (L.frames > 0 && L.session && L.session.state === 'connected') {
      setBadge('live', 'LIVE'); $('#liveMsg').hidden = true; if (health(L.stationId).state !== 'live') setHealth(L.stationId, 'live');
      if (Date.now() - snapAt > 10000) { snapAt = Date.now(); snapshot(L.stationId); }
    }
    if (L.recorder) $('#recTime').textContent = fmtDur(Date.now() - L.recStart);
  }, 500);
}
function stopFrameMonitor() { rvfcOn = false; clearInterval(monT); }
function snapshot(stationId) {
  const v = $('#liveVideo'); if (!v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = 240; c.height = Math.round(240 * v.videoHeight / v.videoWidth);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  try { Store.upsertStation({ id: stationId, lastSnapshot: c.toDataURL('image/jpeg', 0.6), lastSeen: Date.now() }); } catch { }
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
function stopRecording() {
  const L = S.live; if (!L || !L.recorder) return;
  try { L.recorder.stop(); } catch { }
  L.recorder = null; $('#btnRecord').classList.remove('rec-on'); $('#recBadge').hidden = true;
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
  C.cam = await navigator.mediaDevices.getUserMedia(cameraConstraints(S.settings.facing || 'environment', true));
  C.cam.getVideoTracks()[0].addEventListener('ended', () => renderStationStatus());
  $('#stationPreview').srcObject = C.cam;
  for (const s of C.sessions) { await s.setVideoTrack(C.cam.getVideoTracks()[0]); }
  return C.cam;
}
async function requestWake() {
  const C = S.station;
  if (!('wakeLock' in navigator)) { C.wakeNote = 'Wake Lock not supported: set Auto-Lock to Never'; return renderStationStatus(); }
  try { C.wake = await navigator.wakeLock.request('screen'); C.wakeNote = 'Screen Wake Lock on'; C.wake.addEventListener('release', () => { C.wakeNote = 'Wake Lock released'; renderStationStatus(); }); }
  catch (e) { C.wakeNote = 'Wake Lock refused (' + e.name + '): set Auto-Lock to Never'; }
  renderStationStatus();
}
async function startStation() {
  try { await ensureCamera(); }
  catch (e) { toast('Camera blocked: allow Camera and Microphone for Sentinel in Settings'); return false; }
  S.station.active = true;
  try { const a = $('#talkAudio'); a.muted = true; await a.play().catch(() => { }); a.muted = false; } catch { } // unlock audio output with this tap
  await requestWake();
  show('stationActive');
  renderStationStatus();
  if (S.settings.signaling === 'peerjs' && (!S.broker || S.broker.status !== 'online')) startBroker();
  return true;
}
function stopStation() {
  const C = S.station; C.active = false;
  for (const s of C.sessions) s.close(); C.sessions.clear();
  if (C.cam) C.cam.getTracks().forEach(t => t.stop()); C.cam = null;
  if (C.wake) C.wake.release().catch(() => { }); C.wake = null;
  $('#dim').classList.remove('show');
  show('stationHome', false); S.history = []; render();
}
async function stationSwitchCamera() {
  const C = S.station;
  const facing = (S.settings.facing === 'user') ? 'environment' : 'user';
  const old = C.cam && C.cam.getVideoTracks()[0];
  if (old) { old.stop(); C.cam.removeTrack(old); }
  const s = await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, false));
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
    if (m.t === 'bye') session.close();
  });
  session.addEventListener('state', e => {
    if (['closed', 'failed'].includes(e.detail)) { C.sessions.delete(session); if (!C.sessions.size) $('#talkIndicator').hidden = true; }
    renderStationStatus();
  });
  window.SentinelDebug.stationSession = session;
  renderStationStatus();
}
function pairedCC(ccId, secret) { return Store.devices().find(d => d.id === ccId && (!d.secret || d.secret === secret)); }
function stIncoming(conn) {
  let authed = null;
  conn.on('data', async msg => {
    if (!msg || !msg.t) return;
    if (msg.t === 'ping') {
      const cc = pairedCC(msg.cc, msg.secret);
      conn.send(cc ? { t: 'pong', cam: S.station.active && !!S.station.cam, n: deviceName(), facing: S.settings.facing } : { t: 'denied' });
    } else if (msg.t === 'hello') {
      const cc = pairedCC(msg.cc, msg.secret);
      if (!cc) return conn.send({ t: 'denied' });
      if (!S.station.active) return conn.send({ t: 'not-active' });
      authed = cc; conn.send({ t: 'hello-ok' });
    } else if (msg.t === 'offer' && authed) {
      try {
        const cam = await ensureCamera();
        const session = new MediaSession('camera', S.settings);
        const sdp = await session.answerOffer(msg.sdp, cam);
        wireStationSession(session, authed.n);
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
      if (!S.broker || S.broker.status !== 'online') await startBroker();
      if (!S.broker || S.broker.status !== 'online') throw new Error('Broker offline. Try offline pairing.');
      const conn = await S.broker.connect(data.cc, 10000);
      conn.send({ t: 'pair-req', tok: data.tok, id: S.id, n: deviceName(), secret });
      const r = await waitFor(conn, ['pair-ok', 'pair-fail'], 10000);
      conn.close();
      if (r.t === 'pair-fail') { toast('Pairing refused: ' + r.reason); window.SentinelDebug.lastPair = r; return showStationHome(); }
      Store.upsertDevice({ id: data.cc, n: r.n || data.n, secret, mode: 'peerjs', pairedAt: Date.now() });
      window.SentinelDebug.lastPair = r;
      toast('Paired with ' + (r.n || data.n));
      showStationHome();
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
  try { p = await decodePayload(text); } catch { toast('That is not a Sentinel code'); return back(); }
  const role = S.settings.role;
  if (role === 'station' && (p.kind === 'HAIL1P' || p.kind === 'HAIL1O')) return stHandleInvite(p.kind, p.data);
  if (role === 'command' && p.kind === 'HAIL1A') { S.history = ['home']; return ccHandleAnswer(p.data); }
  toast(role === 'command' ? 'Scan this code with the camera station instead' : 'Scan this code with the command center instead');
  back();
}

// ---------- rendering ----------
function chip(state) { return `<span class="chip ${state}">${{ live: 'Live', reconnecting: 'Reconnecting', stale: 'Stale', offline: 'Offline' }[state]}</span>`; }
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
    if ($('#stations').classList.contains('active')) renderStations();
    if ($('#live').classList.contains('active')) renderStrip();
  } else if (role === 'station') {
    const cc = Store.devices();
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
  $('#aboutBox').innerHTML = `H.A.I.L. Sentinel v${VERSION} · ${isStandalone() ? 'Running as Home Screen app' : 'Running in a browser tab'}<br>Device ID: <span class="num">${esc(S.id)}</span><br>PeerJS 1.5.5 · jsQR 1.4.0 · qrcode-generator 2.0.4 (vendored)<br>Wake Lock: ${'wakeLock' in navigator ? 'available' : 'not available'} · Recording: ${esc(pickMime() || 'n/a')}`;
}
function renderStationStatus() {
  const C = S.station; const v = C.cam && C.cam.getVideoTracks()[0];
  const viewers = Array.from(C.sessions).filter(s => s.state === 'connected').length;
  $('#stationLine').textContent = viewers ? `Streaming to ${viewers} command center${viewers > 1 ? 's' : ''}` : 'Waiting for command center';
  $('#stationStatus').innerHTML = `Camera: <b>${v && v.readyState === 'live' ? (S.settings.facing === 'user' ? 'front' : 'back') + ' · on' : 'stopped'}</b><br>Screen: <b>${esc(C.wakeNote || '…')}</b><br>Signaling: <b>${S.settings.signaling === 'offline' ? 'offline QR' : 'PeerJS broker'}</b><br>Device: <span class="num">${esc(deviceName())}</span>`;
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
  $('#saveSettings').onclick = () => {
    const role = $('#segRole button.on')?.dataset.v || S.settings.role;
    S.settings = Store.patchSettings({
      deviceName: $('#setName').value.trim(), signaling: $('#segSig button.on')?.dataset.v || 'peerjs',
      broker: { host: $('#bHost').value.trim() || DEFAULT_BROKER.host, port: Number($('#bPort').value) || 443, path: $('#bPath').value.trim() || '/', key: $('#bKey').value.trim() || 'peerjs', secure: $('#bSecure').value === 'true' },
      stun: $('#sStun').value.trim(), turnUrl: $('#sTurn').value.trim(), turnUser: $('#sTurnU').value.trim(), turnPass: $('#sTurnP').value,
    });
    toast('Saved'); applyRole(role);
  };
  $('#resetAll').onclick = async () => { if (confirm('Erase all pairings, stations and settings on this device? Recordings stay in the vault.')) { Store.clearAll(); location.href = location.pathname; } };
  $('#startStation').onclick = startStation;
  $('#stationScan').onclick = () => openScanner('Scan the pairing code on the command center.');
  $('#approveYes').onclick = stApprove; $('#approveNo').onclick = stDeny;
  $('#stopStation').onclick = stopStation;
  $('#dimBtn').onclick = () => $('#dim').classList.add('show');
  $('#dim').onclick = () => $('#dim').classList.remove('show');
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || S.settings.role !== 'station' || !S.station.active) return;
    try { await ensureCamera(); } catch { } // iOS kills the camera in the background: restart it on return
    requestWake();
  });
}
function handleDeepLink() {
  const q = new URLSearchParams(location.search);
  const role = q.get('role'), action = q.get('action');
  if (role === 'station' || role === 'command') { if (S.settings.role !== role) applyRole(role); }
  if (!S.settings.role) { show('role', false); return; }
  if (action === 'live') { if (S.settings.role === 'command') setTimeout(onLiveButton, S.settings.signaling === 'peerjs' ? 1800 : 0); else toast('Tap START STATION to turn the camera on'); }
  if (action === 'pair') { if (S.settings.role === 'command') openPair(); else openScanner('Scan the pairing code on the command center.'); }
  if (role || action) history.replaceState(null, '', location.pathname);
}

window.SentinelDebug = {
  S, Store, Vault, handleScan, pickStation, liveButtonState, openPair, openOffline, startLive, stopLive, pickMime,
  stopCameraTrack() { const t = S.station.cam && S.station.cam.getVideoTracks()[0]; if (t) t.stop(); return !!t; },
  decodeQrCanvas(sel) { return decodeCanvas(document.querySelector(sel)); },
};

async function boot() {
  wire();
  if (S.settings.role === 'command') show('home', false);
  else if (S.settings.role === 'station') show('stationHome', false);
  else show('role', false);
  handleDeepLink();
  if (S.settings.role && !S.broker) startBroker();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  window.SentinelDebug.ready = true;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
