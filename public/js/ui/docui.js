// Showing, printing and downloading a finished document.
import { h, download } from './dom.js';
import { docHtml, docStyleCss, toDocx, toPlainText } from '../core/export.js';

const slug = (s) => String(s || 'document').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'document';

export function downloadDocx(doc, style, title) {
  download(toDocx(doc, style, title), `${slug(title)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

export function downloadTxt(doc, title) {
  download(new TextEncoder().encode(toPlainText(doc, 0, doc.text.length, '\r\n')), `${slug(title)}.txt`, 'text/plain;charset=utf-8');
}

// A read-only page showing the document as it was formatted.
export function documentPage(doc, style) {
  const page = h('div', { class: 'sheet', style: docStyleCss(style) });
  page.append(h('div', { class: 'doc', html: docHtml(doc) }));
  return page;
}

// Prints only the document, in a hidden frame that uses the app's stylesheet.
export function printDoc(doc, style, title) {
  const frame = h('iframe', { class: 'print-frame', title: 'Print', 'aria-hidden': 'true' });
  document.body.append(frame);
  const css = new URL('css/app.css', document.baseURI).href;
  const fdoc = frame.contentDocument;
  fdoc.open();
  fdoc.write(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="${css}"></head><body class="print-body"><div class="sheet print-sheet" style="${docStyleCss(style).replace(/"/g, '&quot;')}"><div class="doc">${docHtml(doc)}</div></div></body></html>`);
  fdoc.close();
  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };
  const link = fdoc.querySelector('link');
  if (link.sheet) go();
  else {
    link.addEventListener('load', go);
    link.addEventListener('error', go);
  }
}
