// A demo RFC 3161 time-stamping authority for offline development and simulation.
// Its tokens are real CMS SignedData, but the certificate is self-signed and named
// "Draftwork DEMO TSA (not trusted)", which the viewer surfaces as a warning.
import * as A from '../public/js/core/asn1.js';
import { DEMO_TSA_NAME } from '../public/js/core/tsa.js';
import { sha256Bytes } from '../public/js/core/canon.js';

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const SHA256 = '2.16.840.1.101.3.4.2.1';

function rawSigToDer(raw) {
  const half = raw.length / 2;
  return A.seq(A.int(raw.subarray(0, half)), A.int(raw.subarray(half)));
}

export async function createMockTsa(subjectName = DEMO_TSA_NAME) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const sign = async (data) =>
    rawSigToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data)));

  const name = A.seq(A.set(A.seq(A.oid('2.5.4.3'), A.utf8String(subjectName))));
  const serial = crypto.getRandomValues(new Uint8Array(8));
  serial[0] &= 0x7f;
  const algId = A.seq(A.oid(ECDSA_SHA256));
  const tbs = A.seq(
    A.ctx(0, A.int(2)),
    A.int(serial),
    algId,
    name,
    A.seq(A.utcTime(new Date(Date.UTC(2000, 0, 1))), A.utcTime(new Date(Date.UTC(2049, 11, 31)))),
    name,
    spki,
  );
  const cert = A.seq(tbs, algId, A.bitString(await sign(tbs)));
  let counter = 1;

  // Returns a DER TimeStampResp for a DER TimeStampReq.
  async function respond(reqBytes, at = new Date()) {
    const req = A.parse(reqBytes);
    const imprint = A.raw(req.children[1]);
    const nonceNode = req.children.find((c, i) => i > 1 && c.tag === A.TAG.INTEGER);
    const tst = A.seq(
      A.int(1),
      A.oid('1.3.6.1.4.1.99999.1'),
      imprint,
      A.int(counter++),
      A.genTime(at),
      ...(nonceNode ? [A.raw(nonceNode)] : []),
    );
    const attrs = [
      A.seq(A.oid('1.2.840.113549.1.9.3'), A.set(A.oid('1.2.840.113549.1.9.16.1.4'))),
      A.seq(A.oid('1.2.840.113549.1.9.4'), A.set(A.octets(await sha256Bytes(tst)))),
    ];
    const attrSet = A.set(...attrs);
    const signature = await sign(attrSet);
    const signedAttrs = new Uint8Array(attrSet);
    signedAttrs[0] = 0xa0;
    const signerInfo = A.seq(
      A.int(1),
      A.seq(name, A.int(serial)),
      A.seq(A.oid(SHA256)),
      signedAttrs,
      algId,
      A.octets(signature),
    );
    const signedData = A.seq(
      A.int(3),
      A.set(A.seq(A.oid(SHA256))),
      A.seq(A.oid('1.2.840.113549.1.9.16.1.4'), A.ctx(0, A.octets(tst))),
      A.ctx(0, cert),
      A.set(signerInfo),
    );
    const token = A.seq(A.oid('1.2.840.113549.1.7.2'), A.ctx(0, signedData));
    return A.seq(A.seq(A.int(0)), token);
  }

  return { respond };
}
