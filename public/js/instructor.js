import { $, $$, h, toast, copyText, download, LOGO } from './ui/dom.js';
import { popover, closePopover } from './ui/menu.js';
import {
  newConfig, configHash, encodeConfig, decodeConfig, parseFile, DEFAULT_THRESHOLDS, THRESHOLD_LABELS, countWords,
} from './core/format.js';
import { analyzeFile, finalize, fmtDuration } from './core/analysis.js';
import { relayInfo, BROWSER_DEMO_TSA } from './core/tsa.js';
import { DEMO_CONFIG } from './core/demo.js';
import { sha256Hex } from './core/canon.js';
import { isZip, readZip, lmsName, namesMatch } from './core/zipread.js';
import { renderReport, LEVELS, FILE_STATUS, fileNotes } from './ui/report.js';
import { makeBackup, parseBackup, notesFor, mergeNotes, mergeRemoved, isRemoved } from './core/backup.js';
import {
  folderSupported, savedFolder, chooseFolder, forgetFolder, folderPermission, readLatest, writeBackup,
} from './ui/backupfolder.js';
import { initTooltips } from './ui/tooltip.js';
import { appearanceButton } from './ui/appearance.js';
import { ICONS } from './ui/icons.js';

initTooltips();
$('#brand').insertAdjacentHTML('afterbegin', LOGO);
for (const slot of $$('.appearance-slot')) slot.append(appearanceButton());

// ---------- assignment library (this browser only) ----------

const LIB_KEY = 'draftwork.assignments';

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLibrary(lib, { quiet = false } = {}) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch {
    toast('Could not save to this browser’s storage. Download a backup now.');
  }
  if (!quiet) markChanged();
}

// ---------- backup state: what changed since the last backup ----------

const BACKUP_KEY = 'draftwork.backup';
function backupState() {
  try {
    return { rev: 0, backedUpRev: 0, at: null, ...JSON.parse(localStorage.getItem(BACKUP_KEY) || '{}') };
  } catch {
    return { rev: 0, backedUpRev: 0, at: null };
  }
}
function setBackupState(patch) {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...backupState(), ...patch }));
  } catch { /* storage unavailable */ }
}
function markChanged() {
  setBackupState({ rev: backupState().rev + 1 });
  // Ask the browser not to clear this site's data on its own (it can still be cleared by the user).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  renderStorageNote();
  scheduleFolderWrite();
}

let library = loadLibrary();
const knownHashes = () => new Set(library.map((a) => a.hash));

const studentLink = (code) => new URL(`student.html#a=${code}`, location.href).href;

