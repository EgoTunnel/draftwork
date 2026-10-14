import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockTsa } from '../tools/mock-tsa.js';
import { simulateClass } from '../tools/simulate.js';
import { buildRequest, extractToken, verifyToken } from '../public/js/core/tsa.js';
import { canonical, unhex, toBase64, sha256Hex } from '../public/js/core/canon.js';
import * as A from '../public/js/core/asn1.js';
import { Recorder } from '../public/js/core/recorder.js';
import {
  newConfig, configHash, encodeConfig, decodeConfig, diffOp, replay, serializeFile, parseFile,
} from '../public/js/core/format.js';
import { analyzeFile, finalize } from '../public/js/core/analysis.js';
import { DocModel, MARKS, diffEvents } from '../public/js/core/doc.js';
import { toDocx } from '../public/js/core/export.js';

const mock = await createMockTsa();
const stampAt = async (hash, when) => toBase64(A.raw(extractToken(await mock.respond(buildRequest(unhex(hash)), when))));

// Builds a small file through the real Recorder with a fake clock.
async function makeFile(script, { config } = {}) {
  config = config || newConfig({ title: 'Test' });
  const cfgHash = await configHash(config);
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const times = [];
  const rec = await Recorder.create({
    config,
    cfgHash,
    header: { student_label: 'Test Student', created: new Date(clock).toISOString() },
    now: () => clock,
    stamper: (h, cp) => stampAt(h, new Date((times[cp.range[1]] ?? clock) + 500)),
    onChange: (what, e) => {
      if (what === 'event') times[e.s] = clock;
    },
  });
  const api = {
    wait: (ms) => {
      clock += ms;
      rec.tick();
    },
    type: (str, iki = 180) => {
      for (const ch of str) {
        api.wait(iki + Math.round(Math.random() * 80));
        rec.record({ k: 'ins', p: rec.text.length, x: ch, it: 'insertText' });
      }
    },
    rec,
  };
  rec.startSession();
  times[0] = clock;
  await script(api);
  rec.endSession();
  await rec.settle();
  return { file: await rec.toFile(), cfgHash, config };
}

test('canonical JSON sorts keys and is stable', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
});

test('diffOp finds the single edit between two strings', () => {
  assert.deepEqual(diffOp('hello world', 'hello brave world'), { p: 6, n: 0, x: 'brave ' });
  assert.deepEqual(diffOp('hello world', 'hello'), { p: 5, n: 6, x: '' });
  assert.deepEqual(diffOp('abc', 'aXc'), { p: 1, n: 1, x: 'X' });
  assert.equal(diffOp('same', 'same'), null);
});

test('assignment codes round-trip', async () => {
  const c = newConfig({ title: 'Essay', paste: 'allow', sourcesPane: false, wordsMin: 100 });
  const code = await encodeConfig(c);
  assert.deepEqual(await decodeConfig(code), c);
  assert.deepEqual(await decodeConfig(`https://x.test/student.html#a=${code}`), c);
});

test('RFC 3161 tokens verify and bind to their hash', async () => {
  const h = await sha256Hex('checkpoint');
  const tok = await stampAt(h, new Date());
  const ok = await verifyToken(tok, h);
  assert.ok(ok.ok, ok.errors.join());
  assert.ok(ok.demo);
  const bad = await verifyToken(tok, await sha256Hex('other'));
  assert.equal(bad.ok, false);
});

test('a recorded file round-trips and passes every integrity check', async () => {
  const { file, cfgHash } = await makeFile(async ({ type, wait, rec }) => {
    type('The city remembers. ');
    wait(70_000);
    type('Streets keep the shape of rivers.');
    rec.record({ k: 'del', p: 4, n: 5, it: 'deleteWordBackward' });
  });
  assert.equal(replay(file.events).text, file.final.text);
  const parsed = await parseFile(await serializeFile(file));
  const F = finalize(await analyzeFile(parsed, { expectedConfigHash: cfgHash }));
  for (const c of F.integrity) assert.ok(['pass', 'warn'].includes(c.status), `${c.id}: ${c.detail}`);
  assert.equal(F.flags.length, 0);
  assert.ok(file.checkpoints.length >= 2);
});

async function integrityOf(file, opts) {
  const F = finalize(await analyzeFile(file, opts));
  return Object.fromEntries(F.integrity.map((c) => [c.id, c.status]));
}

test('hand-edited events break the replay and the chain', async () => {
  const { file } = await makeFile(async ({ type }) => type('Hello there, reader.'));
  const copy = structuredClone(file);
  copy.events[5].x = 'Z';
  const s = await integrityOf(copy);
  assert.equal(s.replay, 'fail');
  assert.equal(s.chain, 'fail');
});

