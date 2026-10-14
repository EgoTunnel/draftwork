import { $, h, toast, download, LOGO } from './ui/dom.js';
import { sha256Hex, hex, sha256Bytes } from './core/canon.js';
import {
  decodeConfig, configHash, diffOp, parseFile, serializeFile, fileName, countWords,
} from './core/format.js';
import { Recorder } from './core/recorder.js';
import { requestStamp } from './core/tsa.js';
import { getDraft, putDraft, deleteDraft } from './core/store.js';
import { analyzeFile, finalize } from './core/analysis.js';
import { renderReport } from './ui/report.js';

for (const id of ['#brand', '#brand3']) $(id).insertAdjacentHTML('afterbegin', LOGO);
$('#brand2').innerHTML = LOGO;

const STAMP_GAP_WARN_MS = 8 * 60_000;
const STAMP_RETRY_MS = 15_000;
const MOVE_CHARS = 40;

let config = null;
let cfgHash = null;
let rec = null;
let draftKey = null;
let dirty = false;
const cpCreated = new Map();

const show = (id) => {
  for (const s of ['#screen-setup', '#screen-writer', '#screen-ended']) $(s).classList.toggle('hidden', s !== id);
};

function refuse(msg) {
  const el = $('#refusal');
  el.innerHTML = '';
  el.append(h('strong', null, 'Draftwork can’t start a session. '), msg, ' ',
    h('div', { style: 'margin-top:6px' }, 'If you can’t work online at a desktop computer for this assignment, contact your instructor, who will arrange an alternative.'));
  el.classList.remove('hidden');
}

const isDesktop = () => !(matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);

