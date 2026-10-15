// A standalone timestamp relay for serverless hosting (Cloudflare Workers, Deno Deploy, or any
// runtime with the standard fetch API). Use it when the pages are on a static host (GitHub Pages,
// Netlify, a school web server) and set the assignment's "Timestamp service" to this worker's URL.
//
// It keeps no state and never sees student text: requests contain only a SHA-256 hash.
const UPSTREAMS = ['https://freetsa.org/tsr', 'http://timestamp.digicert.com', 'http://timestamp.sectigo.com'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ mode: 'relay', services: UPSTREAMS }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > 4096) return new Response('request too large', { status: 413, headers: cors });
    // Start at a random service so a class's requests are shared between them; fall back in order.
    const first = Math.floor(Math.random() * UPSTREAMS.length);
    const order = UPSTREAMS.map((_, k) => UPSTREAMS[(first + k) % UPSTREAMS.length]);
    for (const url of order) {
      try {
        const up = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/timestamp-query' },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (!up.ok) continue;
        const out = new Uint8Array(await up.arrayBuffer());
        if (out.length < 32 || out[0] !== 0x30) continue;
        return new Response(out, { headers: { ...cors, 'Content-Type': 'application/timestamp-reply', 'Cache-Control': 'no-store' } });
      } catch { /* try the next service */ }
    }
    return new Response('timestamp services unavailable', { status: 502, headers: cors });
  },
};
