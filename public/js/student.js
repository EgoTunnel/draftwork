import { $, $$, h, toast, download, LOGO } from './ui/dom.js';
import { sha256Hex, hex, sha256Bytes, fingerprintCode } from './core/canon.js';
import { decodeConfig, configHash, diffOp, parseFile, serializeFile, fileName, countWords } from './core/format.js';
import { MARKS, STYLES, HEADING_STYLES } from './core/doc.js';
import { FONTS, SIZES, LINE_SPACINGS, docStyle, docStyleCss } from './core/export.js';
import { Recorder } from './core/recorder.js';
import { isTestAssignment } from './core/demo.js';
import { requestStamp, relayInfo } from './core/tsa.js';
import { getDraft, putDraft, deleteDraft, addVersion, listVersions, getVersion } from './core/store.js';
import { analyzeFile, finalize } from './core/analysis.js';
import { renderReport, AI_USE } from './ui/report.js';
import { Editor } from './ui/editor.js';
import { ICONS } from './ui/icons.js';
import { menuBar } from './ui/menu.js';
import { initTooltips } from './ui/tooltip.js';
import { appearanceButton } from './ui/appearance.js';
import { downloadDocx, downloadTxt, printDoc } from './ui/docui.js';

initTooltips();
for (const id of ['#brand', '#brand3']) $(id).insertAdjacentHTML('afterbegin', LOGO);
$('#brand2').innerHTML = LOGO;
for (const slot of $$('.appearance-slot')) slot.append(appearanceButton());
const icon = (sel, name) => {
  $(sel).innerHTML = ICONS[name];
};
icon('#nav-close', 'close');
icon('#cite-skip', 'close');
icon('#sources-close', 'close');
icon('#symbols-close', 'close');
icon('#find-prev', 'up');
icon('#find-next', 'down');
icon('#find-toggle-replace', 'replace');
icon('#find-close', 'close');
icon('#view-page', 'pageView');
icon('#view-web', 'webView');
icon('#zoom-out', 'minus');
icon('#zoom-in', 'plus');

const STAMP_GAP_WARN_MS = 8 * 60_000;
const STAMP_RETRY_MS = 15_000;

let config = null;
let cfgHash = null;
let rec = null;
let editor = null;
let draftKey = null;
let dirty = false;
const cpCreated = new Map();
const clips = new Map(); // text copied inside the sandbox -> { pane, runs }

// ---------- editor preferences (this browser) ----------

const PREF_KEY = 'draftwork.editor';
const prefs = (() => {
  const d = { zoom: 100, layout: 'page', nav: false, sources: true, spell: true, smartQuotes: true, autoLists: true, citePrompt: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
  } catch {
    return d;
  }
})();
function setPref(k, v) {
  prefs[k] = v;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch { /* not persisted */ }
  applyPrefs();
}

const show = (id) => {
  for (const s of ['#screen-setup', '#screen-writer', '#screen-ended']) $(s).classList.toggle('hidden', s !== id);
};

function refuse(msg) {
  const el = $('#refusal');
  el.innerHTML = '';
  el.append(h('strong', null, 'Can’t start writing. '), msg,
    h('div', { style: 'margin-top:6px' }, 'If you can’t work online on a computer for this assignment, contact your instructor.'));
  el.classList.remove('hidden');
}

const isDesktop = () => !(matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);

// Draftwork's automated tests run in Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi).
const isTested = () => {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  return brands.some((b) => /Chromium/.test(b.brand)) || (/Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent));
};

async function checkConnection() {
  const simulated = String(config.tsa_url).startsWith('demo:');
  if (!simulated && !navigator.onLine) throw new Error('This computer is offline.');
  const info = await relayInfo(simulated ? config.tsa_url : new URL(config.tsa_url, location.href).href);
  if (info && info.mode === 'mock' && !config.allow_demo_tsa) {
    throw new Error('This Draftwork server is in test mode, so your work couldn’t be verified. Let your instructor know.');
  }
  try {
    await requestStamp(config.tsa_url, await sha256Hex(`draftwork-connection-check:${config.nonce}:${Date.now()}`), { timeoutMs: 12_000 });
  } catch {
    throw new Error('The timestamp service can’t be reached. Check your internet connection and try again.');
  }
}

// ---------- setup ----------

async function openAssignment(code) {
  config = await decodeConfig(code);
  cfgHash = await configHash(config);
  draftKey = `draft:${cfgHash}`;
  document.title = `${config.title} · Draftwork`;
  $('#need-code').classList.add('hidden');
  $('#assignment-card').classList.remove('hidden');
  $('#a-title').textContent = config.title;
  const p = config.policy;
  const pol = $('#a-policy');
  pol.innerHTML = '';
  pol.append(...[
    h('li', { 'data-tip': p.paste === 'block' ? 'You can still cut, copy and paste within your own document.' : 'Pasted text is labelled in the record.' },
      p.paste === 'block' ? 'Pasting from other sources is off' : 'Pasting from other sources is allowed'),
    p.sources_pane && h('li', { 'data-tip': 'A side panel where you can paste quotes, then copy them into your writing.' }, 'Sources panel for quotes'),
    (p.words_min || p.words_max) && h('li', null, `${p.words_min || 0}–${p.words_max || 'any'} words`),
    config.due && h('li', null, `Due ${new Date(config.due).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}`),
    isTestAssignment(config)
      ? h('li', { class: 'warn-text', 'data-tip': 'Timestamps are simulated, so this file can’t prove when it was written. Fine for trying Draftwork out; real assignments use a timestamp service.' }, 'Test assignment: for trying Draftwork out')
      : h('li', { 'data-tip': 'Your work is timestamped as you go, so you need to stay connected.' }, 'Needs an internet connection'),
  ].filter(Boolean));
  if (!isTested()) {
    $('#browser-note').classList.remove('hidden');
  }
  if (!isDesktop()) {
    refuse('Draftwork works on desktop and laptop computers.');
    return;
  }
  let saved = null;
  try {
    saved = await getDraft(draftKey);
  } catch { /* storage unavailable */ }
  renderVersions();
  if (saved) {
    lastFileSave = saved.lastFileSave || 0;
    eventsAtFileSave = saved.eventsAtFileSave || 0;
  }
  if (saved && saved.file) {
    const f = saved.file;
    $('#resume-info').textContent = `${f.header.student_label} · ${countWords(f.final.text)} words · saved ${new Date(saved.savedAt).toLocaleString()}`;
    $('#resume-card').classList.remove('hidden');
    $('#resume-btn').onclick = () => begin(() => Recorder.resume(f, recOpts()));
    $('#resume-save').onclick = async () => saveFileFrom(f);
    $('#discard-btn').onclick = async () => {
      if (!confirm('Discard this draft from this browser? This can’t be undone.')) return;
      await deleteDraft(draftKey);
      location.reload();
    };
  } else {
    $('#new-card').classList.remove('hidden');
  }
  $('#file-card').classList.remove('hidden');
}

