// Pure helpers (no DOM): reconnect backoff, pairing codes, feed state. Unit-tested in tests/unit_backoff.mjs.
export const BACKOFF = { base: 1000, factor: 2, cap: 30000, jitter: 0.2 };

// Delay before reconnect attempt n (0-based). Exponential, capped, +/- jitter. Never gives up.
export function nextDelay(attempt, opts = BACKOFF, rnd = Math.random) {
  const a = Math.max(0, attempt | 0);
  const raw = Math.min(opts.cap, opts.base * Math.pow(opts.factor, a));
  const j = raw * opts.jitter * (rnd() * 2 - 1);
  return Math.max(250, Math.round(Math.min(opts.cap * (1 + opts.jitter), raw + j)));
}

// Human pairing code: 6 chars, no look-alikes (0/O, 1/I/L). ~30 bits; valid 5 min, single use.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeCode(rand = n => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(6); let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  // after mapping, 0 and 1 are not in the alphabet, so a typo is rejected instead of silently matched
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/.test(s) ? s : null;
}
export const formatCode = c => c ? c.slice(0, 3) + '-' + c.slice(3) : '';
export const codePeerId = c => 'hailpair-' + c.toLowerCase();

// Maps raw signals to one of: live | connecting | stale | offline.
export function feedState({ pcState, frames, frameAgeMs, attempt, staleMs = 3000, offlineAfter = 6 }) {
  if (pcState === 'connected' && frames > 0 && frameAgeMs < staleMs) return 'live';
  if (pcState === 'connected' && frames > 0) return 'stale';
  if (attempt >= offlineAfter) return 'offline';
  return 'connecting';
}
