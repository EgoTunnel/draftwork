// RFC 3161 timestamping: build requests, fetch tokens, verify tokens with WebCrypto.
import * as A from './asn1.js';
import { digest, bytesEqual, unhex, toBase64, fromBase64, hex } from './canon.js';

const OID = {
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecPublicKey: '1.2.840.10045.2.1',
  p256: '1.2.840.10045.3.1.7',
  p384: '1.3.132.0.34',
  p521: '1.3.132.0.35',
  commonName: '2.5.4.3',
  extKeyUsage: '2.5.29.37',
  timeStamping: '1.3.6.1.5.5.7.3.8',
};

const HASH_BY_OID = {
  [OID.sha1]: 'SHA-1', [OID.sha256]: 'SHA-256', [OID.sha384]: 'SHA-384', [OID.sha512]: 'SHA-512',
};

// Signature algorithm OIDs that pin a hash.
const SIG_HASH = {
  '1.2.840.113549.1.1.5': 'SHA-1',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.1': 'SHA-1',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
};

const CURVES = {
  [OID.p256]: { name: 'P-256', size: 32 },
  [OID.p384]: { name: 'P-384', size: 48 },
  [OID.p521]: { name: 'P-521', size: 66 },
};

export const DEMO_TSA_NAME = 'Draftwork DEMO TSA (not trusted)';

export function buildRequest(hashBytes, nonceBytes) {
  const nonce = nonceBytes || crypto.getRandomValues(new Uint8Array(8));
  nonce[0] &= 0x7f;
  return A.seq(
    A.int(1),
    A.seq(A.seq(A.oid(OID.sha256), A.nul()), A.octets(hashBytes)),
    A.int(nonce),
    A.bool(true),
  );
}