async function renderVersions() {
  let versions = [];
  try {
    versions = await listVersions(cfgHash);
  } catch { /* storage unavailable */ }
  const card = $('#versions-card');
  card.classList.toggle('hidden', !versions.length);
  const list = $('#versions-list');
  list.innerHTML = '';
  for (const v of versions) {
    list.append(h('div', { class: 'row' },
      h('span', null, new Date(v.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
      h('span', { class: 'muted small' }, `${v.words.toLocaleString()} words`),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn small', type: 'button', 'data-tip': 'Continue writing from this version. Your current draft is kept as another version.',
        onclick: async () => {
          if (!confirm('Continue from this earlier version? Everything written after it will not be part of your submission, though your current draft stays in this list.')) return;
          try {
            const cur = await getDraft(draftKey);
            if (cur && cur.file) await addVersion(cfgHash, cur.file, countWords(cur.file.final.text));
          } catch { /* best effort */ }
          const file = await getVersion(v.key);
          begin(() => Recorder.resume(file, recOpts()));
        },
      }, 'Restore')));
  }
}

function recOpts() {
  return {
    stamper: (hashHex) => requestStamp(config.tsa_url, hashHex),
    onChange: (what, payload) => {
      if (what === 'event') dirty = true;
      if (what === 'checkpoint') {
        cpCreated.set(payload.c, Date.now());
        saveDraft();
      }
      if (what === 'stamp' || what === 'stamp-error') updateStampPill();
    },
  };
}

