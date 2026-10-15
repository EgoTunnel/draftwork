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

const SOURCES = [
  'Lewis Mumford, The Culture of Cities (1938)',
  'Walter Benjamin, “A Berlin Chronicle”',
  'Winston Churchill, speech to the House of Commons, 28 October 1943',
];

// Chatbot-style paragraphs for the AI-misuse writers. Two students who asked the same
// chatbot get some identical paragraphs, which the shared-passage flag finds.
const AI_TITLE = 'Cities and Memory: Exploring the Intersection of Urban Space and Collective Remembrance';
const AI_PARAS = [
  "In today's rapidly evolving urban landscape, cities serve as living repositories of collective memory. Every street, building, and public square carries traces of the people who came before us, creating a rich tapestry of shared experience. As urban planners and residents navigate the challenges of growth and change, it is essential to recognize that the physical fabric of a city is deeply intertwined with the stories, identities, and values of its communities. Understanding this connection is crucial for building a more inclusive future.",
  'Furthermore, memory in the city is not static; it is a dynamic and multifaceted process. Monuments, street names, and historic districts are constantly reinterpreted by each new generation, reflecting shifting priorities and perspectives. For example, the preservation of older neighborhoods can foster a sense of continuity and belonging, while redevelopment may erase important cultural landmarks. Ultimately, the way a city remembers its past plays a pivotal role in shaping how its residents envision their shared future.',
  'Another key aspect to consider is the role of literature in capturing urban memory. Writers such as Italo Calvino and Walter Benjamin have explored how cities exist not only as physical spaces but also as landscapes of the imagination. Through their works, readers gain valuable insight into the complex relationship between place and identity. These texts remind us that every city is, in a sense, a story waiting to be told, retold, and reimagined.',
  'It is also important to acknowledge the challenges that arise when memory and development come into conflict. Gentrification, for instance, often displaces long-standing communities and replaces familiar spaces with generic structures. This process can lead to a profound sense of loss among residents whose personal histories are tied to these places. Therefore, policymakers must strike a delicate balance between economic growth and the preservation of cultural heritage.',
  'In conclusion, cities are far more than collections of buildings and streets; they are vibrant archives of human experience. By recognizing the importance of collective memory, we can create urban environments that honor the past while embracing the future. As we continue to navigate an increasingly interconnected world, fostering a deeper understanding of the relationship between cities and memory will be essential for building resilient, inclusive, and meaningful communities.',
  'Cities and memory are deeply intertwined concepts that have fascinated scholars, writers, and urban planners for centuries. At its core, the relationship between a city and its memories reflects the ways in which people make sense of their surroundings and their place within them. This essay will explore how cities preserve, transform, and sometimes erase memory, and why this dynamic matters for the communities that call these places home.',
  'Moreover, technology has added a new dimension to how cities remember. Digital archives, social media, and online mapping tools allow residents to document and share their experiences in unprecedented ways. These platforms can amplify marginalized voices and preserve stories that might otherwise be forgotten. However, they also raise important questions about who controls these narratives and how accurately they represent the lived experiences of diverse communities.',
  "Public spaces play a crucial role in the formation of collective memory. Parks, plazas, and markets serve as gathering places where shared experiences unfold, from everyday encounters to significant historical events. These spaces foster a sense of community and belonging that transcends individual differences. When such spaces are thoughtfully designed and maintained, they become powerful symbols of a city's identity and resilience in the face of change.",
  'Additionally, it is worth noting that memory is often selective. Cities tend to celebrate certain histories while overlooking others, which can perpetuate inequality and exclusion. For instance, monuments frequently honor powerful figures while neglecting the contributions of ordinary people and marginalized groups. Addressing these gaps requires a concerted effort to diversify the stories that are told and to ensure that all members of a community see themselves reflected in its landscape.',
  "The concept of urban memory also extends to the sensory experiences that define a place. The sounds of a bustling market, the smell of a local bakery, and the texture of cobblestone streets all contribute to a city's unique character. These sensory details evoke powerful emotional responses and help anchor personal memories to specific locations. In this way, the city becomes a living embodiment of the experiences of those who inhabit it.",
  'Ultimately, the relationship between cities and memory highlights the importance of thoughtful urban planning. By engaging communities in meaningful dialogue and incorporating diverse perspectives, planners can ensure that development honors the past while meeting the needs of the present. This holistic approach not only strengthens the social fabric of a city but also fosters a deeper sense of connection and pride among its residents.',
  'Throughout history, cities have served as both witnesses to and participants in the unfolding of human events. From ancient Rome to modern-day New York, urban centers have been shaped by wars, migrations, economic booms, and cultural movements. Each of these forces leaves an indelible mark on the cityscape, creating layers of history that coexist and interact in complex ways. Exploring these layers offers valuable insights into the broader human story.',
  'Education also plays a significant role in sustaining urban memory. Schools, museums, and community organizations can introduce younger generations to the histories embedded in their surroundings, fostering a sense of stewardship and civic pride. Walking tours, oral history projects, and interactive exhibits make the past tangible and accessible. By nurturing this awareness, cities empower residents to become active participants in preserving and reinterpreting the stories that define their shared spaces.',
  'In light of these considerations, it becomes clear that preserving urban memory is not merely an exercise in nostalgia. Rather, it is a vital process that enables communities to learn from the past, celebrate their achievements, and confront difficult truths. By embracing the rich and multifaceted nature of urban memory, cities can cultivate a sense of shared purpose that guides them toward a more equitable and sustainable future.',
];
const aiParas = (...k) => k.map((i) => AI_PARAS[i]);

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
    const pasted = sim.ev({ k: 'paste_src', pane: 'src', p: 0, x: q + '\n', it: 'insertFromPaste' });
    sim.quote = q;
    // Most students answer the "Where's this from?" prompt.
    if (r.chance(0.75)) {
      sim.wait(r.range(4000, 15000));
      sim.ev({ k: 'cite', of: pasted.s, x: SOURCES[QUOTES.indexOf(q)] });
    }
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
    // later in the draft, go back and adjust the opening's last sentence
    if (pi >= 2 && r.chance(revise * 0.8)) {
      const firstBreak = sim.text.indexOf('\n\n');
      if (firstBreak > 0) {
        sim.wait(r.range(8000, 30_000));
        sim.moveTo(firstBreak - 1);
        sim.backspace(1, 'deleteContentBackward');
        sim.type(r.pick([', at least at first.', ', or so it seems.', ' in ways worth tracing.']), typing);
        sim.wait(r.range(2000, 6000));
        sim.moveTo(sim.text.length);
      }
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

// Types a title line and styles it as one.
function typeTitle(sim, title, typing) {
  sim.type(title, typing);
  sim.ev({ k: 'para', a: 0, b: 1, set: { s: 'title' }, it: 'formatStyle' });
  sim.type('\n', typing);
}

// A writer copying from another screen: steady, linear, glancing away between bursts.
function transcriber(sim, r, paras, { tryPaste = true, title = null } = {}) {
  const steady = { ikiMean: 165, ikiSd: 25, typo: 0.004 };
  sim.start();
  sim.wait(30_000);
  // tried to paste the first paragraph first
  if (tryPaste) {
    sim.sys({ k: 'paste_blocked', len: paras[0].length, it: 'insertFromPaste' });
    sim.wait(r.range(15_000, 40_000));
  }
  if (title) typeTitle(sim, title, steady);
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

// Retyping a chatbot's answer from a phone: several tries at pasting it first, then steady
// typing with no window switches, just short glances down every few words.
function phoneCopier(sim, r, title, paras) {
  const steady = { ikiMean: 140, ikiSd: 28, typo: 0.005 };
  const answer = [title, ...paras].join('\n\n');
  sim.start();
  sim.wait(r.range(30_000, 60_000));
  for (let k = 0; k < 4; k++) {
    sim.sys({ k: 'paste_blocked', len: answer.length, it: 'insertFromPaste' });
    sim.wait(r.range(2500, 9000));
  }
  sim.wait(r.range(20_000, 40_000));
  typeTitle(sim, title, steady);
  let n = r.int(8, 15);
  for (const w of paras.join('\n\n').split(/(?<=\s)/)) {
    sim.type(w, steady);
    if (--n <= 0) {
      sim.wait(r.range(1500, 4000));
      n = r.int(8, 15);
    }
  }
  sim.end();
}

// An "AI humaniser" tool: its first attempts to insert the text are refused, so it types the
// text instead, with fake typos, far faster than a person.
function humaniser(sim, r, title, paras) {
  const tool = { ikiMean: 48, ikiSd: 20, typo: 0.02, minIki: 15 };
  sim.start();
  sim.wait(r.range(20_000, 40_000));
  const len = [title, ...paras].join('\n\n').length;
  for (let k = 0; k < 2; k++) {
    sim.ev({ k: 'untrusted', it: 'insertText', len });
    sim.wait(r.range(1500, 4000));
  }
  sim.wait(r.range(20_000, 40_000));
  typeTitle(sim, title, tool);
  paras.forEach((para, pi) => {
    if (pi) sim.type('\n\n', tool);
    for (const s of para.match(/[^.]+\.\s*/g) || [para]) {
      sim.type(s, tool);
      sim.wait(r.range(400, 1800));
    }
  });
  sim.end();
}

// Brings a chatbot essay in through the sources panel, a paragraph at a time, swapping a
// word here and there so it looks less copied.
function launderer(sim, r, title, paras) {
  const typing = { ikiMean: 180, ikiSd: 80, typo: 0.03 };
  const swaps = [[/\bcrucial\b/, 'important'], [/\bessential\b/, 'key'], [/\bpivotal\b/, 'big'], [/\bvaluable\b/, 'useful'], [/\bvital\b/, 'needed'], [/\bprofound\b/, 'deep']];
  sim.start();
  sim.wait(r.range(20_000, 50_000));
  const pasted = sim.ev({ k: 'paste_src', pane: 'src', p: 0, x: paras.join('\n\n') + '\n', it: 'insertFromPaste' });
  sim.wait(r.range(5000, 12_000));
  sim.ev({ k: 'cite', of: pasted.s, x: 'my research notes' });
  sim.wait(r.range(10_000, 30_000));
  typeTitle(sim, title, typing);
  sim.type('This essay looks at how cities hold on to memory, and what happens when they forget.', typing);
  for (const p of paras) {
    sim.wait(r.range(8000, 25_000));
    sim.type('\n\n', typing);
    const start = sim.cursor;
    sim.ev({ k: 'paste_in', from: 'src', p: start, x: p, it: 'insertFromPaste' });
    sim.cursor += p.length;
    for (const [re, word] of swaps) {
      const m = p.match(re);
      if (!m) continue;
      sim.wait(r.range(3000, 9000));
      sim.moveTo(start + m.index + m[0].length);
      sim.backspace(m[0].length, 'deleteWordBackward');
      sim.type(word, typing);
      sim.moveTo(sim.text.length);
      break;
    }
  }
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

  // Inappropriate uses of AI, each with the student's own disclosure.
  await run('Polly Phone', config, cfgHash, 60, (sim, r) => phoneCopier(sim, r, AI_TITLE, aiParas(0, 1, 2, 3, 4)));
  await run('Gene Rated', config, cfgHash, 62, (sim, r) => transcriber(sim, r, aiParas(5, 1, 6, 11, 13), { tryPaste: false, title: AI_TITLE }));
  await run('Hugh Maniser', config, cfgHash, 64, (sim, r) => humaniser(sim, r, AI_TITLE, aiParas(7, 8, 12, 9, 10)));
  await run('Cole Launder', config, cfgHash, 66, (sim, r) => launderer(sim, r, AI_TITLE, aiParas(11, 3, 0, 10)));
  const aiUse = {
    'Polly Phone': { used: 'none', detail: '' },
    'Gene Rated': { used: 'drafting', detail: 'ChatGPT wrote a first draft from the prompt, then I typed it out and changed some words.' },
    'Hugh Maniser': { used: 'editing', detail: 'A grammar checker.' },
    'Cole Launder': { used: 'ideas', detail: 'Asked ChatGPT for an outline.' },
  };
  const notes = { [names[2]]: 'Outlined on paper first.', 'Polly Phone': 'Wrote it in one go the night before.' };

  for (const f of files) {
    f.file.header.process_notes = notes[f.label] || '';
    if (aiUse[f.label]) f.file.header.ai_use = aiUse[f.label];
  }
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
