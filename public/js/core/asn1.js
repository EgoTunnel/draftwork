// Minimal DER reader and writer: enough for RFC 3161 requests, responses and CMS SignedData.

export const TAG = {
  BOOLEAN: 0x01, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06,
  UTF8: 0x0c, PRINTABLE: 0x13, IA5: 0x16, UTC_TIME: 0x17, GEN_TIME: 0x18,
  SEQUENCE: 0x30, SET: 0x31,
};

// ---------- reader ----------

export function parse(bytes, offset = 0) {
  if (offset + 2 > bytes.length) throw new Error('DER: truncated header');
  const tag = bytes[offset];
  let pos = offset + 1;
  let len = bytes[pos++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: unsupported length form');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[pos++];
  }
  const start = pos;
  const end = start + len;
  if (end > bytes.length) throw new Error('DER: length past end of data');
  const node = {
    tag,
    cls: tag >> 6,
    constructed: !!(tag & 0x20),
    num: tag & 0x1f,
    offset,
    start,
    end,
    bytes,
  };
  if (node.constructed) {
    node.children = [];
    let p = start;
    while (p < end) {
      const child = parse(bytes, p);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

export const content = (n) => n.bytes.subarray(n.start, n.end);
export const raw = (n) => n.bytes.subarray(n.offset, n.end);

export function readOid(n) {
  const b = content(n);
  const parts = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      if (parts.length === 0) {
        const first = v < 80 ? Math.floor(v / 40) : 2;
        parts.push(first, v - first * 40);
      } else parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

export function readTime(n) {
  const s = new TextDecoder().decode(content(n));
  let m;
  if (n.tag === TAG.UTC_TIME) {
    m = s.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/);
    if (!m) throw new Error('bad UTCTime ' + s);
    const yy = +m[1];
    return new Date(Date.UTC(yy < 50 ? 2000 + yy : 1900 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  }
  m = s.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)?(\d\d)?(?:[.,](\d+))?Z$/);
  if (!m) throw new Error('bad GeneralizedTime ' + s);
  const ms = m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +(m[5] || 0), +(m[6] || 0), ms));
}

export function readString(n) {
  return new TextDecoder().decode(content(n));
}

// Unsigned big-endian integer bytes with any leading zero removed.
export function readUInt(n) {
  let b = content(n);
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return b;
}

// ---------- writer ----------

function lenBytes(len) {
  if (len < 0x80) return [len];
  const out = [];
  while (len > 0) {
    out.unshift(len & 0xff);
    len = Math.floor(len / 256);
  }
  return [0x80 | out.length, ...out];
}

export function tlv(tag, body) {
  const head = [tag, ...lenBytes(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function concat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const seq = (...items) => tlv(TAG.SEQUENCE, concat(...items));

// DER SET OF: members sorted by their encodings.
export function set(...items) {
  const sorted = [...items].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  return tlv(TAG.SET, concat(...sorted));
}

export const nul = () => new Uint8Array([0x05, 0x00]);
export const bool = (v) => new Uint8Array([0x01, 0x01, v ? 0xff : 0x00]);
export const octets = (b) => tlv(TAG.OCTET_STRING, b);
export const bitString = (b) => tlv(TAG.BIT_STRING, concat(new Uint8Array([0]), b));
export const utf8String = (s) => tlv(TAG.UTF8, new TextEncoder().encode(s));
export const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);

// INTEGER from a non-negative number or unsigned big-endian bytes.
export function int(v) {
  let b;
  if (typeof v === 'number') {
    const arr = [];
    do {
      arr.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    b = new Uint8Array(arr);
  } else {
    b = v;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
  }
  if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
  return tlv(TAG.INTEGER, b);
}

export function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const tmp = [];
    let v = p;
    do {
      tmp.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < tmp.length - 1; i++) tmp[i] |= 0x80;
    out.push(...tmp);
  }
  return tlv(TAG.OID, new Uint8Array(out));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function genTime(date) {
  const s = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    (date.getUTCMilliseconds() ? '.' + pad(date.getUTCMilliseconds(), 3).replace(/0+$/, '') : '') + 'Z';
  return tlv(TAG.GEN_TIME, new TextEncoder().encode(s));
}

export function utcTime(date) {
  const s = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(TAG.UTC_TIME, new TextEncoder().encode(s));
}
