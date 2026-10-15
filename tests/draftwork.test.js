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
import { DocModel, MARKS, diffEvents, FOOTNOTE, FONT_KEYS, SIZE_LIST, fontOf, sizeOf } from '../public/js/core/doc.js';
import { toDocx, zip, toPlainText } from '../public/js/core/export.js';
import { readZip, lmsName, namesMatch } from '../public/js/core/zipread.js';

const mock = await createMockTsa();
const stampAt = async (hash, when) => toBase64(A.raw(extractToken(await mock.respond(buildRequest(unhex(hash)), when))));

// Builds a small file through the real Recorder with a fake clock.
async function makeFile(script, { config, stamper } = {}) {
  config = config || newConfig({ title: 'Test', allowDemoTsa: true });
  const cfgHash = await configHash(config);
  let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
  const times = [];
  const rec = await Recorder.create({
    config,
    cfgHash,
    header: { student_label: 'Test Student', created: new Date(clock).toISOString() },
    now: () => clock,
    stamper: (h, cp) => (stamper || stampAt)(h, new Date((times[cp.range[1]] ?? clock) + 500)),
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
  const F = finalize(await analyzeFile(copy));
  assert.deepEqual(F.flags.map((f) => f.title), ['Student name or start time was changed']);
});

test('integrity flags explain in plain words where the text and its history part ways', async () => {
  const { file } = await makeFile(async ({ type }) => type('The consequences were lasting.'));
  const copy = structuredClone(file);
  copy.final.text = 'The consequences were brief.';
  copy.final.hash = await sha256Hex(copy.final.text);
  const f = finalize(await analyzeFile(copy)).flags.find((x) => x.id === 'integrity-replay');
  assert.equal(f.title, 'Submitted text doesn’t match its history');
  assert.match(f.reason, /submitted text reads “The consequences were brief\.”, but the edit history gives “The consequences were lasting\.”/);
  assert.match(f.detail, /character 22/);
});

test('typing faster than people type, and repeated paste attempts, are flagged', async () => {
  const { file } = await makeFile(async ({ type, rec, wait }) => {
    type('A normal start, typed at a normal pace. ');
    wait(5000);
    type('Then a long stretch arrives far faster than anyone could type it, steadily and without a single pause, '.repeat(4), 20);
    for (let k = 0; k < 3; k++) {
      wait(4000);
      rec.record({ k: 'paste_blocked', len: 400 + k, it: 'insertFromPaste' });
    }
  });
  const F = finalize(await analyzeFile(file));
  const ids = F.flags.map((f) => f.id);
  assert.ok(ids.includes('speed'), `got ${ids}`);
  assert.ok(ids.includes('pastes'), `got ${ids}`);
  assert.match(F.flags.find((f) => f.id === 'pastes').reason, /3 times \(1,203 characters in all/);
  assert.ok(F.prompts.some((p) => p.title === 'Typing faster than people type'));
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

test('timestamps from an unapproved service fail, and demo stamps need the assignment to allow them', async () => {
  const forger = await createMockTsa('Totally Real Timestamp Authority');
  const forgedStamp = async (h, when) => toBase64(A.raw(extractToken(await forger.respond(buildRequest(unhex(h)), when))));
  const forged = await makeFile(async ({ type }) => type('Forged history'), { stamper: forgedStamp });
  const f = finalize(await analyzeFile(forged.file));
  const tsa = f.integrity.find((c) => c.id === 'tsa');
  assert.equal(tsa.status, 'fail');
  assert.match(tsa.explain.technical, /not an approved timestamp service|not a time-stamping certificate/);
  assert.match(f.flags.find((x) => x.id === 'integrity-tsa').reason, /doesn’t accept|isn’t valid for timestamping/);

  const strict = newConfig({ title: 'Strict' });
  const demo = await makeFile(async ({ type }) => type('Demo stamps'), { config: strict });
  assert.equal((await integrityOf(demo.file)).tsa, 'fail');
  const allowed = await makeFile(async ({ type }) => type('Demo stamps'));
  assert.equal((await integrityOf(allowed.file)).tsa, 'warn');
});

test('a long passage moved in from the sources panel is flagged as heavy quoting', async () => {
  const essayText = 'This whole essay was written somewhere else and brought in through the sources panel. '.repeat(10);
  const { file } = await makeFile(async ({ type, rec, wait }) => {
    type('My intro. ');
    rec.record({ k: 'paste_src', pane: 'src', p: 0, x: essayText, it: 'insertFromPaste' });
    wait(3000);
    rec.record({ k: 'paste_in', from: 'src', p: rec.text.length, x: essayText, it: 'insertFromPaste' });
  });
  const F = finalize(await analyzeFile(file));
  const q = F.flags.find((f) => f.id === 'quotes');
  assert.ok(q, 'no heavy-quoting flag');
  assert.ok(F.prompts.some((p) => p.title === 'Heavy quoting'));
  // An ordinary short quote is fine.
  const { file: ok } = await makeFile(async ({ type, rec }) => {
    type('A paragraph of my own words that goes on for a while, making an argument about cities and memory. ');
    rec.record({ k: 'paste_src', pane: 'src', p: 0, x: '"We shape our buildings."', it: 'insertFromPaste' });
    rec.record({ k: 'paste_in', from: 'src', p: rec.text.length, x: '"We shape our buildings."', it: 'insertFromPaste' });
  });
  assert.ok(!finalize(await analyzeFile(ok)).flags.some((f) => f.id === 'quotes'));
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
  assert.equal(view.getUint16(eocd + 10, true), 11);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes(' &amp; &lt;stuff&gt;'));
  assert.ok(text.includes('<w:b/></w:rPr><w:t xml:space="preserve">Text</w:t>'));
  assert.ok(text.includes('<w:pStyle w:val="Title"/>'));
  assert.ok(text.includes('<w:tab/>'));
});

test('LMS zips: entries are read and student names recognised', async () => {
  const inner = await serializeFile((await makeFile(async ({ type }) => type('abc'))).file);
  const archive = zip([
    ['smithjane_LATE_123456_7890123_essay.draftwork', inner],
    ['Jane Smith_42_assignsubmission_file_\\essay.draftwork', inner],
    ['readme.txt', 'x'],
  ]);
  const entries = await readZip(archive);
  assert.equal(entries.length, 3);
  assert.equal((await parseFile(entries[0].bytes)).header.student_label, 'Test Student');
  assert.deepEqual(lmsName(entries[0].name), { lms: 'Canvas', name: 'smithjane' });
  assert.deepEqual(lmsName(entries[1].name), { lms: 'Moodle', name: 'Jane Smith' });
  assert.deepEqual(lmsName('12345-678 - Jane Smith - Oct 14, 2026 1200 PM - essay.draftwork'), { lms: 'Brightspace', name: 'Jane Smith' });
  assert.deepEqual(lmsName('Essay 2_jsmith_attempt_2026-10-14-12-00-00_essay.draftwork'), { lms: 'Blackboard', name: 'jsmith' });
  assert.ok(namesMatch('smithjane', 'Jane Smith, 000123'));
  assert.ok(namesMatch('jsmith', 'J. Smith'));
  assert.ok(!namesMatch('Jane Doe', 'Blake Okafor'));
});

test('page breaks and Works Cited style survive Enter and export', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'End of essay\nWorks Cited', 0);
  d.applyPara({ a: 1, b: 1, set: { pb: true, al: 'c' } });
  d.applyText(d.text.length, 0, '\nSmith, J. A Book.', 0);
  assert.equal(d.paras[2].pb, undefined, 'Enter does not copy the page break');
  d.applyPara({ a: 2, b: 1, set: { s: 'bib', al: 'l' } });
  const xml = new TextDecoder().decode(toDocx(d, {}, 'T'));
  assert.ok(xml.includes('<w:pageBreakBefore/>'));
  assert.ok(xml.includes('<w:pStyle w:val="Bibliography"/>'));
  assert.ok(xml.includes('PAGE'));
  d.applyPara({ a: 1, b: 1, set: { pb: false } });
  assert.equal(d.paras[1].pb, undefined, 'clearing a break leaves no trace in the format');
});

test('footnotes follow their anchors, survive undo, and export to Word', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'First claim. Second claim.', 0);
  d.applyText(12, 0, FOOTNOTE, 0); // after "First claim."
  assert.deepEqual(d.notes, ['']);
  d.applyNote({ i: 0, p: 0, x: 'Smith, p. 4.' });
  d.applyText(d.text.length, 0, FOOTNOTE, 0);
  d.applyNote({ i: 1, p: 0, x: 'Jones, p. 9.' });
  assert.deepEqual(d.notes, ['Smith, p. 4.', 'Jones, p. 9.']);
  const before = d.clone();
  d.applyText(0, 13, '', 0); // deleting the first sentence takes its footnote with it
  assert.deepEqual(d.notes, ['Jones, p. 9.']);
  for (const e of diffEvents(d, before, 'historyUndo', diffOp)) d.apply(e);
  assert.deepEqual(d.notes, ['Smith, p. 4.', 'Jones, p. 9.']);
  assert.equal(d.text, before.text);
  assert.deepEqual(d.format().notes, d.notes);
  assert.throws(() => d.applyNote({ i: 5, p: 0, x: 'x' }));
  const xml = new TextDecoder().decode(toDocx(d, { headerText: 'Smith', pageNum: 'header' }, 'T'));
  assert.ok(xml.includes('<w:footnoteReference w:id="2"/>'));
  assert.ok(xml.includes('Jones, p. 9.'));
  assert.ok(xml.includes('Smith ') && xml.includes('<w:headerReference'));
  assert.ok(!xml.includes('<w:footerReference'), 'page number is in the header, not the footer');
  assert.ok(toPlainText(d).includes('First claim.[1]'));
});