// Assignments removed on purpose, so merging an older backup doesn't bring them back.
const REMOVED_KEY = 'draftwork.removed';
function loadRemoved() {
  try {
    return JSON.parse(localStorage.getItem(REMOVED_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveRemoved(r) {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(r));
  } catch { /* storage unavailable */ }
}

// extra.fromBackup: keep a removal made later than the backup's copy.
async function addToLibrary(config, extra = {}) {
  const { fromBackup, ...rest } = extra;
  const hash = await configHash(config);
  if (library.some((a) => a.hash === hash)) return { hash, existed: true };
  const removed = loadRemoved();
  if (fromBackup && isRemoved(removed, hash, rest.added)) return { hash, existed: false, removed: true };
  if (removed[hash] && !fromBackup) {
    delete removed[hash];
    saveRemoved(removed);
  }
  library.unshift({ hash, config, code: await encodeConfig(config), added: new Date().toISOString(), ...rest });
  saveLibrary(library, { quiet: !!rest.demo });
  return { hash, existed: false };
}

// ---------- backup, sharing and merging ----------

const realAssignments = () => library.filter((a) => !a.demo);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

const fullBackup = () => makeBackup({ assignments: realAssignments(), notes: allNotes(), removed: loadRemoved(), from: location.origin });
const backupText = (b) => JSON.stringify(b, null, 2);

// The backup folder, once chosen: { dir, ok }, where ok means Draftwork may write to it now.
let folder = null;
let folderError = null;

function renderStorageNote() {
  const s = backupState();
  const pending = s.rev - s.backedUpRev;
  const hasData = realAssignments().length > 0 || Object.keys(allNotes()).length > 0;
  const when = s.at ? new Date(s.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const auto = !!(folder && folder.ok && !folderError);

  // Status line in the backup card.
  const status = $('#backup-status');
  if (auto) status.textContent = `Backing up automatically to the folder “${folder.dir.name}”${when && hasData ? `. Last saved ${when}` : ''}.`;
  else if (!hasData) status.textContent = 'Nothing to back up yet.';
  else if (!when) status.innerHTML = '<span class="warn-text">Never backed up.</span> Your assignments exist only in this browser.';
  else if (pending > 0) status.innerHTML = `<span class="warn-text">Changes since your last backup</span> (${escapeHtml(when)}).`;
  else status.textContent = `Backed up ${when}. Nothing has changed since.`;
  renderFolderBox();

  // Banner at the top of the page whenever something isn't backed up.
  const note = $('#storage-note');
  note.innerHTML = '';
  if (folder && !folder.ok && hasData) {
    note.classList.remove('hidden');
    note.append(
      h('div', null, h('strong', null, 'Allow backups to continue. '),
        `Draftwork needs your OK to keep saving backups to the folder “${folder.dir.name}”. Browsers ask again after they restart.`),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn small primary', type: 'button', onclick: reconnectFolder }, 'Allow'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: downloadBackup }, 'Download a backup instead')));
    return;
  }
  if (!hasData || auto || (when && pending <= 0)) {
    note.classList.add('hidden');
    return;
  }
  note.classList.remove('hidden');
  note.append(
    h('div', null,
      h('strong', null, when ? 'You have changes that aren’t backed up. ' : 'Your assignments are saved only in this browser. '),
      `They’re kept in this browser at ${location.host || 'this address'}, not online. Clearing browsing data, a private window, or another browser, computer or web address won’t have them.`,
      folderSupported() ? ' Back up automatically to a folder (such as your OneDrive), or download a backup.' : ' Download a backup to keep them safe, and open it wherever you need them.'),
    h('div', { class: 'row', style: 'margin-top:8px' },
      folderSupported() && h('button', { class: 'btn small primary', type: 'button', onclick: connectFolder }, 'Back up to a folder…'),
      h('button', { class: `btn small ${folderSupported() ? '' : 'primary'}`, type: 'button', onclick: downloadBackup }, 'Download backup'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { showTab('assign'); $('#backup-card').scrollIntoView({ behavior: 'smooth' }); } }, 'Backup options')));
}

function renderFolderBox() {
  $('#f-folder-row').classList.toggle('hidden', !folderSupported() || !!folder);
  const box = $('#folder-box');
  box.innerHTML = '';
  if (!folderSupported()) {
    box.append(h('p', { class: 'small muted', style: 'margin:0' }, 'Automatic backup to a folder works in Chrome and Edge. In this browser, download a backup after making changes.'));
    return;
  }
  if (!folder) {
    box.append(h('div', { class: 'row' },
      h('button', {
        class: 'btn primary', type: 'button', onclick: connectFolder,
        'data-tip': 'Choose a folder, such as one in your college OneDrive. Draftwork saves a backup there whenever anything changes, plus one copy per day. Choose the same folder on another computer to bring everything across.',
      }, 'Back up automatically to a folder…')));
    return;
  }
  box.append(h('div', { class: 'row folder-row' },
    h('span', { class: `small ${folder.ok && !folderError ? '' : 'warn-text'}` }, folder.ok && !folderError ? '✓ Automatic backup to ' : 'Automatic backup paused: ', h('strong', null, folder.dir.name)),
    h('span', { class: 'spacer' }),
    !folder.ok && h('button', { class: 'btn small primary', type: 'button', onclick: reconnectFolder }, 'Allow'),
    h('button', { class: 'btn small ghost', type: 'button', onclick: connectFolder, 'data-tip': 'Back up to a different folder. Anything already in that folder is merged in first.' }, 'Change folder'),
    h('button', { class: 'btn small ghost', type: 'button', onclick: stopFolder, 'data-tip': 'Stop saving to this folder. The files already there are kept.' }, 'Stop')));
  if (folderError) box.append(h('p', { class: 'small warn-text', style: 'margin:6px 0 0' }, folderError));
}

// Call straight from a click: the browser only shows its folder picker in response to one.
async function connectFolder() {
  let dir;
  try {
    dir = await chooseFolder();
  } catch (err) {
    if (!err || err.name !== 'AbortError') toast('Couldn’t use that folder. Try another one.');
    return false;
  }
  folder = { dir, ok: (await folderPermission(dir, true)) === 'granted' };
  folderError = null;
  await syncFolder({ announce: true });
  if (folder.ok) toast(`Backing up automatically to “${dir.name}”.`);
  return true;
}

async function reconnectFolder() {
  if (!folder) return;
  folder.ok = (await folderPermission(folder.dir, true)) === 'granted';
  if (folder.ok) await syncFolder({ announce: true });
  else renderStorageNote();
}

async function stopFolder() {
  if (!confirm(`Stop backing up to “${folder.dir.name}”? The backups already there are kept.`)) return;
  await forgetFolder();
  folder = null;
  folderError = null;
  renderStorageNote();
}

// Merges what the folder holds (perhaps written on another computer), then saves ours there.
async function syncFolder({ announce = false } = {}) {
  if (!folder || !folder.ok) return renderStorageNote();
  const text = await readLatest(folder.dir);
  if (text) {
    try {
      const r = await mergeBackup(parseBackup(text));
      if (announce && (r.added || r.notes || r.removedHere)) toast(`Merged the backup already in “${folder.dir.name}”: ${describeMerge(r)}.`, 8000);
    } catch { /* not a backup we can read; ours replaces it */ }
  }
  await writeFolder();
}

let folderTimer = null;
function scheduleFolderWrite() {
  if (!folder || !folder.ok) return;
  clearTimeout(folderTimer);
  folderTimer = setTimeout(writeFolder, 800);
}

async function writeFolder() {
  clearTimeout(folderTimer);
  if (!folder || !folder.ok) return;
  const b = fullBackup();
  try {
    await writeBackup(folder.dir, backupText(b));
    folderError = null;
    setBackupState({ backedUpRev: backupState().rev, at: b.exported });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') folder.ok = false;
    else folderError = 'Couldn’t save to the backup folder. Check that it still exists, or choose another.';
  }
  renderStorageNote();
}

function downloadBackup() {
  const b = fullBackup();
  download(new TextEncoder().encode(backupText(b)), `draftwork-backup-${b.exported.slice(0, 10)}.json`, 'application/json');
  setBackupState({ backedUpRev: backupState().rev, at: b.exported });
  renderStorageNote();
  toast(`Backup downloaded: ${plural(b.assignments.length, 'assignment')} and your check-in notes. Keep the file somewhere safe.`, 7000);
}

function describeMerge(r) {
  const parts = [`${plural(r.added, 'new assignment')}${r.already ? ` (${r.already} already here)` : ''}`];
  if (r.notes) parts.push(`check-in notes for ${plural(r.notes, 'submission')}`);
  if (r.removedHere) parts.push(`${plural(r.removedHere, 'assignment')} removed, as you did elsewhere`);
  if (r.skipped) parts.push(`${r.skipped} couldn’t be read`);
  return parts.join(', ');
}

// Merges a backup or shared file into this browser. Nothing here is lost: assignments are added,
// notes are combined, and only assignments removed on purpose elsewhere are removed here too.
async function mergeBackup(data) {
  const wasEmpty = !realAssignments().length && !Object.keys(allNotes()).length;
  let removedHere = 0;
  if (data.removed && !data.shared) {
    const removed = mergeRemoved(loadRemoved(), data.removed);
    saveRemoved(removed);
    const keep = library.filter((a) => a.demo || !isRemoved(removed, a.hash, a.added));
    removedHere = library.length - keep.length;
    if (removedHere) {
      library = keep;
      saveLibrary(library);
    }
  }
  let added = 0;
  let already = 0;
  let skipped = 0;
  for (const a of data.assignments) {
    try {
      if (!a.config || a.config.v !== 1 || !a.config.nonce) throw new Error('bad');
      const r = await addToLibrary(a.config, { fromBackup: true, ...(a.added ? { added: a.added } : {}) });
      if (r.existed) already++;
      else if (!r.removed) added++;
    } catch {
      skipped++;
    }
  }
  const { notes, changed } = mergeNotes(allNotes(), data.notes || {});
  if (changed) {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    } catch {
      throw new Error('This browser’s storage is full, so the notes couldn’t be merged.');
    }
    markChanged();
  }
  // Opening a backup in an empty browser leaves nothing that isn't backed up.
  if (wasEmpty && !data.shared) setBackupState({ backedUpRev: backupState().rev, at: backupState().at || data.exported });
  renderLibrary();
  renderStorageNote();
  if (loaded.length && (added || removedHere)) await reanalyze();
  else if (loaded.length && changed) renderGroups();
  return { added, already, skipped, notes: changed, removedHere, shared: !!data.shared };
}

async function openBackupFile(text) {
  const r = await mergeBackup(parseBackup(text));
  toast(`${r.shared ? 'Merged the shared file' : 'Merged the backup'}: ${describeMerge(r)}.`, 8000);
}

// A file for a co-teacher or TA: chosen assignments, and optionally the notes on their submissions.
function openShare(ev) {
  const list = realAssignments();
  if (!list.length) {
    toast('No assignments to share yet.');
    return;
  }
  const boxes = list.map((a) => h('input', { type: 'checkbox', checked: true, value: a.hash, 'aria-label': a.config.title }));
  const withNotes = h('input', { type: 'checkbox', id: 'share-notes' });
  const body = h('div', { class: 'share-pop stack' },
    h('strong', null, 'Share with a colleague'),
    h('div', { class: 'small muted' }, 'They open the file under Assignments → Open backup or shared file, and it’s merged with what they have.'),
    h('div', { class: 'stack share-list' }, list.map((a, k) => h('label', { class: 'check' }, boxes[k], h('span', null, a.config.title)))),
    h('label', { class: 'check', 'data-tip': 'Your answers, outcomes and flag reviews for these assignments’ submissions. Include them when you’re reviewing the same students together.' },
      withNotes, h('span', null, 'Include my check-in notes')),
    h('div', { class: 'row' }, h('button', {
      class: 'btn small primary', type: 'button',
      onclick: () => {
        const hashes = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
        if (!hashes.size) {
          toast('Choose at least one assignment.');
          return;
        }
        const chosen = list.filter((a) => hashes.has(a.hash));
        const b = makeBackup({ assignments: chosen, notes: withNotes.checked ? notesFor(allNotes(), hashes) : {}, shared: true, from: location.origin });
        const slug = chosen[0].config.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'assignment';
        download(new TextEncoder().encode(backupText(b)), `draftwork-shared-${slug}${chosen.length > 1 ? `-and-${chosen.length - 1}-more` : ''}.json`, 'application/json');
        closePopover();
        toast(`Saved ${plural(chosen.length, 'assignment')}${withNotes.checked ? ' with your notes' : ''} to share. Send the file to your colleague.`, 7000);
      },
    }, 'Download file')));
  popover(ev.currentTarget, body, { align: 'left' });
}

$('#backup-btn').addEventListener('click', downloadBackup);
$('#share-btn').addEventListener('click', openShare);
$('#restore-input').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    await openBackupFile(await f.text());
  } catch (err) {
    toast(err.message, 6000);
  }
});


