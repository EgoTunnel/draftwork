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
import { renderReport } from './ui/report.js';
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
  if (typeof renderStorageNote === 'function') renderStorageNote();
}

let library = loadLibrary();
const knownHashes = () => new Set(library.map((a) => a.hash));

const studentLink = (code) => new URL(`student.html#a=${code}`, location.href).href;

async function addToLibrary(config, extra = {}) {
  const hash = await configHash(config);
  if (library.some((a) => a.hash === hash)) return { hash, existed: true };
  library.unshift({ hash, config, code: await encodeConfig(config), added: new Date().toISOString(), ...extra });
  saveLibrary(library, { quiet: !!extra.demo });
  return { hash, existed: false };
}

// ---------- backup and restore ----------

const realAssignments = () => library.filter((a) => !a.demo);

function renderStorageNote() {
  const s = backupState();
  const pending = s.rev - s.backedUpRev;
  const hasData = realAssignments().length > 0 || Object.keys(allNotes()).length > 0;
  const when = s.at ? new Date(s.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

  // Status line in the Back up & restore card.
  const status = $('#backup-status');
  if (!hasData) status.textContent = 'Nothing to back up yet.';
  else if (!when) status.innerHTML = '<span class="warn-text">Never backed up.</span> Your assignments exist only in this browser.';
  else if (pending > 0) status.innerHTML = `<span class="warn-text">Changes since your last backup</span> (${escapeHtml(when)}).`;
  else status.textContent = `Backed up ${when}. Nothing has changed since.`;

  // Banner at the top of the page whenever there's something not backed up.
  const note = $('#storage-note');
  note.innerHTML = '';
  if (!hasData || (when && pending <= 0)) {
    note.classList.add('hidden');
    return;
  }
  note.classList.remove('hidden');
  note.append(
    h('div', null,
      h('strong', null, when ? 'You have changes that aren’t backed up. ' : 'Your assignments are saved only in this browser. '),
      `They’re kept in this browser at ${location.host || 'this address'}, not online. Clearing browsing data, a private window, or another browser, computer or web address won’t have them. Download a backup to keep them safe, and restore it wherever you need them.`),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn small primary', type: 'button', onclick: downloadBackup }, 'Download backup'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { showTab('assign'); $('#backup-card').scrollIntoView({ behavior: 'smooth' }); } }, 'Backup options')));
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function downloadBackup() {
  const backup = {
    type: 'draftwork-backup',
    version: 1,
    exported: new Date().toISOString(),
    from: location.origin,
    assignments: realAssignments().map((a) => ({ config: a.config, added: a.added })),
    notes: allNotes(),
  };
  const date = new Date().toISOString().slice(0, 10);
  download(new TextEncoder().encode(JSON.stringify(backup, null, 2)), `draftwork-backup-${date}.json`, 'application/json');
  setBackupState({ backedUpRev: backupState().rev, at: backup.exported });
  renderStorageNote();
  toast(`Backup downloaded: ${backup.assignments.length} assignment${backup.assignments.length === 1 ? '' : 's'} and your check-in notes. Keep the file somewhere safe.`, 7000);
}

// Merges a backup into this browser. Nothing already here is removed.
async function restoreBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file isn’t a Draftwork backup.');
  }
  if (!data || data.type !== 'draftwork-backup' || !Array.isArray(data.assignments)) throw new Error('That file isn’t a Draftwork backup.');
  let added = 0;
  let skipped = 0;
  for (const a of data.assignments) {
    try {
      if (!a.config || a.config.v !== 1 || !a.config.nonce) throw new Error('bad');
      const r = await addToLibrary(a.config, a.added ? { added: a.added } : {});
      if (!r.existed) added++;
    } catch {
      skipped++;
    }
  }
  // Notes: keep whichever copy was updated most recently.
  const mine = allNotes();
  let notes = 0;
  for (const [key, n] of Object.entries(data.notes || {})) {
    if (!n || typeof n !== 'object') continue;
    if (!mine[key] || String(n.updated || '') > String(mine[key].updated || '')) {
      mine[key] = n;
      notes++;
    }
  }
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(mine));
  } catch {
    throw new Error('This browser’s storage is full, so the notes couldn’t be restored.');
  }
  // What was just restored is, by definition, backed up.
  setBackupState({ backedUpRev: backupState().rev, at: backupState().at || data.exported });
  renderLibrary();
  renderStorageNote();
  if (loaded.length) reanalyze();
  const total = data.assignments.length;
  toast(`Restored from backup: ${added} new assignment${added === 1 ? '' : 's'} (${total - added - skipped} already here)` +
    `${notes ? `, check-in notes for ${notes} submission${notes === 1 ? '' : 's'}` : ''}.${skipped ? ` ${skipped} couldn’t be read.` : ''}`, 7000);
}

