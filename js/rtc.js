// One WebRTC media session between a command center (viewer) and a camera station.
// The same class is used for both signaling modes; only the transport of offer/answer differs.
import { minifySdp } from './codec.js';

export function iceServersFrom(settings) {
  const list = [];
  const stun = (settings.stun || '').split(/[\s,]+/).filter(Boolean);
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

export function cameraConstraints(facing, withAudio) {
  return {
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    audio: withAudio ? { echoCancellation: true, noiseSuppression: true } : false,
  };
}
