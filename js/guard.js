// Guard mode: a black (or dim) touch-blocking overlay for monitoring. Streams and wake lock keep running underneath.
// Unlock = press and hold 2 s, or a PIN if one is set (stored only as a salted SHA-256 hash on this device).
const HOLD_MS = 2000, MAX_TRIES = 5, LOCKOUT_MS = 30000;
async function sha(text) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join(''); }
export async function hashPin(pin, salt) { return sha(salt + ':' + pin); }

export class Guard extends EventTarget {
  constructor(el, getSettings, statusFn) {
    super(); this.el = el; this.getSettings = getSettings; this.statusFn = statusFn; this.on = false; this.tries = 0; this.lockUntil = 0; this.entry = '';
    this.el.innerHTML = `<div class="g-clock num" id="gClock"></div><div class="g-status" id="gStatus"></div>
      <div class="g-hold" id="gHold"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="g-track"/><circle cx="50" cy="50" r="44" class="g-prog" id="gProg"/></svg><span id="gHoldTxt">HOLD TO UNLOCK</span></div>
      <div class="g-pin" id="gPin" hidden><div class="g-dots num" id="gDots"></div><div class="g-pad">${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k => `<button class="g-key" data-k="${k}" ${k === '' ? 'disabled' : ''}>${k}</button>`).join('')}</div><div class="g-msg small" id="gMsg"></div></div>`;
    const block = e => { if (!this.on) return; if (!e.target.closest('.g-key,#gHold')) { e.preventDefault(); this.poke(); } };
    ['touchstart', 'touchmove', 'gesturestart', 'contextmenu', 'dblclick'].forEach(t => this.el.addEventListener(t, block, { passive: false }));
    this.el.addEventListener('click', e => { if (e.target === this.el || e.target.closest('.g-clock,.g-status')) this.poke(); });
    const hold = this.el.querySelector('#gHold');
    const start = e => { e.preventDefault(); if (this.hasPin()) return this.showPin(); this.holdStart = performance.now(); this.animHold(); };
    const end = () => { this.holdStart = 0; this.el.querySelector('#gProg').style.strokeDashoffset = 276.5; };
    hold.addEventListener('pointerdown', start); ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => hold.addEventListener(t, end));
    this.el.querySelectorAll('.g-key').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); this.key(b.dataset.k); }));
  }
  hasPin() { const s = this.getSettings(); return !!(s.guardPinHash && s.guardPinSalt); }
  engage() {
    this.on = true; this.entry = ''; this.el.classList.toggle('dimmed', this.getSettings().guardStyle === 'dim');
    this.el.classList.add('show'); this.el.querySelector('#gPin').hidden = true; this.el.querySelector('#gHold').hidden = false;
    this.el.querySelector('#gHoldTxt').textContent = this.hasPin() ? 'TAP TO ENTER PIN' : 'HOLD TO UNLOCK';
    this.tick(); clearInterval(this.t); this.t = setInterval(() => this.tick(), 1000);
    this.dispatchEvent(new Event('engage'));
  }
  release() { this.on = false; clearInterval(this.t); this.el.classList.remove('show', 'awake'); this.dispatchEvent(new Event('release')); }
  poke() { this.el.classList.add('awake'); clearTimeout(this.pokeT); this.pokeT = setTimeout(() => this.el.classList.remove('awake'), 4000); }
  tick() {
    this.el.querySelector('#gClock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.el.querySelector('#gStatus').innerHTML = this.statusFn ? this.statusFn() : '';
  }
  animHold() {
    if (!this.holdStart) return;
    const p = Math.min(1, (performance.now() - this.holdStart) / HOLD_MS);
    this.el.querySelector('#gProg').style.strokeDashoffset = 276.5 * (1 - p);
    if (p >= 1) { this.holdStart = 0; this.release(); return; }
    requestAnimationFrame(() => this.animHold());
  }
  showPin() { this.poke(); this.el.querySelector('#gHold').hidden = true; this.el.querySelector('#gPin').hidden = false; this.entry = ''; this.dots(); }
  dots() { this.el.querySelector('#gDots').textContent = '●'.repeat(this.entry.length) || 'ENTER PIN'; }
  async key(k) {
    this.poke(); const msg = this.el.querySelector('#gMsg');
    if (Date.now() < this.lockUntil) { msg.textContent = `Too many tries. Wait ${Math.ceil((this.lockUntil - Date.now()) / 1000)} s`; return; }
    if (k === '⌫') this.entry = this.entry.slice(0, -1); else if (/^\d$/.test(k) && this.entry.length < 8) this.entry += k;
    this.dots();
    const s = this.getSettings(); const len = s.guardPinLen || 4;
    if (this.entry.length < len) return;
    const ok = (await hashPin(this.entry, s.guardPinSalt)) === s.guardPinHash;
    this.entry = ''; this.dots();
    if (ok) { this.tries = 0; msg.textContent = ''; this.release(); }
    else { this.tries++; msg.textContent = 'Wrong PIN'; if (this.tries >= MAX_TRIES) { this.tries = 0; this.lockUntil = Date.now() + LOCKOUT_MS; msg.textContent = 'Too many tries. Wait 30 s'; } }
  }
}
