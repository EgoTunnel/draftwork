// Generates a synthetic class of .draftwork files for demos and tests.
// Each writer is simulated through the real Recorder with a fake clock and the demo TSA.
//
//   node tools/simulate.js [outDir]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMockTsa } from './mock-tsa.js';
import { buildRequest, extractToken } from '../public/js/core/tsa.js';
import { unhex, toBase64 } from '../public/js/core/canon.js';
import * as A from '../public/js/core/asn1.js';
import { Recorder } from '../public/js/core/recorder.js';
import { newConfig, configHash, encodeConfig, serializeFile, fileName, countWords } from '../public/js/core/format.js';

// ---------- deterministic randomness ----------

function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    normal: (mean, sd) => {
      const u = Math.max(1e-9, next());
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return r;
}

// ---------- essay text ----------

const OPENERS = ['In many ways', 'At first glance', 'Historically', 'For most readers', 'In practice', 'Seen this way', 'By contrast', 'More importantly', 'Even so', 'Taken together'];
const SUBJECTS = ['the city council', 'the novel', 'the author', 'public libraries', 'the new policy', 'local farmers', 'the narrator', 'urban planners', 'the survey', 'small schools', 'the river project', 'most students'];
const VERBS = ['reshaped', 'questioned', 'depended on', 'ignored', 'quietly undermined', 'made room for', 'struggled with', 'borrowed from', 'complicated', 'set out to explain'];
const OBJECTS = ['the idea of community', 'the cost of housing', 'an older tradition', 'the limits of memory', 'how people actually lived', 'the promise of progress', 'the role of chance', 'what counted as evidence', 'the meaning of home', 'a familiar argument'];
const TAILS = ['', ', and the consequences were lasting', ', which few people noticed at the time', ' in ways that still matter', ', at least on paper', ' more than anyone expected', ', though not for long', ', as the second chapter shows'];

