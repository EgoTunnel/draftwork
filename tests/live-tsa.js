// Live check (needs internet): every approved timestamp service returns a token that verifies
// as trusted with Draftwork's pinned anchors.   node tests/live-tsa.js
import { buildRequest, extractToken, verifyToken } from '../public/js/core/tsa.js';
import { sha256Hex, unhex, toBase64 } from '../public/js/core/canon.js';
import { TRUST_ANCHORS } from '../public/js/core/trust.js';
import * as A from '../public/js/core/asn1.js';

let failed = 0;
const h = await sha256Hex(`live-check-${Date.now()}`);
for (const a of TRUST_ANCHORS) {
  try {
    const res = await fetch(a.url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: buildRequest(unhex(h)), signal: AbortSignal.timeout(12000) });
    const tok = toBase64(A.raw(extractToken(new Uint8Array(await res.arrayBuffer()))));
    const v = await verifyToken(tok, h, { anchors: TRUST_ANCHORS });
    console.log(`${v.ok && v.trusted ? 'ok  ' : 'FAIL'} ${a.name}: ${v.signer}${v.errors.length ? ' — ' + v.errors.join('; ') : ''}`);
    if (!(v.ok && v.trusted)) failed++;
  } catch (e) {
    console.log(`FAIL ${a.name}: ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
