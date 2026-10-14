// Starts Draftwork and opens it in the default browser.
//
//   node launch.js [--mock-tsa] [--demo] [--port 8080] [--page instructor|student] [--no-open]
//
// --mock-tsa  offline: timestamps come from the demo TSA (the viewer marks them as not trusted)
// --demo      generate the demo class into samples/ first, if it isn't there
//
// If Draftwork is already running on the port, it just opens the browser.
// Drafts and saved assignments live in the browser per address, so the launcher sticks
// to one port and only moves to another if something else is using it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PREFERRED = Number(opt('--port', process.env.PORT || 8080));
const PAGE = { instructor: 'instructor.html', student: 'student.html' }[opt('--page', '')] || '';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Draftwork needs Node.js 20 or newer (found ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

const portFree = (port) => new Promise((resolve) => {
  const srv = createServer();
  srv.once('error', () => resolve(false));
  srv.once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port); // same binding as server.js (all interfaces, IPv6 and IPv4)
});

async function isDraftwork(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return (await res.text()).includes('<title>Draftwork</title>');
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (has('--no-open')) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

function run(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...scriptArgs], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`))));
  });
}

async function waitUntilUp(port, child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) return false;
    if (await isDraftwork(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ---------- main ----------

if (has('--demo') && !existsSync(join(ROOT, 'samples'))) {
  console.log('Generating the demo class…');
  await run('tools/simulate.js', ['samples']);
}

let port = PREFERRED;
if (!(await portFree(port))) {
  if (await isDraftwork(port)) {
    const url = `http://localhost:${port}/${PAGE}`;
    console.log(`Draftwork is already running at ${url}`);
    openBrowser(url);
    process.exit(0);
  }
  for (port = PREFERRED + 1; port < PREFERRED + 20 && !(await portFree(port)); port++);
  console.warn(`Port ${PREFERRED} is used by another program; using ${port}.`);
  console.warn('Drafts and assignments saved in the browser belong to the address, so they will not appear here.');
}

const serverArgs = ['--port', String(port)];
if (has('--mock-tsa')) serverArgs.push('--mock-tsa');
const tsa = opt('--tsa', null);
if (tsa) serverArgs.push('--tsa', tsa);

const server = spawn(process.execPath, [join(ROOT, 'server.js'), ...serverArgs], { cwd: ROOT, stdio: 'inherit' });
server.on('exit', (code) => {
  if (code) console.error(`The Draftwork server stopped (exit code ${code}).`);
  process.exit(code ?? 0);
});
const stop = () => server.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (await waitUntilUp(port, server)) {
  const url = `http://localhost:${port}/${PAGE}`;
  openBrowser(url);
  console.log(`\nOpened ${url}\nKeep this window open while you use Draftwork. Close it (or press Ctrl+C) to stop.\n`);
} else {
  console.error('Draftwork did not start.');
  stop();
}
