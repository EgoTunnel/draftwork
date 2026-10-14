import { $, $$, h, toast, copyText, LOGO } from './ui/dom.js';
import {
  newConfig, configHash, encodeConfig, decodeConfig, parseFile, DEFAULT_THRESHOLDS, THRESHOLD_LABELS, countWords,
} from './core/format.js';
import { analyzeFile, finalize, fmtDuration } from './core/analysis.js';
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

function saveLibrary(lib) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch {
    toast('Could not save to this browser’s storage; copy the code somewhere safe.');
  }
}

let library = loadLibrary();
const knownHashes = () => new Set(library.map((a) => a.hash));

const studentLink = (code) => new URL(`student.html#a=${code}`, location.href).href;

async function addToLibrary(config, extra = {}) {
  const hash = await configHash(config);
  if (library.some((a) => a.hash === hash)) return { hash, existed: true };
  library.unshift({ hash, config, code: await encodeConfig(config), added: new Date().toISOString(), ...extra });
  saveLibrary(library);
  return { hash, existed: false };
}

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
  const config = newConfig({
    title: $('#f-title').value,
    paste: $('#f-paste').value,
    sourcesPane: $('#f-sources').checked,
    wordsMin: $('#f-min').value,
    wordsMax: $('#f-max').value,
    tsaUrl: $('#f-tsa').value.trim() || '/tsa',
    thresholds,
  });
  await addToLibrary(config);
  renderLibrary();
  $('#new-form').reset();
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) $(`#th-${k}`).value = v;
  toast(`Created "${config.title}". Use Copy link to share it with students.`);
  reanalyze();
});

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

async function addFiles(entries) {
  const status = $('#load-status');
  let ok = 0;
  const errors = [];
  for (let k = 0; k < entries.length; k++) {
    const { name, bytes } = entries[k];
    status.textContent = `Checking ${k + 1} of ${entries.length}: ${name}…`;
    try {
      const file = await parseFile(bytes);
      const key = `${file.assignment.config_hash}:${normLabel(file.header.student_label)}:${file.final.hash}:${file.events.length}`;
      if (loaded.some((x) => x.key === key)) continue;
      const A = await analyzeFile(file, { knownConfigHashes: knownHashes() });
      loaded.push({ key, name, A });
      ok++;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  status.textContent = `${loaded.length} file${loaded.length === 1 ? '' : 's'} loaded.` + (errors.length ? ` ${errors.length} could not be read.` : '');
  if (errors.length) toast(errors.slice(0, 3).join(' · '), 8000);
  $('#clear-files').classList.toggle('hidden', !loaded.length);
  void ok;
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
  for (const [hash, items] of groupsOf()) {
    const cfg = items[0].A.config;
    const min = items[0].A.T.min_class_size;
    const rows = items.map((item) => {
      const F = finalized(item);
      const fails = F.integrity.filter((c) => c.status === 'fail').length;
      const warns = F.integrity.filter((c) => c.status !== 'pass' && c.status !== 'fail').length;
      const integrityTip = F.integrity.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`).join('\n') || 'All integrity checks passed';
      return h('tr', { class: 'clickable', tabindex: '0', onclick: () => openDetail(item, 'overview'), onkeydown: (e) => e.key === 'Enter' && openDetail(item, 'overview') },
        h('td', null, h('strong', null, F.header.student_label || '(no label)'), h('div', { class: 'small muted' }, item.name)),
        h('td', null, countWords(F.file.final.text).toLocaleString()),
        h('td', null, F.sessions.length),
        h('td', null, fmtDuration(F.raw.active)),
        h('td', null, h('span', { 'data-tip': integrityTip },
          fails ? h('span', { class: 'pill bad' }, `${fails} failed`) : warns ? h('span', { class: 'pill warn' }, 'Passed*') : h('span', { class: 'pill ok' }, 'Passed'))),
        h('td', null, F.flags.length ? h('div', { class: 'chips' }, [...new Set(F.flags.map((f) => f.title))].map((t) => h('span', { class: `pill ${t === 'Integrity failure' ? 'bad' : 'warn'}` }, t))) : h('span', { class: 'muted small' }, '—')),
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
          h('th', null, ''))),
        h('tbody', null, rows)))));
  }
}

let currentTab = 'overview';
function openDetail(item, tab = currentTab) {
  current = item;
  currentTab = tab;
  $('#review-list').classList.add('hidden');
  $('#review-detail').classList.remove('hidden');
  renderReport($('#report'), finalized(item), { mode: 'instructor', tab, onTab: (t) => (currentTab = t) });
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
});

$('#clear-files').addEventListener('click', () => {
  loaded = [];
  renderGroups();
  $('#load-status').textContent = '';
  $('#clear-files').classList.add('hidden');
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

// Demo class (served by `npm run simulate` + server.js; absent on a plain static host).
(async () => {
  try {
    const names = await (await fetch('samples/index.json')).json();
    if (!names.some((n) => n.endsWith('.draftwork'))) return;
    const btn = $('#load-demo');
    btn.classList.remove('hidden');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
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
    });
  } catch { /* no demo */ }
})();

renderLibrary();
