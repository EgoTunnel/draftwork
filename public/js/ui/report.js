// The submission viewer: an Overview (integrity, flags, writing process, questions, replay)
// and a Document tab showing the submitted text as the student formatted it.
import { h, s, toast } from './dom.js';
import { productionGraph, indexAtClock } from './graph.js';
import { stateAt, fmtClock, fmtDuration, POLICY_FOOTER } from '../core/analysis.js';
import { countWords, finalDoc } from '../core/format.js';
import { paragraphParts, docStyleCss, toPlainText, toClipboardHtml } from '../core/export.js';
import { documentPage, downloadDocx, downloadTxt, printDoc } from './docui.js';
import { ICONS } from './icons.js';

const STATUS_MARK = { pass: '✓', fail: '✕', warn: '!', unknown: '?' };
const STATUS_TEXT = { pass: 'Passed', fail: 'Failed', warn: 'Passed, with a note', unknown: 'Could not check' };
const SPEEDS = [1, 4, 16, 64, 256];

function describeEvent(e) {
  const q = (x) => JSON.stringify(x.length > 60 ? x.slice(0, 60) + '…' : x);
  const x = e.x || '';
  const where = e.pane === 'src' ? ' (sources)' : '';
  switch (e.k) {
    case 'ins': return `Typed ${q(x)}${where}`;
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

export function renderReport(root, F, { mode = 'instructor', tab = 'overview', onTab = null } = {}) {
  root.innerHTML = '';
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
    ),
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
    h('span', { class: `pill ${F.flags.length ? 'warn' : ''}` }, `${F.flags.length} flag${F.flags.length === 1 ? '' : 's'}`));

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
        moment(p.i, `Show at ${fmtClock(tl.clock[p.i])}`))))
      : h('p', { class: 'empty-state' }, 'Not enough writing yet to suggest questions.'),
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
      doc.innerHTML = `<div class="doc" style="${replayStyle}">${parts.map((p) => `<div class="${p.cls}"${p.label ? ` data-label="${p.label}"` : ''}>${p.html}</div>`).join('')}</div>`;
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
      F.sessions.length > 1 && h('span', null, `Session ${tl.session[idx] + 1} of ${F.sessions.length}`),
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
    h('div', { class: 'desk reader' }, documentPage(final, style)),
  );

  root.append(banner || '', head, tabs, panels.overview, panels.document,
    h('footer', { class: 'policy-footer' }, POLICY_FOOTER));
  select(tab);
  render(idx);
  return { seek, destroy: stop, select };
}
