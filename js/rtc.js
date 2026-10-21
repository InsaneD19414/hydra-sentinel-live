// One WebRTC media session between a command center (viewer) and a camera station.
// The same class is used for both signaling modes; only the transport of offer/answer differs.
import { minifySdp } from './codec.js';

// Free public STUN only (no paid relays). TURN is optional and user-supplied in Settings.
export const DEFAULT_STUN = 'stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302, stun:stun2.l.google.com:19302, stun:stun3.l.google.com:19302';
export function iceServersFrom(settings) {
  const list = [];
  const stun = (settings.stun || DEFAULT_STUN).split(/[\s,]+/).filter(Boolean);
  if (stun.length) list.push({ urls: stun });
  if (settings.turnUrl) list.push({ urls: settings.turnUrl.split(/[\s,]+/).filter(Boolean), username: settings.turnUser || undefined, credential: settings.turnPass || undefined });
  return list;
}

function waitIce(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(done, timeoutMs);
    function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); res(); }
    function chk() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', chk);
  });
}

function preferCodecs(tx, kind) {
  try {
    if (!tx.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities(kind); if (!caps) return;
    let keep;
    if (kind === 'video') {
      // H.264 first (hardware on iPhone), VP8 as a safety net. Drop the rest to keep the SDP QR-sized.
      const h264 = caps.codecs.filter(c => /h264/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || '') && /42e01f|42001f/i.test(c.sdpFmtpLine || ''));
      const vp8 = caps.codecs.filter(c => /vp8/i.test(c.mimeType));
      const rtx = caps.codecs.filter(c => /rtx/i.test(c.mimeType)).slice(0, 2);
      keep = [...h264.slice(0, 1), ...vp8.slice(0, 1), ...rtx];
    } else {
      keep = caps.codecs.filter(c => /opus/i.test(c.mimeType)).slice(0, 1);
    }
    if (keep.length) tx.setCodecPreferences(keep);
  } catch (e) { /* not fatal */ }
}

export class MediaSession extends EventTarget {
  constructor(role, settings) {
    super();
    this.role = role; // 'viewer' | 'camera'
    this.sid = Math.random().toString(36).slice(2, 10);
    this.pc = new RTCPeerConnection({ iceServers: iceServersFrom(settings), bundlePolicy: 'max-bundle' });
    this.dc = this.pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    this.dc.onmessage = e => { try { this.emit('message', JSON.parse(e.data)); } catch { } };
    this.dc.onopen = () => this.emit('channel-open');
    this.pc.onconnectionstatechange = () => this.emit('state', this.pc.connectionState);
    this.pc.oniceconnectionstatechange = () => this.emit('ice', this.pc.iceConnectionState);
    this.closed = false;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  send(obj) { if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(obj)); }
  get state() { return this.pc.connectionState; }