// One tab per draft: two tabs writing the same draft would record conflicting sessions.
let haveLock = false;
function takeLock() {
  if (haveLock || !navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(`draftwork:${cfgHash}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      haveLock = true;
      resolve(true);
      return new Promise(() => {}); // held until the page closes
    });
  });
}

async function begin(makeRecorder) {
  $('#refusal').classList.add('hidden');
  const status = $('#start-status');
  status.textContent = 'Connecting…';
  for (const b of $$('#screen-setup button')) b.disabled = true;
  try {
    if (!(await takeLock())) throw new Error('This assignment is already open in another tab or window. Close it there, then try again.');
    await checkConnection();
    rec = await makeRecorder();
    for (const cp of rec.unstamped()) cpCreated.set(cp.c, Date.now());
    startWriting();
  } catch (err) {
    refuse(err.message);
  } finally {
    status.textContent = '';
    for (const b of $$('#screen-setup button')) b.disabled = false;
  }
}

$('#new-card').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const label = $('#label-input').value.trim();
  if (!label) return;
  begin(() => Recorder.create({
    ...recOpts(),
    config,
    cfgHash,
    header: {
      student_label: label,
      created: new Date().toISOString(),
      process_notes: $('#notes-input').value.trim(),
      dictation_mode: $('#dictation-input').checked,
      attachments: [],
      consent: { at: new Date().toISOString(), notice: 1 },
    },
  }));
});

$('#continue-file').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const file = await parseFile(new Uint8Array(await f.arrayBuffer()));
    if (file.assignment.config_hash !== cfgHash) throw new Error('That file belongs to a different assignment.');
    begin(() => Recorder.resume(file, recOpts()));
  } catch (err) {
    toast(err.message, 6000);
  }
  ev.target.value = '';
});

$('#code-btn').addEventListener('click', () => {
  const code = $('#code-input').value;
  const m = code.match(/[#?&]a=([A-Za-z0-9_-]+)/);
  location.hash = `a=${m ? m[1] : code.trim()}`;
  location.reload();
});

// ---------- writing ----------

const ed = $('#editor');
const sheet = $('#sheet');
const desk = $('#desk');
const srcEd = $('#sources');

function startWriting() {
  show('#screen-writer');
  $('#w-title').textContent = config.title;
  $('#policy-note').textContent = config.policy.paste === 'block' ? 'Outside pasting off' : '';
  $('#policy-note').dataset.tip = 'Pasting from other sources is turned off for this assignment. Moving your own text is fine.';
  if (!rec.header.doc_style) rec.header.doc_style = docStyle();
  srcEd.value = srcLast = rec.src;
  rec.startSession();
  if (!editor) {
    editor = new Editor(ed, {
      rec,
      policy: config.policy,
      clips,
      scroller: desk,
      prefs: () => prefs,
      onChange: onDocChange,
      onSelection: updateToolbar,
      onBlocked: (kind) => toast(kind === 'menu'
        ? 'Use Ctrl+V to paste.'
        : 'Pasting from other sources is off for this assignment. You can paste quotes into the Sources panel.', 5000),
      onUntrusted: () => toast('A browser extension or script tried to change your text. The change was undone.', 6000),
      onExternalPaste: (e) => askCitation(e),
      onAnnounce: (msg) => {
        const live = $('#sr-status');
        live.textContent = '';
        setTimeout(() => (live.textContent = msg), 30);
      },
      keys: { save: saveNow, print: printNow, find: () => openFind(false), replace: () => openFind(true) },
    });
    buildToolbar();
    buildMenus();
  } else if (editor.rec !== rec) {
    editor.rec = rec;
    editor.undoStack = [];
    editor.redoStack = [];
    editor.render(true);
  }
  applyDocStyle();
  applyPrefs();
  ed.focus();
  editor.setSel(rec.text.length, rec.text.length);
  onDocChange();
  updateStampPill();
  updateDue();
  updateFileSaveStatus();
  saveDraft();
}

function applyDocStyle() {
  sheet.setAttribute('style', docStyleCss(rec.header.doc_style) + `;zoom:${prefs.zoom / 100}`);
}

function setDocStyle(patch) {
  rec.header.doc_style = { ...docStyle(rec.header.doc_style), ...patch };
  applyDocStyle();
  dirty = true;
  updateToolbar();
  pagesLater();
}

function applyPrefs() {
  if (!rec) return;
  sheet.classList.toggle('web', prefs.layout === 'web');
  $('#view-page').setAttribute('aria-pressed', String(prefs.layout === 'page'));
  $('#view-web').setAttribute('aria-pressed', String(prefs.layout === 'web'));
  $('#navpane').classList.toggle('hidden', !prefs.nav);
  const hasSources = config.policy.sources_pane;
  $('#sources-pane').classList.toggle('hidden', !(hasSources && prefs.sources));
  $('#writer-body').classList.toggle('with-sources', !!(hasSources && prefs.sources));
  $('#writer-body').classList.toggle('with-nav', prefs.nav);
  ed.spellcheck = prefs.spell;
  $('#zoom').value = prefs.zoom;
  $('#zoom-label').textContent = `${prefs.zoom}%`;
  applyDocStyle();
  updateToolbar();
  pagesLater();
}

let navTimer = null;
function onDocChange() {
  updateWords();
  pagesLater();
  clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    renderNav();
    if (!$('#findbar').classList.contains('hidden')) runFind(false);
  }, 250);
}

// ---------- toolbar ----------

const tbButtons = {};

function tb(key, iconName, tip, action, label) {
  const b = h('button', { class: 'tb-btn', type: 'button', 'aria-label': label || tip.replace(/ \(.*\)$/, ''), 'data-tip': tip, html: ICONS[iconName] });
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection in the document
  b.addEventListener('click', () => {
    action();
    if (editor && !$('#findbar').contains(document.activeElement)) ed.focus({ preventScroll: true });
  });
  tbButtons[key] = b;
  return b;
}

function tbSelect(key, tip, options, onPick, width) {
  const s = h('select', { class: 'tb-select', 'aria-label': tip.replace(/ \(.*\)$/, ''), 'data-tip': tip, style: width ? `width:${width}` : null },
    options.map(([v, label]) => h('option', { value: v }, label)));
  s.addEventListener('change', () => {
    onPick(s.value);
    editor.focus();
  });
  tbButtons[key] = s;
  return s;
}

const sep = () => h('span', { class: 'tb-sep', 'aria-hidden': 'true' });
const mark = (bit) => () => editor.toggleMark(bit);

function buildToolbar() {
  const bar = $('#toolbar');
  bar.append(
    tb('undo', 'undo', 'Undo (Ctrl+Z)', () => editor.undo()),
    tb('redo', 'redo', 'Redo (Ctrl+Y)', () => editor.redo()),
    sep(),
    tbSelect('style', 'Paragraph style', Object.entries(STYLES), (s) => editor.setParaAttr({ s }, 'formatStyle'), '8.5em'),
    tbSelect('font', 'Font (whole document)', Object.entries(FONTS).map(([k, f]) => [k, f.label]), (font) => setDocStyle({ font }), '11.5em'),
    tbSelect('size', 'Font size in points (whole document)', SIZES.map((v) => [v, String(v)]), (size) => setDocStyle({ size: Number(size) }), '4.2em'),
    sep(),
    tb('b', 'bold', 'Bold (Ctrl+B)', mark(MARKS.b)),
    tb('i', 'italic', 'Italic (Ctrl+I)', mark(MARKS.i)),
    tb('u', 'underline', 'Underline (Ctrl+U)', mark(MARKS.u)),
    tb('s', 'strike', 'Strikethrough', mark(MARKS.s)),
    tb('sup', 'sup', 'Superscript (Ctrl+Shift+=)', mark(MARKS.sup)),
    tb('sub', 'sub', 'Subscript (Ctrl+=)', mark(MARKS.sub)),
    tb('hl', 'highlight', 'Highlight', mark(MARKS.hl)),
    tb('clear', 'clear', 'Clear formatting (Ctrl+Space)', () => editor.clearFormatting()),
    sep(),
    tb('ul', 'ul', 'Bulleted list (Ctrl+Shift+L)', () => editor.toggleList('ul')),
    tb('ol', 'ol', 'Numbered list', () => editor.toggleList('ol')),
    tb('outdent', 'outdent', 'Decrease indent (Shift+Tab)', () => editor.indent(-1)),
    tb('indent', 'indent', 'Increase indent (Tab)', () => editor.indent(1)),
    sep(),
    tb('al-l', 'alignL', 'Align left (Ctrl+L)', () => editor.setParaAttr({ al: 'l' }, 'formatJustifyLeft')),
    tb('al-c', 'alignC', 'Center (Ctrl+E)', () => editor.setParaAttr({ al: 'c' }, 'formatJustifyCenter')),
    tb('al-r', 'alignR', 'Align right (Ctrl+R)', () => editor.setParaAttr({ al: 'r' }, 'formatJustifyRight')),
    tb('al-j', 'alignJ', 'Justify (Ctrl+J)', () => editor.setParaAttr({ al: 'j' }, 'formatJustifyFull')),
    tbSelect('line', 'Line spacing (whole document)', LINE_SPACINGS.map((v) => [v, v.toFixed(v === 1 || v === 2 ? 1 : 2)]), (line) => setDocStyle({ line: Number(line) }), '4.6em'),
    sep(),
    tb('symbol', 'symbol', 'Special characters', openSymbols),
    tb('find', 'find', 'Find and replace (Ctrl+F)', () => openFind(false)),
    sep(),
    tb('nav', 'nav', 'Navigation pane: jump between headings', () => setPref('nav', !prefs.nav)),
    ...(config.policy.sources_pane ? [tb('sources', 'sources', 'Sources panel', () => setPref('sources', !prefs.sources))] : []),
  );
  // One tab stop for the whole toolbar; arrow keys move between controls (WAI-ARIA toolbar pattern).
  const items = () => [...bar.querySelectorAll('button, select')].filter((x) => !x.disabled);
  const setStop = (el) => {
    for (const x of bar.querySelectorAll('button, select')) x.tabIndex = -1;
    el.tabIndex = 0;
  };
  setStop(items()[0]);
  bar.addEventListener('focusin', (e) => setStop(e.target));
  bar.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (e.target.tagName === 'SELECT' && !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const list = items();
    const i = list.indexOf(e.target);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[next].focus();
  });
}

function updateToolbar(state = editor && editor.state()) {
  if (!state || !tbButtons.b) return;
  const press = (k, on) => tbButtons[k] && tbButtons[k].setAttribute('aria-pressed', String(!!on));
  press('b', state.marks & MARKS.b);
  press('i', state.marks & MARKS.i);
  press('u', state.marks & MARKS.u);
  press('s', state.marks & MARKS.s);
  press('sup', state.marks & MARKS.sup);
  press('sub', state.marks & MARKS.sub);
  press('hl', state.marks & MARKS.hl);
  press('ul', state.para.li === 'ul');
  press('ol', state.para.li === 'ol');
  for (const al of ['l', 'c', 'r', 'j']) press(`al-${al}`, state.para.al === al);
  press('nav', prefs.nav);
  press('sources', prefs.sources);
  tbButtons.undo.disabled = !state.canUndo;
  tbButtons.redo.disabled = !state.canRedo;
  tbButtons.style.value = state.para.s;
  const ds = docStyle(rec.header.doc_style);
  tbButtons.font.value = ds.font;
  tbButtons.size.value = String(ds.size);
  tbButtons.line.value = String(ds.line);
  updateWords();
}

// ---------- menus ----------

function buildMenus() {
  const cmd = (fn) => () => {
    editor.focus();
    fn();
  };
  const markItem = (label, bit, shortcut) => ({ label, shortcut, checked: () => !!(editor.activeMarks() & bit), action: cmd(() => editor.toggleMark(bit)) });
  const para = () => editor.state().para;
  $('#menus').append(menuBar([
    {
      label: 'File',
      items: () => [
        { label: 'Save file', shortcut: 'Ctrl+S', action: saveNow, tip: 'Download your submission file (.draftwork) to upload to your course' },
        { label: 'Download as Word (.docx)', action: () => downloadDocx(rec.doc, rec.header.doc_style, config.title), tip: 'A copy for your own use. Submit the .draftwork file.' },
        { label: 'Download as text (.txt)', action: () => downloadTxt(rec.doc, config.title) },
        { label: 'Print…', shortcut: 'Ctrl+P', action: printNow },
        '-',
        { label: 'Notes…', action: openNotes, tip: 'Tell your instructor how you worked, or attach an outline' },
        { label: 'Preview', action: openPreview, tip: 'See your work the way your instructor will' },
        '-',
        { label: 'End session', action: endSession, tip: 'Stop writing for now. You can continue later.' },
      ],
    },
    {
      label: 'Edit',
      items: () => [
        { label: 'Undo', shortcut: 'Ctrl+Z', disabled: () => !editor.canUndo(), action: cmd(() => editor.undo()) },
        { label: 'Redo', shortcut: 'Ctrl+Y', disabled: () => !editor.canRedo(), action: cmd(() => editor.redo()) },
        '-',
        { label: 'Cut', shortcut: 'Ctrl+X', action: cmd(() => document.execCommand('cut')) },
        { label: 'Copy', shortcut: 'Ctrl+C', action: cmd(() => document.execCommand('copy')) },
        { label: 'Paste', shortcut: 'Ctrl+V', action: cmd(() => editor.pasteFromMenu()) },
        { label: 'Select all', shortcut: 'Ctrl+A', action: cmd(() => editor.setSel(0, rec.text.length, false)) },
        '-',
        { label: 'Find…', shortcut: 'Ctrl+F', action: () => openFind(false) },
        { label: 'Replace…', shortcut: 'Ctrl+H', action: () => openFind(true) },
      ],
    },
    {
      label: 'View',
      items: () => [
        { label: 'Page view', checked: () => prefs.layout === 'page', action: () => setPref('layout', 'page') },
        { label: 'Full-width view', checked: () => prefs.layout === 'web', action: () => setPref('layout', 'web') },
        '-',
        { label: 'Navigation pane', checked: () => prefs.nav, action: () => setPref('nav', !prefs.nav) },
        { label: 'Sources panel', checked: () => prefs.sources, hidden: () => !config.policy.sources_pane, action: () => setPref('sources', !prefs.sources) },
        '-',
        { label: 'Zoom in', action: () => zoomBy(10) },
        { label: 'Zoom out', action: () => zoomBy(-10) },
        { label: 'Actual size', action: () => setPref('zoom', 100) },
        '-',
        {
          label: 'Full screen', checked: () => !!document.fullscreenElement,
          action: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
        },
      ],
    },
    {
      label: 'Insert',
      items: () => [
        { label: 'Page break', shortcut: 'Ctrl+Enter', action: cmd(() => editor.pageBreak()), tip: 'Start the next part on a new page' },
        { label: 'Special character…', action: openSymbols },
        '-',
        { label: 'Works Cited heading', action: cmd(() => insertWorksCited()), tip: 'Starts a new page with a centered “Works Cited” heading; entries below get a hanging indent' },
      ],
    },
    {
      label: 'Format',
      items: () => [
        markItem('Bold', MARKS.b, 'Ctrl+B'),
        markItem('Italic', MARKS.i, 'Ctrl+I'),
        markItem('Underline', MARKS.u, 'Ctrl+U'),
        markItem('Strikethrough', MARKS.s),
        markItem('Superscript', MARKS.sup, 'Ctrl+Shift+='),
        markItem('Subscript', MARKS.sub, 'Ctrl+='),
        markItem('Highlight', MARKS.hl),
        { label: 'Clear formatting', shortcut: 'Ctrl+Space', action: cmd(() => editor.clearFormatting()) },
        '-',
        { header: 'Paragraph style' },
        ...Object.entries(STYLES).map(([s, label]) => ({
          label, checked: () => para().s === s,
          shortcut: { p: 'Ctrl+Alt+0', h1: 'Ctrl+Alt+1', h2: 'Ctrl+Alt+2', h3: 'Ctrl+Alt+3' }[s],
          action: cmd(() => editor.setParaAttr({ s }, 'formatStyle')),
        })),
        '-',
        { header: 'Alignment' },
        ...[['l', 'Left', 'Ctrl+L'], ['c', 'Center', 'Ctrl+E'], ['r', 'Right', 'Ctrl+R'], ['j', 'Justify', 'Ctrl+J']].map(([al, label, shortcut]) => ({
          label, shortcut, checked: () => para().al === al, action: cmd(() => editor.setParaAttr({ al }, 'formatAlign')),
        })),
        '-',
        { label: 'Bulleted list', shortcut: 'Ctrl+Shift+L', checked: () => para().li === 'ul', action: cmd(() => editor.toggleList('ul')) },
        { label: 'Numbered list', checked: () => para().li === 'ol', action: cmd(() => editor.toggleList('ol')) },
        { label: 'Increase indent', shortcut: 'Tab', action: cmd(() => editor.indent(1)) },
        { label: 'Decrease indent', shortcut: 'Shift+Tab', action: cmd(() => editor.indent(-1)) },
        '-',
        { label: 'Page break before', checked: () => !!para().pb, action: cmd(() => editor.setParaAttr({ pb: !para().pb }, 'formatPageBreak')), tip: 'Start this paragraph on a new page' },
        '-',
        { header: 'Whole document' },
        { label: 'Page numbers', checked: () => docStyle(rec.header.doc_style).pageNumbers, action: () => setDocStyle({ pageNumbers: !docStyle(rec.header.doc_style).pageNumbers }), tip: 'Number the pages when printing or downloading for Word' },
        { label: 'Space after paragraphs', checked: () => docStyle(rec.header.doc_style).after, action: () => setDocStyle({ after: !docStyle(rec.header.doc_style).after }) },
        { label: 'Indent first lines', checked: () => docStyle(rec.header.doc_style).firstLine, action: () => setDocStyle({ firstLine: !docStyle(rec.header.doc_style).firstLine }) },
      ],
    },
    {
      label: 'Tools',
      items: () => [
        { label: 'Word count…', action: openCount },
        { label: 'Special characters…', action: openSymbols },
        '-',
        { label: 'Check spelling', checked: () => prefs.spell, action: () => setPref('spell', !prefs.spell), tip: 'Underline misspelled words (uses your browser’s spell checker)' },
        { label: 'Smart quotes and dashes', checked: () => prefs.smartQuotes, action: () => setPref('smartQuotes', !prefs.smartQuotes), tip: 'Turn straight quotes into curly ones and -- into an em dash as you type' },
        { label: 'Automatic lists', checked: () => prefs.autoLists, action: () => setPref('autoLists', !prefs.autoLists), tip: 'Typing "- " or "1. " at the start of a line starts a list' },
        { label: 'Ask where pasted text is from', checked: () => prefs.citePrompt, action: () => setPref('citePrompt', !prefs.citePrompt), tip: 'After you paste from another source, a small box asks for the author, title or link' },
      ],
    },
  ], { onClose: () => editor && editor.focus() }));
}

// Works Cited: a new page, a centered heading, then an empty entry paragraph with a hanging indent.
function insertWorksCited() {
  const len = rec.text.length;
  editor.setSel(len, len, false);
  editor.batch(() => {
    const k = rec.doc.paras.length - 1;
    const [ps, pe] = rec.doc.paraBounds()[k];
    let head = k;
    if (pe > ps) {
      editor.emit({ k: 'ins', p: len, x: '\n', it: 'insertWorksCited' });
      head = k + 1;
    }
    editor.emit({ k: 'ins', p: rec.text.length, x: 'Works Cited', it: 'insertWorksCited' });
    editor.emit({ k: 'para', a: head, b: 1, set: { s: 'p', al: 'c', li: '', in: 0, pb: true }, it: 'insertWorksCited' });
    editor.emit({ k: 'ins', p: rec.text.length, x: '\n', it: 'insertWorksCited' });
    editor.emit({ k: 'para', a: head + 1, b: 1, set: { s: 'bib', al: 'l' }, it: 'insertWorksCited' });
  });
  editor.after(rec.text.length);
  editor.announce('Works Cited page added');
}

// ---------- status bar, pages, zoom, navigation ----------

function updateWords() {
  if (!editor) return;
  const text = rec.text;
  const total = countWords(text);
  const { start, end } = editor.sel;
  const p = config.policy;
  const label = start !== end ? `${countWords(text.slice(start, end)).toLocaleString()} of ${total.toLocaleString()} words` : `${total.toLocaleString()} word${total === 1 ? '' : 's'}`;
  const btn = $('#sb-words');
  btn.textContent = label;
  const over = p.words_max && total > p.words_max;
  btn.classList.toggle('warn-text', !!over);
  if (p.words_min || p.words_max) {
    const target = p.words_min || p.words_max;
    const pct = Math.min(100, Math.round((total / target) * 100));
    btn.append(h('span', { class: `wbar${over ? ' over' : total >= target ? ' done' : ''}`, 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` })));
  }
  btn.dataset.tip = (p.words_min || p.words_max) ? `Word count details. Required length: ${p.words_min || 0}–${p.words_max || 'any'} words.` : 'Word count details';
}

