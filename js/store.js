// Local persistence: settings, paired devices, stations (localStorage) + recordings vault (IndexedDB).
const K = 'hail.sentinel.';
const DEFAULT_SETTINGS = {
  role: null,                // 'command' | 'station'
  deviceName: '',
  signaling: 'peerjs',       // 'peerjs' | 'offline'
  broker: { host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs' },
  stun: 'stun:stun.l.google.com:19302',
  turnUrl: '', turnUser: '', turnPass: '',   // entered by the user on-device only; never shipped in code
  facing: 'environment',
};
function read(name, dflt) {
  try { const v = localStorage.getItem(K + name); return v ? JSON.parse(v) : structuredClone(dflt); }
  catch { return structuredClone(dflt); }
}
function write(name, v) { localStorage.setItem(K + name, JSON.stringify(v)); }

export function randomId(bytes = 8) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export const Store = {
  settings() { return Object.assign(structuredClone(DEFAULT_SETTINGS), read('settings', {})); },
  saveSettings(s) { write('settings', s); },
  patchSettings(p) { const s = this.settings(); Object.assign(s, p); this.saveSettings(s); return s; },
  identity() {
    let id = read('identity', null);
    if (!id) { id = { peerId: 'hail-' + randomId(10), createdAt: Date.now() }; write('identity', id); }
    return id;
  },
  // Command center: paired camera devices. Station: paired command centers.
  devices() { return read('devices', []); },
  saveDevices(d) { write('devices', d); },
  upsertDevice(dev) {
    const d = this.devices(); const i = d.findIndex(x => x.id === dev.id);
    if (i >= 0) d[i] = Object.assign(d[i], dev); else d.push(dev);
    this.saveDevices(d); return dev;
  },
  removeDevice(id) { this.saveDevices(this.devices().filter(x => x.id !== id)); },
  stations() { return read('stations', []); },
  saveStations(s) { write('stations', s); },
  upsertStation(st) {
    const s = this.stations(); const i = s.findIndex(x => x.id === st.id);
    if (i >= 0) s[i] = Object.assign(s[i], st); else s.push(st);
    this.saveStations(s); return st;
  },
  removeStation(id) { this.saveStations(this.stations().filter(x => x.id !== id)); },
  pendingTokens() { return read('tokens', []); },
  savePendingTokens(t) { write('tokens', t); },
  clearAll() { Object.keys(localStorage).filter(k => k.startsWith(K)).forEach(k => localStorage.removeItem(k)); },
};

// ---- IndexedDB recordings vault ----
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('hail-sentinel-vault', 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore('recordings', { keyPath: 'id' }); s.createIndex('created', 'created'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction('recordings', mode); const s = t.objectStore('recordings');
    const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
  }));
}
export const Vault = {
  add(rec) { return tx('readwrite', s => s.put(rec)); },
  async list() {
    const all = await tx('readonly', s => s.getAll());
    return (all || []).sort((a, b) => b.created - a.created);
  },
  get(id) { return tx('readonly', s => s.get(id)); },
  remove(id) { return tx('readwrite', s => s.delete(id)); },
};
