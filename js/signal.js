// PeerJS broker wrapper (signaling only: media and data go device-to-device over WebRTC).
export const DEFAULT_BROKER = { host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs' };

export class Broker extends EventTarget {
  constructor(settings, peerId, iceServers) {
    super();
    this.peerId = peerId; this.settings = settings; this.iceServers = iceServers;
    this.status = 'idle'; this.peer = null; this.pending = new Map();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setStatus(s, info) { this.status = s; this.emit('status', { status: s, info }); }
  start(timeoutMs = 15000) {
    if (!window.Peer) return Promise.reject(new Error('PeerJS not loaded'));
    const b = Object.assign({}, DEFAULT_BROKER, this.settings.broker || {});
    this.setStatus('connecting');
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.setStatus('error', 'timeout'); rej(new Error('Broker timeout')); }, timeoutMs);
      this.peer = new window.Peer(this.peerId, {
        host: b.host, port: Number(b.port) || 443, path: b.path || '/', secure: b.secure !== false && b.secure !== 'false', key: b.key || 'peerjs',
        config: { iceServers: this.iceServers }, debug: 1,
      });
      this.peer.on('open', () => { clearTimeout(t); this.setStatus('online'); res(this); });
      this.peer.on('connection', conn => this.emit('connection', conn));
      this.peer.on('disconnected', () => {
        this.setStatus('reconnecting');
        setTimeout(() => { if (this.peer && !this.peer.destroyed && this.peer.disconnected) try { this.peer.reconnect(); } catch { } }, 2000);
      });
      this.peer.on('error', err => {
        if (err && err.type === 'peer-unavailable') {
          const m = /peer (\S+)/.exec(err.message || ''); const id = m && m[1];
          for (const [pid, p] of this.pending) if (!id || pid === id) p.reject(new Error('Device unreachable'));
          return;
        }
        clearTimeout(t); this.setStatus('error', err && err.type);
        rej(err);
      });
    });
  }
  connect(peerId, timeoutMs = 9000) {
    return new Promise((res, rej) => {
      if (!this.peer || this.status !== 'online') return rej(new Error('Broker offline'));
      const conn = this.peer.connect(peerId, { reliable: true, serialization: 'json' });
      const done = (ok, v) => { clearTimeout(t); this.pending.delete(peerId); ok ? res(v) : (rej(v), conn.close()); };
      const t = setTimeout(() => done(false, new Error('Connect timeout')), timeoutMs);
      this.pending.set(peerId, { reject: e => done(false, e) });
      conn.on('open', () => done(true, conn));
      conn.on('error', e => done(false, e));
    });
  }
  destroy() { if (this.peer) try { this.peer.destroy(); } catch { } this.peer = null; this.setStatus('idle'); }
}

// Wait for one message of a given type on a PeerJS DataConnection.
export function waitFor(conn, types, timeoutMs = 10000) {
  types = [].concat(types);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { off(); rej(new Error('Timed out waiting for ' + types.join('/'))); }, timeoutMs);
    const onData = d => { if (d && types.includes(d.t)) { off(); res(d); } };
    const onClose = () => { off(); rej(new Error('Connection closed')); };
    function off() { clearTimeout(t); conn.off('data', onData); conn.off('close', onClose); }
    conn.on('data', onData); conn.on('close', onClose);
  });
}
