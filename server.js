// Serves the pages and acts as the stateless RFC 3161 relay.
// Public TSAs do not accept browser (CORS) requests, so the sandbox posts to /tsa and this forwards it,
// trying each upstream service in turn so one outage does not leave a class without timestamps.
//
//   node server.js [--port 8080] [--host 0.0.0.0] [--tsa url1,url2,...] [--mock-tsa]
//
// Environment: PORT, HOST, DRAFTWORK_TSA (comma-separated upstreams), TRUST_PROXY=1 behind a proxy.
// --mock-tsa answers locally with the demo TSA (offline development; assignments must allow demo stamps).
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
const HOST = opt('--host', process.env.HOST || undefined);
const DEFAULT_UPSTREAMS = 'https://freetsa.org/tsr,http://timestamp.digicert.com,http://timestamp.sectigo.com';
const UPSTREAMS = opt('--tsa', process.env.DRAFTWORK_TSA || DEFAULT_UPSTREAMS).split(',').map((s) => s.trim()).filter(Boolean);
const MOCK = args.includes('--mock-tsa');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const SAMPLES = resolve(fileURLToPath(new URL('./samples', import.meta.url)));
const MAX_REQ = 4096;
const RATE_PER_MIN = 60;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.draftwork': 'application/octet-stream',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https:; frame-src 'self'; object-src 'none'; base-uri 'self'",
};

let mock = null;
if (MOCK) {
  const { createMockTsa } = await import('./tools/mock-tsa.js');
  mock = await createMockTsa();
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------- rate limiting (per client, per minute) ----------

const hits = new Map();
function limited(req) {
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const minute = Math.floor(Date.now() / 60_000);
  const h = hits.get(ip);
  if (!h || h.minute !== minute) {
    hits.set(ip, { minute, n: 1 });
    if (hits.size > 10_000) hits.clear();
    return false;
  }
  return ++h.n > RATE_PER_MIN;
}

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

// The upstream that answered last goes first next time.
let preferred = 0;
async function stampUpstream(body) {
  const errors = [];
  for (let k = 0; k < UPSTREAMS.length; k++) {
    const idx = (preferred + k) % UPSTREAMS.length;
    const url = UPSTREAMS[idx];
    try {
      const up = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      if (!up.ok) throw new Error(`HTTP ${up.status}`);
      const out = Buffer.from(await up.arrayBuffer());
      if (out.length < 32 || out[0] !== 0x30) throw new Error('not a timestamp response');
      preferred = idx;
      return out;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function relay(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === 'GET') {
    const info = MOCK ? { mode: 'mock', services: ['Draftwork demo TSA'] } : { mode: 'relay', services: UPSTREAMS };
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(info));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, cors).end();
    return;
  }
  if (limited(req)) {
    res.writeHead(429, { ...cors, 'Retry-After': '60' }).end('too many requests');
    return;
  }
  try {
    const body = await readBody(req);
    const out = mock ? Buffer.from(await mock.respond(new Uint8Array(body))) : await stampUpstream(body);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/timestamp-reply', 'Cache-Control': 'no-store' }).end(out);
  } catch (err) {
    console.warn('[tsa]', err.message);
    res.writeHead(502, { ...cors, 'Content-Type': 'text/plain' }).end('timestamp services unavailable');
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
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (path === '/tsa') return relay(req, res);
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
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
}).listen(PORT, HOST, () => {
  console.log(`Draftwork on http://localhost:${PORT}  (timestamps: ${MOCK ? 'demo TSA, testing only' : UPSTREAMS.join(' → ')})`);
});