function renderLibrary() {
  const box = $('#assign-list');
  box.innerHTML = '';
  updateFirstSteps();
  box.append(h('h2', null, 'Your assignments'));
  if (!library.length) {
    box.append(h('p', { class: 'empty-state' }, 'None yet.'));
    return;
  }
  for (const a of library) {
    const c = a.config;
    const link = studentLink(a.code);
    const pol = [
      c.policy.paste === 'block' ? 'Pasting blocked' : 'Pasting allowed',
      c.policy.sources_pane ? 'sources panel' : null,
      c.policy.words_min || c.policy.words_max ? `${c.policy.words_min || 0}–${c.policy.words_max || '∞'} words` : null,
      Object.keys(c.thresholds || {}).length ? 'custom thresholds' : null,
      c.due ? `due ${new Date(c.due).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : null,
      c.ai_disclosure ? 'AI disclosure' : null,
      c.policy.spelling === false ? 'spell check off' : null,
      c.allow_demo_tsa ? 'test assignment' : null,
    ].filter(Boolean).join(' · ');
    box.append(h('div', { class: 'assign-row' },
      h('div', { class: 'row' },
        h('strong', null, c.title), a.demo && h('span', { class: 'pill', 'data-tip': 'Added with the demo class' }, 'demo'),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn small primary', type: 'button', 'data-tip': 'Instructions with the link and the steps for saving and uploading, ready to paste into your course site',
          onclick: (e) => showInstructions(e.currentTarget, a),
        }, 'Instructions for students'),
        h('button', { class: 'btn small', type: 'button', 'data-tip': `Copy just the link:\n${link}`, onclick: () => copyText(link) }, 'Copy link'),
        h('button', { class: 'btn small ghost', type: 'button', 'data-tip': 'Copy the short code (students can paste it instead of the link)', onclick: () => copyText(a.code) }, 'Code'),
        h('a', { class: 'btn small ghost', href: link, target: '_blank', rel: 'noopener', 'data-tip': 'Open the student page for this assignment in a new tab' }, 'Try'),
        h('button', {
          class: 'btn small ghost', type: 'button', 'data-tip': 'Remove from this browser',
          onclick: () => {
            if (!confirm(`Remove "${c.title}" from this browser? You can import its code again later.`)) return;
            library = library.filter((x) => x !== a);
            if (!a.demo) saveRemoved({ ...loadRemoved(), [a.hash]: new Date().toISOString() });
            saveLibrary(library);
            renderLibrary();
          },
        }, 'Remove')),
      h('div', { class: 'small muted' }, pol)));
  }
}

// Plain instructions for students, to paste into the course site. They use the same words as
// Draftwork itself ("Save file to upload", "upload it to your course").
function studentInstructions(a) {
  const c = a.config;
  const due = c.due ? new Date(c.due).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const where = c.submit_url ? `to this assignment’s dropbox: ${c.submit_url}` : 'to this assignment’s dropbox in our course site';
  return [
    `${c.title}: writing in Draftwork`,
    '',
    `Write this assignment in Draftwork, a word processor that records how your writing comes together. Open it here: ${studentLink(a.code)}`,
    due ? `Due ${due}.` : null,
    '',
    '1. Open the link in Chrome or Edge on a computer. Enter your name and student number (check them carefully: they can’t be changed later), then start writing. Your draft is kept on that computer as you go.',
    '2. When you’re finished, click “Save file to upload…”. This saves a .draftwork file to your Downloads folder.',
    `3. Upload that .draftwork file ${where}, the same way you’d upload a Word document. Saving doesn’t submit your assignment: it isn’t submitted until you upload the file.`,
    '4. Keep the receipt Draftwork shows you after saving.',
    '',
    c.policy.paste === 'block'
      ? `Pasting text from other places is turned off.${c.policy.sources_pane ? ' To quote a source, paste it into the Sources panel on the right, then copy it into your writing from there.' : ''}`
      : null,
    'Working on another computer? Save your file, then on the other computer open the link above and choose “Continue from a file I saved…” to keep writing.',
    'Please upload only the .draftwork file, not a Word document. If something isn’t working, save your file and contact me.',
  ].filter((l) => l !== null).join('\n');
}

function showInstructions(anchor, a) {
  const ta = h('textarea', { rows: 14, readonly: true, 'aria-label': 'Instructions for students', class: 'instructions-text' });
  ta.value = studentInstructions(a);
  popover(anchor, h('div', { class: 'share-pop stack instructions-pop' },
    h('strong', null, 'Instructions for students'),
    h('div', { class: 'small muted' }, 'Paste this into the assignment in your course site. In the dropbox settings, allow .draftwork files (or all file types).'),
    ta,
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'button', onclick: () => { copyText(ta.value); closePopover(); } }, 'Copy instructions'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: closePopover }, 'Close'))), { align: 'right' });
}

// thresholds form
const thBox = $('#f-thresholds');
for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
  thBox.append(h('label', { for: `th-${k}` }, THRESHOLD_LABELS[k] || k), h('input', { type: 'number', id: `th-${k}`, value: v, step: 'any', min: 0, 'data-tip': `Default: ${v}` }));
}

$('#new-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  // Ask for the backup folder first, while the click still counts for the browser's picker.
  const picking = !folder && folderSupported() && $('#f-folder').checked ? connectFolder() : null;
  const thresholds = {};
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
    const val = Number($(`#th-${k}`).value);
    if (Number.isFinite(val) && val !== v) thresholds[k] = val;
  }
  const tsaAnchors = [];
  for (const line of $('#f-anchors').value.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(.*?)[,\s]+([0-9a-fA-F]{64})$/);
    if (!m) {
      toast(`Couldn’t read “${line}”. Use: name, 64-character fingerprint.`, 6000);
      return;
    }
    tsaAnchors.push({ name: m[1].trim() || 'Custom TSA', spki: m[2].toLowerCase() });
  }
  const dueVal = $('#f-due').value;
  const config = newConfig({
    title: $('#f-title').value,
    paste: $('#f-paste').value,
    sourcesPane: $('#f-sources').checked,
    wordsMin: $('#f-min').value,
    wordsMax: $('#f-max').value,
    tsaUrl: $('#f-tsa').value.trim() || '/tsa',
    thresholds,
    allowDemoTsa: $('#f-demo').checked,
    tsaAnchors,
    due: dueVal ? new Date(dueVal).toISOString() : null,
    aiDisclosure: $('#f-ai').checked,
    spelling: $('#f-spelling').checked,
    submitUrl: $('#f-submit').value,
  });
  if (picking) await picking;
  await addToLibrary(config);
  renderLibrary();
  $('#new-form').reset();
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) $(`#th-${k}`).value = v;
  presetDemo();
  toast(folder && folder.ok
    ? `Created "${config.title}" and backed it up to “${folder.dir.name}”. Use Instructions for students to give them the link and steps.`
    : `Created "${config.title}". Use Instructions for students to give them the link and steps, and Download backup to keep it safe.`, 8000);
  reanalyze();
});

