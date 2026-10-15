// A word-processor surface over the recorder's document model.
// Every change goes through rec.record() as an event and the page is re-rendered from the model,
// so what the replay rebuilds is exactly what the student saw.
import { diffOp } from '../core/format.js';
import {
  MARKS, ALL_MARKS, MAX_INDENT, runsOf, marksField, diffEvents, samePara, FOOTNOTE, countNotes, fontOf, sizeOf,
  FONT_MASK, SIZE_MASK, FONT_SHIFT, SIZE_SHIFT,
} from '../core/doc.js';
import { paragraphParts, toClipboardHtml, toPlainText } from '../core/export.js';

const MOVE_CHARS = 40;
const HISTORY_LIMIT = 200;
const TYPING_MERGE_MS = 1500;
const norm = (s) => String(s || '').replace(/\r\n?/g, '\n');
const isSpace = (c) => c === ' ' || c === '\t' || c === ' ';

export class Editor {
  // opts: { rec, policy, clips, prefs(), onChange(), onSelection(), onBlocked(kind), onUntrusted(), keys: {save, print, find, replace} }
  constructor(el, opts) {
    this.el = el;
    this.o = opts;
    this.rec = opts.rec;
    this.sel = { start: 0, end: 0 };
    this.caret = 0;
    this.pendingMarks = null;
    this.undoStack = [];
    this.redoStack = [];
    this.group = null;
    this.batching = false;
    this.composing = false;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    this.bind();
    this.render(true);
  }

  get doc() {
    return this.rec.doc;
  }

  active() {
    return this.rec && this.rec.inSession;
  }

  // ---------- rendering and selection ----------

  render(force = false) {
    const parts = paragraphParts(this.doc);
    const root = this.el;
    for (const n of [...root.childNodes]) if (!(n.nodeType === 1 && n._dw)) n.remove();
    const els = [...root.children];
    parts.forEach((p, k) => {
      let el = els[k];
      if (!el) {
        el = document.createElement('div');
        el._dw = true;
        root.append(el);
      }
      const key = `${p.cls}\u0001${p.label}\u0001${p.html}`;
      if (force || el._key !== key) {
        el.className = p.cls;
        if (p.label) el.dataset.label = p.label;
        else delete el.dataset.label;
        el.innerHTML = p.html;
        el._key = key;
      }
    });
    for (let k = parts.length; k < els.length; k++) els[k].remove();
    root.classList.toggle('is-empty', this.doc.text.length === 0 && !this.doc.paras[0].li);
  }

  domText() {
    return [...this.el.childNodes].map((n) => n.textContent).join('\n');
  }

  offsetOf(node, off) {
    const root = this.el;
    if (node !== root && !root.contains(node)) return null;
    const kids = [...root.childNodes];
    if (node === root) {
      let pos = 0;
      for (let i = 0; i < Math.min(off, kids.length); i++) pos += kids[i].textContent.length + 1;
      return off >= kids.length ? Math.max(0, pos - 1) : pos;
    }
    let para = node;
    while (para.parentNode !== root) para = para.parentNode;
    let pos = 0;
    for (const k of kids) {
      if (k === para) break;
      pos += k.textContent.length + 1;
    }
    const r = document.createRange();
    r.setStart(para, 0);
    r.setEnd(node, off);
    return pos + r.toString().length;
  }

  pointAt(off) {
    const kids = [...this.el.childNodes];
    let pos = 0;
    for (let i = 0; i < kids.length; i++) {
      const len = kids[i].textContent.length;
      if (off <= pos + len || i === kids.length - 1) return this.deepPoint(kids[i], Math.min(off - pos, len));
      pos += len + 1;
    }
    return [this.el, 0];
  }