function updateDue() {
  const el = $('#due-status');
  if (!config || !config.due) {
    el.textContent = '';
    return;
  }
  const due = new Date(config.due);
  const left = due - Date.now();
  const when = due.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let rel;
  if (left < 0) rel = 'past due';
  else if (left < 3600_000) rel = `${Math.max(1, Math.round(left / 60_000))} min left`;
  else if (left < 2 * 86_400_000) rel = `${Math.round(left / 3600_000)} h left`;
  else rel = `${Math.round(left / 86_400_000)} days left`;
  el.textContent = `Due ${when} (${rel})`;
  el.className = left < 0 ? 'bad-text' : left < 86_400_000 ? 'warn-text' : 'muted';
  el.dataset.tip = left < 0 ? 'The due date has passed. You can still write; your instructor will see when each part was written.' : 'The due date set by your instructor';
}
setInterval(() => rec && rec.inSession && updateDue(), 30_000);

let pagesTimer = null;
function pagesLater() {
  clearTimeout(pagesTimer);
  pagesTimer = setTimeout(updatePages, 120);
}

function updatePages() {
  const el = $('#sb-page');
  if (!editor || prefs.layout === 'web') {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const z = prefs.zoom / 100;
  const pageH = 9 * 96 * z; // a letter page has 9 inches of text height
  const r = ed.getBoundingClientRect();
  const total = Math.max(1, Math.ceil((r.height - 1) / pageH));
  let current = 1;
  const s = window.getSelection();
  if (s.rangeCount && ed.contains(s.focusNode)) {
    const rr = s.getRangeAt(0).getBoundingClientRect();
    if (rr.height) current = Math.min(total, Math.max(1, Math.floor((rr.top - r.top) / pageH) + 1));
  }
  el.textContent = `Page ${current} of ${total}`;
}
document.addEventListener('selectionchange', () => editor && pagesLater());

function zoomBy(d) {
  setPref('zoom', Math.max(50, Math.min(200, prefs.zoom + d)));
}
$('#zoom').addEventListener('input', (e) => setPref('zoom', Number(e.target.value)));
$('#zoom-in').addEventListener('click', () => zoomBy(10));
$('#zoom-out').addEventListener('click', () => zoomBy(-10));
$('#zoom-label').addEventListener('click', () => setPref('zoom', 100));
$('#view-page').addEventListener('click', () => setPref('layout', 'page'));
$('#view-web').addEventListener('click', () => setPref('layout', 'web'));
$('#sb-words').addEventListener('click', openCount);
$('#skip-doc').addEventListener('click', (e) => {
  e.preventDefault();
  if (editor) editor.focus();
});
$('#nav-close').addEventListener('click', () => setPref('nav', false));
$('#sources-close').addEventListener('click', () => setPref('sources', false));
// Clicking the page outside the text puts the caret at the nearest end, as in a word processor.
desk.addEventListener('mousedown', (e) => {
  if (!editor || ed.contains(e.target) || e.button !== 0) return;
  e.preventDefault();
  ed.focus({ preventScroll: true });
  const r = ed.getBoundingClientRect();
  const p = e.clientY < r.top ? 0 : rec.text.length;
  editor.setSel(p, p, false);
});
desk.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 10 : -10);
}, { passive: false });

