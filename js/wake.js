// Keep-screen-awake controller.
// 1) Screen Wake Lock API (iOS Safari 16.4+, Home Screen apps fixed in iOS 18.4; Chrome 84+).
// 2) Fallback for older iOS / when the lock is refused: a tiny muted looping inline video (needs one tap to start).
// The lock is dropped by the OS whenever the page is hidden, so it is re-acquired on visibilitychange.
export function iosVersion(ua = navigator.userAgent) {
  const m = /OS (\d+)[_.](\d+)/.exec(ua); if (!m || !/iPhone|iPad|iPod|Macintosh/.test(ua)) return null;
  return parseFloat(m[1] + '.' + m[2]);
}
export class Wake extends EventTarget {
  constructor() {
    super(); this.wanted = false; this.lock = null; this.video = null; this.state = 'off'; this.detail = '';
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.wanted) this.acquire(); });
    // A user gesture is needed to start the fallback video on old iOS: retry on the next tap.
    document.addEventListener('pointerdown', () => { if (this.wanted && this.state !== 'on' && this.state !== 'fallback') this.acquire(); }, true);
  }
  get supported() { return 'wakeLock' in navigator; }
  set(state, detail) { this.state = state; this.detail = detail || ''; this.dispatchEvent(new CustomEvent('change', { detail: { state, detail } })); }
  async enable() { this.wanted = true; return this.acquire(); }
  disable() {
    this.wanted = false;
    if (this.lock) { this.lock.release().catch(() => { }); this.lock = null; }
    this.stopVideo(); this.set('off', 'Screen may sleep normally');
  }
  needsBelt() { // iOS 16.4-18.3 Home Screen apps: API resolves but does not hold the screen
    const v = iosVersion(); const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    return v !== null && v < 18.4 && standalone;
  }
  async acquire() {
    if (!this.wanted || document.visibilityState !== 'visible') return this.state;
    let ok = false;
    if (this.supported) {
      try {
        if (!this.lock || this.lock.released) {
          this.lock = await navigator.wakeLock.request('screen');
          this.lock.addEventListener('release', () => { this.lock = null; if (this.wanted && document.visibilityState === 'visible') setTimeout(() => this.acquire(), 500); else if (this.wanted) this.set('paused', 'Paused while Sentinel is hidden. Resumes when you return'); });
        }
        ok = true;
      } catch (e) { this.lastError = e.name; }
    }
    if (ok && !this.needsBelt()) { this.stopVideo(); this.set('on', 'Screen Wake Lock on'); return this.state; }
    const vOk = await this.startVideo();
    if (vOk) this.set('fallback', ok ? 'Wake Lock + video keep-awake (older iOS)' : 'Video keep-awake (Wake Lock unavailable)');
    else if (ok) this.set('on', 'Screen Wake Lock on');
    else this.set('denied', 'Tap the screen once to keep it awake, or set Auto-Lock to Never');
    return this.state;
  }
  async startVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.loop = true; v.setAttribute('aria-hidden', 'true');
      v.src = 'img/keepawake.mp4';
      Object.assign(v.style, { position: 'fixed', width: '2px', height: '2px', left: '0', bottom: '0', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
      document.body.appendChild(v); this.video = v;
    }
    // play() can stay pending until the media loads; never let that block the caller
    try { return await Promise.race([this.video.play().then(() => true), new Promise(r => setTimeout(() => r(!this.video.paused), 2500))]); } catch { return false; }
  }
  stopVideo() { if (this.video) { try { this.video.pause(); } catch { } this.video.remove(); this.video = null; } }
}
