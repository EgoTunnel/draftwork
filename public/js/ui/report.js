// The submission viewer: an Overview (integrity, flags, writing process, questions, replay)
// and a Document tab showing the submitted text as the student formatted it.
import { h, s, toast } from './dom.js';
import { productionGraph, indexAtClock } from './graph.js';
import { stateAt, fmtClock, fmtDuration, POLICY_FOOTER } from '../core/analysis.js';
import { countWords, finalDoc } from '../core/format.js';
import { paragraphParts, docStyleCss, toPlainText, toClipboardHtml, notesHtml } from '../core/export.js';
import { documentPage, downloadDocx, downloadTxt, printDoc, printHtml } from './docui.js';
import { ICONS } from './icons.js';
import { fingerprintCode } from '../core/canon.js';
import { namesMatch } from '../core/zipread.js';

export const OUTCOMES = { '': 'Not asked yet', ok: 'Explained convincingly', unclear: 'Answer unclear', follow: 'Needs follow-up' };
export const DISPOSITIONS = { '': 'Not reviewed', benign: 'Benign after check-in', concern: 'Concern remains' };
export const AI_USE = {
  none: 'No AI tools', ideas: 'For ideas or brainstorming', feedback: 'For feedback on my writing',
  editing: 'For grammar or wording fixes', drafting: 'To draft some of the text', other: 'Other',
};

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// A one-page record of the review: checks, flags (with review status), questions and answers.
function printSummary(F, notes, fileInfo) {
  const n = notes || { prompts: {}, flags: {}, summary: '' };
  const header = F.header;
  const rows = [];
  rows.push(`<h1>${escHtml(header.student_label || 'Unnamed')}</h1>`);
  rows.push(`<p class="muted">${escHtml(F.config.title)} · ${countWords(F.file.final.text)} words · ${fmtDuration(F.raw.active)} writing · ${F.sessions.length} session(s)` +
    `${fileInfo && fileInfo.fingerprint ? ` · file ${fingerprintCode(fileInfo.fingerprint)}` : ''} · reviewed ${new Date().toLocaleDateString()}</p>`);
  if (header.process_notes) rows.push(`<p><strong>Student’s notes:</strong> ${escHtml(header.process_notes)}</p>`);
  if (header.ai_use) rows.push(`<p><strong>AI use:</strong> ${escHtml(AI_USE[header.ai_use.used] || header.ai_use.used)}${header.ai_use.detail ? ` — ${escHtml(header.ai_use.detail)}` : ''}</p>`);
  rows.push('<h2>Integrity</h2><ul>');
  for (const c of F.integrity) rows.push(`<li>${{ pass: '✓', fail: '✕', warn: '!', unknown: '?' }[c.status]} ${escHtml(c.label)} — ${escHtml(c.detail)}</li>`);
  rows.push('</ul><h2>Flags</h2>');
  if (!F.flags.length) rows.push('<p>None.</p>');
  else {
    rows.push('<ul>');
    for (const f of F.flags) {
      const d = n.flags[f.id];
      const resp = (header.flag_notes || {})[f.id];
      rows.push(`<li><strong>${escHtml(f.title)}</strong>: ${escHtml(f.reason)}${d ? ` <em>[${DISPOSITIONS[d]}]</em>` : ''}${resp ? `<br>Student’s response: “${escHtml(resp)}”` : ''}</li>`);
    }
    rows.push('</ul>');
  }
  rows.push('<h2>Check-in</h2><ol>');
  for (const p of F.prompts) {
    const a = n.prompts[p.i] || {};
    rows.push(`<li><p>${escHtml(p.question)}</p>${a.outcome ? `<p><em>${OUTCOMES[a.outcome]}</em></p>` : ''}${a.answer ? `<p>Answer: ${escHtml(a.answer)}</p>` : ''}</li>`);
  }
  rows.push('</ol>');
  if (n.summary) rows.push(`<h2>Notes</h2><p>${escHtml(n.summary).replace(/\n/g, '<br>')}</p>`);
  rows.push(`<p class="muted small">${POLICY_FOOTER}</p>`);
  printHtml(`<div class="print-summary">${rows.join('')}</div>`, `Review - ${header.student_label || 'submission'}`);
}

