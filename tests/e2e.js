// End-to-end tests in a real browser, driven over the Chrome DevTools Protocol (no dependencies).
// Keystrokes and IME composition go through the browser's real input pipeline, so they arrive as
// trusted events exactly like a person typing.
//
//   node tests/e2e.js [--browser "C:\path\to\msedge.exe"] [--headed]
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { newConfig, encodeConfig, configHash } from '../public/js/core/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : null);
const CANDIDATES = [
  opt('--browser'), process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  console.log('No Chromium-based browser found; pass --browser <path>.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

// A plain static file server, like GitHub Pages: no /tsa relay, no samples endpoint.
function staticServer(dir, port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const srv = httpServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(dir, p);
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  srv.listen(port);
  return srv;
}

// ---------- minimal CDP client ----------

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async open(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const t = await res.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    const p = new Page(ws);
    p.targetId = t.id;
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }

  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  }

  async waitFor(expr, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(`!!(${expr})`).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${expr}`);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(300);
    await this.waitFor('document.readyState === "complete"');
  }

  async key(key, { code, vk, mods = 0, text, commands } = {}) {
    const base = { key, code: code || key, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: mods };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text, commands });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // Ctrl+C / Ctrl+V as the browser's own editing commands.
  clip(command) {
    const letter = { copy: 'c', paste: 'v', cut: 'x' }[command];
    return this.key(letter, { code: `Key${letter.toUpperCase()}`, vk: letter.toUpperCase().charCodeAt(0), mods: 2, commands: [command] });
  }

  // Types one key at a time, the way a person does.
  async type(str) {
    for (const ch of str) {
      if (ch === '\n') await this.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
      else {
        const upper = ch.toUpperCase();
        const vk = /[a-z0-9]/i.test(ch) ? upper.charCodeAt(0) : ch === ' ' ? 32 : 0;
        const code = /[a-z]/i.test(ch) ? `Key${upper}` : ch === ' ' ? 'Space' : undefined;
        await this.key(ch, { code, vk, text: ch });
      }
    }
  }

  ctrl(letter, extra = 0) {
    const up = letter.toUpperCase();
    return this.key(letter, { code: `Key${up}`, vk: up.charCodeAt(0), mods: 2 | extra });
  }

  close(port) {
    this.ws.close();
    return fetch(`http://127.0.0.1:${port}/json/close/${this.targetId}`).catch(() => {});
  }
}

// ---------- test harness ----------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// Reads the autosaved draft (its event log) straight from IndexedDB.
const draftEvents = (cfgHash) => `new Promise((res, rej) => {
  const r = indexedDB.open('draftwork', 1);
  r.onsuccess = () => {
    const g = r.result.transaction('drafts').objectStore('drafts').get('draft:${cfgHash}');
    g.onsuccess = () => res(g.result ? g.result.file.events : null);
    g.onerror = rej;
  };
  r.onerror = rej;
})`;