// How this copy of Draftwork is deployed. Static hosts publish site.json (written by the static
// build); the Node server has none and provides /tsa itself.
let site = { static: false, relay: null };
const siteReady = fetch('site.json').then((r) => (r.ok ? r.json() : null)).then((s) => {
  if (s) site = { ...site, ...s };
}).catch(() => {});

// Defaults for new assignments: the site's relay, or test assignments when there's no real one.
async function presetDemo() {
  await siteReady;
  if (site.static && !site.relay) {
    $('#f-tsa').value = BROWSER_DEMO_TSA;
    $('#f-demo').checked = true;
    $('#no-relay-note').classList.remove('hidden');
    return;
  }
  if (site.relay) $('#f-tsa').value = site.relay;
  const tsa = $('#f-tsa').value.trim() || '/tsa';
  const info = await relayInfo(tsa.startsWith('demo:') ? tsa : new URL(tsa, location.href).href);
  if (info && info.mode === 'mock') {
    $('#f-demo').checked = true;
    $('#f-demo').closest('label').dataset.tip = 'This server is running the offline demo timestamp service, so test assignments must accept demo timestamps.';
  }
}
presetDemo();

$('#import-btn').addEventListener('click', async () => {
  try {
    const config = await decodeConfig($('#import-code').value);
    const { existed } = await addToLibrary(config);
    $('#import-code').value = '';
    renderLibrary();
    toast(existed ? 'Already in your assignments.' : `Imported "${config.title}".`);
    reanalyze();
  } catch {
    toast('That is not a valid assignment code.');
  }
});

// ---------- tabs ----------

function showTab(name) {
  for (const t of ['review', 'assign']) {
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`#view-${t}`).classList.toggle('hidden', t !== name);
  }
}
$('#tab-review').addEventListener('click', () => showTab('review'));
$('#tab-assign').addEventListener('click', () => showTab('assign'));

// ---------- submissions ----------

let loaded = []; // { key, name, A }
let otherFiles = []; // files in an LMS zip that aren't .draftwork: { path, name, lms }
let current = null;

const normLabel = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------- check-in notes (this browser only) ----------