$('#backup-btn').addEventListener('click', downloadBackup);
$('#restore-input').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    await restoreBackup(await f.text());
  } catch (err) {
    toast(err.message, 6000);
  }
});

function renderLibrary() {
  const box = $('#assign-list');
  box.innerHTML = '';
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
      c.allow_demo_tsa ? 'test assignment' : null,
    ].filter(Boolean).join(' · ');
    box.append(h('div', { class: 'assign-row' },
      h('div', { class: 'row' },
        h('strong', null, c.title), a.demo && h('span', { class: 'pill', 'data-tip': 'Added with the demo class' }, 'demo'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', 'data-tip': `Copy the link to give students:\n${link}`, onclick: () => copyText(link) }, 'Copy link'),
        h('button', { class: 'btn small ghost', type: 'button', 'data-tip': 'Copy the short code (students can paste it instead of the link)', onclick: () => copyText(a.code) }, 'Code'),
        h('a', { class: 'btn small ghost', href: link, target: '_blank', rel: 'noopener', 'data-tip': 'Open the student page for this assignment in a new tab' }, 'Try'),
        h('button', {
          class: 'btn small ghost', type: 'button', 'data-tip': 'Remove from this browser',
          onclick: () => {
            if (!confirm(`Remove "${c.title}" from this browser? You can import its code again later.`)) return;
            library = library.filter((x) => x !== a);
            saveLibrary(library);
            renderLibrary();
          },
        }, 'Remove')),
      h('div', { class: 'small muted' }, pol)));
  }
}

// thresholds form
const thBox = $('#f-thresholds');
for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
  thBox.append(h('label', { for: `th-${k}` }, THRESHOLD_LABELS[k] || k), h('input', { type: 'number', id: `th-${k}`, value: v, step: 'any', min: 0, 'data-tip': `Default: ${v}` }));
}

$('#new-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
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
  });
  await addToLibrary(config);
  renderLibrary();
  $('#new-form').reset();
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) $(`#th-${k}`).value = v;
  presetDemo();
  toast(`Created "${config.title}". Use Copy link to share it with students, and Download backup to keep it safe.`, 7000);
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
  const outcomes = F.prompts.map((p) => (n.prompts && n.prompts[p.i] && n.prompts[p.i].outcome) || '');
  const asked = outcomes.filter(Boolean).length;
  const follow = outcomes.filter((o) => o === 'follow').length + Object.values(n.flags || {}).filter((d) => d === 'concern').length;
  return { asked, total: F.prompts.length, follow, any: asked > 0 || !!n.summary };
}

let filter = 'all';
const FILTERS = {
  all: ['All', () => true],
  flagged: ['Flagged', (F) => F.flags.length > 0],
  integrity: ['Integrity failed', (F) => F.integrity.some((c) => c.status === 'fail')],
  todo: ['Not checked in', (F, s) => !s.any],
  follow: ['Follow-up', (F, s) => s.follow > 0],
};

