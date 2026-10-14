// Serves the two static pages and acts as the tiny, stateless RFC 3161 relay.
// Public TSAs do not allow browser (CORS) requests, so the sandbox posts to /tsa and this forwards it.
//
//   node server.js [--port 8080] [--tsa https://freetsa.org/tsr] [--mock-tsa]
//
// --mock-tsa answers locally with the demo TSA (offline development; the viewer marks its tokens as untrusted).
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(opt('--port', process.env.PORT || 8080));
const UPSTREAM = opt('--tsa', process.env.DRAFTWORK_TSA || 'https://freetsa.org/tsr');
const MOCK = args.includes('--mock-tsa');
const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const SAMPLES = resolve(fileURLToPath(new URL('./samples', import.meta.url)));
const MAX_REQ = 4096;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.draftwork': 'application/octet-stream',
};

let mock = null;
if (MOCK) {
  const { createMockTsa } = await import('./tools/mock-tsa.js');
  mock = await createMockTsa();
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_REQ) throw new Error('request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function relay(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, cors).end();
    return;
  }
  try {
    const body = await readBody(req);
    let out;
    if (mock) out = Buffer.from(await mock.respond(new Uint8Array(body)));
    else {
      const up = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body,
        signal: AbortSignal.timeout(12_000),
      });
      if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
      out = Buffer.from(await up.arrayBuffer());
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/timestamp-reply', 'Cache-Control': 'no-store' }).end(out);
  } catch (err) {
    console.warn('[tsa]', err.message);
    res.writeHead(502, { ...cors, 'Content-Type': 'text/plain' }).end('timestamp authority unavailable');
  }
}

async function serveFile(res, root, rel) {
  const path = normalize(join(root, rel));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(path);
    const file = s.isDirectory() ? join(path, 'index.html') : path;
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  if (path === '/tsa') return relay(req, res);
  if (path === '/samples/index.json') {
    try {
      const names = (await readdir(SAMPLES)).filter((n) => n.endsWith('.draftwork') || n === 'assignment-codes.txt');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(names));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    }
    return;
  }
  if (path.startsWith('/samples/')) return serveFile(res, SAMPLES, path.slice('/samples/'.length));
  return serveFile(res, ROOT, path);
}).listen(PORT, () => {
  console.log(`Draftwork on http://localhost:${PORT}  (timestamps: ${MOCK ? 'demo TSA, not trusted' : UPSTREAM})`);
});
