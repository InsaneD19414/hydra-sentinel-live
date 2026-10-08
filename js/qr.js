// QR draw (vendored qrcode-generator 2.0.4) and in-app camera QR scanner (BarcodeDetector, else vendored jsQR 1.4.0).
export function drawQr(canvas, text, ecc = 'L') {
  const q = window.qrcode(0, ecc);
  const alnum = /^[0-9A-Z $%*+\-./:]+$/.test(text);
  q.addData(text, alnum ? 'Alphanumeric' : 'Byte');
  q.make();
  const n = q.getModuleCount(), quiet = 4;
  const cell = Math.max(2, Math.floor(1200 / (n + quiet * 2)));
  const size = (n + quiet * 2) * cell;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, size, size);
  g.fillStyle = '#0A0A0A';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  return { modules: n, version: (n - 17) / 4, chars: text.length, mode: alnum ? 'Alphanumeric' : 'Byte' };
}

export function decodeCanvas(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

export class QrScanner {
  constructor(video, onResult) { this.video = video; this.onResult = onResult; this.running = false; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.video.srcObject = this.stream; this.video.setAttribute('playsinline', ''); this.video.muted = true;
    await this.video.play().catch(() => { });
    this.running = true;
    if ('BarcodeDetector' in window) {
      try { const f = await window.BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) this.detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { }
    }
    this.canvas = document.createElement('canvas');
    this.loop();
  }
  async loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        let text = null;
        if (this.detector) { const codes = await this.detector.detect(v); if (codes.length) text = codes[0].rawValue; }
        else {
          const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
          this.canvas.width = Math.round(v.videoWidth * scale); this.canvas.height = Math.round(v.videoHeight * scale);
          this.canvas.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
          text = decodeCanvas(this.canvas);
        }
        if (text) { this.stop(); this.onResult(text); return; }
      } catch { }
    }
    setTimeout(() => this.loop(), 120);
  }
  stop() { this.running = false; if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null; if (this.video) this.video.srcObject = null; }
}