test('font and size apply to selected text, independent of other formatting', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'abcdef', MARKS.b);
  d.applyFmt({ p: 1, n: 3, font: FONT_KEYS.indexOf('arial'), size: SIZE_LIST.indexOf(14) });
  assert.equal(fontOf(d.marks[2]), FONT_KEYS.indexOf('arial'));
  assert.equal(SIZE_LIST[sizeOf(d.marks[2])], 14);
  assert.ok(d.marks[2] & MARKS.b, 'bold kept');
  assert.equal(fontOf(d.marks[0]), 0);
  d.applyFmt({ p: 1, n: 3, clr: MARKS.b });
  assert.equal(fontOf(d.marks[2]), FONT_KEYS.indexOf('arial'), 'font kept when bold is cleared');
  assert.throws(() => d.applyFmt({ p: 0, n: 1, font: 99 }));
  const xml = new TextDecoder().decode(toDocx(d, {}, 'T'));
  assert.ok(xml.includes('<w:rFonts w:ascii="Arial"') && xml.includes('<w:sz w:val="28"/>'));
});

test('documents without the new features hash exactly as before', () => {
  const d = new DocModel();
  d.applyText(0, 0, 'Plain\nHeading', 0);
  d.applyPara({ a: 1, b: 1, set: { s: 'h1' } });
  assert.deepEqual(Object.keys(d.format()), ['marks', 'paras']);
  assert.equal(d.hashInput(), 'Plain\nHeading\u0000{"marks":[[13,0]],"paras":[{"al":"l","in":0,"li":"","s":"p"},{"al":"l","in":0,"li":"","s":"h1"}]}');
});