const STATUS_MARK = { pass: '✓', fail: '✕', warn: '!', unknown: '?' };
const STATUS_TEXT = { pass: 'Passed', fail: 'Failed', warn: 'Passed, with a note', unknown: 'Could not check' };
const SPEEDS = [1, 4, 16, 64, 256];

function describeEvent(e) {
  const q = (x) => JSON.stringify(x.length > 60 ? x.slice(0, 60) + '…' : x);
  const x = e.x || '';
  const where = e.pane === 'src' ? ' (sources)' : '';
  switch (e.k) {
    case 'ins': return x === '￼' ? 'Added a footnote' : `Typed ${q(x)}${where}`;
    case 'note': return `Edited footnote ${(e.i || 0) + 1}${e.x ? `: ${q(x)}` : ''}`;
    case 'del': return `Deleted ${e.n} character${e.n === 1 ? '' : 's'}${where}`;
    case 'rep': return `Replaced ${e.n} character${e.n === 1 ? '' : 's'} with ${q(x)}${where}`;
    case 'paste_in': return e.from === 'src' ? `Pasted ${x.length} characters from sources` : `Moved or pasted ${x.length} of their own characters`;
    case 'paste_src': return `Pasted ${x.length} characters into sources`;
    case 'paste_blocked': return `Tried to paste ${e.len} characters from outside (blocked)`;
    case 'ime': return `Entered ${q(x)} by dictation or input method`;
    case 'move': return 'Moved the cursor';
    case 'blur': return 'Left the window';
    case 'focus': return 'Came back to the window';
    case 'session_start': return `Started writing, ${new Date(e.w).toLocaleString()}`;
    case 'session_end': return 'Stopped writing';
    case 'untrusted': return 'A script tried to change the text (refused)';
    case 'cite': return `Noted where pasted text came from: ${q(x)}`;
    case 'fmt': return 'Changed text formatting';
    case 'para': return 'Changed paragraph formatting';
    default: return e.k;
  }
}

function strip(values, me, priors, fmt) {
  const all = [...values, me, ...priors.map((p) => p.value)].filter(Number.isFinite);
  if (values.length < 2 || !Number.isFinite(me)) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 140;
  const x = (v) => 6 + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (W - 12);
  const svg = s('svg', { class: 'strip', width: W, height: 22, viewBox: `0 0 ${W} 22`, role: 'img', 'aria-label': `This file ${fmt(me)} among ${values.length} in the class` });
  svg.append(s('line', { x1: 6, x2: W - 6, y1: 11, y2: 11, stroke: 'var(--border)' }));
  for (const v of values) svg.append(s('circle', { class: 'd', cx: x(v), cy: 11, r: 3 }));
  for (const p of priors) if (Number.isFinite(p.value)) svg.append(s('circle', { class: 'prior', cx: x(p.value), cy: 11, r: 5 }));
  svg.append(s('circle', { class: 'me', cx: x(me), cy: 11, r: 4.5 }));
  const below = values.filter((v) => v < me).length;
  const tip = `Dots: the ${values.length} submissions for this assignment. Filled blue: this file (${fmt(me)}).` +
    (priors.length ? ' Orange ring: this student’s earlier work.' : '');
  return h('div', { 'data-tip': tip }, svg, h('div', { class: 'small muted' }, `${Math.round((below / values.length) * 100)}th percentile`));
}

function sectionHead(title, tip, right) {
  return h('div', { class: 'section-head' },
    h('h2', null, title, tip ? h('span', { class: 'info', tabindex: '0', 'data-tip': tip, 'aria-label': tip, html: ICONS.info }) : null),
    right || null);
}

async function copyDoc(doc) {
  const text = toPlainText(doc);
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([toClipboardHtml(doc, 0, doc.text.length)], { type: 'text/html' }),
      })]);
    } else await navigator.clipboard.writeText(text);
    toast('Copied the document');
  } catch {
    toast('Copy failed. Select the text and press Ctrl+C.');
  }
}

