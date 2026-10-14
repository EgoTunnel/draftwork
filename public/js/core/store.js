// Tiny IndexedDB key-value store for autosaved drafts and their earlier versions.
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

// Keys starting with prefix, in key order.
export const keysWith = (prefix) => tx('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)));

// ---------- version history ----------

const HISTORY_KEEP = 12;
const histPrefix = (cfgHash) => `hist:${cfgHash}:`;

export async function addVersion(cfgHash, file, words) {
  const key = `${histPrefix(cfgHash)}${String(Date.now()).padStart(15, '0')}`;
  await putDraft(key, { file, words, savedAt: Date.now() });
  const keys = await keysWith(histPrefix(cfgHash));
  for (const old of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP))) await deleteDraft(old);
}

// Newest first: [{ key, savedAt, words, events }]
export async function listVersions(cfgHash) {
  const keys = await keysWith(histPrefix(cfgHash));
  const out = [];
  for (const key of keys.reverse()) {
    const v = await getDraft(key);
    if (v && v.file) out.push({ key, savedAt: v.savedAt, words: v.words, events: v.file.events.length });
  }
  return out;
}

export const getVersion = async (key) => (await getDraft(key)).file;