// Asks the TSA (usually a same-origin relay) to stamp a SHA-256 hex digest.
// Resolves to the base64 DER of the TimeStampToken (a CMS ContentInfo).
export async function requestStamp(url, hashHex, { timeoutMs = 15000 } = {}) {
  const req = buildRequest(unhex(hashHex));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: req,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`TSA HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const token = extractToken(bytes);
  const tst = parseTstInfo(token);
  if (!bytesEqual(tst.imprint, unhex(hashHex))) throw new Error('TSA returned a token for a different hash');
  return toBase64(A.raw(token));
}

// Which kind of timestamping the relay at `url` provides ({ mode: 'relay' | 'mock', services }).
export async function relayInfo(url) {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    if (res.ok) return await res.json();
  } catch { /* unknown */ }
  return null;
}

// Accepts a TimeStampResp and returns the token node.
export function extractToken(bytes) {
  const resp = A.parse(bytes);
  if (!resp.children || resp.children.length < 1) throw new Error('Malformed TSA response');
  // A ContentInfo starts with an OID; a TimeStampResp starts with PKIStatusInfo.
  if (resp.children[0].tag === A.TAG.OID) return resp;
  const status = A.content(resp.children[0].children[0]);
  const code = status[status.length - 1];
  if (code !== 0 && code !== 1) throw new Error(`TSA refused the request (status ${code})`);
  if (!resp.children[1]) throw new Error('TSA response has no token');
  return resp.children[1];
}

function signedDataOf(token) {
  const [ctOid, wrapped] = token.children;
  if (A.readOid(ctOid) !== OID.signedData) throw new Error('Token is not CMS SignedData');
  return wrapped.children[0];
}

function parseTstInfo(token) {
  const sd = signedDataOf(token);
  const encap = sd.children[2];
  if (A.readOid(encap.children[0]) !== OID.tstInfo) throw new Error('Token does not contain TSTInfo');
  const octet = encap.children[1].children[0];
  const eContent = A.content(octet);
  const tst = A.parse(eContent);
  const [, policy, imprint, serial, gen] = tst.children;
  return {
    eContent,
    policy: A.readOid(policy),
    imprintAlg: A.readOid(imprint.children[0].children[0]),
    imprint: A.content(imprint.children[1]),
    serial: hex(A.readUInt(serial)),
    genTime: A.readTime(gen),
  };
}

function nameCN(nameNode) {
  for (const rdn of nameNode.children || []) {
    for (const atv of rdn.children || []) {
      if (A.readOid(atv.children[0]) === OID.commonName) return A.readString(atv.children[1]);
    }
  }
  return '';
}

function parseCert(certNode) {
  const tbs = certNode.children[0];
  let i = 0;
  if (tbs.children[0].tag === 0xa0) i = 1;
  const serial = A.readUInt(tbs.children[i]);
  const subject = tbs.children[i + 4];
  const spki = tbs.children[i + 5];
  const issuer = tbs.children[i + 2];
  const validity = tbs.children[i + 3];
  // Extended key usages, from extensions [3] if present.
  const eku = [];
  const extWrap = tbs.children.find((c) => c.tag === 0xa3);
  if (extWrap) {
    for (const ext of extWrap.children[0].children) {
      if (A.readOid(ext.children[0]) !== OID.extKeyUsage) continue;
      const val = A.parse(A.content(ext.children[ext.children.length - 1]));
      for (const o of val.children) eku.push(A.readOid(o));
    }
  }
  return {
    serial, cn: nameCN(subject), issuerCn: nameCN(issuer), subjectDer: A.raw(subject), issuerDer: A.raw(issuer),
    spki: A.raw(spki), spkiNode: spki, der: A.raw(certNode),
    notBefore: A.readTime(validity.children[0]), notAfter: A.readTime(validity.children[1]), eku,
    tbs: A.raw(tbs), sigAlg: A.readOid(certNode.children[1].children[0]), sig: A.content(certNode.children[2]).subarray(1),
  };
}

// Walks from the signer up through the token's certificates, verifying each signature,
// until it reaches a pinned public key. Returns the anchor, or throws with the reason.
async function chainToAnchor(signer, certs, anchors) {
  const pinned = new Map(anchors.map((a) => [a.spki, a]));
  let cert = signer;
  for (let depth = 0; depth < 6; depth++) {
    const spkiHash = hex(await digest('SHA-256', cert.spki));
    if (pinned.has(spkiHash)) return pinned.get(spkiHash);
    const issuer = certs.find((c) => c !== cert && bytesEqual(c.subjectDer, cert.issuerDer));
    if (!issuer) break;
    let good = false;
    try {
      good = await verifySignature(issuer, cert.sigAlg, 'SHA-256', cert.tbs, cert.sig);
    } catch { /* unsupported algorithm */ }
    if (!good) throw new Error(`the certificate for ${cert.cn} is not validly signed by ${issuer.cn}`);
    cert = issuer;
  }
  throw new Error(`signed by “${signer.cn}”, which is not an approved timestamp service`);
}

function ecdsaDerToRaw(der, size) {
  const n = A.parse(der);
  const fix = (b) => {
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    const out = new Uint8Array(size);
    out.set(b, size - b.length);
    return out;
  };
  return A.concat(fix(A.content(n.children[0])), fix(A.content(n.children[1])));
}

async function verifySignature(cert, sigAlgOid, digestHash, data, signature) {
  const keyAlg = A.readOid(cert.spkiNode.children[0].children[0]);
  const hash = SIG_HASH[sigAlgOid] || digestHash;
  if (keyAlg === OID.rsaEncryption) {
    if (sigAlgOid === OID.rsaPss) throw new Error('RSA-PSS signatures are not supported yet');
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  if (keyAlg === OID.ecPublicKey) {
    const curve = CURVES[A.readOid(cert.spkiNode.children[0].children[1])];
    if (!curve) throw new Error('Unsupported EC curve');
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash }, key, ecdsaDerToRaw(signature, curve.size), data);
  }
  throw new Error('Unsupported TSA key type ' + keyAlg);
}

// Verifies a base64 token against the expected SHA-256 hex digest.
// Checks the message imprint, the CMS messageDigest attribute and the signature. With `anchors`,
// it also requires the signer to be a time-stamping certificate, valid at the stamp time, that
// chains to a pinned key; `allowDemo` accepts the demo TSA instead (marked `demo`).
export async function verifyToken(tokenB64, expectedHashHex, { anchors = null, allowDemo = false } = {}) {
  const result = { ok: false, errors: [], genTime: null, signer: '', demo: false, trusted: false, anchor: null };
  try {
    const token = extractToken(fromBase64(tokenB64));
    const tst = parseTstInfo(token);
    result.genTime = tst.genTime;
    result.serial = tst.serial;
    result.policy = tst.policy;
    if (tst.imprintAlg !== OID.sha256) result.errors.push('Imprint is not SHA-256');
    if (!bytesEqual(tst.imprint, unhex(expectedHashHex))) result.errors.push('Token stamps a different checkpoint');

    const sd = signedDataOf(token);
    const certSet = sd.children.find((c) => c.tag === 0xa0);
    const signerInfos = sd.children[sd.children.length - 1];
    const certs = certSet ? certSet.children.map(parseCert) : [];
    if (!certs.length) throw new Error('Token carries no certificate (certReq was not honoured)');
    const si = signerInfos.children[0];
    let k = 1;
    const sid = si.children[k++];
    const digestAlg = HASH_BY_OID[A.readOid(si.children[k++].children[0])];
    if (!digestAlg) throw new Error('Unsupported digest algorithm');
    let signedAttrs = null;
    if (si.children[k].tag === 0xa0) signedAttrs = si.children[k++];
    const sigAlgOid = A.readOid(si.children[k++].children[0]);
    const signature = A.content(si.children[k++]);

    let signedBytes = tst.eContent;
    if (signedAttrs) {
      let md = null;
      for (const attr of signedAttrs.children) {
        if (A.readOid(attr.children[0]) === OID.messageDigest) md = A.content(attr.children[1].children[0]);
      }
      const actual = await digest(digestAlg, tst.eContent);
      if (!md || !bytesEqual(md, actual)) result.errors.push('Signed digest does not match TSTInfo');
      signedBytes = new Uint8Array(A.raw(signedAttrs));
      signedBytes[0] = 0x31; // re-tag [0] IMPLICIT as SET OF for verification
    }

    // The signer is named by issuer and serial number, or by key identifier; try candidates in order.
    let candidates = certs;
    if (sid.tag === A.TAG.SEQUENCE) {
      const serial = A.readUInt(sid.children[1]);
      const match = certs.filter((c) => bytesEqual(c.serial, serial));
      if (match.length) candidates = match;
    }
    let cert = null;
    for (const c of candidates) {
      try {
        if (await verifySignature(c, sigAlgOid, digestAlg, signedBytes, signature)) {
          cert = c;
          break;
        }
      } catch { /* try the next */ }
    }
    if (!cert) {
      result.signer = candidates[0].cn;
      result.errors.push('TSA signature does not verify');
    } else {
      result.signer = cert.cn;
      result.fingerprint = hex(await digest('SHA-256', cert.der));
      result.demo = cert.cn === DEMO_TSA_NAME;
      if (anchors) {
        if (result.demo) {
          if (!allowDemo) result.errors.push('signed by the demo timestamp service, which this assignment does not accept');
        } else {
          if (!cert.eku.includes(OID.timeStamping)) result.errors.push(`“${cert.cn}” is not a time-stamping certificate`);
          if (tst.genTime < cert.notBefore || tst.genTime > cert.notAfter) result.errors.push(`“${cert.cn}” was not valid at the stamp time`);
          try {
            result.anchor = (await chainToAnchor(cert, certs, anchors)).name;
            result.trusted = true;
          } catch (e) {
            result.errors.push(e.message);
          }
        }
      }
    }
  } catch (e) {
    result.errors.push(e.message || String(e));
  }
  result.ok = result.errors.length === 0;
  return result;
}