test('editing final_text and its hash together still fails the replay', async () => {
  const { file } = await makeFile(async ({ type }) => type('Original words.'));
  const copy = structuredClone(file);
  copy.final.text = 'Different words.';
  copy.final.hash = await sha256Hex(copy.final.text);
  assert.equal((await integrityOf(copy)).replay, 'fail');
});

test('a dropped event is caught by the chain', async () => {
  const { file } = await makeFile(async ({ type, rec }) => {
    type('abc');
    rec.record({ k: 'blur' });
    rec.record({ k: 'focus' });
  });
  const copy = structuredClone(file);
  copy.events.splice(5, 1);
  assert.equal((await integrityOf(copy)).chain, 'fail');
});

test('loosening the paste policy fails the config check', async () => {
  const { file, cfgHash } = await makeFile(async ({ type }) => type('abc'));
  const copy = structuredClone(file);
  copy.assignment.config.policy.paste = 'allow';
  assert.equal((await integrityOf(copy, { expectedConfigHash: cfgHash })).config, 'fail');
  copy.assignment.config_hash = await configHash(copy.assignment.config);
  assert.equal((await integrityOf(copy, { expectedConfigHash: cfgHash })).config, 'fail');
  assert.equal((await integrityOf(copy, { knownConfigHashes: new Set([cfgHash]) })).config, 'unknown');
});

test('relabelling a file breaks the chain seed', async () => {
  const { file } = await makeFile(async ({ type }) => type('abc'));
  const copy = structuredClone(file);
  copy.header.student_label = 'Someone Else';
  assert.equal((await integrityOf(copy)).chain, 'fail');
});

test('time running backwards fails the timestamp check', async () => {
  const { file } = await makeFile(async ({ type }) => type('abcdef'));
  const copy = structuredClone(file);
  copy.events[4].t = 1;
  assert.equal((await integrityOf(copy)).time, 'fail');
});

test('a stamp moved from another checkpoint fails TSA verification', async () => {
  const { file } = await makeFile(async ({ type, wait }) => {
    type('first part ');
    wait(65_000);
    type('second part');
  });
  const copy = structuredClone(file);
  assert.ok(copy.checkpoints.length >= 2);
  copy.checkpoints[1].tsa = copy.checkpoints[0].tsa;
  assert.equal((await integrityOf(copy)).tsa, 'fail');
});

test('a stamp dated before its events fails TSA verification', async () => {
  const { file } = await makeFile(async ({ type }) => type('abc'));
  const copy = structuredClone(file);
  const F = await analyzeFile(copy);
  copy.checkpoints[0].tsa = await stampAt(F.cpHashes[0], new Date(Date.UTC(2026, 0, 1)));
  assert.equal((await integrityOf(copy)).tsa, 'fail');
});

test('untrusted input and large drag-and-drop insertions are flagged', async () => {
  const { file } = await makeFile(async ({ type, rec, wait }) => {
    type('Some text. ');
    rec.record({ k: 'untrusted', it: 'insertText', len: 5 });
    wait(1000);
    rec.record({ k: 'ins', p: rec.text.length, x: 'x'.repeat(80), it: 'insertFromDrop' });
    rec.record({ k: 'ime', p: rec.text.length, x: 'y'.repeat(80), it: 'insertCompositionText' });
    rec.record({ k: 'paste_in', p: 0, x: 'z'.repeat(80), it: 'insertFromPaste' });
  });
  const F = finalize(await analyzeFile(file));
  const ids = F.flags.map((f) => f.id);
  assert.ok(ids.includes('untrusted'));
  assert.ok(ids.includes('unusual'));
  const unusual = F.flags.find((f) => f.id === 'unusual');
  assert.equal(unusual.moments.length, 1, 'IME and internal paste are not unusual');
});

test('paragraph rules: Enter after a heading starts Normal; merges keep the right style', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'Title', 0);
  d.applyPara({ a: 0, b: 1, set: { s: 'h1', al: 'c' } });
  d.applyText(5, 0, '\n', 0); // Enter at the end of the heading
  assert.deepEqual(d.paras.map((p) => p.s), ['h1', 'p']);
  assert.equal(d.paras[1].al, 'c', 'alignment carries over');
  d.applyText(0, 0, '\n', 0); // Enter at the start pushes the heading down
  assert.deepEqual(d.paras.map((p) => p.s), ['p', 'h1', 'p']);
  d.applyText(0, 1, '', 0); // deleting the empty paragraph above keeps the heading
  assert.deepEqual(d.paras.map((p) => p.s), ['h1', 'p']);
  d.applyText(6, 0, 'body', 0);
  d.applyText(5, 1, '', 0); // backspace at the start of the body merges into the heading
  assert.equal(d.text, 'Titlebody');
  assert.deepEqual(d.paras.map((p) => p.s), ['h1']);
  d.applyText(2, 0, '\n', 0); // splitting a heading in the middle keeps both as headings
  assert.deepEqual(d.paras.map((p) => p.s), ['h1', 'h1']);
});

