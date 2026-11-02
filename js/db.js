// Tiny IndexedDB wrapper. Match data (teams, moments, tags, signals) lives on the device only.
const DB_NAME = 'pitchside', STORE = 'matches';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
};

export const allMatches = async () => ((await tx('readonly', s => s.getAll())) || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
export const getMatch = id => tx('readonly', s => s.get(id));
export const saveMatch = m => tx('readwrite', s => s.put(m));
export const deleteMatch = id => tx('readwrite', s => s.delete(id));
export const newId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