function renderNav() {
  if (!prefs.nav || !rec) return;
  const list = $('#nav-list');
  list.innerHTML = '';
  const bounds = rec.doc.paraBounds();
  const items = [];
  rec.doc.paras.forEach((p, k) => {
    if (!HEADING_STYLES.has(p.s)) return;
    const [s, e] = bounds[k];
    const text = rec.text.slice(s, e).trim();
    if (text) items.push({ s, text, level: { title: 0, h1: 0, h2: 1, h3: 2 }[p.s] });
  });
  if (!items.length) {
    list.append(h('p', { class: 'small muted', style: 'padding:0 12px' }, 'Headings you add appear here.'));
    return;
  }
  for (const it of items) {
    list.append(h('button', {
      class: 'nav-item', type: 'button', style: `padding-left:${12 + it.level * 14}px`,
      onclick: () => {
        ed.focus({ preventScroll: true });
        editor.setSel(it.s, it.s);
      },
    }, it.text));
  }
}

// ---------- find and replace ----------

let matches = [];
let matchIdx = -1;
const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

function openFind(withReplace) {
  const bar = $('#findbar');
  bar.classList.remove('hidden');
  if (withReplace) setReplaceVisible(true);
  const input = $('#find-input');
  const { start, end } = editor.sel;
  const selected = rec.text.slice(start, end);
  if (selected && !selected.includes('\n') && selected.length < 80) input.value = selected;
  input.focus();
  input.select();
  runFind(true);
}

