// Automatic backups to a folder the instructor chooses (the File System Access API, in Chrome
// and Edge). The folder handle is kept in IndexedDB; after a restart the browser may ask again
// before Draftwork can write to it.

const DB = 'draftwork-instructor';
const STORE = 'handles';
const KEY = 'backup-folder';
export const LATEST = 'draftwork-backup.json';

export const folderSupported = () => typeof window.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}

export async function savedFolder() {
  try {
    return (await tx('readonly', (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

// Must be called straight from a click (the browser requires it for the picker).
export async function chooseFolder() {
  const dir = await window.showDirectoryPicker({ id: 'draftwork-backups', mode: 'readwrite', startIn: 'documents' });
  await tx('readwrite', (s) => s.put(dir, KEY));
  return dir;
}

export async function forgetFolder() {
  try {
    await tx('readwrite', (s) => s.delete(KEY));
  } catch { /* nothing saved */ }
}

// 'granted', 'prompt' or 'denied'. With ask, shows the browser's prompt (needs a click).
export async function folderPermission(dir, ask = false) {
  const opts = { mode: 'readwrite' };
  try {
    let p = dir.queryPermission ? await dir.queryPermission(opts) : 'granted';
    if (p !== 'granted' && ask && dir.requestPermission) p = await dir.requestPermission(opts);
    return p;
  } catch {
    return 'denied';
  }
}

export async function readLatest(dir) {
  try {
    return await (await (await dir.getFileHandle(LATEST)).getFile()).text();
  } catch {
    return null;
  }
}

async function writeFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// The latest backup, plus one copy per day to go back to.
export async function writeBackup(dir, text) {
  await writeFile(dir, LATEST, text);
  await writeFile(dir, `draftwork-backup-${new Date().toISOString().slice(0, 10)}.json`, text);
}