test('simulated class: flags land on the right writers and nowhere else', async () => {
  const { files } = await simulateClass({ students: 15, seed: 7 });
  const analyses = [];
  for (const { file } of files) analyses.push(await analyzeFile(await parseFile(await serializeFile(file))));
  const flagsOf = {};
  const promptTitles = [];
  const levelOf = {};
  for (const a of analyses) {
    const cohort = analyses.filter((x) => x.cfgHash === a.cfgHash);
    const F = finalize(a, { cohort });
    flagsOf[`${a.header.student_label}|${a.config.title}`] = new Set(F.flags.map((f) => f.id));
    levelOf[`${a.header.student_label}|${a.config.title}`] = F.level;
    const main = F.prompts.filter((p) => !p.extra);
    assert.ok(main.length >= 1 && main.length <= 5, 'between one and five main questions');
    assert.ok(F.prompts.length <= 9, 'at most four more');
    assert.equal(new Set(F.prompts.map((p) => p.key)).size, F.prompts.length, 'each question has its own notes key');
    for (const f of F.flags) assert.ok(f.title && f.reason && f.detail, `${f.id} has a title, reason and detail`);
    promptTitles.push(...F.prompts.map((p) => p.title));
  }
  for (const t of ['The most reworked paragraph', 'Back to the opening', 'The most productive return']) {
    assert.ok(promptTitles.includes(t), `someone in the class gets "${t}"`);
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
  assert.ok(get('Sam Copier').has('overlap'), 'the copied paragraph is found');
  assert.ok(get('Blake Okafor').has('overlap'), 'and shown on the original too');
  // Inappropriate AI use, four ways.
  for (const id of ['pastes', 'retype', 'transcription', 'overlap']) assert.ok(get('Polly Phone').has(id), `Polly Phone: ${id}`);
  for (const id of ['transcription', 'away', 'overlap']) assert.ok(get('Gene Rated').has(id), `Gene Rated: ${id}`);
  for (const id of ['untrusted', 'speed', 'fast']) assert.ok(get('Hugh Maniser').has(id), `Hugh Maniser: ${id}`);
  assert.ok(get('Cole Launder').has('quotes'), 'Cole Launder: quotes');
  const composed = Object.entries(flagsOf).filter(([k]) => !/Ranscriber|Typer|Offline|Pered|Ctation|Copier|Blake|Polly|Gene|Hugh|Cole/.test(k));
  for (const [k, v] of composed) assert.equal(v.size, 0, `${k} should have no flags, got ${[...v]}`);
  // Green, amber, red.
  const lvl = (label) => levelOf[Object.keys(levelOf).find((k) => k.startsWith(label + '|') && k.includes('Cities'))];
  for (const [k] of composed) assert.equal(levelOf[k], 'none', k);
  for (const n of ['Wren Offline', 'Blake Okafor', 'Sam Copier']) assert.equal(lvl(n), 'minor', n);
  for (const n of ['T. Ranscriber', 'Otto Typer', 'Tam Pered', 'Polly Phone', 'Gene Rated', 'Hugh Maniser', 'Cole Launder']) assert.equal(lvl(n), 'major', n);
  assert.deepEqual([...get('Blake Okafor')], ['overlap']);
});