function setReplaceVisible(on) {
  $('#replace-row').classList.toggle('hidden', !on);
  $('#find-toggle-replace').setAttribute('aria-pressed', String(on));
}

function closeFind() {
  $('#findbar').classList.add('hidden');
  if (hasHighlights) {
    CSS.highlights.delete('dw-find');
    CSS.highlights.delete('dw-find-cur');
  }
  const m = matches[matchIdx];
  ed.focus({ preventScroll: true });
  if (m) editor.setSel(m, m + $('#find-input').value.length);
}

function runFind(jump) {
  const q = $('#find-input').value;
  const text = rec.text;
  matches = [];
  if (q) {
    const cs = $('#find-case').getAttribute('aria-pressed') === 'true';
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? q : q.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1 && matches.length < 5000; i = hay.indexOf(needle, i + needle.length)) matches.push(i);
  }
  if (jump || matchIdx >= matches.length) {
    const from = editor.sel.start;
    matchIdx = matches.findIndex((m) => m >= from);
    if (matchIdx === -1) matchIdx = matches.length ? 0 : -1;
  }
  showMatches(jump);
}

function showMatches(scroll) {
  const q = $('#find-input').value;
  $('#find-count').textContent = q ? (matches.length ? `${matchIdx + 1} of ${matches.length}` : 'No results') : '';
  if (!hasHighlights) return;
  const range = (p) => {
    const r = new Range();
    const [a, ao] = editor.pointAt(p);
    const [b, bo] = editor.pointAt(p + q.length);
    r.setStart(a, ao);
    r.setEnd(b, bo);
    return r;
  };
  CSS.highlights.set('dw-find', new Highlight(...matches.slice(0, 1000).map(range)));
  if (matchIdx >= 0) {
    const cur = range(matches[matchIdx]);
    CSS.highlights.set('dw-find-cur', new Highlight(cur));
    if (scroll) {
      const r = cur.getBoundingClientRect();
      const b = desk.getBoundingClientRect();
      if (r.top < b.top + 40 || r.bottom > b.bottom - 40) desk.scrollTop += r.top - b.top - b.height / 3;
    }
  } else CSS.highlights.delete('dw-find-cur');
}

function step(d) {
  if (!matches.length) return;
  matchIdx = (matchIdx + d + matches.length) % matches.length;
  showMatches(true);
}

$('#find-input').addEventListener('input', () => runFind(true));
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  }
});
$('#findbar').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
$('#find-next').addEventListener('click', () => step(1));
$('#find-prev').addEventListener('click', () => step(-1));
$('#find-close').addEventListener('click', closeFind);
$('#find-case').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  runFind(true);
});
$('#find-toggle-replace').addEventListener('click', () => setReplaceVisible($('#replace-row').classList.contains('hidden')));
// Only text typed here (or copied inside the sandbox) can be used as a replacement.
$('#replace-input').addEventListener('paste', (e) => {
  const t = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
  if (clips.has(t) || config.policy.paste === 'allow') return;
  e.preventDefault();
  rec.record({ k: 'paste_blocked', len: t.length, it: 'insertFromPaste' });
  toast('Pasting from other sources is off for this assignment.');
});
$('#replace-input').addEventListener('drop', (e) => e.preventDefault());
$('#replace-one').addEventListener('click', () => {
  if (matchIdx < 0) return;
  const q = $('#find-input').value;
  const p = matches[matchIdx];
  editor.replaceRange(p, p + q.length, $('#replace-input').value);
  runFind(false);
  showMatches(true);
});
$('#replace-all').addEventListener('click', () => {
  if (!matches.length) return;
  const q = $('#find-input').value;
  const x = $('#replace-input').value;
  const n = matches.length;
  editor.batch(() => {
    for (let k = matches.length - 1; k >= 0; k--) editor.replaceRange(matches[k], matches[k] + q.length, x);
  });
  runFind(false);
  toast(`Replaced ${n} match${n === 1 ? '' : 'es'}.`);
});

// ---------- sources panel (plain text) ----------

let srcLast = '';
let srcComposing = false;
let srcPendingPaste = false;

srcEd.addEventListener('beforeinput', (e) => {
  if (!rec || !rec.inSession) return e.preventDefault();
  if (!e.isTrusted) {
    e.preventDefault();
    rec.record({ k: 'untrusted', it: e.inputType, len: (e.data || '').length, pane: 'src' });
  }
});
srcEd.addEventListener('input', (e) => {
  if (!rec || !rec.inSession || e.isComposing || srcComposing) return;
  if (!e.isTrusted) return revertSrc();
  commitSrc(e.inputType);
});
srcEd.addEventListener('compositionstart', () => {
  srcComposing = true;
});
srcEd.addEventListener('compositionend', () => {
  srcComposing = false;
  commitSrc('insertCompositionText');
});
srcEd.addEventListener('paste', () => {
  srcPendingPaste = true;
});
srcEd.addEventListener('drop', (e) => e.preventDefault());
for (const ev of ['copy', 'cut']) {
  srcEd.addEventListener(ev, (e) => {
    if (!e.isTrusted) return;
    const t = srcEd.value.slice(srcEd.selectionStart, srcEd.selectionEnd);
    if (t) clips.set(t, { pane: 'src' });
  });
}

function commitSrc(it) {
  const op = diffOp(srcLast, srcEd.value);
  if (!op) return;
  let k = op.n === 0 ? 'ins' : op.x === '' ? 'del' : 'rep';
  const pasted = srcPendingPaste && op.x;
  if (pasted) k = 'paste_src';
  srcPendingPaste = false;
  const e = rec.record({ k, p: op.p, n: op.n || undefined, x: op.x || undefined, it, pane: 'src' });
  srcLast = srcEd.value;
  // Text copied from Draftwork itself doesn't need a citation.
  if (pasted && !clips.has(op.x)) askCitation(e);
}

// ---------- citation prompt after pasting from outside ----------

let citeFor = null;

function askCitation(e) {
  if (!prefs.citePrompt || !rec || !rec.inSession) return;
  citeFor = e;
  const text = (e.x || '').replace(/\s+/g, ' ').trim();
  $('#cite-snippet').textContent = `“${text.length > 90 ? `${text.slice(0, 90)}…` : text}”`;
  const url = text.match(/https?:\/\/\S+/);
  $('#cite-input').value = url ? url[0] : '';
  $('#cite-bar').classList.remove('hidden');
}

function closeCitation(refocus) {
  $('#cite-bar').classList.add('hidden');
  citeFor = null;
  if (refocus) (prefs.sources && config.policy.sources_pane ? srcEd : ed).focus();
}