function sentence(r) {
  const opener = r.chance(0.4) ? r.pick(OPENERS) + ', ' : '';
  let s = `${opener}${r.pick(SUBJECTS)} ${r.pick(VERBS)} ${r.pick(OBJECTS)}${r.pick(TAILS)}.`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function essay(r, paragraphs, sentences) {
  return Array.from({ length: paragraphs }, () => Array.from({ length: r.int(sentences - 1, sentences + 1) }, () => sentence(r)).join(' '));
}

const QUOTES = [
  '"The city is a fact in nature, like a cave, a run of mackerel or an ant-heap."',
  '"Memory is not an instrument for exploring the past but its theatre."',
  '"We shape our buildings; thereafter they shape us."',
];

// ---------- simulated writer ----------

class Sim {
  constructor({ r, recorder, start }) {
    this.r = r;
    this.rec = recorder;
    this.clock = start;
    this.times = [];
  }

  wait(ms) {
    this.clock += Math.max(1, Math.round(ms));
    this.rec.tick();
  }

  get text() {
    return this.rec.text;
  }

  ev(e) {
    const out = this.rec.record(e);
    this.times[out.s] = this.clock;
    return out;
  }

  sys(e) {
    const out = this.rec.push(e);
    this.times[out.s] = this.clock;
    return out;
  }

  start() {
    this.rec.startSession();
    this.times[this.rec.events.length - 1] = this.clock;
    this.cursor = this.text.length;
  }

  end() {
    this.rec.endSession();
    this.times[this.rec.events.length - 1] = this.clock;
  }

  moveTo(p) {
    if (Math.abs(p - this.cursor) > 40) this.sys({ k: 'move', p, from: this.cursor });
    this.cursor = p;
  }

  ins(x, it = 'insertText', k = 'ins', extra = {}) {
    this.ev({ k, p: this.cursor, x, it, ...extra });
    this.cursor += x.length;
  }

  backspace(n = 1, it = 'deleteContentBackward') {
    n = Math.min(n, this.cursor);
    if (!n) return;
    this.ev({ k: 'del', p: this.cursor - n, n, it });
    this.cursor -= n;
  }

  // Types text one key at a time. ikiMean/ikiSd in ms; typo rate per character.
  type(str, { ikiMean = 190, ikiSd = 80, typo = 0.03, minIki = 35 } = {}) {
    for (const ch of str) {
      this.wait(Math.max(minIki, this.r.normal(ikiMean, ikiSd)));
      if (typo && /[a-z]/.test(ch) && this.r.chance(typo)) {
        this.ins(String.fromCharCode(97 + this.r.int(0, 25)));
        this.wait(Math.max(minIki, this.r.normal(ikiMean * 1.6, ikiSd)));
        this.backspace();
        this.wait(Math.max(minIki, this.r.normal(ikiMean, ikiSd)));
      }
      this.ins(ch === '\n' ? '\n' : ch, ch === '\n' ? 'insertLineBreak' : 'insertText');
    }
  }

  blur(ms) {
    this.sys({ k: 'blur' });
    this.wait(ms);
    this.sys({ k: 'focus' });
  }
}

// A writer who composes: pauses at boundaries, revises behind the cursor, deletes, moves, quotes.
function composer(sim, r, paras, { speed = 1, sessions = 2, revise = 0.25, quote = true, dictation = false } = {}) {
  const typing = { ikiMean: 170 * speed, ikiSd: 90 * speed, typo: 0.035 };
  const sessionBreak = Math.max(1, Math.floor(paras.length / sessions));
  sim.start();
  if (quote) {
    sim.wait(r.range(20_000, 60_000));
    const q = r.pick(QUOTES);
    sim.ev({ k: 'paste_src', pane: 'src', p: 0, x: q + '\n', it: 'insertFromPaste' });
    sim.quote = q;
  }
  // a title, styled as one
  sim.wait(r.range(5_000, 20_000));
  sim.type(r.pick(['Cities and Memory', 'What the River Remembers', 'Streets as Archives', 'The Shape of a Place']), typing);
  sim.ev({ k: 'para', a: 0, b: 1, set: { s: 'title' }, it: 'formatStyle' });
  sim.type('\n', typing);
  paras.forEach((para, pi) => {
    if (pi > 0 && pi % sessionBreak === 0 && sessions > 1 && pi / sessionBreak < sessions) {
      sim.end();
      sim.clock += r.range(18, 30) * 3600_000;
      sim.start();
    }
    if (pi > 0) sim.type('\n\n', typing);
    sim.wait(r.range(15_000, 90_000)); // thinking at a paragraph boundary
    const sentences = para.match(/[^.]+\.\s*/g) || [para];
    sentences.forEach((s, si) => {
      const body = s.trimEnd() + (si < sentences.length - 1 ? ' ' : '');
      if (dictation && r.chance(0.6)) {
        sim.wait(r.range(1500, 4000));
        sim.ins(body, 'insertCompositionText', 'ime');
        return;
      }
      // false start: type a few words, delete them, rephrase
      if (r.chance(0.3)) {
        const fake = sentence(r).split(' ').slice(0, r.int(2, 5)).join(' ') + ' ';
        sim.type(fake, typing);
        sim.wait(r.range(2500, 9000));
        for (let k = 0; k < fake.length;) {
          const n = Math.min(fake.length - k, r.int(1, 7));
          sim.backspace(n, n > 1 ? 'deleteWordBackward' : 'deleteContentBackward');
          sim.wait(r.range(80, 300));
          k += n;
        }
      }
      sim.type(body, typing);
      // now and then, italicize a phrase just written
      const m = body.match(/(the [a-z]+ [a-z]+)/);
      if (m && r.chance(0.15)) {
        sim.wait(r.range(1500, 4000));
        sim.ev({ k: 'fmt', p: sim.cursor - body.length + m.index, n: m[1].length, set: 2, it: 'formatMark' });
      }
      sim.wait(r.chance(0.7) ? r.range(2200, 12_000) : r.range(300, 1500));
      if (r.chance(0.06)) sim.blur(r.range(5_000, 60_000));
    });
    // revise an earlier sentence
    if (r.chance(revise) && sim.text.length > 200) {
      const end = sim.text.length;
      const target = r.int(20, Math.max(21, end - 120));
      const at = sim.text.indexOf(' ', target) + 1 || target;
      sim.wait(r.range(4000, 20_000));
      sim.moveTo(at);
      const wordEnd = sim.text.indexOf(' ', at);
      if (wordEnd > at) {
        sim.cursor = wordEnd;
        sim.backspace(wordEnd - at, 'deleteWordBackward');
        sim.type(r.pick(['really', 'gradually', 'arguably', 'openly', 'barely']) + ' ' + r.pick(['changed', 'framed', 'shaped', 'hid']), typing);
      }
      sim.wait(r.range(2000, 6000));
      sim.moveTo(sim.text.length);
    }
  });
  // cut a paragraph and move it earlier
  const t = sim.text;
  const paraStarts = [...t.matchAll(/\n\n/g)].map((m) => m.index + 2);
  if (paraStarts.length >= 3 && r.chance(0.6)) {
    sim.wait(r.range(60_000, 240_000));
    const from = paraStarts[paraStarts.length - 1];
    const moved = t.slice(from);
    sim.moveTo(from - 2);
    sim.ev({ k: 'del', p: from - 2, n: moved.length + 2, it: 'deleteByCut' });
    sim.cursor = from - 2;
    sim.wait(r.range(3000, 9000));
    const dest = paraStarts[0];
    sim.moveTo(dest);
    sim.ev({ k: 'paste_in', p: dest, x: moved + '\n\n', it: 'insertFromPaste' });
    sim.cursor = dest + moved.length + 2;
    sim.moveTo(sim.text.length);
  }
  // integrate the quote
  if (quote && sim.quote) {
    sim.wait(r.range(10_000, 40_000));
    const firstBreak = sim.text.indexOf('\n\n');
    const at = firstBreak > 0 ? firstBreak : sim.text.length;
    sim.moveTo(at);
    sim.type(' As one critic put it, ', typing);
    sim.ev({ k: 'paste_in', p: sim.cursor, x: sim.quote, it: 'insertFromPaste', from: 'src' });
    sim.cursor += sim.quote.length;
    sim.moveTo(sim.text.length);
  }
  // a large deletion near the end
  if (r.chance(0.7)) {
    sim.wait(r.range(30_000, 120_000));
    const s = sentence(r) + ' ' + sentence(r) + ' ' + sentence(r);
    sim.type(' ' + s, typing);
    sim.wait(r.range(20_000, 60_000));
    sim.ev({ k: 'del', p: sim.cursor - s.length - 1, n: s.length + 1, it: 'deleteContentBackward' });
    sim.cursor -= s.length + 1;
  }
  sim.end();
}

// A writer copying from another screen: steady, linear, glancing away between bursts.
function transcriber(sim, r, paras) {
  const steady = { ikiMean: 165, ikiSd: 25, typo: 0.004 };
  sim.start();
  sim.wait(30_000);
  // tried to paste the first paragraph first
  sim.sys({ k: 'paste_blocked', len: paras[0].length, it: 'insertFromPaste' });
  sim.wait(r.range(15_000, 40_000));
  paras.forEach((para, pi) => {
    const words = ((pi ? '\n\n' : '') + para).split(/(?<=\s)/);
    let chunk = '';
    let count = 0;
    const flush = () => {
      sim.blur(r.range(22_000, 45_000));
      sim.wait(r.range(300, 900));
      sim.type(chunk, steady);
      chunk = '';
      count = 0;
    };
    for (const w of words) {
      chunk += w;
      if (++count >= r.int(55, 70)) flush();
    }
    if (chunk) flush();
  });
  sim.end();
}

// A script typing at a fixed rhythm.
function autotyper(sim, r, paras) {
  sim.start();
  sim.wait(5000);
  sim.type(paras.join('\n\n'), { ikiMean: 120, ikiSd: 2, typo: 0, minIki: 100 });
  sim.end();
}

export { rng, essay, Sim, composer };

// ---------- driver ----------

export async function simulateClass({ students = 15, seed = 7 } = {}) {
  const mock = await createMockTsa();
  const config = newConfig({ title: 'Essay 2: Cities and Memory', paste: 'block', sourcesPane: true, wordsMin: 300, wordsMax: 1200, allowDemoTsa: true });
  config.nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  config.created = '2026-10-01T09:00:00.000Z';
  const cfgHash = await configHash(config);
  const prior = newConfig({ title: 'Essay 1: A Place I Know', paste: 'block', sourcesPane: false, allowDemoTsa: true });
  prior.nonce = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
  prior.created = '2026-09-10T09:00:00.000Z';
  const priorHash = await configHash(prior);

  const files = [];
  const base = Date.UTC(2026, 9, 6, 14, 0, 0);

  async function run(label, cfg, hash, startOffsetH, fn, { outage = null } = {}) {
    const r = rng(seed + files.length * 101 + label.length);
    const startMs = base + startOffsetH * 3600_000;
    let sim = { clock: startMs };
    const refused = new Set();
    const recorder = await Recorder.create({
      config: cfg,
      cfgHash: hash,
      header: { student_label: label, created: new Date(base + startOffsetH * 3600_000).toISOString(), process_notes: '' },
      now: () => sim.clock,
      stamper: async (h, cp) => {
        const at = sim.times[cp.range[1]] ?? sim.clock;
        // The simulation runs ahead of the stamping, so an outage is modelled per checkpoint:
        // the first attempt fails, and the retry is stamped when the connection comes back.
        const inOutage = outage && at >= outage[0] && at < outage[1];
        if (inOutage && !refused.has(cp.c)) {
          refused.add(cp.c);
          throw new Error('offline');
        }
        const when = inOutage ? outage[1] + r.range(1000, 5000) : at + r.range(150, 900);
        const resp = await mock.respond(buildRequest(unhex(h)), new Date(when));
        return toBase64(A.raw(extractToken(resp)));
      },
    });
    sim = new Sim({ r, recorder, start: startMs });
    await fn(sim, r);
    await recorder.settle();
    // retry anything queued during an outage
    for (let k = 0; k < 100 && recorder.unstamped().length; k++) await recorder.stampPending();
    const file = await recorder.toFile();
    files.push({ label, file });
    return file;
  }

  const names = ['Avery Chen', 'Blake Okafor', 'Casey Lindqvist', 'Dana Ruiz', 'Eli Haddad', 'Finley Park', 'Gray Mensah', 'Harper Novak',
    'Indigo Sato', 'Jordan Abara', 'Kai Moreau', 'Logan Petrov', 'Morgan Iyer', 'Noor Castillo', 'Oakley Brandt', 'Parker Quinn', 'Reese Tanaka'];

  for (let k = 0; k < students; k++) {
    const r0 = rng(seed * 13 + k);
    const paras = essay(r0, r0.int(4, 6), 5);
    await run(names[k % names.length], config, cfgHash, k * 3, (sim, r) =>
      composer(sim, r, paras, { speed: r.range(0.75, 1.35), sessions: r.int(1, 3), revise: r.range(0.2, 0.6), quote: r.chance(0.7) }));
  }
  // Same student, earlier assignment, for the self-baseline.
  await run(names[0], prior, priorHash, -24 * 20, (sim, r) => composer(sim, r, essay(rng(99), 4, 5), { sessions: 2, quote: false }));

  // Copies one paragraph of Blake Okafor's essay into an otherwise original piece.
  {
    const r1 = rng(seed * 13 + 1);
    const blake = essay(r1, r1.int(4, 6), 5);
    const own = essay(rng(506), 4, 5);
    own.splice(2, 0, blake[1]);
    await run('Sam Copier', config, cfgHash, 49, (sim, r) => composer(sim, r, own, { sessions: 1, quote: false }));
  }
  await run('T. Ranscriber', config, cfgHash, 50, (sim, r) => transcriber(sim, r, essay(rng(501), 5, 5)));
  await run('Otto Typer', config, cfgHash, 52, (sim, r) => autotyper(sim, r, essay(rng(502), 5, 5)));
  await run('Dee Ctation', config, cfgHash, 54, (sim, r) => composer(sim, r, essay(rng(503), 4, 5), { dictation: true, quote: false, sessions: 1 }));
  // Writes through a long relay outage: stamps arrive late, so the stretch shows as a gap.
  await run('Wren Offline', config, cfgHash, 56, (sim, r) => composer(sim, r, essay(rng(504), 5, 5), { sessions: 1 }),
    { outage: [base + 56 * 3600_000 + 5 * 60_000, base + 56 * 3600_000 + 40 * 60_000] });
  const tampered = await run('Tam Pered', config, cfgHash, 58, (sim, r) => composer(sim, r, essay(rng(505), 4, 5), { sessions: 1 }));
  // Hand-edit the JSON: change one typed character in the log and the final text to match.
  const idx = tampered.events.findIndex((e, i) => i > 200 && e.k === 'ins' && /[a-z]/.test(e.x || ''));
  tampered.events[idx].x = 'Z';

  for (const f of files) f.file.header.process_notes = f.label === names[2] ? 'Outlined on paper first.' : '';
  return { config, cfgHash, prior, files };
}

if (process.argv[1] && process.argv[1].endsWith('simulate.js')) {
  const out = process.argv[2] || 'samples';
  await mkdir(out, { recursive: true });
  const { config, prior, files } = await simulateClass();
  for (const { file } of files) {
    const bytes = await serializeFile(file);
    await writeFile(join(out, fileName(file)), bytes);
    console.log(`${fileName(file).padEnd(52)} ${String(file.events.length).padStart(6)} events  ${String(countWords(file.final.text)).padStart(5)} words  ${(bytes.length / 1024).toFixed(0)} KB`);
  }
  await writeFile(join(out, 'assignment-codes.txt'),
    `Essay 2: Cities and Memory\n${await encodeConfig(config)}\n\nEssay 1: A Place I Know\n${await encodeConfig(prior)}\n`);
  console.log(`\nWrote ${files.length} files and assignment-codes.txt to ${out}/`);
}
