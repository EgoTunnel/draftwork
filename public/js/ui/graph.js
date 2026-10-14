// Production graph (Inputlog-style): characters typed, document length and cursor position over writing time.
// Drawn at the container's pixel width so labels stay legible at any size.
import { s, h } from './dom.js';
import { fmtClock } from '../core/analysis.js';

const H = 240;
const M = { l: 48, r: 10, t: 14, b: 34 };

export function indexAtClock(tl, ms) {
  let lo = 0;
  let hi = tl.clock.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.clock[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function niceStep(max, target) {
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

export function productionGraph(F, { onSeek, markers = [] } = {}) {
  const { tl, sessions } = F;
  const N = tl.clock.length;
  const maxT = Math.max(1, N ? tl.clock[N - 1] : 1);
  let maxY = 1;
  for (let i = 0; i < N; i++) maxY = Math.max(maxY, tl.typed[i], tl.len[i], tl.cursor[i]);

  const svg = s('svg', { class: 'graph', height: H, role: 'img', 'aria-label': 'Production graph: characters typed, document length and cursor position over writing time' });
  let W = 0;
  let x = () => 0;
  let playhead = null;
  let lastIdx = Math.max(0, N - 1);

  function draw(width) {
    W = Math.max(280, Math.round(width));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.replaceChildren();
    const pw = W - M.l - M.r;
    const ph = H - M.t - M.b;
    x = (ms) => M.l + (ms / maxT) * pw;
    const y = (v) => M.t + ph - (v / maxY) * ph;

    // One sample per pixel column; the cursor keeps the minimum so jumps back stay visible.
    const typed = [];
    const len = [];
    const cur = [];
    let i = 0;
    for (let col = 0; col <= pw && N; col++) {
      const tEnd = ((col + 1) / pw) * maxT;
      let minCur = Infinity;
      let last = -1;
      while (i < N && tl.clock[i] <= tEnd) {
        minCur = Math.min(minCur, tl.cursor[i]);
        last = i++;
      }
      if (last < 0) continue;
      const px = (M.l + col).toFixed(1);
      typed.push(`${px},${y(tl.typed[last]).toFixed(1)}`);
      len.push(`${px},${y(tl.len[last]).toFixed(1)}`);
      cur.push(`${px},${y(minCur).toFixed(1)}`);
    }

    const axis = s('g', { class: 'axis' });
    const yStep = niceStep(maxY, 4);
    for (let v = 0; v <= maxY; v += yStep) {
      axis.append(s('line', { class: 'grid', x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }));
      axis.append(s('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toLocaleString()));
    }
    const xStep = niceStep(maxT / 60_000, Math.max(2, Math.floor(pw / 90))) * 60_000;
    for (let t = 0; t <= maxT; t += xStep) axis.append(s('text', { x: x(t), y: H - M.b + 16, 'text-anchor': 'middle' }, fmtClock(t)));
    axis.append(s('text', { x: W - M.r, y: H - 3, 'text-anchor': 'end' }, 'writing time (h:mm), long breaks removed'));
    axis.append(s('text', { x: 11, y: M.t + ph / 2, transform: `rotate(-90 11 ${M.t + ph / 2})`, 'text-anchor': 'middle' }, 'characters'));
    svg.append(axis);

    sessions.forEach((S, k) => {
      if (k === 0) return;
      const sx = x(tl.clock[S.i0]);
      svg.append(s('line', { class: 'session', x1: sx, x2: sx, y1: M.t, y2: M.t + ph }));
      svg.append(s('text', { class: 'session-label', x: sx + 4, y: M.t + 10 },
        `Session ${k + 1} · ${new Date(S.wall).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
    });

    svg.append(s('polyline', { class: 'l-typed', points: typed.join(' ') }));
    svg.append(s('polyline', { class: 'l-len', points: len.join(' ') }));
    svg.append(s('polyline', { class: 'l-cursor', points: cur.join(' ') }));

    for (const m of markers) {
      const mx = x(tl.clock[Math.min(m.i, N - 1)]);
      svg.append(s('path', { class: m.kind === 'flag' ? 'mk-flag' : 'mk-prompt', d: `M${mx - 5},${H - M.b + 1} L${mx + 5},${H - M.b + 1} L${mx},${H - M.b - 7} Z` },
        s('title', {}, m.label)));
    }
    playhead = s('line', { class: 'playhead', y1: M.t, y2: M.t + ph });
    svg.append(playhead);
    setPlayhead(lastIdx);
  }

  function setPlayhead(idx) {
    lastIdx = idx;
    if (!N || !playhead) return;
    const px = x(tl.clock[Math.min(idx, N - 1)]);
    playhead.setAttribute('x1', px);
    playhead.setAttribute('x2', px);
  }

  const seekFromEvent = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const ms = Math.max(0, Math.min(maxT, ((px - M.l) / (W - M.l - M.r)) * maxT));
    onSeek && onSeek(indexAtClock(tl, ms));
  };
  let dragging = false;
  svg.addEventListener('pointerdown', (ev) => {
    dragging = true;
    svg.setPointerCapture(ev.pointerId);
    seekFromEvent(ev);
  });
  svg.addEventListener('pointermove', (ev) => dragging && seekFromEvent(ev));
  svg.addEventListener('pointerup', () => (dragging = false));

  const legend = h('div', { class: 'legend' },
    h('span', null, h('i', { style: 'border-color: var(--accent)' }), 'Total characters ever typed'),
    h('span', null, h('i', { style: 'border-color: var(--accent-2)' }), 'Current document length'),
    h('span', null, h('i', { style: 'border-color: var(--cursor-line); border-top-style: dashed' }), 'Cursor position'),
    h('span', null, markers.length ? '▲ flags (red) and prompts (blue) · click or drag to scrub' : 'Click or drag to scrub'));

  const el = h('div', { class: 'graph-wrap' }, svg, legend);
  const ro = new ResizeObserver(([entry]) => {
    const wNow = entry.contentRect.width;
    if (wNow && Math.abs(wNow - W) > 8) draw(wNow);
  });
  ro.observe(el);
  return { el, setPlayhead };
}