  deepPoint(el, within) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (within <= t.length) return [t, within];
      within -= t.length;
      last = t;
    }
    return last ? [last, last.length] : [el, 0];
  }

  readSel() {
    const s = window.getSelection();
    if (!s.rangeCount || !this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
    const a = this.offsetOf(s.anchorNode, s.anchorOffset);
    const f = this.offsetOf(s.focusNode, s.focusOffset);
    if (a == null || f == null) return null;
    const len = this.doc.text.length;
    return { start: Math.min(a, f, len), end: Math.min(Math.max(a, f), len), backward: f < a };
  }

  getSel() {
    const s = this.readSel();
    if (s) this.sel = s;
    return this.sel;
  }

  setSel(start, end = start, scroll = true) {
    const len = this.doc.text.length;
    start = Math.max(0, Math.min(start, len));
    end = Math.max(0, Math.min(end, len));
    this.sel = { start: Math.min(start, end), end: Math.max(start, end) };
    const [n1, o1] = this.pointAt(start);
    const [n2, o2] = this.pointAt(end);
    const s = window.getSelection();
    try {
      s.setBaseAndExtent(n1, o1, n2, o2);
    } catch { /* node detached */ }
    if (scroll) this.scrollToCaret();
  }

  scrollToCaret() {
    const s = window.getSelection();
    if (!s.rangeCount) return;
    let rect = s.getRangeAt(0).getBoundingClientRect();
    if (!rect.height) {
      const node = s.focusNode && (s.focusNode.nodeType === 1 ? s.focusNode : s.focusNode.parentElement);
      if (node) rect = node.getBoundingClientRect();
    }
    const box = this.o.scroller || this.el.parentElement;
    const b = box.getBoundingClientRect();
    if (rect.bottom > b.bottom - 48) box.scrollTop += rect.bottom - b.bottom + 96;
    else if (rect.top < b.top + 24) box.scrollTop -= b.top - rect.top + 96;
  }

  focus() {
    this.el.focus({ preventScroll: true });
    this.setSel(this.sel.start, this.sel.end, false);
  }

  // ---------- formatting state ----------

  caretMarks(pos) {
    if (this.pendingMarks != null) return this.pendingMarks;
    const t = this.doc.text;
    const m = this.doc.marks;
    if (pos > 0 && t[pos - 1] !== '\n') return m[pos - 1];
    if (pos < t.length && t[pos] !== '\n') return m[pos];
    return 0;
  }

  // Flags common to the whole selection (or at the caret).
  activeMarks() {
    const { start, end } = this.sel;
    if (start === end) return this.caretMarks(start) & ALL_MARKS;
    let all = ALL_MARKS;
    const t = this.doc.text;
    let any = false;
    for (let i = start; i < end; i++) {
      if (t[i] === '\n' || t[i] === FOOTNOTE) continue;
      all &= this.doc.marks[i];
      any = true;
    }
    return any ? all : 0;
  }

  // Font and size indexes shared by the whole selection; -1 when it's mixed.
  activeFontSize() {
    const { start, end } = this.sel;
    if (start === end) {
      const m = this.caretMarks(start);
      return { font: fontOf(m), size: sizeOf(m) };
    }
    let font = null;
    let size = null;
    const t = this.doc.text;
    for (let i = start; i < end; i++) {
      if (t[i] === '\n' || t[i] === FOOTNOTE) continue;
      const m = this.doc.marks[i];
      font = font === null || font === fontOf(m) ? fontOf(m) : -1;
      size = size === null || size === sizeOf(m) ? sizeOf(m) : -1;
    }
    return { font: font ?? 0, size: size ?? 0 };
  }

  paraRange() {
    const { start, end } = this.sel;
    return [this.doc.paraIndexAt(start), this.doc.paraIndexAt(end)];
  }

  state() {
    const [a] = this.paraRange();
    return {
      marks: this.activeMarks(),
      ...this.activeFontSize(),
      para: this.doc.paras[a],
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      sel: this.sel,
    };
  }

  notifySel() {
    if (this.o.onSelection) this.o.onSelection(this.state());
  }

  // ---------- recording ----------

  snapshot() {
    const d = this.doc;
    return { text: d.text, marks: d.marks.slice(), paras: d.paras.map((p) => ({ ...p })), sel: { ...this.sel } };
  }

  begin(kind) {
    if (this.batching) return;
    const now = Date.now();
    const g = this.group;
    const merge = g && g.kind === kind && (kind === 'typing' || kind === 'delete') &&
      now - g.t < TYPING_MERGE_MS && this.sel.start === this.sel.end && this.sel.start === g.end;
    if (!merge) {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.group = { kind, t: now, end: null };
  }

  emit(e) {
    this.rec.record(e);
  }

  after(caret, { select = null, keepPending = false } = {}) {
    this.render();
    if (select) this.setSel(select[0], select[1]);
    else this.setSel(caret, caret);
    this.caret = this.sel.end;
    if (this.group) this.group.end = this.sel.end;
    if (!keepPending) this.pendingMarks = null;
    this.changed();
  }

  changed() {
    this.notifySel();
    if (this.o.onChange) this.o.onChange();
  }

  // Replaces [start, end) with x. marks: a mask, or runs for x.
  replace(start, end, x, it, { group = 'edit', kind = null, marks = null, extra = {} } = {}) {
    this.begin(group);
    const n = end - start;
    const runs = x ? (Array.isArray(marks) ? marks : [[x.length, marks == null ? this.caretMarks(start) : marks]]) : [];
    this.emit({
      k: kind || (n === 0 ? 'ins' : x === '' ? 'del' : 'rep'),
      p: start, n: n || undefined, x: x || undefined, ...marksField(runs), it, ...extra,
    });
    this.after(start + x.length);
  }

  // ---------- typing ----------

  typeText(data, start, end) {
    data = norm(data);
    if (!data) return;
    const t = this.doc.text;
    const prefs = this.o.prefs();
    if (prefs.smartQuotes) {
      // Curly quotes chosen by the character before; "--" becomes an em dash.
      let out = '';
      for (const ch of data) {
        const prev = out ? out[out.length - 1] : t[start - 1];
        if (ch === '"' || ch === "'") {
          const opening = !prev || /[\s([{—–“‘-]/.test(prev);
          out += ch === '"' ? (opening ? '“' : '”') : (opening ? '‘' : '’');
        } else out += ch;
      }
      data = out.replace(/--/g, '—');
      if (data[0] === '-' && start === end && t[start - 1] === '-' && t[start - 2] !== '-') {
        return this.replace(start - 1, start, '—' + data.slice(1), 'insertReplacementText', { group: 'typing' });
      }
    }
    if (prefs.autoLists && start === end && data.endsWith(' ')) {
      const k = this.doc.paraIndexAt(start);
      const [ps] = this.doc.paraBounds()[k];
      const prefix = t.slice(ps, start) + data.slice(0, -1);
      const a = this.doc.paras[k];
      const li = /^[-*•]$/.test(prefix) ? 'ul' : /^1[.)]$/.test(prefix) ? 'ol' : '';
      if (li && !a.li) {
        this.begin('edit');
        if (start > ps) this.emit({ k: 'del', p: ps, n: start - ps, it: 'autoFormat' });
        this.emit({ k: 'para', a: k, b: 1, set: { li }, it: 'autoFormat' });
        return this.after(ps);
      }
    }
    this.replace(start, end, data, 'insertText', { group: start === end ? 'typing' : 'edit' });
  }

  enter(start, end) {
    const k = this.doc.paraIndexAt(start);
    const a = this.doc.paras[k];
    const [ps, pe] = this.doc.paraBounds()[k];
    if (start === end && a.li && ps === pe) return this.setParas(k, k, { li: '', in: 0 }, 'insertParagraph');
    this.replace(start, end, '\n', 'insertParagraph', { group: 'typing' });
  }

  backspace(start, end, it = 'deleteContentBackward') {
    if (start !== end) return this.replace(start, end, '', it, { group: 'edit' });
    const k = this.doc.paraIndexAt(start);
    const [ps] = this.doc.paraBounds()[k];
    const a = this.doc.paras[k];
    if (start === ps && a.li) return this.setParas(k, k, { li: '' }, it);
    if (start === ps && a.in) return this.setParas(k, k, { in: a.in - 1 }, it);
    if (start === 0) return;
    const t = this.doc.text;
    const n = start > 1 && /[\udc00-\udfff]/.test(t[start - 1]) && /[\ud800-\udbff]/.test(t[start - 2]) ? 2 : 1;
    this.replace(start - n, start, '', it, { group: 'delete' });
  }

  forwardDelete(start, end, it = 'deleteContentForward') {
    if (start !== end) return this.replace(start, end, '', it, { group: 'edit' });
    const t = this.doc.text;
    if (start >= t.length) return;
    const n = /[\ud800-\udbff]/.test(t[start]) && /[\udc00-\udfff]/.test(t[start + 1] || '') ? 2 : 1;
    this.replace(start, start + n, '', it, { group: 'delete' });
  }

  wordStart(p) {
    const t = this.doc.text;
    if (p > 0 && t[p - 1] === '\n') return p - 1;
    let i = p;
    while (i > 0 && isSpace(t[i - 1])) i--;
    while (i > 0 && !/\s/.test(t[i - 1])) i--;
    return i;
  }

  wordEnd(p) {
    const t = this.doc.text;
    if (t[p] === '\n') return p + 1;
    let i = p;
    while (i < t.length && !/\s/.test(t[i])) i++;
    while (i < t.length && isSpace(t[i])) i++;
    return i;
  }

  targetRange(e) {
    const rs = e.getTargetRanges ? e.getTargetRanges() : [];
    if (!rs.length) return null;
    const a = this.offsetOf(rs[0].startContainer, rs[0].startOffset);
    const b = this.offsetOf(rs[0].endContainer, rs[0].endOffset);
    if (a == null || b == null) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  // ---------- formatting commands ----------

  toggleMark(bit) {
    if (!this.active()) return;
    const { start, end } = this.getSel();
    const on = (this.activeMarks() & bit) === bit;
    const exclusive = bit === MARKS.sup ? MARKS.sub : bit === MARKS.sub ? MARKS.sup : 0;
    const name = { [MARKS.b]: 'Bold', [MARKS.i]: 'Italic', [MARKS.u]: 'Underline', [MARKS.s]: 'Strikethrough', [MARKS.sup]: 'Superscript', [MARKS.sub]: 'Subscript', [MARKS.hl]: 'Highlight' }[bit];
    this.announce(`${name} ${on ? 'off' : 'on'}`);
    if (start === end) {
      const m = this.caretMarks(start);
      this.pendingMarks = on ? m & ~bit : (m | bit) & ~exclusive;
      this.pendingAt = start;
      this.notifySel();
      return;
    }
    this.begin('format');
    this.emit({ k: 'fmt', p: start, n: end - start, set: on ? undefined : bit, clr: on ? bit : exclusive || undefined, it: 'formatMark' });
    this.after(end, { select: [start, end] });
  }

  clearFormatting() {
    if (!this.active()) return;
    const { start, end } = this.getSel();
    if (start === end) {
      this.pendingMarks = 0;
      this.pendingAt = start;
      this.notifySel();
      return;
    }
    this.begin('format');
    this.emit({ k: 'fmt', p: start, n: end - start, clr: ALL_MARKS, font: 0, size: 0, it: 'formatRemove' });
    this.after(end, { select: [start, end] });
  }

  // Font or size for the selection; with no selection, for what's typed next (as in Word).
  // index 0 means "follow the document".
  setFontSize(which, index) {
    if (!this.active()) return;
    const { start, end } = this.getSel();
    if (start === end) {
      const m = this.caretMarks(start);
      this.pendingMarks = which === 'font'
        ? (m & ~FONT_MASK) | (index << FONT_SHIFT)
        : (m & ~SIZE_MASK) | (index << SIZE_SHIFT);
      this.pendingAt = start;
      this.notifySel();
      return;
    }
    this.begin('format');
    this.emit({ k: 'fmt', p: start, n: end - start, [which]: index, it: which === 'font' ? 'formatFontName' : 'formatFontSize' });
    this.after(end, { select: [start, end] });
  }

  // Inserts a footnote anchor after the selection and returns the new note's index.
  insertFootnote() {
    if (!this.active()) return -1;
    const { end } = this.getSel();
    const index = countNotes(this.doc.text, 0, end);
    const m = this.caretMarks(end) & ~(MARKS.sup | MARKS.sub);
    this.replace(end, end, FOOTNOTE, 'insertFootnote', { group: 'edit', marks: m });
    this.announce(`Footnote ${index + 1} added`);
    if (this.o.onFootnote) this.o.onFootnote(index);
    return index;
  }

  setParas(a, b, set, it) {
    if (!this.active()) return;
    this.begin('format');
    this.emit({ k: 'para', a, b: b - a + 1, set, it });
    const { start, end } = this.sel;
    this.after(end, { select: [start, end], keepPending: true });
  }

  setParaAttr(set, it) {
    const [a, b] = this.paraRange();
    this.setParas(a, b, set, it);
  }

  toggleList(li) {
    const [a, b] = this.paraRange();
    const all = this.doc.paras.slice(a, b + 1).every((p) => p.li === li);
    this.setParas(a, b, { li: all ? '' : li }, 'formatList');
  }

  indent(delta) {
    if (!this.active()) return;
    const [a, b] = this.paraRange();
    const pa = this.doc.paras.slice(a, b + 1).map((p) => ({ ...p, in: Math.max(0, Math.min(MAX_INDENT, p.in + delta)) }));
    if (pa.every((p, i) => samePara(p, this.doc.paras[a + i]))) return;
    this.begin('format');
    this.emit({ k: 'para', a, pa, it: delta > 0 ? 'formatIndent' : 'formatOutdent' });
    const { start, end } = this.sel;
    this.after(end, { select: [start, end], keepPending: true });
  }

  // Starts a new page at the caret (Ctrl+Enter), splitting the paragraph if needed.
  pageBreak() {
    if (!this.active()) return;
    const { start, end } = this.getSel();
    const k = this.doc.paraIndexAt(start);
    const [ps] = this.doc.paraBounds()[k];
    this.begin('edit');
    if (start === ps && start === end) {
      this.emit({ k: 'para', a: k, b: 1, set: { pb: true }, it: 'insertPageBreak' });
      this.after(start);
    } else {
      this.emit({ k: start === end ? 'ins' : 'rep', p: start, n: end - start || undefined, x: '\n', it: 'insertPageBreak' });
      this.emit({ k: 'para', a: k + 1, b: 1, set: { pb: true }, it: 'insertPageBreak' });
      this.after(start + 1);
    }
    this.announce('Page break inserted');
  }

  announce(msg) {
    if (this.o.onAnnounce) this.o.onAnnounce(msg);
  }

  insertSymbol(ch) {
    if (!this.active()) return;
    const { start, end } = this.sel;
    this.replace(start, end, ch, 'insertSymbol', { group: 'edit' });
  }

  // Used by find and replace.
  replaceRange(start, end, x, it = 'findReplace') {
    this.replace(start, end, x, it, { group: 'edit', marks: this.doc.marks[start] || 0 });
  }

  batch(fn) {
    this.begin('edit');
    this.batching = true;
    try {
      fn();
    } finally {
      this.batching = false;
    }
  }

  // ---------- undo ----------

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  restore(target, it) {
    for (const e of diffEvents(this.doc, target, it, diffOp)) this.emit(e);
    this.group = null;
    this.after(target.sel.end, { select: [target.sel.start, target.sel.end] });
  }

  undo() {
    if (!this.active() || !this.undoStack.length) return;
    const target = this.undoStack.pop();
    this.redoStack.push(this.snapshot());
    this.restore(target, 'historyUndo');
  }

  redo() {
    if (!this.active() || !this.redoStack.length) return;
    const target = this.redoStack.pop();
    this.undoStack.push(this.snapshot());
    this.restore(target, 'historyRedo');
  }

  // ---------- clipboard ----------

  copySelection(e) {
    const { start, end } = this.getSel();
    if (start === end) return false;
    const d = this.doc;
    // Footnote anchors aren't copied (their notes stay with the original).
    let text = '';
    const marks = [];
    for (let i = start; i < end; i++) {
      if (d.text[i] === FOOTNOTE) continue;
      text += d.text[i];
      marks.push(d.marks[i]);
    }
    if (!text) return false;
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', toClipboardHtml(d, start, end));
    this.o.clips.set(text, { pane: 'main', runs: runsOf(marks) });
    if (this.o.clips.size > 50) this.o.clips.delete(this.o.clips.keys().next().value);
    return true;
  }

  // Pasted text goes in only if it was copied inside the sandbox, or the policy allows outside pastes.
  pasteText(raw, it = 'insertFromPaste') {
    if (!this.active()) return;
    const t = norm(raw);
    if (!t) return;
    const { start, end } = this.getSel();
    const clip = this.o.clips.get(t);
    if (clip) {
      const extra = clip.pane === 'src' ? { from: 'src' } : {};
      return this.replace(start, end, t, it, { kind: 'paste_in', marks: clip.pane === 'src' ? 0 : clip.runs, extra });
    }
    if (this.o.policy.paste === 'allow') {
      this.replace(start, end, t, it, { marks: 0 });
      if (this.o.onExternalPaste) this.o.onExternalPaste(this.rec.events[this.rec.events.length - 1]);
      return;
    }
    this.emit({ k: 'paste_blocked', len: t.length, it });
    if (this.o.onBlocked) this.o.onBlocked(it);
  }

  async pasteFromMenu() {
    try {
      this.pasteText(await navigator.clipboard.readText());
    } catch {
      if (this.o.onBlocked) this.o.onBlocked('menu');
    }
  }

  // ---------- reconciling with the DOM ----------

  // Applies whatever the browser changed that we did not intercept (composition, some spellcheck).
  syncFromDom(it, kind) {
    const dom = this.domText();
    const d = this.doc;
    if (dom === d.text) {
      this.render(true);
      this.setSel(this.sel.start, this.sel.end, false);
      return;
    }
    const caret = this.readSel();
    let op = diffOp(d.text, dom);
    if (caret) {
      const p = caret.end - op.x.length;
      if (p !== op.p && p >= 0 && p + op.n <= d.text.length && d.text.slice(0, p) + op.x + d.text.slice(p + op.n) === dom) op = { ...op, p };
    }
    this.begin('typing');
    this.emit({
      k: kind || (op.n === 0 ? 'ins' : op.x === '' ? 'del' : 'rep'),
      p: op.p, n: op.n || undefined, x: op.x || undefined,
      ...(op.x ? marksField([[op.x.length, this.caretMarks(op.p)]]) : {}), it,
    });
    this.render(true);
    this.after(op.p + op.x.length);
  }

  // Reverts changes made by scripts (they fire no trusted input event).
  checkIntegrity() {
    if (!this.active() || this.composing) return;
    if (this.domText() !== this.doc.text) this.refuse('programmatic');
  }

  refuse(it) {
    const len = Math.abs(this.domText().length - this.doc.text.length);
    this.render(true);
    this.setSel(this.sel.start, this.sel.end, false);
    this.emit({ k: 'untrusted', it, len });
    if (this.o.onUntrusted) this.o.onUntrusted();
  }

  // ---------- events ----------

  bind() {
    const el = this.el;
    el.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    el.addEventListener('input', (e) => {
      if (!this.active() || this.composing || e.isComposing) return;
      if (!e.isTrusted) return this.refuse(e.inputType || 'synthetic-input');
      if (this.domText() === this.doc.text) return;
      // Keyboards, dictation and input methods always announce a change with beforeinput first.
      // A change without one came from document.execCommand (devtools, extensions): refuse it.
      const b = this.lastBefore;
      if (b && b.type === e.inputType && Date.now() - b.t < 1000) this.syncFromDom(e.inputType || 'unknown');
      else this.refuse(`unannounced-${e.inputType || 'input'}`);
    });
    el.addEventListener('compositionstart', () => {
      this.composing = true;
      this.getSel();
    });
    el.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.active()) this.syncFromDom('insertCompositionText', 'ime');
    });
    el.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Clipboard and drop events made by scripts are refused like any other untrusted input.
    const untrusted = (e) => {
      if (e.isTrusted) return false;
      e.preventDefault();
      if (this.active()) {
        this.emit({ k: 'untrusted', it: `synthetic-${e.type}`, len: 0 });
        if (this.o.onUntrusted) this.o.onUntrusted();
      }
      return true;
    };
    el.addEventListener('copy', (e) => {
      if (untrusted(e)) return;
      if (this.copySelection(e)) e.preventDefault();
    });
    el.addEventListener('cut', (e) => {
      e.preventDefault();
      if (untrusted(e) || !this.active()) return;
      if (this.copySelection(e)) {
        const { start, end } = this.sel;
        this.replace(start, end, '', 'deleteByCut', { group: 'edit' });
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      if (untrusted(e)) return;
      this.pasteText(e.clipboardData && e.clipboardData.getData('text/plain'), 'insertFromPaste');
    });
    el.addEventListener('dragstart', (e) => e.preventDefault());
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (untrusted(e) || !this.active()) return;
      const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (pos) {
        const p = this.offsetOf(pos.startContainer, pos.startOffset);
        if (p != null) this.setSel(p, p, false);
      }
      this.pasteText(e.dataTransfer && e.dataTransfer.getData('text/plain'), 'insertFromDrop');
    });
    document.addEventListener('selectionchange', () => {
      if (this.composing) return;
      const s = this.readSel();
      if (!s) return;
      this.sel = s;
      if (this.active() && Math.abs(s.start - this.caret) > MOVE_CHARS) {
        this.emit({ k: 'move', p: s.start, from: this.caret });
        this.caret = s.start;
      } else if (s.start === s.end) this.caret = s.start;
      if (this.pendingMarks != null && (s.start !== this.pendingAt || s.end !== this.pendingAt)) this.pendingMarks = null;
      this.notifySel();
    });
  }

  onBeforeInput(e) {
    if (!this.active()) return e.preventDefault();
    if (!e.isTrusted) {
      e.preventDefault();
      this.emit({ k: 'untrusted', it: e.inputType, len: (e.data || '').length });
      if (this.o.onUntrusted) this.o.onUntrusted();
      return;
    }
    const t = e.inputType;
    this.lastBefore = { type: t, t: Date.now() };
    if (t === 'insertCompositionText' || this.composing) return;
    e.preventDefault();
    const { start, end } = this.getSel();
    switch (t) {
      case 'insertText':
        return this.typeText(e.data != null ? e.data : (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '', start, end);
      case 'insertReplacementText': {
        const r = this.targetRange(e) || { start, end };
        const x = norm((e.dataTransfer && e.dataTransfer.getData('text/plain')) || e.data || '');
        return this.replace(r.start, r.end, x, t, { group: 'edit', marks: this.doc.marks[r.start] || 0 });
      }
      case 'insertParagraph':
      case 'insertLineBreak':
        return this.enter(start, end);
      case 'deleteContentBackward':
        return this.backspace(start, end);
      case 'deleteContentForward':
        return this.forwardDelete(start, end);
      case 'deleteWordBackward':
        return start !== end ? this.backspace(start, end, t) : this.replace(this.wordStart(start), start, '', t, { group: 'delete' });
      case 'deleteWordForward':
        return start !== end ? this.forwardDelete(start, end, t) : this.replace(start, this.wordEnd(start), '', t, { group: 'delete' });
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
      case 'deleteEntireSoftLine':
      case 'deleteContent': {
        const r = start !== end ? { start, end } : this.targetRange(e);
        if (r && r.end > r.start) this.replace(r.start, r.end, '', t, { group: 'edit' });
        return;
      }
      case 'historyUndo':
        return this.undo();
      case 'historyRedo':
        return this.redo();
      case 'formatBold':
        return this.toggleMark(MARKS.b);
      case 'formatItalic':
        return this.toggleMark(MARKS.i);
      case 'formatUnderline':
        return this.toggleMark(MARKS.u);
      case 'formatStrikeThrough':
        return this.toggleMark(MARKS.s);
      case 'formatSuperscript':
        return this.toggleMark(MARKS.sup);
      case 'formatSubscript':
        return this.toggleMark(MARKS.sub);
      case 'formatJustifyLeft':
        return this.setParaAttr({ al: 'l' }, t);
      case 'formatJustifyCenter':
        return this.setParaAttr({ al: 'c' }, t);
      case 'formatJustifyRight':
        return this.setParaAttr({ al: 'r' }, t);
      case 'formatJustifyFull':
        return this.setParaAttr({ al: 'j' }, t);
      case 'formatIndent':
        return this.indent(1);
      case 'formatOutdent':
        return this.indent(-1);
      default:
        // Pastes, drops and cuts are handled by their own events; anything else is ignored.
    }
  }

  onKeyDown(e) {
    if (!this.active()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const run = (fn) => {
      e.preventDefault();
      fn();
    };
    if (mod && !e.altKey) {
      if (k === 'b') return run(() => this.toggleMark(MARKS.b));
      if (k === 'i') return run(() => this.toggleMark(MARKS.i));
      if (k === 'u') return run(() => this.toggleMark(MARKS.u));
      if (k === 'z' && !e.shiftKey) return run(() => this.undo());
      if (k === 'y' || (k === 'z' && e.shiftKey)) return run(() => this.redo());
      if (k === 'e') return run(() => this.setParaAttr({ al: 'c' }, 'formatJustifyCenter'));
      if (k === 'l' && !e.shiftKey) return run(() => this.setParaAttr({ al: 'l' }, 'formatJustifyLeft'));
      if (k === 'l' && e.shiftKey) return run(() => this.toggleList('ul'));
      if (k === 'r') return run(() => this.setParaAttr({ al: 'r' }, 'formatJustifyRight'));
      if (k === 'j') return run(() => this.setParaAttr({ al: 'j' }, 'formatJustifyFull'));
      if (e.code === 'Space') return run(() => this.clearFormatting());
      if (e.code === 'Equal') return run(() => this.toggleMark(e.shiftKey ? MARKS.sup : MARKS.sub));
      if (k === 'f' && this.o.keys.find) return run(() => this.o.keys.find());
      if (k === 'h' && this.o.keys.replace) return run(() => this.o.keys.replace());
      if (k === 's' && this.o.keys.save) return run(() => this.o.keys.save());
      if (k === 'p' && this.o.keys.print) return run(() => this.o.keys.print());
    }
    if (mod && !e.altKey && e.key === 'Enter') return run(() => this.pageBreak());
    if (mod && e.altKey) {
      if (k === 'f') return run(() => this.insertFootnote());
      if (k === '1') return run(() => this.setParaAttr({ s: 'h1' }, 'formatStyle'));
      if (k === '2') return run(() => this.setParaAttr({ s: 'h2' }, 'formatStyle'));
      if (k === '3') return run(() => this.setParaAttr({ s: 'h3' }, 'formatStyle'));
      if (k === '0') return run(() => this.setParaAttr({ s: 'p' }, 'formatStyle'));
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const { start, end } = this.getSel();
      const [a, b] = this.paraRange();
      if (e.shiftKey) return this.indent(-1);
      if (this.doc.paras[a].li || a !== b) return this.indent(1);
      return this.replace(start, end, '\t', 'insertText', { group: 'typing' });
    }
  }

  plainSelection() {
    const { start, end } = this.sel;
    return toPlainText(this.doc, start, end);
  }
}