  // ---- viewer (command center) ----
  async createOffer() {
    this.videoTx = this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.audioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' }); // talk-back out (muted: no track), station audio in
    preferCodecs(this.videoTx, 'video'); preferCodecs(this.audioTx, 'audio');
    this.remoteStream = new MediaStream([this.videoTx.receiver.track, this.audioTx.receiver.track]);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitIce(this.pc, 4000);
    return minifySdp(this.pc.localDescription.sdp);
  }
  async acceptAnswer(sdp) { await this.pc.setRemoteDescription({ type: 'answer', sdp }); }
  // ICE restart (viewer): new ICE credentials over the same session, so the stream resumes without a new call.
  async createRestartOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
    await waitIce(this.pc, 4000);
    return minifySdp(this.pc.localDescription.sdp);
  }
  // Camera side of an ICE restart / renegotiation on an existing session.
  async reanswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitIce(this.pc, 4000);
    return minifySdp(this.pc.localDescription.sdp);
  }
  // Network round trip (ms) from the selected ICE candidate pair, plus decoded video frame count.
  async stats() {
    const out = { rtt: null, framesDecoded: null, fps: null, relay: false };
    try {
      const r = await this.pc.getStats(); let pairId = null;
      r.forEach(x => { if (x.type === 'transport' && x.selectedCandidatePairId) pairId = x.selectedCandidatePairId; });
      r.forEach(x => {
        if (x.type === 'candidate-pair' && (x.id === pairId || (!pairId && x.nominated && x.state === 'succeeded')) && x.currentRoundTripTime != null) {
          out.rtt = Math.round(x.currentRoundTripTime * 1000);
          const lc = r.get(x.localCandidateId); if (lc && lc.candidateType === 'relay') out.relay = true;
        }
        if (x.type === 'inbound-rtp' && x.kind === 'video') { out.framesDecoded = x.framesDecoded; out.fps = x.framesPerSecond ?? null; }
      });
    } catch { }
    return out;
  }

  async talk(on) {
    if (!this.audioTx) return;
    if (on) {
      if (!this.mic || this.mic.readyState !== 'live') {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        this.mic = s.getAudioTracks()[0];
      }
      this.mic.enabled = true;
      await this.audioTx.sender.replaceTrack(this.mic);
      clearTimeout(this.micIdle);
    } else if (this.mic) {
      this.mic.enabled = false; // muted: silence, then release the mic entirely after 20 s idle
      clearTimeout(this.micIdle);
      this.micIdle = setTimeout(() => this.releaseMic(), 20000);
    }
    this.send({ t: 'talk', on: !!on });
  }
  releaseMic() { if (this.mic) { this.mic.stop(); this.mic = null; } if (this.audioTx && !this.closed) this.audioTx.sender.replaceTrack(null).catch(() => { }); }

  // ---- camera station ----
  // localStream is owned by the station (one shared camera capture for every viewer: iOS allows only one).
  async answerOffer(sdp, localStream) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    const txs = this.pc.getTransceivers();
    this.videoTx = txs.find(t => t.receiver.track.kind === 'video');
    this.audioTx = txs.find(t => t.receiver.track.kind === 'audio');
    const v = localStream.getVideoTracks()[0], a = localStream.getAudioTracks()[0];
    if (this.videoTx) { await this.videoTx.sender.replaceTrack(v || null); this.videoTx.direction = 'sendonly'; }
    if (this.audioTx) { await this.audioTx.sender.replaceTrack(a || null); this.audioTx.direction = 'sendrecv'; }
    this.talkStream = this.audioTx ? new MediaStream([this.audioTx.receiver.track]) : null;
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitIce(this.pc, 4000);
    return minifySdp(this.pc.localDescription.sdp);
  }
  async setVideoTrack(track) { if (this.videoTx && !this.closed) await this.videoTx.sender.replaceTrack(track); }
  // Cap the outgoing video bitrate (quality preset). Best effort: not every browser exposes encodings.
  async setMaxBitrate(bps) {
    try { const snd = this.videoTx && this.videoTx.sender; if (!snd || !snd.getParameters) return false; const p = snd.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}]; p.encodings[0].maxBitrate = bps; await snd.setParameters(p); return true; } catch { return false; }
  }

  close() {
    if (this.closed) return; this.closed = true;
    try { this.send({ t: 'bye' }); } catch { }
    if (this.mic) this.mic.stop();
    clearTimeout(this.micIdle);
    try { this.dc.close(); } catch { }
    try { this.pc.close(); } catch { }
    this.emit('state', 'closed');
  }
}

export const RES = { sd: [640, 480], hd: [1280, 720], fhd: [1920, 1080] };
export const QUALITY_BPS = { low: 500000, medium: 1500000, high: 3000000 };
export function videoConstraints(res = 'hd', fps = 24) {
  const [w, h] = RES[res] || RES.hd; const f = Number(fps) || 24;
  return { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: f, max: Math.max(f, 30) } };
}
export function cameraConstraints(facing, withAudio, res = 'hd', fps = 24) {
  return {
    video: { facingMode: { ideal: facing }, ...videoConstraints(res, fps) },
    audio: withAudio ? { echoCancellation: true, noiseSuppression: true } : false,
  };
}
