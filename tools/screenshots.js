// Takes screenshots of the main screens at desktop size, for the README and visual review.
//
//   node tools/screenshots.js [--out docs/img] [--browser path] [--theme light|dark]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const OUT = resolve(ROOT, opt('--out', 'docs/img'));
const THEME = opt('--theme', 'light');
const BROWSER = [opt('--browser'), process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => existsSync(p));
if (!BROWSER) throw new Error('No Chromium-based browser found; pass --browser <path>.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

// The demo class must exist (npm run simulate).
const samples = join(ROOT, 'samples');
if (!existsSync(join(samples, 'assignment-codes.txt'))) throw new Error('Run `npm run simulate` first.');
const codes = (await readFile(join(samples, 'assignment-codes.txt'), 'utf8')).split(/\r?\n/).filter((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
const essayFile = join(samples, (await readdir(samples)).find((n) => n.includes('cities') && n.includes('avery-chen')));

const dir = await mkdtemp(join(tmpdir(), 'draftwork-shots-'));
const port = await freePort();
const cdp = await freePort();
const server = spawn(process.execPath, [join(ROOT, 'server.js'), '--port', String(port), '--mock-tsa'], { stdio: 'ignore' });
const browser = spawn(BROWSER, [`--remote-debugging-port=${cdp}`, `--user-data-dir=${join(dir, 'profile')}`, '--headless=new', '--no-first-run',
  '--hide-scrollbars', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });

let ws;
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(`!!(${expr})`).catch(() => false)) return;
    await sleep(80);
  }
  throw new Error(`timed out: ${expr}`);
};
const go = async (url) => {
  await send('Page.navigate', { url });
  await sleep(300);
  await waitFor('document.readyState === "complete"');
  await sleep(300);
};
const shot = async (name) => {
  await sleep(500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${name}.png`);
};

try {
  await mkdir(OUT, { recursive: true });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${cdp}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const target = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const base = `http://localhost:${port}`;
  // Theme for the run.
  await go(`${base}/index.html`);
  await evaluate(`localStorage.setItem('draftwork.appearance', JSON.stringify({ theme: '${THEME}', size: 'normal' })); true`);
  const sfx = THEME === 'light' ? '' : `-${THEME}`;

  console.log(`Screenshots (${THEME}) → ${OUT}`);
  await go(`${base}/index.html`);
  await shot(`home${sfx}`);

  // Student: continue a sample essay and show the editor.
  await go(`${base}/student.html#a=${codes[0]}`);
  await waitFor('!document.querySelector("#file-card").classList.contains("hidden")');
  const { root } = await send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#continue-file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [essayFile] });
  await waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
  await evaluate(`(() => { const ed = document.querySelector('#editor'); ed.focus(); const p = ed.children[1]; const r = document.createRange(); r.setStart(p.firstChild || p, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); document.querySelector('#desk').scrollTop = 0; return true; })()`);
  await shot(`student-editor${sfx}`);

  await evaluate(`document.querySelector('#preview-btn').click(); true`);
  await waitFor('document.querySelectorAll("#preview-body .checks li").length === 5');
  await shot(`student-preview${sfx}`);

  // Instructor: the sample class, a flagged report, and the document view.
  await go(`${base}/instructor.html#demo`);
  await waitFor('document.querySelectorAll("tr.clickable").length > 15');
  await shot(`instructor-list${sfx}`);
  await evaluate(`[...document.querySelectorAll('tr.clickable')].find((r) => r.textContent.includes('Ranscriber')).click(); true`);
  await waitFor('document.querySelector(".replay-doc .doc")');
  await evaluate(`window.scrollTo(0, 0); true`);
  await shot(`instructor-report${sfx}`);
  await evaluate(`document.querySelector('#layer-signals').scrollIntoView(); window.scrollBy(0, -70); true`);
  await shot(`instructor-process${sfx}`);
  await evaluate(`document.querySelector('#layer-prompts').scrollIntoView(); window.scrollBy(0, -70); true`);
  await shot(`instructor-questions${sfx}`);
  await evaluate(`window.scrollTo(0, 0); [...document.querySelectorAll('.tab')].find((t) => t.textContent === 'Document').click(); true`);
  await shot(`instructor-document${sfx}`);

  if (args.includes('--extra')) {
    // Assignments page with an assignment that isn't backed up yet.
    await go(`${base}/instructor.html`);
    await evaluate(`document.querySelector('#tab-assign').click(); document.querySelector('#f-title').value = 'Essay 3: Field Notes'; document.querySelector('#new-form').requestSubmit(); true`);
    await waitFor('!document.querySelector("#storage-note").classList.contains("hidden")');
    await sleep(4500); // let the toast fade
    await shot(`instructor-assignments${sfx}`);
    // The citation prompt, after dropping outside text into an assignment that allows pasting.
    const { newConfig, encodeConfig } = await import('../public/js/core/format.js');
    const open = newConfig({ title: 'Reading response', allowDemoTsa: true, paste: 'allow' });
    await go(`${base}/student.html#a=${await encodeConfig(open)}`);
    await waitFor('!document.querySelector("#new-card").classList.contains("hidden")');
    await evaluate(`document.querySelector('#label-input').value = 'Sam Student'; document.querySelector('#consent-input').checked = true; document.querySelector('#start-btn').click(); true`);
    await waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
    await evaluate('document.querySelector("#editor").focus(); true');
    await send('Input.insertText', { text: 'The reading argues that ' });
    const box = await evaluate('(() => { const r = document.querySelector("#editor").lastChild.getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; })()');
    const data = { items: [{ mimeType: 'text/plain', data: '// A standalone timestamp relay for serverless hosting (Cloudflare Workers, Deno Deploy, or any\n// runtime with the standard fetch API). Use it when the pages are on a static host and set the timestamp service to this worker.' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: box[0], y: box[1], data });
    await waitFor('!document.querySelector("#cite-bar").classList.contains("hidden")');
    await shot(`student-cite${sfx}`);
    // Footnotes, a font change on selected text, and an MLA header.
    await evaluate(`document.querySelector('#cite-skip').click(); document.querySelector('#editor').focus(); true`);
    await send('Input.insertText', { text: ' Mumford saw the city as memory made visible.' });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 3 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 3 });
    await waitFor('document.activeElement && document.activeElement.classList.contains("note-input")');
    await send('Input.insertText', { text: 'Lewis Mumford, The Culture of Cities (New York: Harcourt, 1938), 5.' });
    await evaluate(`(() => { const ed = document.querySelector('#editor'); const t = [...ed.querySelectorAll('div')][0].firstChild; const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 11); getSelection().removeAllRanges(); getSelection().addRange(r); ed.focus(); return true; })()`);
    await sleep(100);
    await evaluate(`(() => { const s = document.querySelectorAll('.tb-select')[1]; s.value = 'arial'; s.dispatchEvent(new Event('change')); const z = document.querySelectorAll('.tb-select')[2]; z.value = '16'; z.dispatchEvent(new Event('change')); return true; })()`);
    await evaluate(`(() => { document.querySelector('#header-text').value = 'Student'; document.querySelector('input[name=pagenum][value=header]').checked = true; const d = document.querySelector('#header-dlg'); d.showModal(); d.close('ok'); return true; })()`);
    await shot(`student-footnotes${sfx}`);
    await evaluate(`document.querySelector('#notes-area').scrollIntoView({ block: 'center' }); true`);
    await shot(`student-footnotes-bottom${sfx}`);
  }
} finally {
  if (ws) ws.close();
  browser.kill();
  server.kill();
  await sleep(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
