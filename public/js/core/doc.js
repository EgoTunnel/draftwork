// The formatted document: plain text plus per-character marks and per-paragraph attributes.
// Paragraphs are separated by "\n". Every rule here is deterministic, because replay must
// rebuild exactly what the editor produced.
import { canonical } from './canon.js';

export const MARKS = { b: 1, i: 2, u: 4, s: 8, sup: 16, sub: 32, hl: 64 };
export const ALL_MARKS = 127;
export const STYLES = { p: 'Normal', title: 'Title', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', quote: 'Quote', bib: 'Works Cited' };
export const ALIGNS = { l: 'Left', c: 'Center', r: 'Right', j: 'Justify' };
export const LISTS = { '': 'None', ul: 'Bulleted', ol: 'Numbered' };
export const MAX_INDENT = 5;
export const DEFAULT_PARA = Object.freeze({ s: 'p', al: 'l', li: '', in: 0 });
export const HEADING_STYLES = new Set(['title', 'h1', 'h2', 'h3']);

export const isFormatEvent = (e) => e.k === 'fmt' || e.k === 'para';

export function runsOf(marks, from = 0, to = marks.length) {
  const out = [];
  for (let i = from; i < to; i++) {
    const last = out[out.length - 1];
    if (last && last[1] === marks[i]) last[0]++;
    else out.push([1, marks[i]]);
  }
  return out;
}

export function expandRuns(runs) {
  const out = [];
  for (const [n, m] of runs) {
    if (!Number.isInteger(n) || n < 0 || !Number.isInteger(m) || m < 0 || m > ALL_MARKS) throw new Error('bad formatting runs');
    for (let k = 0; k < n; k++) out.push(m);
  }
  return out;
}

// Event fields for the formatting of inserted text: nothing, a single mask, or runs.
export function marksField(runs) {
  if (!runs.length) return {};
  if (runs.length === 1) return runs[0][1] ? { m: runs[0][1] } : {};
  return { mr: runs };
}

export function normPara(a) {
  const p = { ...DEFAULT_PARA, ...(a || {}) };
  if (!(p.s in STYLES)) throw new Error(`unknown paragraph style ${p.s}`);
  if (!(p.al in ALIGNS)) throw new Error(`unknown alignment ${p.al}`);
  if (!(p.li in LISTS)) throw new Error(`unknown list type ${p.li}`);
  if (!Number.isInteger(p.in) || p.in < 0 || p.in > MAX_INDENT) throw new Error('bad indent');
  // `pb` (page break before) is only present when set, so documents without breaks hash as before.
  return p.pb ? { s: p.s, al: p.al, li: p.li, in: p.in, pb: true } : { s: p.s, al: p.al, li: p.li, in: p.in };
}

export const samePara = (a, b) => a.s === b.s && a.al === b.al && a.li === b.li && a.in === b.in && !!a.pb === !!b.pb;

// New paragraphs created by Enter never inherit a page break.
const withoutBreak = (a) => {
  const { pb, ...rest } = a;
  return rest;
};

export function countNl(s) {
  let c = 0;
  for (let j = s.indexOf('\n'); j !== -1; j = s.indexOf('\n', j + 1)) c++;
  return c;
}

export class DocModel {
  constructor(text = '', marks = null, paras = null) {
    this.text = text;
    this.marks = marks || new Array(text.length).fill(0);
    this.paras = paras || Array.from({ length: countNl(text) + 1 }, () => ({ ...DEFAULT_PARA }));
  }

  static fromFormat(text, format) {
    const marks = format && format.marks ? expandRuns(format.marks) : null;
    const paras = format && format.paras ? format.paras.map(normPara) : null;
    const d = new DocModel(text, marks, paras);
    if (d.marks.length !== text.length || d.paras.length !== countNl(text) + 1) throw new Error('formatting does not fit the text');
    return d;
  }

  clone() {
    return new DocModel(this.text, this.marks.slice(), this.paras.map((p) => ({ ...p })));
  }

  paraIndexAt(p) {
    let k = 0;
    for (let j = this.text.indexOf('\n'); j !== -1 && j < p; j = this.text.indexOf('\n', j + 1)) k++;
    return k;
  }

  // [start, end) of every paragraph's text.
  paraBounds() {
    const out = [];
    let start = 0;
    for (let j = this.text.indexOf('\n'); j !== -1; j = this.text.indexOf('\n', j + 1)) {
      out.push([start, j]);
      start = j + 1;
    }
    out.push([start, this.text.length]);
    return out;
  }

  apply(e) {
    if (e.k === 'fmt') return this.applyFmt(e);
    if (e.k === 'para') return this.applyPara(e);
    return this.applyText(e.p, e.n || 0, e.x || '', e.mr || e.m || 0);
  }

  applyText(p, n, x, m) {
    const t = this.text;
    if (!Number.isInteger(p) || !Number.isInteger(n) || p < 0 || n < 0 || p + n > t.length) throw new Error('edit outside the document');
    const added = Array.isArray(m) ? expandRuns(m) : new Array(x.length).fill(m | 0);
    if (added.length !== x.length) throw new Error('formatting does not match inserted text');
    const k1 = this.paraIndexAt(p);
    const startOfPara = p === 0 || t[p - 1] === '\n';

    // Deleting across paragraph breaks merges paragraphs. The first one keeps its attributes,
    // unless the deletion starts at its very beginning (it disappeared entirely).
    const removedNl = n ? countNl(t.slice(p, p + n)) : 0;
    if (removedNl) this.paras.splice(startOfPara ? k1 : k1 + 1, removedNl);
    const mid = t.slice(0, p) + t.slice(p + n);

    // New paragraphs: Enter at the end of a heading starts a Normal paragraph; Enter at the
    // start of a paragraph pushes it down; Enter in the middle splits it with the same style.
    const nl = countNl(x);
    if (nl) {
      const base = this.paras[k1];
      const lineEnd = mid.indexOf('\n', p);
      const atEnd = (lineEnd === -1 ? mid.length : lineEnd) === p;
      const next = withoutBreak(HEADING_STYLES.has(base.s) ? { ...base, s: 'p' } : { ...base });
      const copies = (src) => Array.from({ length: nl }, () => withoutBreak({ ...src }));
      if (startOfPara && !atEnd) this.paras.splice(k1, 0, ...copies(next));
      else if (atEnd) this.paras.splice(k1 + 1, 0, ...copies(next));
      else this.paras.splice(k1 + 1, 0, ...copies(base));
    }
    this.text = mid.slice(0, p) + x + mid.slice(p);
    this.marks.splice(p, n, ...added);
  }

  // { p, n, set, clr } toggles marks over a range; { p, mr } sets them exactly.
  applyFmt(e) {
    const p = e.p;
    if (e.mr) {
      const exact = expandRuns(e.mr);
      if (!Number.isInteger(p) || p < 0 || p + exact.length > this.text.length) throw new Error('formatting outside the document');
      for (let i = 0; i < exact.length; i++) this.marks[p + i] = exact[i];
      return;
    }
    const n = e.n || 0;
    const set = e.set || 0;
    const clr = e.clr || 0;
    if (!Number.isInteger(p) || p < 0 || p + n > this.text.length || set > ALL_MARKS || clr > ALL_MARKS) throw new Error('formatting outside the document');
    for (let i = p; i < p + n; i++) this.marks[i] = (this.marks[i] | set) & ~clr;
  }

  // { a, b, set } changes some attributes of paragraphs a..a+b-1; { a, pa } sets them exactly.
  applyPara(e) {
    const a = e.a;
    if (e.pa) {
      if (!Number.isInteger(a) || a < 0 || a + e.pa.length > this.paras.length) throw new Error('paragraph outside the document');
      e.pa.forEach((attrs, i) => {
        this.paras[a + i] = normPara(attrs);
      });
      return;
    }
    const b = e.b || 1;
    if (!Number.isInteger(a) || a < 0 || a + b > this.paras.length) throw new Error('paragraph outside the document');
    for (let k = a; k < a + b; k++) this.paras[k] = normPara({ ...this.paras[k], ...e.set });
  }

  hasFormat() {
    return this.marks.some(Boolean) || this.paras.some((p) => !samePara(p, DEFAULT_PARA));
  }

  format() {
    return this.hasFormat() ? { marks: runsOf(this.marks), paras: this.paras.map((p) => ({ ...p })) } : null;
  }

  // What checkpoints hash. Unformatted documents hash their text alone.
  hashInput() {
    const f = this.format();
    return f ? this.text + '\u0000' + canonical(f) : this.text;
  }
}

// Events that turn `doc` into `target` (used for undo and redo).
export function diffEvents(doc, target, it, diffOp) {
  const out = [];
  const op = diffOp(doc.text, target.text);
  if (op) {
    out.push({
      k: op.n === 0 ? 'ins' : op.x === '' ? 'del' : 'rep',
      p: op.p,
      n: op.n || undefined,
      x: op.x || undefined,
      ...(op.x ? marksField(runsOf(target.marks, op.p, op.p + op.x.length)) : {}),
      it,
    });
  }
  // After the text op the lengths match, so compare against the model the op produces.
  const after = doc.clone();
  if (op) after.applyText(op.p, op.n, op.x, op.x ? runsOf(target.marks, op.p, op.p + op.x.length) : 0);
  let a = 0;
  let b = after.marks.length - 1;
  while (a <= b && after.marks[a] === target.marks[a]) a++;
  while (b >= a && after.marks[b] === target.marks[b]) b--;
  if (a <= b) out.push({ k: 'fmt', p: a, mr: runsOf(target.marks, a, b + 1), it });
  a = 0;
  b = after.paras.length - 1;
  while (a <= b && samePara(after.paras[a], target.paras[a])) a++;
  while (b >= a && samePara(after.paras[b], target.paras[b])) b--;
  if (a <= b) out.push({ k: 'para', a, pa: target.paras.slice(a, b + 1).map((p) => ({ ...p })), it });
  return out;
}
