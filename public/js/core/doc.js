// The formatted document: plain text plus per-character marks, per-paragraph attributes and
// footnotes. Paragraphs are separated by "\n". Every rule here is deterministic, because replay
// must rebuild exactly what the editor produced.
import { canonical } from './canon.js';

// A mark is a number: bits 0–6 are flags, bits 7–10 a font index, bits 11–15 a size index.
// Index 0 means "the document's default". The font and size tables are append-only.
export const MARKS = { b: 1, i: 2, u: 4, s: 8, sup: 16, sub: 32, hl: 64 };
export const ALL_MARKS = 127;
export const FONT_KEYS = ['', 'times', 'georgia', 'garamond', 'palatino', 'arial', 'calibri', 'verdana', 'courier'];
export const SIZE_LIST = [0, 8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36];
export const FONT_SHIFT = 7;
export const FONT_MASK = 0xf << FONT_SHIFT;
export const SIZE_SHIFT = 11;
export const SIZE_MASK = 0x1f << SIZE_SHIFT;
export const fontOf = (m) => (m & FONT_MASK) >> FONT_SHIFT;
export const sizeOf = (m) => (m & SIZE_MASK) >> SIZE_SHIFT;

// A footnote is this character in the text; its note text is kept in `notes`, in anchor order.
export const FOOTNOTE = '￼';

export const STYLES = { p: 'Normal', title: 'Title', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', quote: 'Quote', bib: 'Works Cited' };
export const ALIGNS = { l: 'Left', c: 'Center', r: 'Right', j: 'Justify' };
export const LISTS = { '': 'None', ul: 'Bulleted', ol: 'Numbered' };
export const MAX_INDENT = 5;
export const DEFAULT_PARA = Object.freeze({ s: 'p', al: 'l', li: '', in: 0 });
export const HEADING_STYLES = new Set(['title', 'h1', 'h2', 'h3']);

// Events that change the essay without being text events.
export const isFormatEvent = (e) => e.k === 'fmt' || e.k === 'para' || e.k === 'note';

const validMark = (m) => Number.isInteger(m) && m >= 0 && m <= 0xffff && fontOf(m) < FONT_KEYS.length && sizeOf(m) < SIZE_LIST.length;

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
    if (!Number.isInteger(n) || n < 0 || !validMark(m)) throw new Error('bad formatting runs');
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

export function countNotes(s, from = 0, to = s.length) {
  let c = 0;
  for (let j = s.indexOf(FOOTNOTE, from); j !== -1 && j < to; j = s.indexOf(FOOTNOTE, j + 1)) c++;
  return c;
}

export class DocModel {
  constructor(text = '', marks = null, paras = null, notes = null) {
    this.text = text;
    this.marks = marks || new Array(text.length).fill(0);
    this.paras = paras || Array.from({ length: countNl(text) + 1 }, () => ({ ...DEFAULT_PARA }));
    this.notes = notes || new Array(countNotes(text)).fill('');
  }

  static fromFormat(text, format) {
    const marks = format && format.marks ? expandRuns(format.marks) : null;
    const paras = format && format.paras ? format.paras.map(normPara) : null;
    const notes = format && format.notes ? format.notes.map(String) : null;
    const d = new DocModel(text, marks, paras, notes);
    if (d.marks.length !== text.length || d.paras.length !== countNl(text) + 1 || d.notes.length !== countNotes(text)) {
      throw new Error('formatting does not fit the text');
    }
    return d;
  }

  clone() {
    return new DocModel(this.text, this.marks.slice(), this.paras.map((p) => ({ ...p })), this.notes.slice());
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
    if (e.k === 'note') return this.applyNote(e);
    return this.applyText(e.p, e.n || 0, e.x || '', e.mr || e.m || 0);
  }

  applyText(p, n, x, m) {
    const t = this.text;
    if (!Number.isInteger(p) || !Number.isInteger(n) || p < 0 || n < 0 || p + n > t.length) throw new Error('edit outside the document');
    const added = Array.isArray(m) ? expandRuns(m) : new Array(x.length).fill(m | 0);
    if (added.length !== x.length || (!Array.isArray(m) && !validMark(m | 0))) throw new Error('formatting does not match inserted text');
    const k1 = this.paraIndexAt(p);
    const startOfPara = p === 0 || t[p - 1] === '\n';

    // Footnotes follow their anchors: removed anchors take their notes with them, and inserted
    // anchors get empty notes, at the position of the anchor in the document.
    const notesBefore = countNotes(t, 0, p);
    const removedNotes = n ? countNotes(t, p, p + n) : 0;
    if (removedNotes) this.notes.splice(notesBefore, removedNotes);
    const addedNotes = countNotes(x);
    if (addedNotes) this.notes.splice(notesBefore, 0, ...new Array(addedNotes).fill(''));

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

  // { p, n, set, clr, font?, size? } changes marks over a range; { p, mr } sets them exactly.
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
    const font = e.font;
    const size = e.size;
    if (!Number.isInteger(p) || p < 0 || p + n > this.text.length || set > ALL_MARKS || clr > ALL_MARKS) throw new Error('formatting outside the document');
    if (font != null && !(Number.isInteger(font) && font >= 0 && font < FONT_KEYS.length)) throw new Error('unknown font');
    if (size != null && !(Number.isInteger(size) && size >= 0 && size < SIZE_LIST.length)) throw new Error('unknown size');
    for (let i = p; i < p + n; i++) {
      let m = (this.marks[i] | set) & ~clr;
      if (font != null) m = (m & ~FONT_MASK) | (font << FONT_SHIFT);
      if (size != null) m = (m & ~SIZE_MASK) | (size << SIZE_SHIFT);
      this.marks[i] = m;
    }
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

  // { i, p, n, x } edits the text of footnote i like a text event.
  applyNote(e) {
    const i = e.i;
    if (!Number.isInteger(i) || i < 0 || i >= this.notes.length) throw new Error('footnote does not exist');
    const t = this.notes[i];
    const n = e.n || 0;
    if (!Number.isInteger(e.p) || e.p < 0 || e.p + n > t.length) throw new Error('edit outside the footnote');
    const x = String(e.x || '');
    if (x.includes(FOOTNOTE) || x.includes('\n')) throw new Error('footnotes are a single line of text');
    this.notes[i] = t.slice(0, e.p) + x + t.slice(e.p + n);
  }

  hasFormat() {
    return this.marks.some(Boolean) || this.paras.some((p) => !samePara(p, DEFAULT_PARA)) || this.notes.length > 0;
  }

  // `notes` is only present when there are footnotes, so documents without them hash as before.
  format() {
    if (!this.hasFormat()) return null;
    const f = { marks: runsOf(this.marks), paras: this.paras.map((p) => ({ ...p })) };
    if (this.notes.length) f.notes = this.notes.slice();
    return f;
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
  after.notes.forEach((note, i) => {
    const d = diffOp(note, target.notes[i]);
    if (d) out.push({ k: 'note', i, p: d.p, n: d.n || undefined, x: d.x || undefined, it });
  });
  return out;
}
