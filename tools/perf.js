// Performance check on a long essay: file size, analysis time, and (with a browser) typing latency
// in a long document and how fast the viewer opens it.
//
//   node tools/perf.js [--words 4000] [--browser path] [--no-browser]
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { rng, essay, Sim, composer } from './simulate.js';
import { createMockTsa } from './mock-tsa.js';
import { Recorder } from '../public/js/core/recorder.js';
import { buildRequest, extractToken, BROWSER_DEMO_TSA } from '../public/js/core/tsa.js';
import { unhex, toBase64 } from '../public/js/core/canon.js';
import * as A from '../public/js/core/asn1.js';
import { newConfig, configHash, encodeConfig, serializeFile, countWords } from '../public/js/core/format.js';
import { analyzeFile, finalize } from '../public/js/core/analysis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const WORDS = Number(opt('--words', 4000));

// ---------- build a long essay through the real Recorder ----------

const config = newConfig({ title: 'Long essay', allowDemoTsa: true, tsaUrl: BROWSER_DEMO_TSA });
const cfgHash = await configHash(config);
const mock = await createMockTsa();
const r = rng(4242);
const paras = essay(r, Math.ceil(WORDS / 70), 6);
let sim = { clock: Date.UTC(2026, 9, 10, 9) };
const rec = await Recorder.create({
  config, cfgHash,
  header: { student_label: 'Long Writer', created: new Date(sim.clock).toISOString() },
  now: () => sim.clock,
  stamper: async (h, cp) => toBase64(A.raw(extractToken(await mock.respond(buildRequest(unhex(h)), new Date((sim.times[cp.range[1]] ?? sim.clock) + 400))))),
});
sim = new Sim({ r, recorder: rec, start: sim.clock });
let t = Date.now();
composer(sim, r, paras, { sessions: 4, revise: 0.5 });
await rec.settle();
const file = await rec.toFile();
const buildMs = Date.now() - t;
const bytes = await serializeFile(file);
const raw = JSON.stringify(file).length;

t = Date.now();
const F = finalize(await analyzeFile(file));
const analyzeMs = Date.now() - t;
console.log(`Essay: ${countWords(file.final.text).toLocaleString()} words, ${file.events.length.toLocaleString()} events, ${file.checkpoints.length} checkpoints`);
console.log(`File: ${(raw / 1024 / 1024).toFixed(1)} MB JSON, ${(bytes.length / 1024).toFixed(0)} KB gzipped`);
console.log(`Simulated writing: ${(buildMs / 1000).toFixed(1)} s · Analysis (all checks, flags, prompts): ${analyzeMs} ms · integrity: ${F.integrity.map((c) => c.status).join(' ')}`);

if (args.includes('--no-browser')) process.exit(0);

// ---------- browser: typing latency in the long document, and viewer load time ----------

const BROWSER = [opt('--browser'), process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => existsSync(p));
if (!BROWSER) {
  console.log('No Chromium-based browser found; skipping browser timings.');
  process.exit(0);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});
const dir = await mkdtemp(join(tmpdir(), 'draftwork-perf-'));
const filePath = join(dir, 'long.draftwork');
await writeFile(filePath, bytes);
const port = await freePort();
const cdp = await freePort();
const server = spawn(process.execPath, [join(ROOT, 'server.js'), '--port', String(port), '--mock-tsa'], { stdio: 'ignore' });
const browser = spawn(BROWSER, [`--remote-debugging-port=${cdp}`, `--user-data-dir=${join(dir, 'profile')}`, '--headless=new', '--no-first-run',
  '--window-size=1280,900', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });

let ws;
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(`!!(${expr})`).catch(() => false)) return;
    await sleep(50);
  }
  throw new Error(`timed out: ${expr}`);
};
const setFile = async (selector) => {
  const { root } = await send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
};

try {
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
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    // Leaving the writing page asks "leave with unsaved changes?"; answer yes.
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

  // Student: continue the long draft from its file, then type at the end.
  await send('Page.navigate', { url: `http://localhost:${port}/student.html#a=${await encodeConfig(config)}` });
  await waitFor('document.readyState === "complete" && !document.querySelector("#file-card").classList.contains("hidden")');
  let t0 = Date.now();
  await setFile('#continue-file');
  await waitFor('!document.querySelector("#screen-writer").classList.contains("hidden")');
  const openMs = Date.now() - t0;
  await evaluate('document.querySelector("#editor").focus(); true');
  const lat = [];
  for (const ch of 'The quick brown fox jumps over the lazy dog again and again. ') {
    const s = performance.now();
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await evaluate('new Promise((r) => requestAnimationFrame(() => r(true)))');
    lat.push(performance.now() - s);
  }
  lat.sort((a, b) => a - b);
  const med = lat[Math.floor(lat.length / 2)];
  const p95 = lat[Math.floor(lat.length * 0.95)];
  console.log(`Student page: opened the long draft in ${openMs} ms; keystroke to next frame: median ${med.toFixed(0)} ms, 95th percentile ${p95.toFixed(0)} ms`);

  // Instructor: open the file and the report.
  await send('Page.navigate', { url: `http://localhost:${port}/instructor.html` });
  await waitFor('document.readyState === "complete"');
  t0 = Date.now();
  await setFile('#file-input');
  await waitFor('document.querySelectorAll("tr.clickable").length === 1');
  const listMs = Date.now() - t0;
  t0 = Date.now();
  await evaluate('document.querySelector("tr.clickable").click(); true');
  await waitFor('document.querySelector(".replay-doc .doc")');
  const reportMs = Date.now() - t0;
  console.log(`Viewer: checked the file in ${listMs} ms; opened the report in ${reportMs} ms`);
} finally {
  if (ws) ws.close();
  browser.kill();
  server.kill();
  await sleep(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