const serverPort = await freePort();
const cdpPort = await freePort();
const profile = await mkdtemp(join(tmpdir(), 'draftwork-e2e-'));
const server = spawn(process.execPath, [join(ROOT, 'server.js'), '--port', String(serverPort), '--mock-tsa'], { stdio: 'ignore' });
const browser = spawn(BROWSER, [
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-features=Translate', ...(args.includes('--headed') ? [] : ['--headless=new']),
  // CI containers (e.g. GitHub's Ubuntu runners) don't allow Chrome's sandbox.
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore' });

let page;
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  const config = newConfig({ title: 'E2E Essay', allowDemoTsa: true, wordsMin: 5, aiDisclosure: true });
  const code = await encodeConfig(config);
  const cfgHash = await configHash(config);
  const base = `http://localhost:${serverPort}`;
  page = await Page.open(cdpPort);
  await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: base }).catch(() => {});
  await page.goto(`${base}/student.html#a=${code}`);

  await check('student can start after agreeing to the notice', async () => {
    await page.waitFor('!document.querySelector("#new-card").classList.contains("hidden")');
    await page.eval(`document.querySelector('#label-input').value = 'E2E Student, 1'; true`);
    await page.eval(`document.querySelector('#start-btn').click(); true`);
    await sleep(300);
    assert(await page.eval('document.querySelector("#screen-writer").classList.contains("hidden")'), 'started without consent');
    await page.eval(`document.querySelector('#consent-input').checked = true; document.querySelector('#start-btn').click(); true`);
    await page.waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
    await page.eval('document.querySelector("#editor").focus(); true');
  });

  await check('typing arrives one trusted keystroke at a time', async () => {
    await page.type('Hello wordl');
    await page.key('Backspace', { code: 'Backspace', vk: 8 });
    await page.key('Backspace', { code: 'Backspace', vk: 8 });
    await page.type('ld');
    const text = await page.eval('document.querySelector("#editor").textContent');
    assert(text === 'Hello world', `text was ${JSON.stringify(text)}`);
    await sleep(5600); // autosave interval
    const ev = await page.eval(draftEvents(cfgHash));
    const typed = ev.filter((e) => e.k === 'ins' && e.it === 'insertText');
    const dels = ev.filter((e) => e.k === 'del' && e.it === 'deleteContentBackward');
    assert(typed.length === 13, `expected 13 single-key insertions, got ${typed.length}`);
    assert(dels.length === 2, `expected 2 backspaces, got ${dels.length}`);
  });

  await check('smart quotes, Ctrl+B and Enter', async () => {
    await page.type(' "x"');
    await page.ctrl('b');
    await page.type(' bold');
    await page.ctrl('b');
    await page.type('\nnext');
    const html = await page.eval('[...document.querySelectorAll("#editor > div")].map((d) => d.innerHTML)');
    assert(html.length === 2, `expected 2 paragraphs, got ${html.length}`);
    assert(html[0].includes('\u201cx\u201d'), `quotes not curled: ${html[0]}`);
    assert(/<span class="mk-b"> bold<\/span>/.test(html[0]), `bold missing: ${html[0]}`);
  });

  await check('automatic list from "- "', async () => {
    await page.type('\n- item');
    const last = await page.eval('(() => { const d = [...document.querySelectorAll("#editor > div")].pop(); return [d.className, d.dataset.label, d.textContent]; })()');
    assert(last[0].includes('li-ul') && last[2] === 'item', `got ${JSON.stringify(last)}`);
  });

  await check('IME composition is recorded as one ime event', async () => {
    await page.type('\n');
    await page.key('Backspace', { code: 'Backspace', vk: 8 }); // leave the list
    await page.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await page.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await page.send('Input.insertText', { text: '日本' });
    await sleep(200);
    const last = await page.eval('[...document.querySelectorAll("#editor > div")].pop().textContent');
    assert(last === '日本', `last paragraph is ${JSON.stringify(last)}`);
    await sleep(5600);
    const ev = await page.eval(draftEvents(cfgHash));
    const ime = ev.filter((e) => e.k === 'ime');
    assert(ime.length === 1 && ime[0].x === '日本', `ime events: ${JSON.stringify(ime)}`);
  });

  await check('undo and redo', async () => {
    await page.type(' end');
    await page.ctrl('z');
    let last = await page.eval('[...document.querySelectorAll("#editor > div")].pop().textContent');
    assert(last === '日本', `after undo: ${JSON.stringify(last)}`);
    await page.ctrl('y');
    last = await page.eval('[...document.querySelectorAll("#editor > div")].pop().textContent');
    assert(last === '日本 end', `after redo: ${JSON.stringify(last)}`);
  });

  // The OS clipboard is shared with the rest of the computer, so these tests use trusted
  // drag-and-drop, which goes through the same insertion path without touching it.
  await check('text from outside is blocked; a script-made paste is refused', async () => {
    const box = await page.eval('(() => { const r = document.querySelector("#editor").lastChild.getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; })()');
    const data = { items: [{ mimeType: 'text/plain', data: 'Text from somewhere else entirely' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await page.send('Input.dispatchDragEvent', { type, x: box[0], y: box[1], data });
    }
    await sleep(200);
    const all = await page.eval('document.querySelector("#editor").textContent');
    assert(!all.includes('somewhere else'), 'dropped outside text got in');
    await page.eval(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'world'); document.querySelector('#editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(5600);
    const ev = await page.eval(draftEvents(cfgHash));
    assert(ev.some((e) => e.k === 'paste_blocked' && e.len === 33 && e.it === 'insertFromDrop'), 'no paste_blocked event for the drop');
    assert(ev.some((e) => e.k === 'untrusted' && e.it === 'synthetic-paste'), 'synthetic paste not refused');
  });

  await check('script changes to the page are undone and logged', async () => {
    await page.eval(`document.querySelector('#editor > div').append(' injected'); true`);
    await sleep(900);
    const text = await page.eval('document.querySelector("#editor > div").textContent');
    assert(!text.includes('injected'), 'injection stayed');
    await sleep(5600);
    const ev = await page.eval(draftEvents(cfgHash));
    assert(ev.some((e) => e.k === 'untrusted'), 'no untrusted event');
  });

  await check('text inserted with execCommand (devtools, extensions) is refused', async () => {
    const before = await page.eval('document.querySelector("#editor").textContent');
    await page.eval(`(() => {
      const ed = document.querySelector('#editor'); ed.focus();
      const r = document.createRange(); r.selectNodeContents(ed.lastChild); r.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      document.execCommand('insertText', false, ' An entire essay written somewhere else and slipped in.');
      return true; })()`);
    await sleep(900);
    const after = await page.eval('document.querySelector("#editor").textContent');
    assert(after === before, `text got in: ${JSON.stringify(after.slice(-60))}`);
    await sleep(5600);
    const ev = await page.eval(draftEvents(cfgHash));
    assert(!ev.some((e) => (e.x || '').includes('slipped in')), 'inserted text was recorded as writing');
    assert(ev.some((e) => e.k === 'untrusted' && e.it === 'unannounced-insertText'), 'not logged as untrusted');
  });

  await check('a second tab cannot open the same draft', async () => {
    const other = await Page.open(cdpPort);
    await other.goto(`${base}/student.html#a=${code}`);
    await other.waitFor('!document.querySelector("#resume-card").classList.contains("hidden")');
    await other.eval(`document.querySelector('#resume-btn').click(); true`);
    await other.waitFor('!document.querySelector("#refusal").classList.contains("hidden")');
    const msg = await other.eval('document.querySelector("#refusal").textContent');
    assert(/another tab/.test(msg), msg);
    await other.close(cdpPort);
  });

  await check('saving asks for the AI disclosure, then shows a receipt', async () => {
    await page.eval(`document.querySelector('#save-btn').click(); true`);
    await page.waitFor('document.querySelector("#notes-dlg").open');
    await page.eval(`document.querySelector('#ai-used').value = 'none'; document.querySelector('#notes-dlg').close(); true`);
    await sleep(300); // the dialog's close event is asynchronous
    await page.eval(`document.querySelector('#save-btn').click(); true`);
    await page.waitFor('document.querySelector("#receipt-dlg").open', 20000);
    const code = await page.eval('document.querySelector("#receipt-code").textContent');
    assert(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/.test(code), `receipt ${code}`);
    await page.eval(`document.querySelector('#receipt-dlg').close(); true`);
  });

  await check('preview: every integrity check passes', async () => {
    await page.eval(`document.querySelector('#preview-btn').click(); true`);
    await page.waitFor('document.querySelectorAll("#preview-body .checks li").length === 5', 20000);
    const marks = await page.eval('[...document.querySelectorAll("#preview-body .checks .mark")].map((m) => m.className)');
    assert(marks.every((m) => /pass|warn/.test(m)), `checks: ${marks.join(', ')}`);
  });

  await check('pasting from outside asks where it came from, and records the answer', async () => {
    const open = newConfig({ title: 'Open paste', allowDemoTsa: true, paste: 'allow' });
    const openHash = await configHash(open);
    const p = await Page.open(cdpPort);
    await p.goto(`${base}/student.html#a=${await encodeConfig(open)}`);
    await p.waitFor('!document.querySelector("#new-card").classList.contains("hidden")');
    await p.eval(`document.querySelector('#label-input').value = 'Citer'; document.querySelector('#consent-input').checked = true; document.querySelector('#start-btn').click(); true`);
    await p.waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
    await p.eval('document.querySelector("#editor").focus(); true');
    await p.type('Intro. ');
    const box = await p.eval('(() => { const r = document.querySelector("#editor").lastChild.getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; })()');
    const data = { items: [{ mimeType: 'text/plain', data: 'Cities are the memory of a people. See https://example.org/memory' }], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await p.send('Input.dispatchDragEvent', { type, x: box[0], y: box[1], data });
    await p.waitFor('!document.querySelector("#cite-bar").classList.contains("hidden")');
    const pre = await p.eval('document.querySelector("#cite-input").value');
    assert(pre === 'https://example.org/memory', `link not prefilled: ${pre}`);
    await p.eval(`document.querySelector('#cite-input').focus(); document.querySelector('#cite-input').select(); true`);
    await p.type('Rossi, The Architecture of the City');
    await p.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
    await p.waitFor('document.querySelector("#cite-bar").classList.contains("hidden")');
    await sleep(5600);
    const ev = await p.eval(draftEvents(openHash));
    const paste = ev.find((e) => e.it === 'insertFromDrop' && e.k === 'ins');
    const cite = ev.find((e) => e.k === 'cite');
    assert(paste && cite && cite.of === paste.s && cite.x === 'Rossi, The Architecture of the City', `events: ${JSON.stringify(cite)}`);
    await p.eval(`document.querySelector('#preview-btn').click(); true`);
    await p.waitFor('document.querySelectorAll("#preview-body .checks li").length === 5', 20000);
    await p.eval(`[...document.querySelectorAll('#preview-body .tab')].find((t) => t.textContent === 'Document').click(); true`);
    const listed = await p.eval('document.querySelector("#preview-body .sources-list").textContent');
    assert(listed.includes('Rossi'), `not listed for the instructor: ${listed}`);
    await p.close(cdpPort);
  });

  await check('instructor: backup, wipe the browser, restore', async () => {
    const dl = await mkdtemp(join(tmpdir(), 'draftwork-dl-'));
    const p = await Page.open(cdpPort);
    await p.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
    await p.goto(`${base}/instructor.html`);
    await p.eval(`document.querySelector('#tab-assign').click(); document.querySelector('#f-title').value = 'Backed-up essay'; document.querySelector('#new-form').requestSubmit(); true`);
    await p.waitFor('!document.querySelector("#storage-note").classList.contains("hidden")');
    const warn = await p.eval('document.querySelector("#storage-note").textContent');
    assert(/only in this browser/.test(warn), warn);
    await p.eval(`document.querySelector('#backup-btn').click(); true`);
    let file = null;
    for (let i = 0; i < 50 && !file; i++) {
      await sleep(100);
      file = (await readdir(dl)).find((n) => /^draftwork-backup-.*\.json$/.test(n));
    }
    assert(file, 'no backup downloaded');
    assert(await p.eval('document.querySelector("#storage-note").classList.contains("hidden")'), 'warning still shown after backup');
    await p.eval('localStorage.clear(); true');
    await p.goto(`${base}/instructor.html`);
    await p.eval(`document.querySelector('#tab-assign').click(); true`);
    assert(!(await p.eval('document.querySelector("#assign-list").textContent')).includes('Backed-up essay'), 'storage was not wiped');
    const { root } = await p.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#restore-input' });
    await p.send('DOM.setFileInputFiles', { nodeId, files: [join(dl, file)] });
    await p.waitFor('document.querySelector("#assign-list").textContent.includes("Backed-up essay")');
    await p.close(cdpPort);
    await rm(dl, { recursive: true, force: true }).catch(() => {});
  });

  // ---------- the static demo site (no server-side relay at all) ----------
  const site = await mkdtemp(join(tmpdir(), 'draftwork-site-'));
  await new Promise((res, rej) => {
    const b = spawn(process.execPath, [join(ROOT, 'tools', 'build-static.js'), '--out', site], { stdio: 'ignore', cwd: ROOT });
    b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exited ${c}`))));
  });
  const staticPort = await freePort();
  const statics = staticServer(site, staticPort);
  const sbase = `http://localhost:${staticPort}`;

  await check('static demo: "Start writing" works with simulated timestamps', async () => {
    const demo = await Page.open(cdpPort);
    await demo.goto(`${sbase}/index.html`);
    await demo.waitFor('document.querySelector("#try-student").href.includes("#a=")');
    await demo.goto(await demo.eval('document.querySelector("#try-student").href'));
    await demo.waitFor('!document.querySelector("#new-card").classList.contains("hidden")');
    const facts = await demo.eval('document.querySelector("#a-policy").textContent');
    assert(/Test assignment/.test(facts), 'not marked as a test assignment');
    await demo.eval(`document.querySelector('#label-input').value = 'Visitor'; document.querySelector('#consent-input').checked = true; document.querySelector('#start-btn').click(); true`);
    await demo.waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
    await demo.eval('document.querySelector("#editor").focus(); true');
    await demo.type('A short test.');
    await demo.eval(`document.querySelector('#preview-btn').click(); true`);
    await demo.waitFor('document.querySelectorAll("#preview-body .checks li").length === 5', 20000);
    const tsa = await demo.eval('[...document.querySelectorAll("#preview-body .checks li")].pop().textContent');
    assert(/verified/.test(tsa) && /test assignment/i.test(tsa), `timestamp check: ${tsa}`);
    await demo.close(cdpPort);
  });

  await check('static demo: the sample class opens from the front page', async () => {
    const demo = await Page.open(cdpPort);
    await demo.goto(`${sbase}/instructor.html#demo`);
    await demo.waitFor('document.querySelectorAll("tr.clickable").length > 15', 30000);
    const notice = await demo.eval('!document.querySelector("#no-relay-note").classList.contains("hidden")');
    assert(notice, 'no-relay notice not shown');
    await demo.close(cdpPort);
  });
  statics.close();
  await rm(site, { recursive: true, force: true }).catch(() => {});
} finally {
  if (page) await page.close(cdpPort).catch(() => {});
  browser.kill();
  server.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed} passed, ${failed} failed (${BROWSER.split(/[\\/]/).pop()})`);
process.exit(failed ? 1 : 0);