async function addFiles(entries) {
  const status = $('#load-status');
  const errors = [];
  // Expand LMS zips; keep only .draftwork files from inside them.
  const files = [];
  for (const e of entries) {
    if (isZip(e.bytes)) {
      status.textContent = `Opening ${e.name}…`;
      try {
        const inner = (await readZip(e.bytes)).filter((x) => /\.draftwork$/i.test(x.name));
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
        await restoreBackup(new TextDecoder().decode(bytes));
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
  renderGroups();
}

// Re-run the config check after the library changes.
async function reanalyze() {
  if (!loaded.length) return;
  for (const item of loaded) item.A = await analyzeFile(item.A.file, { knownConfigHashes: knownHashes() });
  renderGroups();
}

function finalized(item) {
  const A = item.A;
  const cohort = loaded.filter((x) => x.A.cfgHash === A.cfgHash).map((x) => x.A);
  const priors = loaded.filter((x) => x.A !== A && x.A.cfgHash !== A.cfgHash && normLabel(x.A.header.student_label) === normLabel(A.header.student_label))
    .map((x) => x.A);
  return finalize(A, { cohort, priors });
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

function renderGroups() {
  const box = $('#groups');
  box.innerHTML = '';
  const known = knownHashes();
  if (loaded.length) {
    box.append(h('div', { class: 'row filters', role: 'group', 'aria-label': 'Show' },
      h('span', { class: 'small muted' }, 'Show:'),
      Object.entries(FILTERS).map(([k, [label]]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(filter === k),
        onclick: () => {
          filter = k;
          renderGroups();
        },
      }, label))));
  }
  for (const [hash, items] of groupsOf()) {
    const cfg = items[0].A.config;
    const min = items[0].A.T.min_class_size;
    const shown = items.map((item) => ({ item, F: finalized(item) }))
      .map((x) => ({ ...x, s: checkinStatus(x.item, x.F) }))
      .filter((x) => FILTERS[filter][1](x.F, x.s));
    const rows = shown.map(({ item, F, s }) => {
      const fails = F.integrity.filter((c) => c.status === 'fail').length;
      const warns = F.integrity.filter((c) => c.status !== 'pass' && c.status !== 'fail').length;
      const integrityTip = F.integrity.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`).join('\n') || 'All integrity checks passed';
      const lmsMismatch = item.lms && item.lms.name && !namesMatch(item.lms.name, F.header.student_label);
      return h('tr', { class: 'clickable', tabindex: '0', onclick: () => openDetail(item, 'overview'), onkeydown: (e) => e.key === 'Enter' && openDetail(item, 'overview') },
        h('td', null, h('strong', null, F.header.student_label || '(no label)'),
          h('div', { class: `small ${lmsMismatch ? 'warn-text' : 'muted'}`, 'data-tip': lmsMismatch ? `The LMS says this was submitted by “${item.lms.name}”, which doesn’t obviously match the name in the file.` : null },
            item.lms && item.lms.name ? `${item.lms.lms}: ${item.lms.name}` : item.name)),
        h('td', null, countWords(F.file.final.text).toLocaleString()),
        h('td', null, F.sessions.length),
        h('td', null, fmtDuration(F.raw.active)),
        h('td', null, h('span', { 'data-tip': integrityTip },
          fails ? h('span', { class: 'pill bad' }, `${fails} failed`) : warns ? h('span', { class: 'pill warn' }, 'Passed*') : h('span', { class: 'pill ok' }, 'Passed'))),
        h('td', null, F.flags.length ? h('div', { class: 'chips' }, [...new Set(F.flags.map((f) => f.title))].map((t) => h('span', { class: `pill ${t === 'Integrity failure' ? 'bad' : 'warn'}` }, t))) : h('span', { class: 'muted small' }, '—')),
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
            h('span', { 'data-tip': `The “too fast” and “machine-regular rhythm” flags compare students with each other, so they need at least ${min} submissions.` },
              classOn ? ' · class comparisons on' : ` · class comparisons need ${min}`)))),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'Student'), h('th', null, 'Words'),
          h('th', { 'data-tip': 'Separate sittings' }, 'Sessions'),
          h('th', { 'data-tip': 'Writing time, not counting breaks over 5 minutes' }, 'Time'),
          h('th', { 'data-tip': 'Whether the file is intact and was written in Draftwork' }, 'Integrity'),
          h('th', { 'data-tip': 'Moments worth asking about' }, 'Flags'),
          h('th', { 'data-tip': 'Your check-in progress, from the notes you record under “Questions to ask”' }, 'Check-in'),
          h('th', null, ''))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 8, class: 'muted small' }, 'No submissions match this filter.')))))));
  }
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
  const group = groupsOf().get(item.A.cfgHash);
  const k = group.indexOf(item);
  $('#prev').disabled = k <= 0;
  $('#next').disabled = k >= group.length - 1;
  window.scrollTo(0, 0);
}

function step(d) {
  const group = groupsOf().get(current.A.cfgHash);
  const k = group.indexOf(current) + d;
  if (group[k]) openDetail(group[k]);
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
  const flagIds = ['gap', 'untrusted', 'unusual', 'retype', 'transcription', 'away', 'fast', 'rhythm', 'overlap', 'quotes'];
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
      row.outcomes = F.prompts.map((p) => (n.prompts && n.prompts[p.i] && n.prompts[p.i].outcome) || '-').join(' ');
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
