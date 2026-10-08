// Compact, QR-friendly payload codec.
// JSON -> UTF-8 -> deflate-raw (CompressionStream, Safari 16.4+/Chrome 80+) -> Base45.
// Base45 uses only the QR "alphanumeric" alphabet, so the QR can be encoded in
// alphanumeric mode (5.5 bits/char) instead of byte mode: ~23% denser than base64.
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function b45encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      let x = bytes[i] * 256 + bytes[i + 1];
      const e = Math.floor(x / 2025); x %= 2025; const d = Math.floor(x / 45); const c = x % 45;
      out += B45[c] + B45[d] + B45[e];
    } else {
      const x = bytes[i]; out += B45[x % 45] + B45[Math.floor(x / 45)];
    }
  }
  return out;
}
export function b45decode(str) {
  const v = Array.from(str, ch => { const i = B45.indexOf(ch); if (i < 0) throw new Error('bad base45'); return i; });
  const out = [];
  for (let i = 0; i < v.length; i += 3) {
    if (v.length - i >= 3) { const x = v[i] + v[i + 1] * 45 + v[i + 2] * 2025; if (x > 65535) throw new Error('bad base45'); out.push(x >> 8, x & 255); }
    else if (v.length - i === 2) { const x = v[i] + v[i + 1] * 45; if (x > 255) throw new Error('bad base45'); out.push(x); }
    else throw new Error('bad base45 length');
  }
  return new Uint8Array(out);
}
async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const hasCompression = typeof CompressionStream !== 'undefined';
export async function deflate(bytes) { return pipe(bytes, new CompressionStream('deflate-raw')); }
export async function inflate(bytes) { return pipe(bytes, new DecompressionStream('deflate-raw')); }

// SDP minifier: drops lines that are safe to drop for a one-shot, non-trickle exchange.
export function minifySdp(sdp) {
  const seen = new Set();
  return sdp.split(/\r?\n/).filter(l => {
    if (!l) return false;
    if (l.startsWith('a=candidate:')) {
      if (/ tcp /i.test(l)) return false;                // TCP host candidates rarely help phones
      const parts = l.split(' '); const key = parts[4] + ':' + parts[5] + ':' + l.split('typ ')[1];
      if (seen.has(key)) return false; seen.add(key);
      return true;
    }
    if (l.startsWith('a=end-of-candidates')) return true;
    if (l.startsWith('a=ssrc:') && !/ cname:/.test(l)) return false; // msid/label variants are redundant with a=msid
    return true;
  }).join('\r\n') + '\r\n';
}

// prefix: 'HAIL1P' (pair invite), 'HAIL1O' (offline offer), 'HAIL1A' (offline answer)
export async function encodePayload(prefix, obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (hasCompression) return prefix + 'Z:' + b45encode(await deflate(raw));
  return prefix + 'R:' + b45encode(raw);
}
export async function decodePayload(text) {
  const m = /^(HAIL1[POA])([ZR]):(.+)$/s.exec((text || '').trim());
  if (!m) throw new Error('Not a Sentinel code');
  let bytes = b45decode(m[3]);
  if (m[2] === 'Z') bytes = await inflate(bytes);
  return { kind: m[1], data: JSON.parse(new TextDecoder().decode(bytes)) };
}