// opts.notes: { get(), set(notes) } for the instructor's check-in notes (this browser only).
// opts.fileInfo: { fingerprint, lms: { lms, name } }. opts.onFlagNote(id, text): the student's own responses.
export function renderReport(root, F, { mode = 'instructor', tab = 'overview', onTab = null, notes = null, fileInfo = null, onFlagNote = null } = {}) {
  root.innerHTML = '';
  const N0 = notes ? { prompts: {}, flags: {}, summary: '', ...notes.get() } : null;
  const saveNotes = debounce(() => notes && notes.set({ ...N0, updated: new Date().toISOString() }), 400);
  const N = F.events.length;
  const tl = F.tl;
  const words = countWords(F.file.final.text);
  const elapsed = N ? tl.abs[N - 1] - tl.abs[0] : 0;
  const header = F.header;
  const style = header.doc_style;
  let seek = () => {};

  const moment = (i, label) => h('button', { class: 'btn small', type: 'button', 'data-tip': 'Show this moment in the replay', onclick: () => seek(i, true) }, '▶ ', label);

  // ---------- head ----------
  const failing = F.integrity.filter((c) => c.status === 'fail').length;
  const passing = F.integrity.filter((c) => c.status === 'pass').length;
  const head = h('div', { class: 'rp-head' },
    h('div', { class: 'eyebrow' }, F.config.title),
    h('h1', null, header.student_label || 'Unnamed submission'),
    h('div', { class: 'rp-stats' },
      h('span', null, `${words.toLocaleString()} words`),
      h('span', { 'data-tip': 'Time spent writing, not counting breaks longer than 5 minutes' }, `${fmtDuration(F.raw.active)} writing`),
      h('span', { 'data-tip': 'Each time the student opened the document to write' }, `${F.sessions.length} session${F.sessions.length === 1 ? '' : 's'}${F.sessions.length > 1 ? ` over ${fmtDuration(elapsed)}` : ''}`),
      F.sessions[0] && h('span', null, new Date(F.sessions[0].wall).toLocaleDateString(undefined, { dateStyle: 'medium' })),
      header.dictation_mode && h('span', { class: 'pill accent', 'data-tip': 'The student said they used dictation' }, 'Dictation'),
      F.config.due && (() => {
        const last = N ? tl.abs[N - 1] : 0;
        const late = last > Date.parse(F.config.due);
        return h('span', { class: `pill ${late ? 'warn' : ''}`, 'data-tip': `Due ${new Date(F.config.due).toLocaleString()}. Last edit ${new Date(last).toLocaleString()}.` }, late ? 'Edited after due date' : 'Finished before due date');
      })(),
      fileInfo && fileInfo.fingerprint && h('span', { class: 'mono small', 'data-tip': 'Fingerprint of this file. It matches the receipt the student got when they saved it.' }, fingerprintCode(fileInfo.fingerprint)),
      fileInfo && fileInfo.lms && fileInfo.lms.name && h('span', {
        class: namesMatch(fileInfo.lms.name, header.student_label) ? 'small' : 'small warn-text',
        'data-tip': namesMatch(fileInfo.lms.name, header.student_label)
          ? `Submitted in ${fileInfo.lms.lms} as “${fileInfo.lms.name}”`
          : `Submitted in ${fileInfo.lms.lms} as “${fileInfo.lms.name}”, which doesn’t obviously match the name in the file. Check it was the student’s own file.`,
      }, `${fileInfo.lms.lms}: ${fileInfo.lms.name}`),
    ),
    header.ai_use && h('div', { class: 'rp-notes' },
      h('div', { class: 'eyebrow' }, 'AI use (student’s disclosure)'),
      h('div', null, AI_USE[header.ai_use.used] || header.ai_use.used, header.ai_use.detail ? h('span', { class: 'muted' }, ` — ${header.ai_use.detail}`) : null)),
    F.config.ai_disclosure && !header.ai_use && h('div', { class: 'small warn-text', style: 'margin-top:8px' }, 'The student did not complete the AI-use disclosure.'),
    (header.process_notes || (header.attachments || []).length > 0) && h('div', { class: 'rp-notes' },
      h('div', { class: 'eyebrow' }, 'Student’s notes'),
      header.process_notes && h('div', null, header.process_notes),
      (header.attachments || []).map((a) => h('div', { class: 'small muted', 'data-tip': `Only the name and fingerprint were kept (SHA-256 ${a.sha256.slice(0, 16)}…), not the file.` },
        `Attached: ${a.filename}`))),
  );

  const banner = mode === 'student' && h('div', { class: 'notice info', style: 'margin-bottom:16px', 'data-tip': 'Class comparisons appear when your instructor opens the whole class.' },
    'This is how your instructor will see your work.');

  // ---------- tabs ----------
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panels = {};
  const tabBtns = {};
  const select = (name) => {
    for (const [k, b] of Object.entries(tabBtns)) {
      b.setAttribute('aria-selected', String(k === name));
      panels[k].classList.toggle('hidden', k !== name);
    }
    if (name !== 'overview') stop();
    if (onTab) onTab(name);
  };
  for (const [k, label, tip] of [
    ['overview', 'Overview', 'Checks, flags, the writing process and questions to ask'],
    ['document', 'Document', 'The submitted document, as the student formatted it'],
  ]) {
    tabBtns[k] = h('button', { class: 'tab', role: 'tab', type: 'button', 'data-tip': tip, onclick: () => select(k) }, label);
    tabs.append(tabBtns[k]);
  }
  tabs.append(h('span', { class: 'spacer' }),
    h('span', { class: `pill ${failing ? 'bad' : F.integrity.some((c) => c.status !== 'pass') ? 'warn' : 'ok'}`, 'data-tip': 'Integrity checks passed' },
      failing ? `${failing} check${failing === 1 ? '' : 's'} failed` : `${passing}/${F.integrity.length} checks`),
    h('span', { class: `pill ${F.flags.length ? 'warn' : ''}` }, `${F.flags.length} flag${F.flags.length === 1 ? '' : 's'}`),
    N0 ? h('button', {
      class: 'btn small', type: 'button', 'data-tip': 'Print or save as PDF a one-page record: checks, flags with your review, questions and answers',
      onclick: () => printSummary(F, N0, fileInfo), html: `${ICONS.print}<span>Print summary</span>`,
    }) : '');

  // ---------- overview: integrity ----------
  const l1 = h('section', { class: 'card', id: 'layer-integrity' },
    sectionHead('Integrity', 'Pass/fail checks that the file wasn’t altered and was written in Draftwork. A failure means the file was changed or built outside the app.'),
    h('ul', { class: 'checks' }, F.integrity.map((c) => h('li', null,
      h('span', { class: `mark ${c.status}`, 'aria-label': STATUS_TEXT[c.status], 'data-tip': STATUS_TEXT[c.status] }, STATUS_MARK[c.status]),
      h('span', { 'data-tip': c.tip || null }, c.label),
      h('span', { class: 'detail' }, c.detail)))),
  );

  // ---------- overview: flags ----------
  const l2 = h('section', { class: 'card', id: 'layer-flags' },
    sectionHead('Flags', 'Unusual moments, or ones that match a known misuse pattern. Each is listed on its own with innocent explanations. A flag is a reason to ask, not a finding.'),
    F.flags.length
      ? F.flags.map((f) => h('div', { class: `flag ${f.kind}` },
        h('h3', null, f.title, h('span', { class: `pill ${f.kind === 'integrity' ? 'bad' : 'warn'}`, 'data-tip': f.kind === 'integrity' ? 'The file was altered or produced outside Draftwork' : 'A writing pattern worth a conversation' }, f.kind === 'integrity' ? 'Integrity' : 'Pattern')),
        h('div', null, f.reason),
        f.moments.length ? h('div', { class: 'moments' }, f.moments.map((m) => moment(m.i, m.label))) : null,
        h('details', { class: 'benign', open: true },
          h('summary', null, f.kind === 'integrity' ? 'Before concluding anything' : 'Possible innocent explanations'),
          h('ul', null, f.benign.map((b) => h('li', null, b)),
            f.kind === 'pattern' && header.process_notes ? h('li', null, h('em', null, `Student’s note: “${header.process_notes}”`)) : null)),
        mode !== 'student' && (header.flag_notes || {})[f.id] && h('div', { class: 'student-response' },
          h('div', { class: 'eyebrow' }, 'Student’s response'), h('div', null, header.flag_notes[f.id])),
        mode === 'student' && onFlagNote && f.kind === 'pattern' && (() => {
          const ta = h('textarea', { rows: 2, placeholder: 'Optional: explain this to your instructor, e.g. “I was reading my notes in another window.”', 'aria-label': `Your note about ${f.title}` });
          ta.value = (header.flag_notes || {})[f.id] || '';
          ta.addEventListener('input', debounce(() => onFlagNote(f.id, ta.value.trim()), 400));
          return h('div', { class: 'student-response' }, h('label', { 'data-tip': 'Your instructor sees this next to the flag.' }, 'Your note about this'), ta);
        })(),
        N0 && f.kind === 'pattern' && (() => {
          const sel = h('select', { 'aria-label': 'Review status', 'data-tip': 'Your conclusion after talking with the student. Kept in this browser and included in exports, to help calibrate flags.' },
            Object.entries(DISPOSITIONS).map(([k, v]) => h('option', { value: k, selected: (N0.flags[f.id] || '') === k }, v)));
          sel.addEventListener('change', () => {
            N0.flags[f.id] = sel.value;
            saveNotes();
          });
          return h('div', { class: 'row review-row' }, h('span', { class: 'small muted' }, 'Review:'), sel);
        })(),
      ))
      : h('p', { class: 'empty-state' }, 'No flags.'),
    !F.classOn && h('p', { class: 'small muted', style: 'margin:10px 0 0', 'data-tip': 'The “too fast” and “machine-regular rhythm” flags compare against the class, so they need enough submissions.' },
      `Class comparison flags: ${F.cohortSize} of ${F.T.min_class_size} submissions loaded.`),
  );

  // ---------- overview: writing process ----------
  const markers = [
    ...F.flags.flatMap((f) => f.moments.map((m) => ({ i: m.i, kind: 'flag', label: `${f.title}: ${m.label}` }))),
    ...F.prompts.map((p, k) => ({ i: p.i, kind: 'prompt', label: `Question ${k + 1}: ${p.title}` })),
  ];
  const graph = productionGraph(F, { onSeek: (i) => seek(i, false), markers });
  const statsById = Object.fromEntries((F.classStats || []).map((c) => [c.id, c]));
  const l3 = h('section', { class: 'card', id: 'layer-signals' },
    sectionHead('Writing process', 'How the text was produced over time. In composed writing the three lines separate: total typed runs above length because of deletions, and the cursor drops when the writer goes back. When text is copied in, they run almost together.'),
    graph.el,
    h('div', { class: 'table-wrap', style: 'margin-top:16px' },
      h('table', { class: 'signals' },
        h('thead', null, h('tr', null, h('th', null, 'Signal'), h('th', null, 'This file'), h('th', { 'data-tip': 'Compared with the other submissions for this assignment, and the student’s own earlier work when loaded' }, 'Class'))),
        h('tbody', null, F.signals.map((sg) => {
          const cs = statsById[sg.id] || { values: [], priors: [] };
          const fmt = sg.fmt || ((v) => (Number.isFinite(v) ? v.toFixed(1) : '—'));
          const tip = `${sg.measures}. Copying tends to look like: ${sg.transcription.toLowerCase()}. Innocent explanations: ${sg.benign.toLowerCase()}.`;
          return h('tr', null,
            h('td', null, h('span', { class: 'has-tip', tabindex: '0', 'data-tip': tip }, sg.name)),
            h('td', { class: 'val' },
              h('div', { class: sg.watch ? 'watch' : '', 'data-tip': sg.watch ? `In the range copied text tends to show: ${sg.transcription.toLowerCase()}` : null }, sg.value),
              sg.moments && sg.moments.length ? h('div', { class: 'moments' }, sg.moments.slice(0, 6).map((i) => moment(i, fmtClock(tl.clock[i])))) : null),
            h('td', null,
              strip(cs.values, sg.metric, cs.priors, fmt) || h('span', { class: 'muted small' }, '—'),
              cs.priors.map((p) => h('div', { class: 'small' }, `${p.title}: `, h('strong', null, fmt(p.value))))),
          );
        })))),
  );

  // ---------- overview: questions ----------
  const l4 = h('section', { class: 'card', id: 'layer-prompts' },
    sectionHead('Questions to ask', 'Specific moments to ask the student about in a short check-in. Flagged moments come first.',
      F.prompts.length ? h('button', {
        class: 'btn small', type: 'button', 'data-tip': 'Copy all questions as a numbered list',
        onclick: () => navigator.clipboard.writeText(F.prompts.map((p, k) => `${k + 1}. ${p.question}`).join('\n')).then(() => toast('Copied'), () => toast('Copy failed')),
      }, 'Copy') : null),
    F.prompts.length
      ? h('ol', { class: 'prompts' }, F.prompts.map((p) => h('li', null,
        h('div', null, h('span', { class: `pill ${p.flagged ? 'warn' : 'accent'}` }, p.title)),
        h('div', { class: 'q' }, p.question),
        moment(p.i, `Show at ${fmtClock(tl.clock[p.i])}`),
        N0 && (() => {
          const a = N0.prompts[p.i] || (N0.prompts[p.i] = { answer: '', outcome: '' });
          const ta = h('textarea', { rows: 2, placeholder: 'What the student said', 'aria-label': 'Student’s answer' });
          ta.value = a.answer || '';
          ta.addEventListener('input', () => {
            a.answer = ta.value;
            saveNotes();
          });
          const sel = h('select', { 'aria-label': 'Outcome' }, Object.entries(OUTCOMES).map(([k, v]) => h('option', { value: k, selected: (a.outcome || '') === k }, v)));
          sel.addEventListener('change', () => {
            a.outcome = sel.value;
            saveNotes();
          });
          return h('div', { class: 'checkin' }, ta, sel);
        })())))
      : h('p', { class: 'empty-state' }, 'Not enough writing yet to suggest questions.'),
    N0 && (() => {
      const ta = h('textarea', { rows: 3, placeholder: 'Anything else from the check-in', 'aria-label': 'Check-in notes' });
      ta.value = N0.summary || '';
      ta.addEventListener('input', () => {
        N0.summary = ta.value;
        saveNotes();
      });
      return h('div', { style: 'margin-top:12px' },
        h('label', { 'data-tip': 'Your notes are kept in this browser only. They’re included in Print summary and Export.' }, 'Check-in notes'), ta);
    })(),
  );

  // ---------- overview: replay ----------
  const doc = h('div', { class: 'replay-doc', tabindex: '0', 'aria-label': 'The document at the selected moment' });
  const meta = h('div', { class: 'replay-meta' });
  const evLine = h('div', { class: 'replay-event' });
  const range = h('input', { type: 'range', min: 0, max: Math.max(0, N - 1), value: Math.max(0, N - 1), 'aria-label': 'Replay position' });
  const ticks = h('div', { class: 'ticks' }, markers.map((m) => h('button', {
    class: `tick ${m.kind}`, type: 'button', 'data-tip': m.label, 'aria-label': m.label,
    style: `left:${N > 1 ? (m.i / (N - 1)) * 100 : 0}%`, onclick: () => seek(m.i, false),
  })));
  const playBtn = h('button', { class: 'btn small primary', type: 'button', 'data-tip': 'Play back the writing (long breaks are skipped)' }, '▶ Play');
  const speedSel = h('select', { 'aria-label': 'Playback speed', 'data-tip': 'Playback speed' }, SPEEDS.map((v) => h('option', { value: v, selected: v === 16 }, `${v}×`)));
  const srcToggle = F.replaySrc ? h('label', { class: 'check small', style: 'margin:0', 'data-tip': 'Show what the student pasted into the sources panel' }, h('input', { type: 'checkbox' }), 'Sources') : null;
  const aside = h('aside', { class: 'replay card', id: 'replay' },
    sectionHead('Replay', 'Scrub or play through the writing. The latest changes are highlighted; deleted text shows struck through for a moment.'),
    doc, meta,
    h('div', { class: 'scrub' }, range, ticks),
    h('div', { class: 'replay-controls' },
      playBtn, speedSel,
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Previous event', 'aria-label': 'Previous event', onclick: () => seek(idx - 1, false) }, '◀'),
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Next event', 'aria-label': 'Next event', onclick: () => seek(idx + 1, false) }, '▶'),
      srcToggle),
    evLine,
  );

  const replayStyle = `${docStyleCss(style)};--doc-size:10.5pt`.replace(/"/g, '&quot;');
  let idx = Math.max(0, N - 1);
  let showSrc = false;
  function render(i) {
    if (!N) {
      doc.textContent = '(empty)';
      return;
    }
    idx = Math.max(0, Math.min(N - 1, i));
    const e = F.events[idx];
    const st = stateAt(F, idx, idx - 40);
    if (showSrc) {
      doc.innerHTML = '';
      doc.append(h('div', { class: 'eyebrow' }, 'Sources'), h('div', { style: 'white-space:pre-wrap' }, st.src || '(empty)'));
    } else {
      let caretHtml = '<span class="caret"></span>';
      if (e.n && e.pane !== 'src' && (e.k === 'del' || e.k === 'rep' || e.k === 'paste_in' || e.k === 'ime')) {
        const before = stateAt(F, idx - 1, idx - 1).text;
        const gone = before.slice(e.p, e.p + e.n).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        caretHtml = `<span class="deleted">${gone}</span>${caretHtml}`;
      }
      const parts = paragraphParts(st.doc, {
        charClass: (j) => {
          const o = st.origin[j];
          return o === idx ? 'r1' : o >= 0 && o > idx - 40 ? 'r' : '';
        },
        caret: tl.cursor[idx],
        caretHtml,
      });
      doc.innerHTML = `<div class="doc" style="${replayStyle}">${parts.map((p) => `<div class="${p.cls}"${p.label ? ` data-label="${p.label}"` : ''}>${p.html}</div>`).join('')}${notesHtml(st.doc)}</div>`;
      if (!st.text.length) doc.firstChild.insertAdjacentHTML('beforeend', '<div class="muted">(empty page)</div>');
    }
    const caret = doc.querySelector('.caret');
    if (caret) {
      const top = caret.offsetTop - doc.offsetTop;
      if (top < doc.scrollTop + 20 || top > doc.scrollTop + doc.clientHeight - 40) doc.scrollTop = Math.max(0, top - doc.clientHeight / 3);
    }
    meta.innerHTML = '';
    meta.append(
      h('span', { 'data-tip': 'Writing time so far, not counting long breaks' }, h('strong', null, fmtClock(tl.clock[idx]))),
      h('span', null, new Date(tl.abs[idx]).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })),
      F.sessions.length > 1 ? h('span', null, `Session ${tl.session[idx] + 1} of ${F.sessions.length}`) : '',
      h('span', null, `${countWords(st.text)} words`),
    );
    evLine.textContent = describeEvent(e);
    range.value = idx;
    graph.setPlayhead(idx);
  }

  seek = (i, scroll) => {
    select('overview');
    stop();
    render(i);
    if (scroll && window.matchMedia('(max-width: 960px)').matches) aside.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  let raf = null;
  let vt = 0;
  let lastFrame = 0;
  function frame(now) {
    const dt = lastFrame ? now - lastFrame : 0;
    lastFrame = now;
    vt += dt * Number(speedSel.value);
    const next = indexAtClock(tl, vt);
    if (next !== idx) render(next);
    if (idx >= N - 1) return stop();
    raf = requestAnimationFrame(frame);
  }
  function play() {
    if (idx >= N - 1) render(0);
    vt = tl.clock[idx];
    lastFrame = 0;
    playBtn.textContent = '❚❚ Pause';
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    playBtn.textContent = '▶ Play';
  }
  playBtn.addEventListener('click', () => (raf ? stop() : play()));
  range.addEventListener('input', () => {
    stop();
    render(Number(range.value));
  });
  if (srcToggle) srcToggle.querySelector('input').addEventListener('change', (ev) => {
    showSrc = ev.target.checked;
    render(idx);
  });

  panels.overview = h('div', { role: 'tabpanel' }, h('div', { class: 'rp-grid' }, h('div', { class: 'rp-main' }, l1, l2, l3, l4), aside));

  // ---------- document tab ----------
  const final = finalDoc(F.file);
  const title = `${F.config.title} - ${header.student_label || 'submission'}`;
  const text = final.text;
  panels.document = h('div', { role: 'tabpanel', class: 'doc-view' },
    h('div', { class: 'doc-toolbar' },
      h('span', { class: 'muted small' },
        `${words.toLocaleString()} words · ${text.replace(/\s/g, '').length.toLocaleString()} characters · ${text.split('\n').filter((l) => l.trim()).length} paragraphs`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Copy the whole document, with formatting', onclick: () => copyDoc(final), html: `${ICONS.copy}<span>Copy</span>` }),
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Download as a Word document', onclick: () => downloadDocx(final, style, title), html: `${ICONS.download}<span>Word</span>` }),
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Download as plain text', onclick: () => downloadTxt(final, title), html: `${ICONS.download}<span>Text</span>` }),
      h('button', { class: 'btn small', type: 'button', 'data-tip': 'Print the document', onclick: () => printDoc(final, style, title), html: `${ICONS.print}<span>Print</span>` }),
    ),
    sourcesList(),
    h('div', { class: 'desk reader' }, documentPage(final, style)),
  );

  // Text the student pasted from outside (into the sources panel, or the document where allowed),
  // with the source details they gave.
  function sourcesList() {
    const cites = new Map();
    for (const e of F.events) if (e.k === 'cite' && Number.isInteger(e.of)) cites.set(e.of, e.x || '');
    const external = (e) => (e.it === 'insertFromPaste' || e.it === 'insertFromDrop') && (e.k === 'ins' || e.k === 'rep') && e.pane !== 'src';
    const pastes = F.events.filter((e) => e.k === 'paste_src' || external(e) || cites.has(e.s));
    if (!pastes.length) return '';
    const cited = pastes.filter((e) => cites.has(e.s)).length;
    return h('details', { class: 'card sources-card', open: true },
      h('summary', { 'data-tip': 'Text pasted from outside Draftwork, with the source details the student gave when prompted' },
        `Pasted sources (${pastes.length}${cited < pastes.length ? `, ${pastes.length - cited} without details` : ''})`),
      h('ol', { class: 'sources-list' }, pastes.map((e) => {
        const text = (e.x || '').replace(/\s+/g, ' ').trim();
        return h('li', null,
          h('div', { class: 'src-text' }, `“${text.length > 220 ? `${text.slice(0, 220)}…` : text}”`),
          h('div', { class: 'src-cite' }, cites.has(e.s) ? h('span', null, 'Source: ', h('strong', null, cites.get(e.s))) : h('span', { class: 'muted' }, 'No source given'),
            h('span', { class: 'muted' }, ` · ${e.pane === 'src' ? 'sources panel' : 'pasted into the document'} at ${fmtClock(tl.clock[e.s])}`)));
      })));
  }

  root.append(banner || '', head, tabs, panels.overview, panels.document,
    h('footer', { class: 'policy-footer' }, POLICY_FOOTER));
  select(tab);
  render(idx);
  return { seek, destroy: stop, select };
}