async function checkConnection() {
  if (!navigator.onLine) throw new Error('This computer is offline.');
  try {
    await requestStamp(config.tsa_url, await sha256Hex(`draftwork-connection-check:${config.nonce}:${Date.now()}`), { timeoutMs: 12_000 });
  } catch (err) {
    throw new Error(`The timestamp service could not be reached (${err.message}). Check your connection and try again.`);
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
  pol.append(
    h('li', null, p.paste === 'block' ? 'Pasting from outside this document is turned off. Moving your own text around is fine.' : 'Pasting from outside is allowed, and labelled in the record.'),
    h('li', null, p.sources_pane ? 'A sources pane is available for quotes; paste them there, then copy them into your writing.' : 'There is no sources pane for this assignment.'),
    (p.words_min || p.words_max) && h('li', null, `Length: ${p.words_min || 0}–${p.words_max || 'any'} words.`),
    h('li', null, 'Needs a desktop browser with an internet connection the whole time you write.'),
  );
  if (!isDesktop()) {
    refuse('Draftwork is for desktop browsers only.');
    return;
  }
  let saved = null;
  try {
    saved = await getDraft(draftKey);
  } catch { /* storage unavailable */ }
  if (saved && saved.file) {
    const f = saved.file;
    $('#resume-info').textContent = `${f.header.student_label} · ${countWords(f.final.text)} words · last saved ${new Date(saved.savedAt).toLocaleString()}`;
    $('#resume-card').classList.remove('hidden');
    $('#resume-btn').onclick = () => begin(() => Recorder.resume(f, recOpts()));
    $('#resume-save').onclick = async () => saveFileFrom(f);
    $('#discard-btn').onclick = async () => {
      if (!confirm('Discard this draft from this browser? This cannot be undone. Save the file first if you might need it.')) return;
      await deleteDraft(draftKey);
      location.reload();
    };
  } else {
    $('#new-card').classList.remove('hidden');
  }
  $('#file-card').classList.remove('hidden');
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

async function begin(makeRecorder) {
  $('#refusal').classList.add('hidden');
  const status = $('#start-status');
  status.textContent = 'Checking the connection…';
  for (const b of document.querySelectorAll('#screen-setup button')) b.disabled = true;
  try {
    await checkConnection();
    rec = await makeRecorder();
    // Checkpoints from earlier sessions that never got a stamp are retried now.
    for (const cp of rec.unstamped()) cpCreated.set(cp.c, Date.now());
    startWriting();
  } catch (err) {
    refuse(err.message);
  } finally {
    status.textContent = '';
    for (const b of document.querySelectorAll('#screen-setup button')) b.disabled = false;
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

$('#code-btn').addEventListener('click', async () => {
  try {
    const code = $('#code-input').value;
    const m = code.match(/[#?&]a=([A-Za-z0-9_-]+)/);
    location.hash = `a=${m ? m[1] : code.trim()}`;
    location.reload();
  } catch {
    toast('That is not a valid assignment link or code.');
  }
});

// ---------- writing ----------

const ed = $('#editor');
const srcEd = $('#sources');
const panes = { main: ed, src: srcEd };
const last = { main: '', src: '' };
const caret = { main: 0, src: 0 };
const composing = { main: false, src: false };
const pendingType = { main: null, src: null };
const pendingPaste = { main: null, src: null };
const clips = new Map(); // text copied inside the sandbox -> pane it came from
let internalDrag = false;

const norm = (s) => String(s || '').replace(/\r\n?/g, '\n');

function startWriting() {
  show('#screen-writer');
  $('#w-title').textContent = config.title;
  const hasSources = config.policy.sources_pane;
  $('#sources-pane').classList.toggle('hidden', !hasSources);
  $('#writer-body').classList.toggle('with-sources', hasSources);
  $('#policy-note').textContent = config.policy.paste === 'block' ? 'Pasting from outside this document is turned off' : 'Pastes from outside are labelled in the record';
  ed.value = last.main = rec.text;
  srcEd.value = last.src = rec.src;
  rec.startSession();
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
  caret.main = ed.value.length;
  caret.src = srcEd.value.length;
  updateWords();
  updateStampPill();
  saveDraft();
}

// Exact position for an edit: the diff can be ambiguous with repeated characters, so prefer the caret.
function locate(before, after, op, caretEnd) {
  const n = op.n;
  const x = op.x;
  const p = caretEnd - x.length;
  if (p !== op.p && p >= 0 && p + n <= before.length && before.slice(0, p) + x + before.slice(p + n) === after) return { p, n, x };
  return op;
}

function commit(pane, it, forcedKind) {
  const el = panes[pane];
  const before = last[pane];
  const after = el.value;
  const raw = diffOp(before, after);
  if (!raw) return;
  const op = locate(before, after, raw, el.selectionEnd);
  let k = forcedKind || (op.n === 0 ? 'ins' : op.x === '' ? 'del' : 'rep');
  const e = { p: op.p, n: op.n || undefined, x: op.x || undefined, it: it || undefined };
  const paste = pendingPaste[pane];
  if (paste && op.x) {
    if (pane === 'src') k = 'paste_src';
    else if (paste.internal) {
      k = 'paste_in';
      if (paste.from === 'src') e.from = 'src';
    }
    pendingPaste[pane] = null;
  }
  if (pane === 'src') e.pane = 'src';
  rec.record({ k, ...e });
  last[pane] = after;
  caret[pane] = el.selectionEnd;
  pendingType[pane] = null;
  if (pane === 'main') updateWords();
}

function revert(pane, it) {
  const el = panes[pane];
  const delta = Math.abs(el.value.length - last[pane].length);
  const pos = Math.min(caret[pane], last[pane].length);
  el.value = last[pane];
  el.setSelectionRange(pos, pos);
  rec.record({ k: 'untrusted', it: it || 'programmatic', len: delta, pane: pane === 'src' ? 'src' : undefined });
  toast('A script or extension tried to change your text. The change was refused and noted in the record.', 6000);
}

function checkMove(pane) {
  if (!rec || !rec.inSession) return;
  const el = panes[pane];
  const pos = el.selectionStart;
  if (Math.abs(pos - caret[pane]) > MOVE_CHARS) {
    rec.record({ k: 'move', p: pos, from: caret[pane], pane: pane === 'src' ? 'src' : undefined });
  }
  caret[pane] = pos;
}

function wire(pane) {
  const el = panes[pane];
  el.addEventListener('beforeinput', (e) => {
    if (!rec || !rec.inSession) return e.preventDefault();
    if (!e.isTrusted) {
      e.preventDefault();
      rec.record({ k: 'untrusted', it: e.inputType, len: (e.data || '').length, pane: pane === 'src' ? 'src' : undefined });
      return;
    }
    pendingType[pane] = e.inputType;
  });
  el.addEventListener('input', (e) => {
    if (!rec || !rec.inSession) return;
    if (!e.isTrusted) return revert(pane, e.inputType || 'synthetic-input');
    if (e.isComposing || composing[pane]) return;
    commit(pane, pendingType[pane] || e.inputType);
  });
  el.addEventListener('compositionstart', () => {
    composing[pane] = true;
  });
  el.addEventListener('compositionend', () => {
    composing[pane] = false;
    commit(pane, 'insertCompositionText', 'ime');
  });
  const remember = () => {
    const t = norm(el.value.slice(el.selectionStart, el.selectionEnd));
    if (t) {
      clips.set(t, pane);
      if (clips.size > 50) clips.delete(clips.keys().next().value);
    }
  };
  el.addEventListener('copy', remember);
  el.addEventListener('cut', remember);
  el.addEventListener('paste', (e) => {
    if (!rec || !rec.inSession) return e.preventDefault();
    const t = norm(e.clipboardData && e.clipboardData.getData('text/plain'));
    if (pane === 'src') {
      pendingPaste.src = { internal: false };
      return;
    }
    if (clips.has(t)) {
      pendingPaste.main = { internal: true, from: clips.get(t) };
      return;
    }
    if (config.policy.paste === 'allow') {
      pendingPaste.main = { internal: false };
      return;
    }
    e.preventDefault();
    rec.record({ k: 'paste_blocked', len: t.length, it: 'insertFromPaste' });
    toast('Pasting from outside this document is turned off for this assignment. The attempt was noted (length only).', 6000);
  });
  el.addEventListener('dragstart', () => {
    internalDrag = true;
  });
  el.addEventListener('dragend', () => {
    internalDrag = false;
  });
  el.addEventListener('drop', (e) => {
    if (!rec || !rec.inSession) return e.preventDefault();
    const t = norm(e.dataTransfer && e.dataTransfer.getData('text/plain'));
    if (internalDrag || clips.has(t)) {
      pendingPaste[pane] = { internal: true, from: internalDrag ? pane : clips.get(t) };
      return;
    }
    if (pane === 'src') {
      pendingPaste.src = { internal: false };
      return;
    }
    if (config.policy.paste === 'allow') return;
    e.preventDefault();
    rec.record({ k: 'paste_blocked', len: t.length, it: 'insertFromDrop' });
    toast('Dropping text from outside this document is turned off for this assignment.', 6000);
  });
  for (const ev of ['keyup', 'mouseup', 'select']) el.addEventListener(ev, () => checkMove(pane));
}
wire('main');
wire('src');

window.addEventListener('blur', () => rec && rec.inSession && rec.record({ k: 'blur' }));
window.addEventListener('focus', () => rec && rec.inSession && rec.record({ k: 'focus' }));
window.addEventListener('pagehide', () => {
  if (rec && rec.inSession) {
    rec.endSession();
    saveDraft();
  }
});

// Script-set values fire no input event; catch them by comparing with the logged state.
setInterval(() => {
  if (!rec || !rec.inSession) return;
  for (const pane of ['main', 'src']) {
    if (!composing[pane] && panes[pane].value !== last[pane]) revert(pane, 'programmatic');
  }
}, 500);

// Checkpoints, stamp retries and autosave.
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

function updateWords() {
  const w = countWords(ed.value);
  const p = config.policy;
  const pill = $('#words-pill');
  pill.textContent = `${w.toLocaleString()} word${w === 1 ? '' : 's'}` + (p.words_min || p.words_max ? ` (${p.words_min || 0}–${p.words_max || '∞'})` : '');
  pill.className = 'pill' + ((p.words_max && w > p.words_max) ? ' warn' : '');
}

function updateStampPill() {
  if (!rec) return;
  const pill = $('#stamp-pill');
  const txt = $('#stamp-text');
  const pending = rec.unstamped();
  if (!pending.length) {
    pill.className = 'pill ok';
    txt.textContent = rec.checkpoints.length ? 'Timestamped' : 'Connected';
    pill.title = rec.lastStampOk ? `Last checkpoint stamped ${new Date(rec.lastStampOk).toLocaleTimeString()}` : 'Checkpoints are written every minute of activity';
    return;
  }
  const oldest = Math.min(...pending.map((c) => cpCreated.get(c.c) || Date.now()));
  const age = Date.now() - oldest;
  pill.className = age > STAMP_GAP_WARN_MS ? 'pill bad' : 'pill warn';
  txt.textContent = `Waiting to timestamp · ${pending.length} queued`;
  pill.title = `${rec.stampError || 'Waiting for the connection'}. Keep writing; queued checkpoints are stamped when it returns.` +
    (age > STAMP_GAP_WARN_MS ? ' A stretch of more than 10 minutes without a stamp shows to your instructor as a gap.' : '');
  if (age > STAMP_GAP_WARN_MS && !updateStampPill.warned) {
    updateStampPill.warned = true;
    toast('No timestamp for over 8 minutes. Check your connection: a stretch over 10 minutes shows to your instructor as a gap.', 8000);
  }
  if (age <= STAMP_GAP_WARN_MS) updateStampPill.warned = false;
}

let saving = null;
async function saveDraft() {
  if (!rec || saving) return saving;
  dirty = false;
  saving = (async () => {
    try {
      const file = await rec.toFile();
      await putDraft(draftKey, { file: structuredClone(file), savedAt: Date.now() });
      $('#autosave-status').textContent = `Saved in this browser at ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      $('#autosave-status').textContent = `Could not save in this browser (${err.message}). Save the file now.`;
    } finally {
      saving = null;
    }
  })();
  return saving;
}

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
  const notes = [];
  if (p.words_min && w < p.words_min) notes.push(`under the ${p.words_min}-word minimum`);
  if (p.words_max && w > p.words_max) notes.push(`over the ${p.words_max}-word limit`);
  const unstamped = file.checkpoints.filter((c) => !c.tsa).length;
  if (unstamped) notes.push(`${unstamped} checkpoint${unstamped === 1 ? ' is' : 's are'} still waiting for a timestamp`);
  toast(`Saved ${fileName(file)} (${(bytes.length / 1024).toFixed(0)} KB). Upload it to your LMS dropbox.` + (notes.length ? ` Note: ${notes.join('; ')}.` : ''), 8000);
}

$('#save-btn').addEventListener('click', async () => {
  $('#save-btn').disabled = true;
  try {
    await saveFileFrom(await finalFile());
    await saveDraft();
  } finally {
    $('#save-btn').disabled = false;
  }
});

$('#end-btn').addEventListener('click', async () => {
  rec.endSession();
  await Promise.race([rec.settle(), new Promise((r) => setTimeout(r, 8000))]);
  await saveDraft();
  show('#screen-ended');
});
$('#ended-save').addEventListener('click', async () => saveFileFrom(structuredClone(await rec.toFile())));
$('#ended-continue').addEventListener('click', async () => {
  try {
    await checkConnection();
    startWriting();
  } catch (err) {
    toast(err.message + ' If you can’t work online at a desktop, contact your instructor.', 8000);
  }
});

// ---------- preview ----------

async function openPreview() {
  const file = rec.inSession ? await finalFile() : structuredClone(await rec.toFile());
  const A = await analyzeFile(file, { expectedConfigHash: cfgHash });
  const F = finalize(A);
  $('#preview').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderReport($('#preview-body'), F, { mode: 'student' });
}
$('#preview-btn').addEventListener('click', openPreview);
$('#ended-preview').addEventListener('click', openPreview);
$('#preview-close').addEventListener('click', () => {
  $('#preview').classList.add('hidden');
  $('#preview-body').innerHTML = '';
  document.body.style.overflow = '';
  if (rec.inSession) ed.focus();
});

// ---------- notes dialog ----------

function renderAttachments() {
  const ul = $('#dlg-attachments');
  ul.innerHTML = '';
  for (const a of rec.header.attachments || []) ul.append(h('li', null, `${a.filename} · ${a.sha256.slice(0, 12)}…`));
}

$('#notes-btn').addEventListener('click', () => {
  $('#dlg-notes').value = rec.header.process_notes || '';
  $('#dlg-dictation').checked = !!rec.header.dictation_mode;
  renderAttachments();
  $('#notes-dlg').showModal();
});
$('#notes-dlg').addEventListener('close', () => {
  rec.header.process_notes = $('#dlg-notes').value.trim();
  rec.header.dictation_mode = $('#dlg-dictation').checked;
  saveDraft();
  ed.focus();
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

// ---------- boot ----------

(async () => {
  const m = location.hash.match(/a=([A-Za-z0-9_-]+)/);
  if (!m) {
    $('#need-code').classList.remove('hidden');
    return;
  }
  try {
    await openAssignment(m[1]);
  } catch (err) {
    $('#need-code').classList.remove('hidden');
    refuse(`This assignment link could not be read (${err.message}).`);
  }
})();
