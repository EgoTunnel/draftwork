// Tiny IndexedDB key-value store for autosaved drafts.
const DB = 'draftwork';
const STORE = 'drafts';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export const getDraft = (key) => tx('readonly', (s) => s.get(key));
export const putDraft = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const deleteDraft = (key) => tx('readwrite', (s) => s.delete(key));
