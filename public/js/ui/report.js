// The replay viewer: integrity checks, flags, process signals and conversation prompts, with a scrubbable replay.
import { h, s, escapeHtml, copyText } from './dom.js';
import { productionGraph, indexAtClock } from './graph.js';
import { stateAt, fmtClock, fmtDuration, POLICY_FOOTER } from '../core/analysis.js';
import { countWords } from '../core/format.js';

const STATUS_MARK = { pass: '✓', fail: '✕', warn: '!', unknown: '?' };
const STATUS_TEXT = { pass: 'Pass', fail: 'Fail', warn: 'Check', unknown: 'Unknown' };
const SPEEDS = [1, 4, 16, 64, 256];

function describeEvent(e) {
  const q = (x) => JSON.stringify(x.length > 60 ? x.slice(0, 60) + '…' : x);
  const x = e.x || '';
  const where = e.pane === 'src' ? ' in sources pane' : '';
  switch (e.k) {
    case 'ins': return `inserted ${q(x)}${where} · ${e.it || ''}`;
    case 'del': return `deleted ${e.n} char${e.n === 1 ? '' : 's'}${where} · ${e.it || ''}`;
    case 'rep': return `replaced ${e.n} char${e.n === 1 ? '' : 's'} with ${q(x)}${where} · ${e.it || ''}`;
    case 'paste_in': return `pasted ${x.length} chars ${e.from === 'src' ? 'from the sources pane' : 'copied inside this document'}`;
    case 'paste_src': return `pasted ${x.length} chars into the sources pane`;
    case 'paste_blocked': return `external paste of ${e.len} chars refused by policy`;
    case 'ime': return `composed ${q(x)} (IME / dictation)`;
    case 'move': return `cursor jumped from ${e.from} to ${e.p}${where}`;
    case 'blur': return 'left the window';
    case 'focus': return 'came back to the window';
    case 'session_start': return `session started ${new Date(e.w).toLocaleString()}`;
    case 'session_end': return 'session ended';
    case 'untrusted': return `script-generated input refused (${e.it || 'unknown'})`;
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
  const svg = s('svg', { class: 'strip', width: W, height: 22, viewBox: `0 0 ${W} 22`, role: 'img', 'aria-label': `Class distribution, this file at ${fmt(me)}` });
  svg.append(s('line', { x1: 6, x2: W - 6, y1: 11, y2: 11, stroke: 'var(--border)' }));
  for (const v of values) svg.append(s('circle', { class: 'd', cx: x(v), cy: 11, r: 3 }));
  for (const p of priors) if (Number.isFinite(p.value)) svg.append(s('circle', { class: 'prior', cx: x(p.value), cy: 11, r: 5 }, s('title', {}, `${p.title}: ${fmt(p.value)}`)));
  svg.append(s('circle', { class: 'me', cx: x(me), cy: 11, r: 4.5 }, s('title', {}, `This file: ${fmt(me)}`)));
  const below = values.filter((v) => v < me).length;
  return h('div', null, svg, h('div', { class: 'small muted' }, `${Math.round((below / values.length) * 100)}th pct · n=${values.length}`));
}

export function renderReport(root, F, { mode = 'instructor' } = {}) {
  root.innerHTML = '';
  const N = F.events.length;
  const tl = F.tl;
  const words = countWords(F.file.final.text);
  const elapsed = N ? tl.abs[N - 1] - tl.abs[0] : 0;
  const header = F.header;
  let seek = () => {};

  const moment = (i, label) => h('button', { class: 'btn small', type: 'button', onclick: () => seek(i, true) }, '▶ ', label);

  // ---------- head ----------
  const failing = F.integrity.filter((c) => c.status === 'fail').length;
  const head = h('div', { class: 'rp-head' },
    h('div', { class: 'layer-label' }, F.config.title),
    h('h1', null, header.student_label || 'Unlabelled submission'),
    h('div', { class: 'rp-stats' },
      h('span', null, `${words.toLocaleString()} words`),
      h('span', null, `${fmtDuration(F.raw.active)} active writing`),
      h('span', null, `${F.sessions.length} session${F.sessions.length === 1 ? '' : 's'} over ${fmtDuration(elapsed)}`),
      h('span', null, `${N.toLocaleString()} events`),
      F.sessions[0] && h('span', null, `started ${new Date(F.sessions[0].wall).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`),
      header.dictation_mode && h('span', { class: 'pill accent' }, 'Dictation mode'),
    ),
    h('div', { class: 'rp-glance' },
      h('a', { href: '#layer-integrity', class: `pill ${failing ? 'bad' : F.integrity.some((c) => c.status !== 'pass') ? 'warn' : 'ok'}` },
        h('span', { class: 'dot' }), failing ? `${failing} integrity check${failing === 1 ? '' : 's'} failed` : `Integrity ${F.integrity.filter((c) => c.status === 'pass').length}/${F.integrity.length} pass`),
      h('a', { href: '#layer-flags', class: `pill ${F.flags.length ? 'warn' : ''}` }, `${F.flags.length} flag${F.flags.length === 1 ? '' : 's'}`),
      h('a', { href: '#layer-prompts', class: 'pill accent' }, `${F.prompts.length} conversation prompt${F.prompts.length === 1 ? '' : 's'}`),
    ),
    (header.process_notes || (header.attachments || []).length > 0) && h('div', { class: 'rp-notes' },
      h('div', { class: 'layer-label' }, 'Student’s process notes'),
      header.process_notes && h('div', null, header.process_notes),
      (header.attachments || []).map((a) => h('div', { class: 'small muted' },
        `Outline attached: ${a.filename} (image not stored; SHA-256 ${a.sha256.slice(0, 16)}…, added ${new Date(a.added).toLocaleDateString()})`)),
    ),
  );

  const banner = mode === 'student' && h('div', { class: 'notice info', style: 'margin-bottom:16px' },
    h('strong', null, 'This is what your instructor will see. '),
    'Class comparisons and the two class-relative flags (too fast for the length, machine-regular rhythm) appear only when your instructor opens the whole class. ',
    'Nothing here is a score: a pattern can only lead to a conversation.');

  // ---------- layer 1 ----------
  const l1 = h('section', { class: 'card', id: 'layer-integrity' },
    h('div', { class: 'section-head' },
      h('div', null, h('div', { class: 'layer-label' }, 'Layer 1'), h('h2', null, 'Integrity checks')),
      h('span', { class: 'small muted' }, 'Pass or fail. A failure means the file was altered or built outside the app.')),
    h('ul', { class: 'checks' }, F.integrity.map((c) => h('li', null,
      h('span', { class: `mark ${c.status}`, title: STATUS_TEXT[c.status] }, STATUS_MARK[c.status]),
      h('span', null, c.label),
      h('span', { class: 'detail' }, c.detail)))),
  );

  // ---------- layer 2 ----------
  const l2 = h('section', { class: 'card', id: 'layer-flags' },
    h('div', { class: 'section-head' },
      h('div', null, h('div', { class: 'layer-label' }, 'Layer 2'), h('h2', null, 'Flags')),
      h('span', { class: 'small muted' }, 'Each stands alone. They are never combined into a score.')),
    F.flags.length
      ? F.flags.map((f) => h('div', { class: `flag ${f.kind}` },
        h('h3', null, f.title, h('span', { class: `pill ${f.kind === 'integrity' ? 'bad' : 'warn'}` }, f.kind === 'integrity' ? 'Integrity' : 'Pattern')),
        h('div', null, f.reason),
        f.moments.length ? h('div', { class: 'moments' }, f.moments.map((m) => moment(m.i, m.label))) : null,
        h('div', { class: 'benign' },
          h('strong', null, f.kind === 'integrity' ? 'Before concluding anything' : 'Benign readings'),
          h('ul', null, f.benign.map((b) => h('li', null, b)),
            f.kind === 'pattern' && header.process_notes ? h('li', null, h('em', null, `Student’s note: “${header.process_notes}”`)) : null)),
      ))
      : h('p', { class: 'empty-state' }, 'No flags. Nothing unusual and nothing matching a known misuse pattern.'),
    !F.classOn && h('p', { class: 'small muted', style: 'margin-top:10px' },
      `Class-relative flags (too fast for the length, machine-regular rhythm) switch on at ${F.T.min_class_size} submissions for this assignment; ${F.cohortSize} loaded.`),
  );

  // ---------- layer 3 ----------
  const markers = [
    ...F.flags.flatMap((f) => f.moments.map((m) => ({ i: m.i, kind: 'flag', label: `${f.title}: ${m.label}` }))),
    ...F.prompts.map((p, k) => ({ i: p.i, kind: 'prompt', label: `Prompt ${k + 1}: ${p.title}` })),
  ];
  const graph = productionGraph(F, { onSeek: (i) => seek(i, false), markers });
  const statsById = Object.fromEntries((F.classStats || []).map((c) => [c.id, c]));
  const hasPriors = (F.classStats || []).some((c) => c.priors.length);
  const l3 = h('section', { class: 'card', id: 'layer-signals' },
    h('div', { class: 'section-head' },
      h('div', null, h('div', { class: 'layer-label' }, 'Layer 3'), h('h2', null, 'Process signals')),
      h('span', { class: 'small muted' }, 'Observations, not verdicts.')),
    h('p', { class: 'small muted' },
      'In composed writing the lines separate: typed exceeds length because of deletions, and the cursor drops whenever the writer goes back. In transcribed writing the three lines run almost on top of one another.'),
    graph.el,
    h('div', { class: 'table-wrap', style: 'margin-top:16px' },
      h('table', { class: 'signals' },
        h('thead', null, h('tr', null,
          h('th', null, 'Signal'), h('th', null, 'This file'), h('th', null, hasPriors ? 'Class · own earlier work' : 'Class'))),
        h('tbody', null, F.signals.map((sg) => {
          const cs = statsById[sg.id] || { values: [], priors: [] };
          const fmt = sg.fmt || ((v) => (Number.isFinite(v) ? v.toFixed(1) : '—'));
          return h('tr', null,
            h('td', null, sg.name, h('div', { class: 'small muted', style: 'font-weight:400;white-space:normal' }, sg.measures)),
            h('td', { class: 'val' },
              h('div', { class: sg.watch ? 'watch' : '' }, sg.value),
              sg.moments && sg.moments.length ? h('div', { class: 'moments' }, sg.moments.slice(0, 6).map((i) => moment(i, fmtClock(tl.clock[i])))) : null,
              h('div', { class: 'small muted', style: 'margin-top:4px' }, h('em', null, 'Transcription tends to look like: '), sg.transcription),
              h('div', { class: 'small muted' }, h('em', null, 'Benign explanations: '), sg.benign)),
            h('td', null,
              strip(cs.values, sg.metric, cs.priors, fmt) || h('span', { class: 'muted small' }, 'Open the class to compare'),
              cs.priors.map((p) => h('div', { class: 'small' }, `${p.title}: `, h('strong', null, fmt(p.value))))),
          );
        })))),
    h('p', { class: 'small muted', style: 'margin-top:8px' },
      'Thresholds are illustrative starting points to calibrate on real data, not validated cutoffs. Comparisons are only ever against this class and the student’s own earlier files, never a fixed population norm.'),
  );

  // ---------- layer 4 ----------
  const l4 = h('section', { class: 'card', id: 'layer-prompts' },
    h('div', { class: 'section-head' },
      h('div', null, h('div', { class: 'layer-label' }, 'Layer 4'), h('h2', null, 'Conversation prompts')),
      F.prompts.length ? h('button', { class: 'btn small', type: 'button', onclick: () => copyText(F.prompts.map((p, k) => `${k + 1}. ${p.question}`).join('\n')) }, 'Copy questions') : null),
    h('p', { class: 'small muted' }, 'A student who wrote the piece answers these in seconds. Flagged moments come first.'),
    F.prompts.length
      ? h('ol', { class: 'prompts' }, F.prompts.map((p) => h('li', null,
        h('div', { class: 'row' }, h('span', { class: `pill ${p.flagged ? 'warn' : 'accent'}` }, p.title)),
        h('div', { class: 'q' }, p.question),
        moment(p.i, `Jump to ${fmtClock(tl.clock[p.i])}`))))
      : h('p', { class: 'empty-state' }, 'Not enough activity to pick moments yet.'),
  );

  // ---------- replay ----------
  const doc = h('div', { class: 'replay-doc', tabindex: '0', 'aria-label': 'Document at the selected moment' });
  const meta = h('div', { class: 'replay-meta' });
  const evLine = h('div', { class: 'replay-event' });
  const range = h('input', { type: 'range', min: 0, max: Math.max(0, N - 1), value: Math.max(0, N - 1), 'aria-label': 'Replay position' });
  const ticks = h('div', { class: 'ticks' }, markers.map((m) => h('button', {
    class: `tick ${m.kind}`, type: 'button', title: m.label, 'aria-label': m.label,
    style: `left:${N > 1 ? (m.i / (N - 1)) * 100 : 0}%`, onclick: () => seek(m.i, false),
  })));
  const playBtn = h('button', { class: 'btn small primary', type: 'button' }, '▶ Play');
  const speedSel = h('select', { 'aria-label': 'Playback speed' }, SPEEDS.map((v) => h('option', { value: v, selected: v === 16 }, `${v}×`)));
  const srcToggle = F.replaySrc ? h('label', { class: 'check small', style: 'margin:0' }, h('input', { type: 'checkbox' }), 'Show sources pane') : null;
  const aside = h('aside', { class: 'replay card', id: 'replay' },
    h('div', { class: 'section-head' }, h('h2', null, 'Replay'), h('span', { class: 'small muted' }, 'Recent changes highlighted')),
    doc, meta,
    h('div', { class: 'scrub' }, range, ticks),
    h('div', { class: 'replay-controls' },
      playBtn, speedSel,
      h('button', { class: 'btn small', type: 'button', title: 'Previous event', onclick: () => seek(idx - 1, false) }, '◀'),
      h('button', { class: 'btn small', type: 'button', title: 'Next event', onclick: () => seek(idx + 1, false) }, '▶'),
      srcToggle),
    evLine,
  );

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
    let html = '';
    if (showSrc) {
      html = `<div class="layer-label">Sources pane</div>${escapeHtml(st.src) || '<span class="muted">(empty)</span>'}`;
    } else {
      const caretPos = tl.cursor[idx];
      let deletedHtml = '';
      if (e.n && e.pane !== 'src') {
        const before = stateAt(F, idx - 1, idx - 1).text;
        deletedHtml = `<span class="deleted">${escapeHtml(before.slice(e.p, e.p + e.n))}</span>`;
      }
      const text = st.text;
      let j = 0;
      while (j <= text.length) {
        if (j === caretPos) html += (e.n && e.pane !== 'src' && e.p === j - (e.x || '').length ? deletedHtml : '') + '<span class="caret"></span>';
        if (j === text.length) break;
        const o = st.origin[j];
        let k = j + 1;
        while (k < text.length && st.origin[k] === o && k !== caretPos) k++;
        const cls = o === idx ? 'r1' : o >= 0 && o > idx - 40 ? 'r' : '';
        const chunk = escapeHtml(text.slice(j, k));
        html += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
        j = k;
      }
      if (!text.length) html += '<span class="muted">(empty document)</span>';
    }
    doc.innerHTML = html;
    const caret = doc.querySelector('.caret');
    if (caret) {
      const top = caret.offsetTop - doc.offsetTop;
      if (top < doc.scrollTop + 20 || top > doc.scrollTop + doc.clientHeight - 40) doc.scrollTop = Math.max(0, top - doc.clientHeight / 3);
    }
    const S = F.sessions[tl.session[idx]];
    meta.innerHTML = '';
    meta.append(
      h('span', null, h('strong', null, fmtClock(tl.clock[idx])), ' writing time'),
      h('span', null, new Date(tl.abs[idx]).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span', null, `session ${tl.session[idx] + 1}/${F.sessions.length}`),
      h('span', null, `event ${idx.toLocaleString()}/${(N - 1).toLocaleString()}`),
      h('span', null, `${countWords(st.text)} words`),
    );
    evLine.textContent = describeEvent(e);
    range.value = idx;
    graph.setPlayhead(idx);
    void S;
  }

  seek = (i, scroll) => {
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

  root.append(
    banner || '',
    head,
    h('div', { class: 'rp-grid' }, h('div', { class: 'rp-main' }, l1, l2, l3, l4), aside),
    h('footer', { class: 'policy-footer' }, POLICY_FOOTER),
  );
  render(idx);
  return { seek, destroy: stop };
}
