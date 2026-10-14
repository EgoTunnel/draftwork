// Document output: shared HTML rendering, plain text and .docx export. No DOM needed.
import { MARKS, HEADING_STYLES } from './doc.js';

export const FONTS = {
  times: { label: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", serif', docx: 'Times New Roman' },
  georgia: { label: 'Georgia', css: 'Georgia, "Times New Roman", serif', docx: 'Georgia' },
  garamond: { label: 'Garamond', css: 'Garamond, "EB Garamond", "Palatino Linotype", Georgia, serif', docx: 'Garamond' },
  palatino: { label: 'Palatino', css: '"Palatino Linotype", Palatino, "Book Antiqua", serif', docx: 'Palatino Linotype' },
  arial: { label: 'Arial', css: 'Arial, Helvetica, "Liberation Sans", sans-serif', docx: 'Arial' },
  calibri: { label: 'Calibri', css: 'Calibri, Carlito, "Segoe UI", sans-serif', docx: 'Calibri' },
  verdana: { label: 'Verdana', css: 'Verdana, Geneva, sans-serif', docx: 'Verdana' },
  courier: { label: 'Courier New', css: '"Courier New", Courier, monospace', docx: 'Courier New' },
};
export const SIZES = [9, 10, 10.5, 11, 12, 13, 14, 16, 18];
export const LINE_SPACINGS = [1, 1.15, 1.5, 2];
export const DEFAULT_DOC_STYLE = { font: 'times', size: 12, line: 1.15, after: true, firstLine: false, pageNumbers: true };

export const docStyle = (s) => ({ ...DEFAULT_DOC_STYLE, ...(s || {}) });

export function docStyleCss(s) {
  s = docStyle(s);
  const font = (FONTS[s.font] || FONTS.times).css;
  return `--doc-font:${font};--doc-size:${s.size}pt;--doc-line:${s.line};--doc-after:${s.after ? '0.6em' : '0'};--doc-first:${s.firstLine ? '0.5in' : '0'}`;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BULLETS = ['•', '◦', '▪'];

// List labels per paragraph ("" for non-list paragraphs). Numbering restarts after any non-list paragraph.
export function listLabels(paras) {
  const out = [];
  let counters = [];
  for (const p of paras) {
    if (!p.li) {
      counters = [];
      out.push('');
      continue;
    }
    counters.length = p.in + 1;
    if (p.li === 'ol') {
      counters[p.in] = (counters[p.in] || 0) + 1;
      out.push(`${counters[p.in]}.`);
    } else {
      counters[p.in] = 0;
      out.push(BULLETS[p.in % BULLETS.length]);
    }
  }
  return out;
}

export function markClasses(m) {
  if (!m) return '';
  const c = [];
  if (m & MARKS.b) c.push('mk-b');
  if (m & MARKS.i) c.push('mk-i');
  if (m & MARKS.u) c.push('mk-u');
  if (m & MARKS.s) c.push('mk-s');
  if (m & MARKS.sup) c.push('mk-sup');
  if (m & MARKS.sub) c.push('mk-sub');
  if (m & MARKS.hl) c.push('mk-hl');
  return c.join(' ');
}

export const paraClass = (a) => `para s-${a.s} al-${a.al}${a.li ? ` li-${a.li}` : ''}${a.in ? ` in-${a.in}` : ''}${a.pb ? ' pb' : ''}`;

// One entry per paragraph: { cls, label, html }.
// opts.charClass(i) adds a class to character i; opts.caret / opts.caretHtml inserts markup at an offset.
export function paragraphParts(doc, opts = {}) {
  const { text, marks, paras } = doc;
  const labels = listLabels(paras);
  const bounds = [];
  let start = 0;
  for (let j = text.indexOf('\n'); j !== -1; j = text.indexOf('\n', j + 1)) {
    bounds.push([start, j]);
    start = j + 1;
  }
  bounds.push([start, text.length]);
  return bounds.map(([s, e], k) => {
    let html = '';
    let i = s;
    const caretHere = opts.caret != null && opts.caret >= s && opts.caret <= e;
    while (i < e) {
      if (caretHere && i === opts.caret) html += opts.caretHtml;
      const m = marks[i];
      const extra = opts.charClass ? opts.charClass(i) : '';
      let j = i + 1;
      while (j < e && marks[j] === m && (!opts.charClass || opts.charClass(j) === extra) && !(caretHere && j === opts.caret)) j++;
      const cls = [markClasses(m), extra].filter(Boolean).join(' ');
      const chunk = esc(text.slice(i, j));
      html += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
      i = j;
    }
    if (caretHere && opts.caret === e) html += opts.caretHtml;
    if (s === e) html += '<br>';
    return { cls: paraClass(paras[k]), label: labels[k], html };
  });
}

export function docHtml(doc, opts) {
  return paragraphParts(doc, opts)
    .map((p) => `<div class="${p.cls}"${p.label ? ` data-label="${esc(p.label)}"` : ''}>${p.html}</div>`)
    .join('');
}

// Plain text, with list labels and indents written out.
export function toPlainText(doc, from = 0, to = doc.text.length, eol = '\n') {
  const labels = listLabels(doc.paras);
  const lines = [];
  let start = 0;
  doc.text.split('\n').forEach((line, k) => {
    const s = start;
    const e = start + line.length;
    start = e + 1;
    if (e < from || s > to) return;
    const piece = doc.text.slice(Math.max(s, from), Math.min(e, to));
    const whole = s >= from;
    const p = doc.paras[k];
    const prefix = whole ? '    '.repeat(p.in) + (labels[k] ? labels[k] + ' ' : '') : '';
    lines.push(prefix + piece);
  });
  return lines.join(eol);
}

// HTML for the clipboard, with inline styles so word processors keep the formatting.
export function toClipboardHtml(doc, from, to) {
  const tagOf = { title: 'h1', h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', p: 'p' };
  const out = [];
  let start = 0;
  doc.text.split('\n').forEach((line, k) => {
    const s = start;
    const e = start + line.length;
    start = e + 1;
    if (e < from || s > to) return;
    const a = doc.paras[k];
    let inner = '';
    for (let i = Math.max(s, from); i < Math.min(e, to); i++) {
      const m = doc.marks[i];
      let ch = esc(doc.text[i]);
      if (m & MARKS.b) ch = `<b>${ch}</b>`;
      if (m & MARKS.i) ch = `<i>${ch}</i>`;
      if (m & MARKS.u) ch = `<u>${ch}</u>`;
      if (m & MARKS.s) ch = `<s>${ch}</s>`;
      if (m & MARKS.sup) ch = `<sup>${ch}</sup>`;
      if (m & MARKS.sub) ch = `<sub>${ch}</sub>`;
      if (m & MARKS.hl) ch = `<mark>${ch}</mark>`;
      inner += ch;
    }
    const align = { l: 'left', c: 'center', r: 'right', j: 'justify' }[a.al];
    const tag = a.li ? 'p' : tagOf[a.s];
    out.push(`<${tag} style="text-align:${align};margin-left:${a.in * 0.5}in">${a.li ? (a.li === 'ul' ? '• ' : '') : ''}${inner}</${tag}>`);
  });
  return out.join('');
}

// ---------- .docx ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A stored (uncompressed) zip archive.
export function zip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const xml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const STYLE_IDS = { p: 'Normal', title: 'Title', h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', quote: 'Quote', bib: 'Bibliography' };

function runXml(text, m) {
  const pr = [];
  if (m & MARKS.b) pr.push('<w:b/>');
  if (m & MARKS.i) pr.push('<w:i/>');
  if (m & MARKS.s) pr.push('<w:strike/>');
  if (m & MARKS.u) pr.push('<w:u w:val="single"/>');
  if (m & MARKS.hl) pr.push('<w:highlight w:val="yellow"/>');
  if (m & MARKS.sup) pr.push('<w:vertAlign w:val="superscript"/>');
  else if (m & MARKS.sub) pr.push('<w:vertAlign w:val="subscript"/>');
  const rPr = pr.length ? `<w:rPr>${pr.join('')}</w:rPr>` : '';
  const parts = text.split('\t').map((t) => (t ? `<w:t xml:space="preserve">${xml(t)}</w:t>` : ''));
  return `<w:r>${rPr}${parts.join('<w:tab/>')}</w:r>`;
}

export function toDocx(doc, style, title = 'Document') {
  const s = docStyle(style);
  const font = xml((FONTS[s.font] || FONTS.times).docx);
  const half = Math.round(s.size * 2);
  const nums = []; // [numId, abstractId, restart]
  let currentOl = null;
  let start = 0;
  const body = [];
  doc.text.split('\n').forEach((line, k) => {
    const a = doc.paras[k];
    const pPr = [];
    if (a.s !== 'p') pPr.push(`<w:pStyle w:val="${STYLE_IDS[a.s]}"/>`);
    if (a.pb) pPr.push('<w:pageBreakBefore/>');
    if (a.li) {
      let numId;
      if (a.li === 'ul') {
        numId = 1;
        currentOl = currentOl && a.in > 0 ? currentOl : null;
      } else {
        if (!currentOl) {
          currentOl = nums.length + 2;
          nums.push(currentOl);
        }
        numId = currentOl;
      }
      pPr.push(`<w:numPr><w:ilvl w:val="${a.in}"/><w:numId w:val="${numId}"/></w:numPr>`);
    } else {
      currentOl = null;
      if (a.in) pPr.push(`<w:ind w:left="${720 * a.in}"/>`);
    }
    if (a.al !== 'l') pPr.push(`<w:jc w:val="${{ c: 'center', r: 'right', j: 'both' }[a.al]}"/>`);
    let runs = '';
    let i = start;
    const end = start + line.length;
    while (i < end) {
      let j = i + 1;
      while (j < end && doc.marks[j] === doc.marks[i]) j++;
      runs += runXml(doc.text.slice(i, j), doc.marks[i]);
      i = j;
    }
    start = end + 1;
    body.push(`<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runs}</w:p>`);
  });

  const spacing = `<w:spacing w:after="${s.after ? 160 : 0}" w:line="${Math.round(240 * s.line)}" w:lineRule="auto"/>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr>${spacing}</w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>${s.firstLine ? '<w:pPr><w:ind w:firstLine="720"/></w:pPr>' : ''}</w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="${half * 2}"/><w:szCs w:val="${half * 2}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.round(half * 1.6)}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.round(half * 1.3)}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.round(half * 1.1)}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720" w:firstLine="0"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="720"/></w:pPr></w:style>
</w:styles>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

  const lvl = (ilvl, fmt, text) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const levels = (fn) => Array.from({ length: 6 }, (_, l) => fn(l)).join('');
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels((l) => lvl(l, 'bullet', BULLETS[l % 3]))}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels((l) => lvl(l, 'decimal', `%${l + 1}.`))}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
${nums.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('\n')}
</w:numbering>`;

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr>${s.pageNumbers ? '<w:footerReference w:type="default" r:id="rId3"/>' : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title></cp:coreProperties>`;

  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`],
    ['word/footer1.xml', footer],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ['docProps/core.xml', core],
  ]);
}

export const isHeading = (a) => HEADING_STYLES.has(a.s);