function saveCitation() {
  const text = $('#cite-input').value.trim();
  if (citeFor && text && rec && rec.inSession) {
    rec.record({ k: 'cite', of: citeFor.s, x: text });
    toast('Source noted.', 2500);
  }
  closeCitation(true);
}

$('#cite-save').addEventListener('click', saveCitation);
$('#cite-skip').addEventListener('click', () => closeCitation(true));
$('#cite-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    saveCitation();
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeCitation(true);
  }
});

function revertSrc() {
  const len = Math.abs(srcEd.value.length - srcLast.length);
  srcEd.value = srcLast;
  rec.record({ k: 'untrusted', it: 'programmatic', len, pane: 'src' });
}

// ---------- background work ----------

window.addEventListener('blur', () => rec && rec.inSession && rec.record({ k: 'blur' }));
window.addEventListener('focus', () => rec && rec.inSession && rec.record({ k: 'focus' }));
window.addEventListener('pagehide', () => {
  if (rec && rec.inSession) {
    rec.endSession();
    saveDraft();
  }
});

// Script-made changes fire no trusted input events; catch them by comparing with the record.
setInterval(() => {
  if (!rec || !rec.inSession) return;
  if (editor) editor.checkIntegrity();
  if (!srcComposing && srcEd.value !== srcLast) revertSrc();
}, 500);

let lastRetry = 0;
setInterval(() => {
  if (!rec || !rec.inSession) return;
  rec.tick();
  if (rec.unstamped().length && !rec.stamping && Date.now() - lastRetry > STAMP_RETRY_MS) {
    lastRetry = Date.now();
    rec.stampPending();
  }
  updateStampPill();
}, 1000);
setInterval(() => dirty && saveDraft(), 5000);

function updateStampPill() {
  if (!rec) return;
  const pill = $('#stamp-pill');
  const txt = $('#stamp-text');
  const pending = rec.unstamped();
  if (!pending.length && isTestAssignment(config)) {
    pill.className = 'pill';
    txt.textContent = 'Test assignment';
    pill.dataset.tip = 'Timestamps are simulated for this test assignment, so the file can’t prove when it was written.';
    return;
  }
  if (!pending.length) {
    pill.className = 'pill ok';
    txt.textContent = 'Connected';
    pill.dataset.tip = rec.lastStampOk ? `Your progress was last timestamped at ${new Date(rec.lastStampOk).toLocaleTimeString()}.` : 'Your progress is timestamped about once a minute while you write.';
    return;
  }
  const oldest = Math.min(...pending.map((c) => cpCreated.get(c.c) || Date.now()));
  const age = Date.now() - oldest;
  pill.className = age > STAMP_GAP_WARN_MS ? 'pill bad' : 'pill warn';
  txt.textContent = 'Reconnecting…';
  pill.dataset.tip = 'Can’t reach the timestamp service. Keep writing; your progress will be timestamped when the connection returns.' +
    (age > STAMP_GAP_WARN_MS ? ' A gap of more than 10 minutes will be visible to your instructor.' : '');
  if (age > STAMP_GAP_WARN_MS && !updateStampPill.warned) {
    updateStampPill.warned = true;
    toast('No connection for over 8 minutes. Please check your internet connection.', 8000);
  }
  if (age <= STAMP_GAP_WARN_MS) updateStampPill.warned = false;
}

let saving = null;
let lastVersionAt = 0;
const VERSION_EVERY_MS = 10 * 60_000;
async function saveDraft() {
  if (!rec || saving) return saving;
  dirty = false;
  saving = (async () => {
    try {
      const file = structuredClone(await rec.toFile());
      await putDraft(draftKey, { file, savedAt: Date.now(), lastFileSave, eventsAtFileSave });
      if (Date.now() - lastVersionAt > VERSION_EVERY_MS) {
        lastVersionAt = Date.now();
        await addVersion(cfgHash, file, countWords(file.final.text));
      }
      $('#autosave-status').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      $('#autosave-status').dataset.tip = 'Your draft is saved in this browser automatically. Use Save file to get the file you submit.';
    } catch {
      $('#autosave-status').textContent = 'Not saved in browser';
      $('#autosave-status').dataset.tip = 'This browser isn’t letting Draftwork save your draft. Use Save file regularly.';
    } finally {
      saving = null;
    }
  })();
  return saving;
}

// ---------- files, print, preview ----------

async function finalFile() {
  rec.checkpoint();
  await Promise.race([rec.settle(), new Promise((r) => setTimeout(r, 8000))]);
  return structuredClone(await rec.toFile());
}

async function saveFileFrom(file) {
  const p = file.assignment.config.policy;
  const w = countWords(file.final.text);
  const bytes = await serializeFile(file);
  download(bytes, fileName(file), 'application/gzip');
  lastFileSave = Date.now();
  eventsAtFileSave = file.events.length;
  updateFileSaveStatus();
  await showReceipt(file, bytes);
  const notes = [];
  if (p.words_min && w < p.words_min) notes.push(`it’s under the ${p.words_min}-word minimum`);
  if (p.words_max && w > p.words_max) notes.push(`it’s over the ${p.words_max}-word limit`);
  if (notes.length) toast(`Note: ${notes.join(' and ')}.`, 7000);
}

async function showReceipt(file, bytes) {
  const full = await sha256Hex(bytes);
  const code = fingerprintCode(full);
  const when = new Date();
  const words = countWords(file.final.text);
  $('#receipt-name').textContent = fileName(file);
  $('#receipt-code').textContent = code;
  $('#receipt-meta').textContent = `${when.toLocaleString()} · ${words.toLocaleString()} words · ${file.events.length.toLocaleString()} edits recorded`;
  const text = `Draftwork receipt\n${config.title}\n${file.header.student_label}\n${fileName(file)}\nSaved ${when.toLocaleString()}\nFingerprint: ${code}\nSHA-256: ${full}`;
  $('#receipt-copy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Receipt copied'), () => toast('Copy failed'));
  try {
    await putDraft(`receipt:${cfgHash}:${when.getTime()}`, { code, full, name: fileName(file), words, savedAt: when.getTime() });
  } catch { /* not kept */ }
  const dlg = $('#receipt-dlg');
  if (!dlg.open) dlg.showModal();
}
$('#receipt-dlg').addEventListener('close', () => editor && rec && rec.inSession && editor.focus());

// ---------- file-save reminders ----------

let lastFileSave = 0;
let eventsAtFileSave = 0;
const REMIND_MS = 30 * 60_000;
let lastReminder = Date.now();

const unsavedToFile = () => rec && rec.events.length > eventsAtFileSave;

