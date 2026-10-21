// Monitor alerts: offline and (optional) motion, with sound (Web Audio) and vibration where supported.
// iOS Safari has no Vibration API, so iPhone gets sound + on-screen banner only.
let ctx = null;
export function unlockAudio() {
  try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { }
}
export function beep(kind = 'offline') {
  try {
    unlockAudio(); if (!ctx) return false;
    const seq = kind === 'motion' ? [880, 0, 880] : [660, 440];
    let t = ctx.currentTime;
    for (const f of seq) {
      if (f) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18); o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.2); }
      t += 0.22;
    }
    return true;
  } catch { return false; }
}
export function buzz(pattern = [200, 100, 200]) { try { return !!(navigator.vibrate && navigator.vibrate(pattern)); } catch { return false; } }

// Motion: compare 32x18 grayscale thumbnails once a second. Returns fraction of pixels that changed.
export class MotionProbe {
  constructor() { this.c = document.createElement('canvas'); this.c.width = 32; this.c.height = 18; this.g = this.c.getContext('2d', { willReadFrequently: true }); this.prev = null; }
  sample(video) {
    if (!video || !video.videoWidth || video.readyState < 2) return 0;
    try {
      this.g.drawImage(video, 0, 0, 32, 18);
      const d = this.g.getImageData(0, 0, 32, 18).data; const cur = new Uint8Array(576);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) cur[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
      let changed = 0; if (this.prev) for (let j = 0; j < 576; j++) if (Math.abs(cur[j] - this.prev[j]) > 28) changed++;
      const first = !this.prev; this.prev = cur; return first ? 0 : changed / 576;
    } catch { return 0; }
  }
  reset() { this.prev = null; }
}