const NOTES_KEY = 'draftwork.notes';
function allNotes() {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
  } catch {
    return {};
  }
}
const getNotes = (key) => allNotes()[key] || {};
function setNotes(key, n) {
  const all = allNotes();
  all[key] = n;
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(all));
  } catch {
    toast('Could not save your notes in this browser.');
  }
  markChanged();
}

// "3 of 4 asked · 1 follow-up" for the table.
function checkinStatus(item, F) {
  const n = getNotes(item.key);
  const outcomes = F.prompts.map((p) => (n.prompts && n.prompts[p.key] && n.prompts[p.key].outcome) || '');
  const asked = outcomes.filter(Boolean).length;
  const follow = outcomes.filter((o) => o === 'follow').length + Object.values(n.flags || {}).filter((d) => d === 'concern').length;
  // Extra questions count once asked, but don't raise the target.
  const main = F.prompts.filter((p) => !p.extra).length;
  return { asked, total: Math.max(main, asked), follow, any: asked > 0 || !!n.summary };
}

let filter = 'all';
// [label, test, shown as a chip]. The level filters are reached from each class's summary bar.
const FILTERS = {
  all: ['All', () => true, true],
  flagged: ['Flagged', (F) => F.flags.length > 0, true],
  major: ['Major flags', (F) => F.level === 'major', true],
  minor: ['Minor flags', (F) => F.level === 'minor', false],
  none: ['No flags', (F) => F.level === 'none', false],
  integrity: ['Altered files', (F) => F.integrity.some((c) => c.status === 'fail'), true],
  todo: ['Not checked in', (F, s) => !s.any, true],
  follow: ['Follow-up', (F, s) => s.follow > 0, true],
};

// Sort order for each class, remembered in this browser.
const LEVEL_RANK = { major: 0, minor: 1, none: 2 };
const byName = (a, b) => normLabel(a.F.header.student_label).localeCompare(normLabel(b.F.header.student_label));
const seriousness = (F) => F.flags.filter((f) => f.severity === 'major').length * 10 + F.flags.length;
const byLevel = (a, b) => LEVEL_RANK[a.F.level] - LEVEL_RANK[b.F.level] || seriousness(b.F) - seriousness(a.F) || byName(a, b);
const SORTS = {
  name: ['Name', byName],
  level: ['Most serious first', byLevel],
  checkin: ['Not checked in first', (a, b) => Number(a.s.any) - Number(b.s.any) || byLevel(a, b)],
};
let sortBy = 'name';
try {
  if (SORTS[localStorage.getItem('draftwork.sort')]) sortBy = localStorage.getItem('draftwork.sort');
} catch { /* storage unavailable */ }

// One class's submissions, finalized, in display order. With visibleOnly, only those the filter shows.
function classRows(items, visibleOnly = true) {
  const rows = items.map((item) => {
    const F = finalized(item);
    return { item, F, s: checkinStatus(item, F) };
  }).sort(SORTS[sortBy][1]);
  return visibleOnly ? rows.filter((x) => FILTERS[filter][1](x.F, x.s)) : rows;
}