test('formatting events apply exactly and undo restores any earlier state', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'one two three\nfour', 0);
  const before = d.clone();
  d.applyFmt({ p: 4, n: 3, set: MARKS.b | MARKS.i });
  d.applyText(8, 5, 'THREE', MARKS.u);
  d.applyPara({ a: 1, b: 1, set: { li: 'ol', in: 2 } });
  d.applyText(13, 1, '', 0);
  const after = d.clone();
  for (const e of diffEvents(d, before, 'historyUndo', diffOp)) d.apply(e);
  assert.equal(canonical(d.format()), canonical(before.format()));
  assert.equal(d.text, before.text);
  for (const e of diffEvents(d, after, 'historyRedo', diffOp)) d.apply(e);
  assert.equal(d.text, after.text);
  assert.deepEqual(d.marks, after.marks);
  assert.deepEqual(d.paras, after.paras);
});

test('formatted files verify, and tampering with formatting is caught', async () => {
  const { file, cfgHash } = await makeFile(async ({ type, rec }) => {
    type('Heading\nBody text here.');
    rec.record({ k: 'para', a: 0, b: 1, set: { s: 'h1' }, it: 'formatStyle' });
    rec.record({ k: 'fmt', p: 8, n: 4, set: MARKS.b, it: 'formatMark' });
  });
  assert.ok(file.final.format);
  const ok = await integrityOf(file, { expectedConfigHash: cfgHash });
  assert.equal(ok.replay, 'pass');
  assert.equal(ok.chain, 'pass');
  const copy = structuredClone(file);
  copy.final.format.paras[0].s = 'p';
  assert.equal((await integrityOf(copy)).replay, 'fail');
  const copy2 = structuredClone(file);
  copy2.events.find((e) => e.k === 'fmt').set = MARKS.i;
  const s2 = await integrityOf(copy2);
  assert.equal(s2.replay, 'fail');
  assert.equal(s2.chain, 'fail');
});

test('.docx export is a valid zip with the expected parts', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'Title\nText & <stuff>\n\tIndented', 0);
  d.applyPara({ a: 0, b: 1, set: { s: 'title' } });
  d.applyFmt({ p: 6, n: 4, set: MARKS.b });
  const bytes = toDocx(d, {}, 'T');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 10, true), 7);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes(' &amp; &lt;stuff&gt;'));
  assert.ok(text.includes('<w:b/></w:rPr><w:t xml:space="preserve">Text</w:t>'));
  assert.ok(text.includes('<w:pStyle w:val="Title"/>'));
  assert.ok(text.includes('<w:tab/>'));
});

test('simulated class: flags land on the right writers and nowhere else', async () => {
  const { files } = await simulateClass({ students: 15, seed: 7 });
  const analyses = [];
  for (const { file } of files) analyses.push(await analyzeFile(await parseFile(await serializeFile(file))));
  const flagsOf = {};
  for (const a of analyses) {
    const cohort = analyses.filter((x) => x.cfgHash === a.cfgHash);
    const F = finalize(a, { cohort });
    flagsOf[`${a.header.student_label}|${a.config.title}`] = new Set(F.flags.map((f) => f.id));
    assert.ok(F.prompts.length >= 1 && F.prompts.length <= 5, 'between one and five prompts');
  }
  const get = (label) => flagsOf[Object.keys(flagsOf).find((k) => k.startsWith(label + '|') && k.includes('Cities'))];
  assert.ok(get('T. Ranscriber').has('transcription'));
  assert.ok(get('T. Ranscriber').has('away'));
  assert.ok(get('T. Ranscriber').has('retype'));
  assert.ok(get('Otto Typer').has('rhythm'));
  assert.ok(get('Otto Typer').has('fast'));
  assert.ok(get('Wren Offline').has('gap'));
  assert.ok(get('Tam Pered').has('integrity-replay'));
  assert.equal(get('Dee Ctation').size, 0, 'dictation is never flagged as a large insertion');
  const composed = Object.entries(flagsOf).filter(([k]) => !/Ranscriber|Typer|Offline|Pered|Ctation/.test(k));
  for (const [k, v] of composed) assert.equal(v.size, 0, `${k} should have no flags, got ${[...v]}`);
});
