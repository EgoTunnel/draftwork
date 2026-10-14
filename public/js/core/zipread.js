// Reads the zip archives LMSs produce for "download all submissions", and works out the
// student name each LMS encodes in its file names.

export const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

async function inflateRaw(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// Returns [{ name, bytes }] for every file entry (stored or deflated). Nested zips are expanded.
export async function readZip(bytes, depth = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  const latin = new TextDecoder('windows-1252');
  const out = [];
  for (let k = 0; k < count; k++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    // Zips made on Windows may use backslashes as path separators.
    const name = (flags & 0x800 ? utf8 : latin).decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else continue;
    if (depth < 2 && /\.zip$/i.test(name)) out.push(...(await readZip(data, depth + 1)).map((e) => ({ ...e, name: `${name}/${e.name}` })));
    else out.push({ name, bytes: data });
  }
  return out;
}

const tidy = (s) => s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

// The student name an LMS put in a submission's file name, or '' if none is recognisable.
export function lmsName(path) {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  const folder = parts.length > 1 ? parts[parts.length - 2] : '';
  let m;
  // Moodle: "Jane Smith_123456_assignsubmission_file_/essay.draftwork"
  if ((m = folder.match(/^(.+?)_\d+_assignsubmission_/))) return { lms: 'Moodle', name: tidy(m[1]) };
  // D2L Brightspace: "12345-67890 - Jane Smith - Oct 14, 2026 1200 PM - essay.draftwork"
  if ((m = file.match(/^\d+-\d+ - (.+?) - [A-Z][a-z]{2} \d/))) return { lms: 'Brightspace', name: tidy(m[1]) };
  // Blackboard: "Essay 2_jsmith_attempt_2026-10-14-12-00-00_essay.draftwork"
  if ((m = file.match(/_([^_]+)_attempt_\d{4}-\d\d-\d\d/))) return { lms: 'Blackboard', name: m[1] };
  // Canvas: "smithjane_LATE_123456_7890123_essay.draftwork" or "smithjane_123456_7890123_essay.draftwork"
  if ((m = file.match(/^([a-z][a-z-]*?)(?:_late)?_\d+_\d+_/i))) return { lms: 'Canvas', name: m[1] };
  return { lms: '', name: '' };
}

// True when an LMS name plausibly matches the label the student typed.
export function namesMatch(lms, label) {
  const squash = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const a = squash(lms);
  if (!a) return true;
  const words = String(label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((w) => w.length >= 3);
  return words.some((w) => a.includes(w));
}