async function addFiles(entries) {
  const status = $('#load-status');
  const errors = [];
  // Expand LMS zips; keep only .draftwork files from inside them.
  const files = [];
  for (const e of entries) {
    if (isZip(e.bytes)) {
      status.textContent = `Opening ${e.name}…`;
      try {
        const all = await readZip(e.bytes);
        const inner = all.filter((x) => /\.draftwork$/i.test(x.name));
        // Anything else a student uploaded (a Word document, say) would otherwise vanish silently.
        for (const x of all) {
          if (/\.draftwork$/i.test(x.name) || /(^|\/)(index\.html?|\.DS_Store|Thumbs\.db)$|(^|\/)__MACOSX\//i.test(x.name)) continue;
          const name = x.name.split('/').pop();
          if (!otherFiles.some((o) => o.path === x.name)) otherFiles.push({ path: x.name, name, lms: lmsName(x.name) });
        }
        if (!inner.length) errors.push(`${e.name}: no .draftwork files inside`);
        files.push(...inner);
      } catch (err) {
        errors.push(`${e.name}: ${err.message}`);
      }
    } else files.push(e);
  }
  for (let k = 0; k < files.length; k++) {
    const { name, bytes } = files[k];
    status.textContent = `Checking ${k + 1} of ${files.length}…`;
    try {
      if (/\.json$/i.test(name) && new TextDecoder().decode(bytes.subarray(0, 200)).includes('draftwork-backup')) {
        await openBackupFile(new TextDecoder().decode(bytes));
        continue;
      }
      const file = await parseFile(bytes);
      const key = `${file.assignment.config_hash}:${normLabel(file.header.student_label)}:${file.final.hash}:${file.events.length}`;
      if (loaded.some((x) => x.key === key)) continue;
      const A = await analyzeFile(file, { knownConfigHashes: knownHashes() });
      const fingerprint = await sha256Hex(bytes);
      const shortName = name.split('/').pop();
      loaded.push({ key, name: shortName, path: name, A, fingerprint, lms: lmsName(name) });
    } catch (err) {
      errors.push(`${name.split('/').pop()}: ${err.message}`);
    }
  }
  status.textContent = `${loaded.length} file${loaded.length === 1 ? '' : 's'} open.` + (errors.length ? ` ${errors.length} could not be read.` : '');
  if (errors.length) toast(errors.slice(0, 3).join(' · '), 8000);
  $('#clear-files').classList.toggle('hidden', !loaded.length);
  $('#export-csv').classList.toggle('hidden', !loaded.length);
  finalCache.clear();
  renderGroups();
}

// Re-run the config check after the library changes.
async function reanalyze() {
  if (!loaded.length) return;
  for (const item of loaded) item.A = await analyzeFile(item.A.file, { knownConfigHashes: knownHashes() });
  finalCache.clear();
  renderGroups();
}

// Class comparisons make finalizing a whole class slow for large classes, so results are kept
// until the set of open files (or their analyses) changes.
const finalCache = new Map();
function finalized(item) {
  const A = item.A;
  if (finalCache.has(item) && finalCache.get(item).A === A) return finalCache.get(item).F;
  const cohort = loaded.filter((x) => x.A.cfgHash === A.cfgHash).map((x) => x.A);
  const priors = loaded.filter((x) => x.A !== A && x.A.cfgHash !== A.cfgHash && normLabel(x.A.header.student_label) === normLabel(A.header.student_label))
    .map((x) => x.A);
  const F = finalize(A, { cohort, priors });
  finalCache.set(item, { A, F });
  return F;
}

function groupsOf() {
  const groups = new Map();
  for (const item of loaded) {
    if (!groups.has(item.A.cfgHash)) groups.set(item.A.cfgHash, []);
    groups.get(item.A.cfgHash).push(item);
  }
  for (const g of groups.values()) g.sort((a, b) => normLabel(a.A.header.student_label).localeCompare(normLabel(b.A.header.student_label)));
  return groups;
}

// The first-steps list on an empty Submissions page, with step 1 ticked once there's an assignment.
function updateFirstSteps() {
  $('#empty-hint').classList.toggle('hidden', loaded.length > 0 || otherFiles.length > 0);
  const [first, second] = $$('#empty-hint li');
  const has = realAssignments().length > 0;
  first.classList.toggle('done', has);
  second.classList.toggle('current', has);
  first.classList.toggle('current', !has);
}

// A file's name as the student gave it, without the course site's prefix, and what kind it is.
function plainFileName(name) {
  const base = name
    .replace(/^\d+-\d+ - .+? - [A-Z][a-z]{2} \d{1,2}, \d{4} \d{3,4} [AP]M - /, '') // Brightspace
    .replace(/^.*?_attempt_\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d_/, '') // Blackboard
    .replace(/^[a-z][a-z-]*?(?:_late)?_\d+_\d+_/i, ''); // Canvas
  const ext = (base.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const kind = { docx: 'a Word document', doc: 'a Word document', pdf: 'a PDF', txt: 'a text file', odt: 'an OpenOffice document', pages: 'a Pages document', rtf: 'a rich text file' }[ext.toLowerCase()];
  return kind ? `${base} (${kind})` : base;
}

// Students whose upload contained other files and no .draftwork file at all.
function wrongFilesNotice() {
  const withDraftwork = new Set(loaded.map((x) => x.lms && x.lms.name && normLabel(x.lms.name)).filter(Boolean));
  const byStudent = new Map();
  for (const o of otherFiles) {
    const who = o.lms && o.lms.name ? o.lms.name : '';
    if (who && withDraftwork.has(normLabel(who))) continue;
    const key = who ? normLabel(who) : o.path;
    if (!byStudent.has(key)) byStudent.set(key, { who, names: [] });
    byStudent.get(key).names.push(plainFileName(o.name));
  }
  if (!byStudent.size) return null;
  const list = [...byStudent.values()];
  const named = list.filter((s) => s.who).length;
  return h('div', { class: 'notice warn', style: 'margin-bottom:16px', role: 'status' },
    h('strong', null, named === list.length
      ? `${list.length} student${list.length === 1 ? '' : 's'} uploaded other files instead of a Draftwork file, so they aren’t listed below.`
      : `${list.length} upload${list.length === 1 ? '' : 's'} contained other files instead of a Draftwork file, so ${list.length === 1 ? 'it isn’t' : 'they aren’t'} listed below.`),
    h('ul', { class: 'small', style: 'margin:6px 0' }, list.slice(0, 30).map((s) => h('li', null, s.who ? h('strong', null, s.who) : null, s.who ? ': ' : '', s.names.join(', ')))),
    list.length > 30 ? h('div', { class: 'small' }, `and ${list.length - 30} more.`) : null,
    h('div', { class: 'small' }, 'Ask them to use “Save file to upload…” in Draftwork and upload the .draftwork file it saves (not a Word document).'));
}

function renderGroups() {
  const box = $('#groups');
  box.innerHTML = '';
  updateFirstSteps();
  const known = knownHashes();
  const wrong = wrongFilesNotice();
  if (wrong) box.append(wrong);
  if (loaded.length) {
    const sortSel = h('select', { 'aria-label': 'Sort submissions', 'data-tip': 'Order of the submissions in each class. Previous and Next follow it.' },
      Object.entries(SORTS).map(([k, [label]]) => h('option', { value: k, selected: sortBy === k }, label)));
    sortSel.addEventListener('change', () => {
      sortBy = sortSel.value;
      try {
        localStorage.setItem('draftwork.sort', sortBy);
      } catch { /* storage unavailable */ }
      renderGroups();
    });
    box.append(h('div', { class: 'row filters' },
      h('div', { class: 'row', role: 'group', 'aria-label': 'Show' },
        h('span', { class: 'small muted' }, 'Show:'),
        Object.entries(FILTERS).filter(([k, [, , chip]]) => chip || filter === k).map(([k, [label]]) => h('button', {
          class: 'chip', type: 'button', 'aria-pressed': String(filter === k),
          onclick: () => {
            filter = k;
            renderGroups();
          },
        }, label))),
      h('span', { class: 'spacer' }),
      h('label', { class: 'row sort-row' }, h('span', { class: 'small muted' }, 'Sort:'), sortSel)));
  }
  for (const [hash, items] of groupsOf()) {
    const cfg = items[0].A.config;
    const min = items[0].A.T.min_class_size;
    const all = classRows(items, false);
    const shown = all.filter((x) => FILTERS[filter][1](x.F, x.s));
    const rows = shown.map(({ item, F, s }) => {
      const fails = F.integrity.filter((c) => c.status === 'fail').length;
      const warns = F.integrity.filter((c) => c.status !== 'pass' && c.status !== 'fail').length;
      const fileStatus = FILE_STATUS[fails ? 'altered' : warns ? 'note' : 'intact'];
      const notes = F.integrity.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`).join('\n');
      const integrityTip = notes ? `${fileStatus.tip}\n\n${notes}` : fileStatus.tip;
      const lmsMismatch = item.lms && item.lms.name && !namesMatch(item.lms.name, F.header.student_label);
      const level = LEVELS[F.level];
      return h('tr', { class: `clickable level-${F.level}`, tabindex: '0', onclick: () => openDetail(item, 'overview'), onkeydown: (e) => e.key === 'Enter' && openDetail(item, 'overview') },
        h('td', null, h('strong', null, F.header.student_label || '(no label)'),
          h('div', { class: `small ${lmsMismatch ? 'warn-text' : 'muted'}`, 'data-tip': lmsMismatch ? `The LMS says this was submitted by “${item.lms.name}”, which doesn’t obviously match the name in the file.` : null },
            item.lms && item.lms.name ? `${item.lms.lms}: ${item.lms.name}` : item.name)),
        h('td', null, countWords(F.file.final.text).toLocaleString()),
        h('td', null, F.sessions.length),
        h('td', null, fmtDuration(F.raw.active)),
        h('td', null, h('span', { 'data-tip': integrityTip },
          fails ? h('span', { class: 'pill bad' }, fileStatus.label) : h('span', { class: 'small muted' }, fileStatus.label),
          !fails && fileNotes(F).length ? h('div', { class: 'small muted file-note' }, fileNotes(F).join(', ')) : null)),
        h('td', null, h('div', { class: 'chips' },
          h('span', { class: `pill level ${level.cls}`, 'data-tip': level.tip }, level.label),
          [...new Map(F.flags.map((f) => [f.title, f])).values()].map((f) => h('span', {
            class: `pill ${f.severity === 'major' ? 'bad' : 'warn'} soft`, 'data-tip': `${f.kind === 'integrity' ? 'Altered file' : f.severity === 'major' ? 'Major' : 'Minor'}: ${f.reason}`,
          }, f.title)))),
        h('td', { class: 'small' }, s.total ? h('span', { class: s.follow ? 'warn-text' : s.asked ? '' : 'muted' },
          s.follow ? `Follow-up (${s.follow})` : s.asked ? `${s.asked} of ${s.total} asked` : 'Not yet') : '—'),
        h('td', { class: 'row-actions' }, h('button', {
          class: 'btn small', type: 'button', 'data-tip': 'Read the submitted document', html: `${ICONS.doc}<span>Read</span>`,
          onclick: (e) => {
            e.stopPropagation();
            openDetail(item, 'document');
          },
        })));
    });
    const classOn = items.length >= min;
    box.append(h('div', { class: 'card', style: 'margin-bottom:16px' },
      h('div', { class: 'section-head' },
        h('div', null,
          h('h2', null, cfg.title),
          h('div', { class: 'small muted' },
            `${items.length} submission${items.length === 1 ? '' : 's'}`,
            !known.has(hash) && h('span', { class: 'warn-text', 'data-tip': 'Import this assignment’s code under Assignments so the files can be checked against it.' }, ' · not in your assignments'),
            h('span', { 'data-tip': `The “written unusually quickly” and “unnaturally even typing” flags compare students with each other, so they need at least ${min} submissions.` },
              classOn ? ' · class comparisons on' : ` · class comparisons need ${min}`)))),
      classSummary(all),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'Student'), h('th', null, 'Words'),
          h('th', { 'data-tip': 'Separate sittings' }, 'Sessions'),
          h('th', { 'data-tip': 'Writing time, not counting breaks over 5 minutes' }, 'Time'),
          h('th', { 'data-tip': 'Whether the file is an unaltered record made in Draftwork. It doesn’t show who wrote the text or how; the Flags column does.' }, 'File'),
          h('th', { 'data-tip': 'Moments worth asking about. Green: no flags. Amber: one or two minor flags. Red: a major flag, or three or more.' }, 'Flags'),
          h('th', { 'data-tip': 'Your check-in progress, from the notes you record under “Questions to ask”' }, 'Check-in'),
          h('th', null, ''))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 8, class: 'muted small' }, 'No submissions match this filter.')))))));
  }
}

// Red, amber and green at a glance, each a shortcut to those submissions, and check-in progress.
function classSummary(all) {
  const count = (lvl) => all.filter((x) => x.F.level === lvl).length;
  const n = { major: count('major'), minor: count('minor'), none: count('none') };
  const altered = all.filter((x) => FILTERS.integrity[1](x.F, x.s)).length;
  const flagged = all.filter((x) => x.F.flags.length);
  const seen = flagged.filter((x) => x.s.any).length;
  const follow = all.filter((x) => x.s.follow > 0).length;
  const pick = (k) => () => {
    filter = filter === k ? 'all' : k;
    renderGroups();
  };
  const order = ['major', 'minor', 'none'];
  return h('div', { class: 'class-summary' },
    h('div', { class: 'level-bar', role: 'img', 'aria-label': `${n.major} with major flags, ${n.minor} with minor flags, ${n.none} with no flags` },
      order.filter((k) => n[k]).map((k) => h('button', {
        class: `seg ${LEVELS[k].cls}`, type: 'button', style: `flex-grow:${n[k]}`, tabindex: '-1',
        'data-tip': `${n[k]} ${LEVELS[k].label.toLowerCase()}: show them`, onclick: pick(k),
      }))),
    h('div', { class: 'row summary-chips' },
      order.map((k) => h('button', {
        class: `chip level-chip ${LEVELS[k].cls}`, type: 'button', 'aria-pressed': String(filter === k),
        'data-tip': `${LEVELS[k].tip} Click to show only these; click again for all.`, onclick: pick(k),
      }, h('span', { class: `dot ${LEVELS[k].cls}` }), `${n[k]} ${LEVELS[k].label.toLowerCase()}`)),
      altered ? h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === 'integrity'), onclick: pick('integrity') }, `${altered} altered file${altered === 1 ? '' : 's'}`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'small muted', 'data-tip': 'Flagged submissions you’ve recorded something for under “Questions to ask”' },
        flagged.length ? `Checked in with ${seen} of ${flagged.length} flagged` : 'Nothing flagged',
        follow ? h('span', { class: 'warn-text' }, ` · ${follow} need follow-up`) : null)));
}

// Previous and Next follow the list as shown: the current sort, and the filter when it includes
// the open submission.
function navOrder(item) {
  const items = groupsOf().get(item.A.cfgHash);
  const visible = classRows(items, true).map((x) => x.item);
  return visible.includes(item) ? visible : classRows(items, false).map((x) => x.item);
}

let currentTab = 'overview';
function openDetail(item, tab = currentTab) {
  current = item;
  currentTab = tab;
  $('#review-list').classList.add('hidden');
  $('#review-detail').classList.remove('hidden');
  renderReport($('#report'), finalized(item), {
    mode: 'instructor', tab, onTab: (t) => (currentTab = t),
    notes: { get: () => getNotes(item.key), set: (n) => setNotes(item.key, n) },
    fileInfo: { fingerprint: item.fingerprint, lms: item.lms },
  });
  const order = navOrder(item);
  const k = order.indexOf(item);
  $('#prev').disabled = k <= 0;
  $('#next').disabled = k >= order.length - 1;
  $('#prev').dataset.tip = `Previous submission (${SORTS[sortBy][0].toLowerCase()}${filter !== 'all' ? `, ${FILTERS[filter][0].toLowerCase()}` : ''})`;
  $('#next').dataset.tip = `Next submission (${SORTS[sortBy][0].toLowerCase()}${filter !== 'all' ? `, ${FILTERS[filter][0].toLowerCase()}` : ''})`;
  window.scrollTo(0, 0);
}

function step(d) {
  const order = navOrder(current);
  const k = order.indexOf(current) + d;
  if (order[k]) openDetail(order[k]);
}
$('#prev').addEventListener('click', () => step(-1));
$('#next').addEventListener('click', () => step(1));
$('#back').addEventListener('click', () => {
  $('#review-detail').classList.add('hidden');
  $('#review-list').classList.remove('hidden');
  $('#report').innerHTML = '';
  renderGroups();
});

// ---------- export (spreadsheet, optionally anonymised for calibration) ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv(anonymous) {
  const rows = [];
  const flagIds = ['gap', 'untrusted', 'unusual', 'retype', 'transcription', 'away', 'fast', 'rhythm', 'overlap', 'quotes', 'speed', 'pastes'];
  for (const [, items] of groupsOf()) {
    for (const item of items) {
      const F = finalized(item);
      const n = getNotes(item.key);
      const s = checkinStatus(item, F);
      const id = anonymous ? (await sha256Hex(`${item.key}`)).slice(0, 10) : F.header.student_label;
      const row = {
        id, assignment: F.config.title,
        lms_name: anonymous ? '' : (item.lms && item.lms.name) || '',
        file_fingerprint: anonymous ? '' : item.fingerprint,
        words: countWords(F.file.final.text), sessions: F.sessions.length, active_min: (F.raw.active / 60_000).toFixed(1),
      };
      for (const c of F.integrity) row[`check_${c.id}`] = c.status;
      for (const f of flagIds) {
        const has = F.flags.some((x) => x.id === f);
        row[`flag_${f}`] = has ? 1 : 0;
        row[`review_${f}`] = has ? (n.flags && n.flags[f]) || '' : '';
      }
      for (const sg of F.signals) row[`signal_${sg.id}`] = Number.isFinite(sg.metric) ? Number(sg.metric.toFixed(4)) : '';
      row.questions_asked = s.asked;
      row.questions_total = s.total;
      row.outcomes = F.prompts.map((p) => (n.prompts && n.prompts[p.key] && n.prompts[p.key].outcome) || '-').join(' ');
      if (!anonymous) row.notes = n.summary || '';
      rows.push(row);
    }
  }
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  download(new TextEncoder().encode('﻿' + csv), anonymous ? 'draftwork-calibration.csv' : 'draftwork-submissions.csv', 'text/csv');
}

$('#export-csv').addEventListener('click', (e) => {
  popover(e.currentTarget, h('div', { class: 'menu' },
    h('button', { class: 'menu-item', type: 'button', onclick: () => { closePopover(); exportCsv(false); } },
      h('span'), h('span', { class: 'menu-label' }, 'Spreadsheet with names'), h('span')),
    h('button', {
      class: 'menu-item', type: 'button', 'data-tip': 'Names, file fingerprints and your notes are left out; students get random IDs. Suitable for sharing to calibrate flag thresholds.',
      onclick: () => { closePopover(); exportCsv(true); },
    }, h('span'), h('span', { class: 'menu-label' }, 'Anonymised, for calibration'), h('span'))), { align: 'left' });
});

$('#clear-files').addEventListener('click', () => {
  loaded = [];
  otherFiles = [];
  finalCache.clear();
  renderGroups();
  $('#load-status').textContent = '';
  $('#clear-files').classList.add('hidden');
  $('#export-csv').classList.add('hidden');
});

const readEntries = (files) => Promise.all([...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));

$('#file-input').addEventListener('change', async (ev) => {
  await addFiles(await readEntries(ev.target.files));
  ev.target.value = '';
});
const drop = $('#drop');
drop.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  drop.classList.remove('over');
  await addFiles(await readEntries(ev.dataTransfer.files));
});

// Demo class (from `npm run simulate` with server.js, or bundled by the static build).
// instructor.html#demo opens it straight away.
(async () => {
  try {
    const names = await (await fetch('samples/index.json')).json();
    if (!names.some((n) => n.endsWith('.draftwork'))) return;
    const btn = $('#load-demo');
    btn.classList.remove('hidden');
    const load = async () => {
      btn.disabled = true;
      await addToLibrary(DEMO_CONFIG, { demo: true });
      if (names.includes('assignment-codes.txt')) {
        const txt = await (await fetch('samples/assignment-codes.txt')).text();
        for (const line of txt.split(/\r?\n/)) {
          if (!/^[A-Za-z0-9_-]{40,}$/.test(line.trim())) continue;
          try {
            await addToLibrary(await decodeConfig(line), { demo: true });
          } catch { /* not a code */ }
        }
        renderLibrary();
      }
      const entries = [];
      for (const n of names.filter((x) => x.endsWith('.draftwork'))) {
        entries.push({ name: n, bytes: new Uint8Array(await (await fetch(`samples/${encodeURIComponent(n)}`)).arrayBuffer()) });
      }
      await addFiles(entries);
      btn.disabled = false;
    };
    btn.addEventListener('click', load);
    if (location.hash === '#demo') load();
  } catch { /* no demo */ }
})();

renderLibrary();
renderStorageNote();

// Pick up the backup folder chosen on an earlier visit. If the browser still allows writing to it,
// merge in anything saved there from another computer.
(async () => {
  if (!folderSupported()) return;
  const dir = await savedFolder();
  if (!dir) return;
  folder = { dir, ok: (await folderPermission(dir)) === 'granted' };
  if (folder.ok) await syncFolder({ announce: true });
  else renderStorageNote();
})();