function updateFileSaveStatus() {
  const el = $('#filesave-status');
  if (!rec) return;
  const ago = lastFileSave ? Date.now() - lastFileSave : null;
  const rel = (ms) => (ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3600_000)} h ago`);
  el.textContent = !lastFileSave ? 'File not saved yet' : unsavedToFile() ? `File saved ${rel(ago)}` : 'File up to date';
  const stale = unsavedToFile() && (!lastFileSave || ago > REMIND_MS);
  el.classList.toggle('warn-text', !!stale);
  el.dataset.tip = 'Your draft is kept in this browser, but only the saved file can be submitted, and it protects your work if this browser’s data is cleared. Click to save now.';
  if (stale && rec.inSession && Date.now() - lastReminder > REMIND_MS && rec.events.length - eventsAtFileSave > 200) {
    lastReminder = Date.now();
    toast('Reminder: save your file (Ctrl+S) so your work is safe outside this browser.', 7000);
  }
}
$('#filesave-status').addEventListener('click', () => saveNow());
setInterval(updateFileSaveStatus, 30_000);

window.addEventListener('beforeunload', (e) => {
  if (rec && rec.inSession && unsavedToFile()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function saveNow() {
  if (config.ai_disclosure && !rec.header.ai_use) {
    toast('This assignment asks whether you used AI tools. Please answer, then save again.', 6000);
    openNotes();
    $('#ai-used').focus();
    return;
  }
  const b = $('#save-btn');
  b.disabled = true;
  try {
    await saveFileFrom(await finalFile());
    await saveDraft();
  } finally {
    b.disabled = false;
  }
}
$('#save-btn').addEventListener('click', saveNow);

function printNow() {
  printDoc(rec.doc, rec.header.doc_style, config.title);
}

async function endSession() {
  rec.endSession();
  await Promise.race([rec.settle(), new Promise((r) => setTimeout(r, 8000))]);
  await saveDraft();
  show('#screen-ended');
}
$('#ended-save').addEventListener('click', async () => saveFileFrom(structuredClone(await rec.toFile())));
$('#ended-continue').addEventListener('click', async () => {
  try {
    await checkConnection();
    startWriting();
  } catch (err) {
    toast(err.message, 8000);
  }
});

async function openPreview() {
  const file = rec.inSession ? await finalFile() : structuredClone(await rec.toFile());
  const F = finalize(await analyzeFile(file, { expectedConfigHash: cfgHash }));
  $('#preview').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderReport($('#preview-body'), F, {
    mode: 'student',
    onFlagNote: (id, text) => {
      const notes = { ...(rec.header.flag_notes || {}) };
      if (text) notes[id] = text;
      else delete notes[id];
      rec.header.flag_notes = notes;
      saveDraft();
    },
  });
}
$('#preview-btn').addEventListener('click', openPreview);
$('#ended-preview').addEventListener('click', openPreview);
$('#preview-close').addEventListener('click', () => {
  $('#preview').classList.add('hidden');
  $('#preview-body').innerHTML = '';
  document.body.style.overflow = '';
  if (rec.inSession) editor.focus();
});

// ---------- dialogs ----------

function renderAttachments() {
  const ul = $('#dlg-attachments');
  ul.innerHTML = '';
  for (const a of rec.header.attachments || []) ul.append(h('li', null, a.filename));
}

function openNotes() {
  $('#dlg-notes').value = rec.header.process_notes || '';
  $('#dlg-dictation').checked = !!rec.header.dictation_mode;
  const ai = $('#ai-fieldset');
  ai.classList.toggle('hidden', !config.ai_disclosure);
  if (config.ai_disclosure) {
    const sel = $('#ai-used');
    if (sel.options.length === 1) for (const [k, v] of Object.entries(AI_USE)) sel.append(h('option', { value: k }, v));
    sel.value = (rec.header.ai_use && rec.header.ai_use.used) || '';
    $('#ai-detail').value = (rec.header.ai_use && rec.header.ai_use.detail) || '';
  }
  renderAttachments();
  $('#notes-dlg').showModal();
}
$('#notes-dlg').addEventListener('close', () => {
  rec.header.process_notes = $('#dlg-notes').value.trim();
  rec.header.dictation_mode = $('#dlg-dictation').checked;
  if (config.ai_disclosure && $('#ai-used').value) {
    rec.header.ai_use = { used: $('#ai-used').value, detail: $('#ai-detail').value.trim() };
  }
  saveDraft();
  if (editor && rec.inSession) editor.focus();
});
$('#dlg-outline').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const digest = hex(await sha256Bytes(new Uint8Array(await f.arrayBuffer())));
  rec.header.attachments = [...(rec.header.attachments || []), { filename: f.name, sha256: digest, added: new Date().toISOString() }];
  renderAttachments();
  ev.target.value = '';
  saveDraft();
});

function openCount() {
  const text = rec.text;
  const { start, end } = editor.sel;
  const rows = [
    ['Words', countWords(text)],
    ['Characters (no spaces)', text.replace(/\s/g, '').length],
    ['Characters (with spaces)', text.replace(/\n/g, '').length],
    ['Paragraphs', text.split('\n').filter((l) => l.trim()).length],
  ];
  if (start !== end) rows.push(['Words selected', countWords(text.slice(start, end))]);
  const p = config.policy;
  if (p.words_min || p.words_max) rows.push(['Required length', `${p.words_min || 0}–${p.words_max || 'any'} words`]);
  const t = $('#count-table');
  t.innerHTML = '';
  for (const [k, v] of rows) t.append(h('tr', null, h('th', null, k), h('td', null, typeof v === 'number' ? v.toLocaleString() : v)));
  $('#count-dlg').showModal();
}
$('#count-dlg').addEventListener('close', () => editor && editor.focus());

const SYMBOLS = '— – “ ” ‘ ’ « » … • · ° ± × ÷ ≈ ≠ ≤ ≥ → ← ↑ ↓ © ® ™ § ¶ † ‡ € £ ¥ ¢ ½ ¼ ¾ ² ³ µ α β γ δ θ λ π σ Σ Ω é è ê ë á à â ä ã í ì î ï ó ò ô ö õ ú ù û ü ñ ç ß æ ø å œ É È Á À Ó Ö Ü Ñ Ç ¿ ¡'.split(' ');
function openSymbols() {
  const grid = $('#symbol-grid');
  if (!grid.children.length) {
    for (const ch of SYMBOLS) {
      const b = h('button', { class: 'symbol', type: 'button', 'aria-label': `Insert ${ch}` }, ch);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        ed.focus({ preventScroll: true });
        editor.setSel(editor.sel.start, editor.sel.end, false);
        editor.insertSymbol(ch);
      });
      grid.append(b);
    }
  }
  const dlg = $('#symbols-dlg');
  if (!dlg.open) dlg.show();
}
$('#symbols-close').addEventListener('click', () => $('#symbols-dlg').close());

// ---------- boot ----------

(async () => {
  const m = location.hash.match(/a=([A-Za-z0-9_-]+)/);
  if (!m) {
    $('#need-code').classList.remove('hidden');
    return;
  }
  try {
    await openAssignment(m[1]);
  } catch {
    $('#need-code').classList.remove('hidden');
    refuse('This assignment link isn’t valid. Check that you copied all of it.');
  }
})();
