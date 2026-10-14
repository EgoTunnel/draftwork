// Viewer analysis: integrity checks (layer 1), flags (2), process signals (3), conversation prompts (4).
// Flags are listed separately and are never combined into a score.
import { canonical, sha256Hex } from './canon.js';
import {
  applyOp, isText, isSrc, eventsHash, checkpointHash, chainSeed, thresholdsFor, countWords,
} from './format.js';
import { DocModel, isFormatEvent } from './doc.js';
import { verifyToken } from './tsa.js';

const ACTIVE_GAP_MS = 5 * 60_000; // gaps longer than this do not count as active time
const SNAPSHOT_EVERY = 250;
const RUN_CHUNK_CHARS = 100;
// Input types that are not a route around the paste block. Undo and redo can only restore text already in the log.
const TYPING_TYPES = new Set(['insertText', 'insertCompositionText', 'insertFromDictation', 'insertLineBreak', 'insertParagraph', 'historyUndo', 'historyRedo']);
const SENTENCE_AFTER = /[.!?]["'”’)\]]*\s+\S/g;

export const POLICY_FOOTER = 'A process pattern can only ever lead to a conversation, never directly to a penalty.';

// ---------- small helpers ----------

export function fmtClock(ms) {
  const totalMin = Math.floor(ms / 60_000);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function snippet(text, words = 8) {
  const w = String(text).replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').split(' ');
  return w.slice(0, words).join(' ') + (w.length > words ? '…' : '');
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordinal = (k) => ORDINALS[k] || `${k + 1}th`;

function paragraphIndex(text, p) {
  const before = text.slice(0, p).replace(/^\s+/, '');
  const m = before.match(/\n\s*\n|\n/g);
  return m ? m.length : 0;
}

export function percentile(values, pct) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const idx = (pct / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (idx - lo);
}

function meanSd(v) {
  if (!v.length) return { mean: NaN, sd: NaN };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { mean, sd };
}

const cv = (v) => {
  const { mean, sd } = meanSd(v);
  return v.length >= 2 && mean > 0 ? sd / mean : NaN;
};

function restBlank(text, from) {
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c !== 32 && c !== 10 && c !== 9 && c !== 13) return false;
  }
  return true;
}

function behindCurrentSentence(text, p) {
  SENTENCE_AFTER.lastIndex = p;
  return SENTENCE_AFTER.test(text);
}

function pauseLocation(text, p) {
  if (p === 0) return 'paragraph';
  let j = p - 1;
  if (text[j] === '\n') return 'paragraph';
  if (!/\s/.test(text[j])) return 'mid-word';
  while (j >= 0 && /[ \t]/.test(text[j])) j--;
  if (j < 0 || text[j] === '\n') return 'paragraph';
  if (/[.!?:;"'”’)]/.test(text[j])) return 'sentence';
  return 'word';
}

export function inputLabel(e, policy) {
  if (e.k === 'paste_in') return e.from === 'src' ? 'quote from sources pane' : 'internal paste';
  if (e.k === 'paste_src') return 'paste into sources pane';
  if (e.k === 'ime') return 'IME / dictation composition';
  if (e.it === 'insertFromDictation') return 'dictation';
  if (e.it === 'insertFromPaste') return policy && policy.paste === 'allow' ? 'external paste (allowed)' : 'external paste';
  if (e.it === 'insertFromDrop') return 'drag-and-drop';
  if (e.it === 'insertReplacementText') return 'autocorrect / spellcheck';
  if (e.it === 'findReplace') return 'find and replace';
  if (e.it === 'insertSymbol') return 'special character';
  if (e.it === 'historyUndo' || e.it === 'historyRedo') return e.it === 'historyUndo' ? 'undo' : 'redo';
  if (e.it === 'insertText') return 'typing';
  return e.it || e.k;
}

// ---------- main analysis ----------

// Analyses one file on its own. Class-relative flags and prompts come from finalize().
// expectedConfigHash: the config the student page loaded. knownConfigHashes: the instructor's library.
export async function analyzeFile(file, { expectedConfigHash = null, knownConfigHashes = null } = {}) {
  const config = file.assignment.config;
  const T = thresholdsFor(config);
  const events = file.events;
  const N = events.length;

  const tl = {
    abs: new Float64Array(N), clock: new Float64Array(N), len: new Int32Array(N),
    typed: new Int32Array(N), cursor: new Int32Array(N), session: new Int16Array(N),
  };
  const snapshots = [];
  const sessions = [];
  const problems = { seq: [], order: [] };
  const cpEnds = new Map();
  for (const cp of file.checkpoints) if (Array.isArray(cp.range)) cpEnds.set(cp.range[1], null);

  const model = new DocModel();
  let text = '';
  let src = '';
  const atEnd = [];
  let replayError = null;
  let active = 0;
  let prevT = null;
  let typed = 0;
  let deletedChars = 0;
  let cursor = 0;
  let lastTextI = -1;
  let lastBlurI = -1;

  const pauses = [];
  const iki = [];
  const largeInserts = [];
  const delEpisodes = [];
  const structural = [];
  const blurs = [];
  const runs = [];
  const bursts = [];
  const awayBursts = [];
  const pasteBlocked = [];
  const untrusted = [];
  const srcPastes = [];
  let textEvents = 0;
  let behindEvents = 0;

  let run = null;
  let burst = null;
  let blurAt = null;
  let away = null;
  let ep = null;

  const endRun = () => {
    if (run && run.ins > 0) {
      run.text = text.slice(run.p0, cursor);
      run.words = countWords(run.text);
      run.rateCv = cv(run.rates);
      run.revision = run.ins ? run.del / run.ins : 0;
      runs.push(run);
    }
    run = null;
  };
  const endBurst = () => {
    if (burst && burst.chars >= 20 && burst.t1 > burst.t0) {
      burst.rate = burst.chars / ((burst.t1 - burst.t0) / 60_000);
      bursts.push(burst);
    }
    burst = null;
  };
  const endAway = () => {
    if (away && away.started) {
      const words = countWords(away.inserted);
      if (words >= T.away_burst_words) awayBursts.push({ i: away.i, endI: away.endI, awayMs: away.awayMs, words });
    }
    away = null;
  };
  const endEpisode = () => {
    if (ep && ep.text.length) delEpisodes.push(ep);
    ep = null;
  };

  try {
    for (let i = 0; i < N; i++) {
      const e = events[i];
      if (e.s !== i) problems.seq.push(i);
      if (e.k === 'session_start' || !sessions.length) {
        if (e.k !== 'session_start') problems.order.push(`event ${i} comes before any session start`);
        sessions.push({ i0: i, i1: i, wall: Date.parse(e.w) || 0, lastT: 0, active: 0 });
        prevT = null;
        endRun();
        endBurst();
        endEpisode();
        endAway();
      }
      const S = sessions[sessions.length - 1];
      let dt = 0;
      if (prevT !== null) {
        dt = e.t - prevT;
        if (dt < 0) problems.order.push(`time runs backwards at event ${i}`);
        else if (dt <= ACTIVE_GAP_MS) {
          active += dt;
          S.active += dt;
        }
      }
      prevT = e.t;
      S.lastT = e.t;
      S.i1 = i;
      const abs = S.wall + e.t;
      tl.abs[i] = abs;
      tl.clock[i] = active;
      tl.session[i] = sessions.length - 1;

      if (e.k === 'blur') {
        blurAt = abs;
        lastBlurI = i;
        endBurst();
        endAway();
      } else if (e.k === 'focus') {
        if (blurAt !== null && run) run.chunkAway += abs - blurAt;
        if (blurAt !== null) {
          blurs.push({ i, ms: abs - blurAt });
          if (abs - blurAt >= T.away_seconds * 1000) away = { i, awayMs: abs - blurAt, inserted: '', lastT: null, started: false };
        }
        blurAt = null;
      } else if (e.k === 'paste_blocked') {
        pasteBlocked.push({ i, len: e.len || 0 });
      } else if (e.k === 'untrusted') {
        untrusted.push({ i, it: e.it, len: e.len });
      } else if (e.k === 'move' && !isSrc(e)) {
        endRun();
        cursor = e.p;
      } else if (isFormatEvent(e) && !isSrc(e)) {
        model.apply(e);
      }

      if (isText(e)) {
        if (isSrc(e)) {
          src = applyOp(src, e);
          if (e.k === 'paste_src') srcPastes.push({ i, x: e.x || '' });
        } else {
          const n = e.n || 0;
          const x = e.x || '';
          const local = e.p === cursor || (n > 0 && e.p + n === cursor && !x) ||
            (e.k === 'rep' && e.p < cursor && cursor - e.p <= 40 && e.p + n <= cursor);
          const typingKind = (e.k === 'ins' || e.k === 'del' || e.k === 'rep' || e.k === 'ime') && x.length <= T.unusual_insert_chars;
          const sameSession = lastTextI >= 0 && tl.session[lastTextI] === sessions.length - 1;
          const gap = sameSession ? e.t - events[lastTextI].t : Infinity;

          // pauses before text events
          if (sameSession && gap > T.long_pause_s * 1000) {
            pauses.push({ i, ms: gap, where: pauseLocation(text, e.p), blur: lastBlurI > lastTextI });
          }
          // structural changes, for the "longest pause before a structural change" prompt
          const prevEv = events[i - 1];
          const pauseBefore = prevEv && tl.session[i - 1] === sessions.length - 1 ? e.t - prevEv.t : 0;
          if (e.k === 'paste_in' && x.length >= 40) {
            structural.push({ i, pause: pauseBefore, what: `moved a passage beginning "${snippet(x, 6)}"` });
          } else if (n >= 100) {
            structural.push({ i, pause: pauseBefore, what: `cut ${countWords(text.slice(e.p, e.p + n))} words` });
          } else if (/\n/.test(x) && !restBlank(text, e.p + n)) {
            structural.push({ i, pause: pauseBefore, what: 'split a paragraph in the middle of your draft' });
          }

          // linear runs (transcription, paste-then-retype, flattest stretch)
          if (run && (!local || !typingKind || e.p < run.p0)) endRun();
          if (!run && typingKind && x.length) {
            run = { i0: i, i1: i, p0: e.p, ins: 0, del: 0, rates: [], chunkT: abs, chunkChars: 0, chunkAway: 0, t0: abs, stops: [] };
          }
          if (run) {
            // A pause of 5 s or more inside a run is a natural stopping point, for paste-then-retype matching.
            if (gap >= 5000 && gap !== Infinity) run.stops.push(cursor - run.p0);
            run.i1 = i;
            run.ins += x.length;
            run.del += n;
            run.chunkChars += x.length;
            if (run.chunkChars >= RUN_CHUNK_CHARS) {
              // Time spent in another window does not count against typing speed.
              const ms = abs - run.chunkT - run.chunkAway;
              if (ms > 0) run.rates.push(run.chunkChars / ms);
              run.chunkT = abs;
              run.chunkChars = 0;
              run.chunkAway = 0;
            }
            run.t1 = abs;
          }

          // bursts between pauses
          if (burst && gap > T.long_pause_s * 1000) endBurst();
          if (x.length && typingKind) {
            if (!burst) burst = { i0: i, t0: abs, t1: abs, chars: 0 };
            burst.chars += x.length;
            burst.t1 = abs;
          }

          // away, then burst
          if (away) {
            if (away.started && e.t - away.lastT > T.away_burst_pause_s * 1000) endAway();
            else {
              away.started = true;
              away.lastT = e.t;
              away.endI = i;
              away.inserted += x;
            }
          }

          // keystroke rhythm
          if (e.k === 'ins' && e.it === 'insertText' && x.length === 1 && sameSession && gap < 2000 &&
              events[lastTextI].k === 'ins' && (events[lastTextI].x || '').length === 1) {
            iki.push(gap);
          }

          // deletion episodes
          if (n > 0) {
            const removed = text.slice(e.p, e.p + n);
            const contiguous = ep && sameSession && gap < 5000 && (e.p + n === ep.p || e.p === ep.p);
            if (!contiguous) {
              endEpisode();
              ep = { i, p: e.p, text: '', para: paragraphIndex(text, e.p), cut: e.it === 'deleteByCut' };
            }
            ep.text = e.p + n === ep.p ? removed + ep.text : ep.text + removed;
            ep.p = e.p;
            ep.endI = i;
            if (x) endEpisode();
          } else if (x) endEpisode();

          if (x.length > T.unusual_insert_chars) largeInserts.push({ i, len: x.length, k: e.k, it: e.it, from: e.from, label: inputLabel(e, config.policy) });

          textEvents++;
          if (behindCurrentSentence(text, e.p)) behindEvents++;

          const end = restBlank(text, e.p + n);
          model.apply(e);
          text = model.text;
          atEnd.splice(e.p, n, ...new Array(x.length).fill(end));
          typed += x.length;
          deletedChars += n;
          cursor = e.p + x.length;
          lastTextI = i;
        }
      }
      tl.len[i] = text.length;
      tl.typed[i] = typed;
      tl.cursor[i] = cursor;
      if (i % SNAPSHOT_EVERY === 0) snapshots.push({ i, src, doc: model.clone() });
      if (cpEnds.has(i)) cpEnds.set(i, model.hashInput());
    }
  } catch (err) {
    replayError = err.message || String(err);
  }
  endRun();
  endBurst();
  endEpisode();
  endAway();

  const A = {
    file, config, T, events, tl, snapshots, sessions, header: file.header,
    cfgHash: file.assignment.config_hash,
    replayText: text, replaySrc: src, replayFormat: model.format(),
    raw: {
      pauses, iki, largeInserts, delEpisodes, structural, blurs, runs, bursts, awayBursts, pasteBlocked, untrusted,
      srcPastes, textEvents, behindEvents, typed, deletedChars, atEnd, active,
    },
  };

  A.integrity = await integrityChecks(A, { replayError, problems, cpEnds, expectedConfigHash, knownConfigHashes });
  A.signals = computeSignals(A);
  A.metrics = {
    words: countWords(file.final.text),
    activeMin: active / 60_000,
    minutesPerWord: countWords(file.final.text) ? active / 60_000 / countWords(file.final.text) : NaN,
    ikiCv: cv(iki),
  };
  return A;
}

// ---------- layer 1 ----------

async function integrityChecks(A, { replayError, problems, cpEnds, expectedConfigHash, knownConfigHashes }) {
  const { file, events, tl, T } = A;
  const checks = [];

  // 1. replay reproduces final_text
  {
    const finalHash = await sha256Hex(file.final.text);
    let status = 'pass';
    let detail = `${events.length.toLocaleString()} events replay to the submitted text exactly.`;
    if (replayError) {
      status = 'fail';
      detail = `Replay stopped: ${replayError}.`;
    } else if (A.replayText !== file.final.text) {
      status = 'fail';
      const d = firstDiff(A.replayText, file.final.text);
      detail = `The replayed text differs from the submitted text from character ${d} on.`;
    } else if (finalHash !== file.final.hash) {
      status = 'fail';
      detail = 'The submitted text does not match its stored hash.';
    } else if (canonical(A.replayFormat) !== canonical(file.final.format || null)) {
      status = 'fail';
      detail = 'The text matches, but the submitted formatting differs from the replay.';
    }
    checks.push({
      id: 'replay', label: 'Edit history rebuilds the submitted text', status, detail,
      tip: 'Replaying every recorded edit from an empty page must produce exactly the submitted document.',
    });
  }

  // 2. checkpoint chain
  A.cpHashes = [];
  {
    const errs = [];
    if (problems.seq.length) errs.push(`event sequence numbers skip or repeat (first at ${problems.seq[0]})`);
    let prev = await chainSeed(file.assignment.config_hash, file.header);
    let expectStart = 0;
    for (let k = 0; k < file.checkpoints.length; k++) {
      const cp = file.checkpoints[k];
      if (cp.c !== k) errs.push(`checkpoint ${k} is numbered ${cp.c}`);
      if (!Array.isArray(cp.range) || cp.range[0] !== expectStart || cp.range[1] < cp.range[0]) {
        errs.push(`checkpoint ${k} does not continue from event ${expectStart}`);
        break;
      }
      const slice = events.slice(cp.range[0], cp.range[1] + 1);
      if (slice.length !== cp.range[1] - cp.range[0] + 1) errs.push(`checkpoint ${k} covers events that are missing`);
      else if (await eventsHash(slice) !== cp.events_hash) errs.push(`events in checkpoint ${k} were changed`);
      const docAt = cpEnds.get(cp.range[1]);
      if (docAt == null || await sha256Hex(docAt) !== cp.doc_hash) errs.push(`document at checkpoint ${k} does not match the replay`);
      if (cp.prev !== prev) errs.push(`checkpoint ${k} does not link to the one before it`);
      prev = await checkpointHash(cp);
      A.cpHashes.push(prev);
      expectStart = cp.range[1] + 1;
    }
    if (expectStart < events.length) errs.push(`${events.length - expectStart} events after the last checkpoint are not covered`);
    if (!file.checkpoints.length && events.length) errs.push('there are no checkpoints');
    checks.push({
      id: 'chain',
      label: 'History has not been edited',
      tip: 'The checkpoint chain is unbroken, and the document at every checkpoint matches the replay.',
      status: errs.length ? 'fail' : 'pass',
      detail: errs.length ? cap(errs.slice(0, 3).join('; ')) + '.'
        : file.checkpoints.length === 1 ? '1 checkpoint, matching the replay.' : `${file.checkpoints.length} checkpoints, all linked and matching.`,
    });
  }

  // 3. assignment config
  {
    const actual = await sha256Hex(canonical(file.assignment.config));
    let status;
    let detail;
    if (actual !== file.assignment.config_hash) {
      status = 'fail';
      detail = 'The assignment settings in the file were changed after writing.';
    } else if (expectedConfigHash) {
      status = actual === expectedConfigHash ? 'pass' : 'fail';
      detail = status === 'pass' ? `“${file.assignment.config.title}”` : 'Written for a different assignment.';
    } else if (knownConfigHashes) {
      status = knownConfigHashes.has(actual) ? 'pass' : 'unknown';
      detail = status === 'pass'
        ? `“${file.assignment.config.title}”`
        : 'Not one of your assignments. Import its code under Assignments to check.';
    } else {
      status = 'unknown';
      detail = 'No assignment to compare against.';
    }
    checks.push({
      id: 'config', label: 'Written for this assignment', status, detail,
      tip: "The assignment settings stored in the file (title, paste rules, limits) match the instructor's copy exactly.",
    });
  }

  // 4. timestamps
  {
    const errs = [...problems.order];
    const S = A.sessions;
    for (let k = 1; k < S.length; k++) {
      if (S[k].wall < S[k - 1].wall + S[k - 1].lastT - 1000) errs.push(`session ${k + 1} starts before session ${k} ends`);
    }
    checks.push({
      id: 'time',
      label: 'Times are in order',
      tip: 'Event times only move forward within each session, and sessions do not overlap.',
      status: errs.length ? 'fail' : 'pass',
      detail: errs.length ? cap(errs.slice(0, 3).join('; ')) + '.' : `${S.length} session${S.length === 1 ? '' : 's'}, in order.`,
    });
  }

  // 5. TSA tokens
  A.stamps = [];
  {
    const errs = [];
    let stamped = 0;
    let demo = false;
    let late = 0;
    const signers = new Set();
    for (let k = 0; k < file.checkpoints.length; k++) {
      const cp = file.checkpoints[k];
      const endI = Math.min(cp.range[1], events.length - 1);
      const cpTime = tl.abs[endI];
      const st = { c: k, endI, cpTime, stamped: !!cp.tsa, onTime: false };
      if (cp.tsa) {
        stamped++;
        const hash = A.cpHashes[k] || await checkpointHash(cp);
        const v = await verifyToken(cp.tsa, hash);
        st.ok = v.ok;
        st.genTime = v.genTime;
        st.signer = v.signer;
        if (v.signer) signers.add(v.signer);
        if (v.demo) demo = true;
        if (!v.ok) errs.push(`checkpoint ${k}: ${v.errors[0]}`);
        else {
          st.lag = v.genTime.getTime() - cpTime;
          if (st.lag < -T.stamp_lag_s * 1000) errs.push(`checkpoint ${k} was stamped ${fmtDuration(-st.lag)} before the time its events claim`);
          else if (st.lag > T.stamp_lag_s * 1000) late++;
          else st.onTime = true;
        }
      }
      A.stamps.push(st);
    }
    const missing = file.checkpoints.length - stamped;
    let status = errs.length ? 'fail' : 'pass';
    if (!errs.length && stamped === 0) status = 'unknown';
    else if (!errs.length && demo) status = 'warn';
    const bits = [];
    if (errs.length) bits.push(cap(errs.slice(0, 3).join('; ')) + '.');
    else if (stamped) bits.push(`${stamped} verified, from ${[...signers].join(', ')}.`);
    if (demo) bits.push('Demo timestamps (testing only).');
    if (missing) bits.push(`${missing} not stamped.`);
    if (late) bits.push(`${late} stamped late.`);
    checks.push({
      id: 'tsa',
      label: 'Timestamps are verified',
      tip: 'Each checkpoint carries an RFC 3161 timestamp from an outside service. Signatures are checked against the certificate in the token (not against a trusted root), and stamp times must match the recorded times.',
      status,
      detail: bits.join(' '),
    });
  }
  return checks;
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- layer 3 ----------

function computeSignals(A) {
  const { raw, tl, sessions, file, events } = A;
  const N = events.length;
  const finalLen = file.final.text.length;
  const elapsed = N ? tl.abs[N - 1] - tl.abs[0] : 0;
  const days = new Set(sessions.map((s) => new Date(s.wall).toDateString())).size;

  const pauseCounts = { paragraph: 0, sentence: 0, word: 0, 'mid-word': 0 };
  let pausesAfterBlur = 0;
  for (const p of raw.pauses) {
    pauseCounts[p.where]++;
    if (p.blur) pausesAfterBlur++;
  }
  const nPauses = raw.pauses.length || 1;
  const boundaryShare = (pauseCounts.paragraph + pauseCounts.sentence) / nPauses;

  const revisionRatio = finalLen ? raw.deletedChars / finalLen : 0;
  const reach = raw.textEvents ? raw.behindEvents / raw.textEvents : 0;
  const linear = finalLen ? raw.atEnd.filter(Boolean).length / finalLen : 0;
  const survival = raw.typed ? finalLen / raw.typed : 0;
  const burstLens = raw.bursts.map((b) => b.chars).sort((a, b) => a - b);
  const medBurst = burstLens.length ? burstLens[Math.floor(burstLens.length / 2)] : 0;
  const rates = raw.bursts.map((b) => b.rate);
  const meanRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const burstCv = cv(rates);
  const awayMs = raw.blurs.reduce((a, b) => a + b.ms, 0);
  const ikiStats = meanSd(raw.iki);
  const ikiCv = cv(raw.iki);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

  return [
    {
      id: 'time', name: 'Time on task', measures: 'Active time vs. elapsed time, sessions across days',
      transcription: 'One session, close to typing time for the length', benign: 'Fast writers; drafted on paper first',
      value: `${fmtDuration(raw.active)} active over ${fmtDuration(elapsed)}; ${sessions.length} session${sessions.length === 1 ? '' : 's'} on ${days} day${days === 1 ? '' : 's'}`,
      metric: raw.active / 60_000, unit: 'active min',
    },
    {
      id: 'pauses', name: 'Pause location', measures: 'Share of long pauses (over 2 s) at sentence and paragraph boundaries vs. mid-word',
      transcription: 'Pauses spread evenly or tied to focus loss', benign: 'Non-native writers pause mid-sentence to find words',
      value: raw.pauses.length
        ? `${raw.pauses.length} pauses: ${pct(pauseCounts.paragraph / nPauses)} paragraph, ${pct(pauseCounts.sentence / nPauses)} sentence, ${pct(pauseCounts.word / nPauses)} between words, ${pct(pauseCounts['mid-word'] / nPauses)} mid-word; ${pausesAfterBlur} after leaving the window`
        : 'No long pauses',
      metric: boundaryShare, unit: 'boundary share', fmt: pct,
    },
    {
      id: 'revision', name: 'Revision ratio', measures: 'Characters deleted ÷ characters in final text',
      transcription: 'Under ~0.1, almost all local typo fixes', benign: 'Confident writer; edited in a second, unlogged pass',
      value: `${num(revisionRatio)} (${raw.deletedChars.toLocaleString()} deleted, ${finalLen.toLocaleString()} final)`,
      metric: revisionRatio, fmt: (x) => num(x), watch: revisionRatio < 0.1,
    },
    {
      id: 'reach', name: 'Revision reach', measures: 'Share of edits made behind the sentence being written',
      transcription: 'Near zero', benign: 'Short pieces; writers who revise in their heads',
      value: pct(reach), metric: reach, fmt: pct, watch: reach < 0.02,
    },
    {
      id: 'linearity', name: 'Linearity', measures: "Share of final text produced at the document's end vs. inserted earlier",
      transcription: 'Near 100% end-of-document', benign: 'Writing to a detailed outline',
      value: pct(linear), metric: linear, fmt: pct, watch: linear > 0.97,
    },
    {
      id: 'bursts', name: 'Burst profile', measures: 'Length and speed of typing runs between pauses',
      transcription: 'Long, steady runs at constant speed', benign: 'Fluent typists on familiar material',
      value: raw.bursts.length
        ? `${raw.bursts.length} bursts; median ${medBurst} chars; ${Math.round(meanRate)} chars/min; speed variation ${num(burstCv)}`
        : 'Not enough typing to measure',
      metric: burstCv, fmt: (x) => num(x), unit: 'speed variation',
    },
    {
      id: 'focus', name: 'Focus pattern', measures: 'Window blurs followed by fast, pause-free bursts',
      transcription: '"Away, then burst" repeated', benign: 'Checking notes or sources in another tab',
      value: `${raw.blurs.length} time${raw.blurs.length === 1 ? '' : 's'} away (${fmtDuration(awayMs)} total); away-then-burst ×${raw.awayBursts.length}`,
      metric: raw.awayBursts.length, fmt: (x) => String(x), unit: 'away-then-burst',
    },
    {
      id: 'large', name: 'Large insertions', measures: 'Any single event over 50 characters, labelled by input type',
      transcription: 'Absent if pasting is blocked', benign: 'Dictation, IME, autocorrect',
      value: raw.largeInserts.length
        ? raw.largeInserts.slice(0, 6).map((l) => `${l.len} chars by ${l.label}`).join('; ') + (raw.largeInserts.length > 6 ? `; +${raw.largeInserts.length - 6} more` : '')
        : 'None',
      metric: raw.largeInserts.length, fmt: (x) => String(x), unit: 'count',
      moments: raw.largeInserts.map((l) => l.i),
    },
    {
      id: 'survival', name: 'Survival', measures: 'Share of all typed text that survives to the final version',
      transcription: 'Over 90%', benign: 'Same as revision ratio',
      value: `${pct(survival)} of ${raw.typed.toLocaleString()} characters typed`, metric: survival, fmt: pct, watch: survival > 0.9,
    },
    {
      id: 'rhythm', name: 'Keystroke rhythm', measures: 'Spread of time between keystrokes',
      transcription: 'Unnaturally regular (simple autotypers)', benign: "Weak signal; a good autotyper defeats it",
      value: raw.iki.length >= 20
        ? `${Math.round(ikiStats.mean)} ms average gap, variation ${num(ikiCv)} (${raw.iki.length.toLocaleString()} keystrokes)`
        : 'Not enough keystrokes to measure',
      metric: ikiCv, fmt: (x) => num(x), unit: 'variation',
    },
  ];
}

// ---------- layer 2 and 4 ----------

const BENIGN = {
  integrity: ['A bug in Draftwork itself. Check the file with the student before drawing conclusions.'],
  gap: ['Lost internet connection or a timestamp relay outage while writing', 'Laptop went to sleep with the page open'],
  untrusted: ['A browser extension (grammar checker, translator, password manager) tried to change the text'],
  unusual: ['Dictation or IME in a browser whose input type is not yet in the compatibility matrix', 'Autocorrect replacing a long span'],
  retype: ['Tried to paste their own notes or outline from another file, then typed them in', 'Coincidence of length'],
  transcription: ['Writing to a detailed outline', 'Drafted on paper first', 'Fluent typist on familiar material', 'Confident writer'],
  away: ['Checking notes or sources in another tab', 'Reading the prompt or rubric in another window'],
  fast: ['Fast writer', 'Drafted on paper first'],
  rhythm: ['Weak signal; some practised typists are very regular'],
};

function flag(kind, id, title, reason, moments, benign) {
  return { kind, id, title, reason, moments: moments || [], benign: benign || [] };
}

// Combines one analysis with its class and the student's earlier files.
// cohort: all analyses for the same assignment (including A). priors: the same student's earlier files.
export function finalize(A, { cohort = [A], priors = [] } = {}) {
  const { T, raw, tl, events } = A;
  const flags = [];
  const clock = (i) => fmtClock(tl.clock[Math.max(0, Math.min(i, events.length - 1))]);

  for (const c of A.integrity) {
    if (c.status === 'fail') flags.push(flag('integrity', 'integrity-' + c.id, 'Integrity failure', `${c.label}: ${c.detail}`, [], BENIGN.integrity));
  }

  // Timestamp gap: more than N minutes of writing between on-time stamps.
  {
    const anchors = A.stamps.filter((s) => s.onTime).map((s) => s.endI);
    const N = events.length;
    if (N) {
      const points = [0, ...anchors, N - 1];
      for (let k = 1; k < points.length; k++) {
        const a = points[k - 1];
        const b = points[k];
        const ms = tl.clock[b] - tl.clock[a];
        if (ms > T.stamp_gap_min * 60_000) {
          flags.push(flag('pattern', 'gap', 'Timestamp gap',
            `${fmtDuration(ms)} of writing (${clock(a)}–${clock(b)}) has no stamped checkpoint, so that stretch could have been produced elsewhere.`,
            [{ i: a, label: `Gap ${clock(a)}–${clock(b)}` }], BENIGN.gap));
        }
      }
    }
  }

  if (raw.untrusted.length) {
    flags.push(flag('pattern', 'untrusted', 'Untrusted input',
      `${raw.untrusted.length} script-generated input attempt${raw.untrusted.length === 1 ? ' was' : 's were'} refused; text injected by a script or extension rather than typed.`,
      raw.untrusted.slice(0, 5).map((u) => ({ i: u.i, label: `Refused at ${clock(u.i)}` })), BENIGN.untrusted));
  }

  {
    const odd = raw.largeInserts.filter((l) => {
      if (l.k === 'paste_in' || l.k === 'ime' || l.k === 'paste_src') return false;
      if (TYPING_TYPES.has(l.it)) return false;
      if (l.it === 'insertFromPaste' && A.config.policy.paste === 'allow') return false;
      return true;
    });
    if (odd.length) {
      flags.push(flag('pattern', 'unusual', 'Unusual input type',
        `${odd.length} insertion${odd.length === 1 ? '' : 's'} over ${T.unusual_insert_chars} characters arrived by ${[...new Set(odd.map((o) => o.label))].join(', ')}, a possible route around the paste block.`,
        odd.slice(0, 5).map((o) => ({ i: o.i, label: `${o.len} chars by ${o.label} at ${clock(o.i)}` })), BENIGN.unusual));
    }
  }

  {
    const hits = [];
    for (const pb of raw.pasteBlocked) {
      if (pb.len < T.paste_retype_min_chars) continue;
      const t0 = tl.abs[pb.i];
      const similar = (len) => Math.abs(len - pb.len) <= pb.len * T.paste_retype_tolerance;
      for (const r of A.raw.runs) {
        if (r.i0 <= pb.i || tl.abs[r.i0] - t0 > T.paste_retype_window_min * 60_000) continue;
        const len = [...r.stops, r.text.length].find(similar);
        if (len !== undefined) {
          hits.push({ pb, run: r, len });
          break;
        }
      }
    }
    if (hits.length) {
      flags.push(flag('pattern', 'retype', 'Paste, then retype',
        `A blocked paste of ${hits[0].pb.len} characters was followed within ${T.paste_retype_window_min} minutes by linear typing of similar length (${hits[0].len} characters).`,
        hits.flatMap((h) => [{ i: h.pb.i, label: `Blocked paste at ${clock(h.pb.i)}` }, { i: h.run.i0, label: `Typing starts at ${clock(h.run.i0)}` }]),
        BENIGN.retype));
    }
  }

  const transcriptionRuns = raw.runs.filter((r) => r.words >= T.transcription_words && r.revision < T.transcription_revision &&
    Number.isFinite(r.rateCv) && r.rateCv < T.transcription_rate_cv);
  if (transcriptionRuns.length) {
    const r = transcriptionRuns.reduce((a, b) => (b.words > a.words ? b : a));
    flags.push(flag('pattern', 'transcription', 'Transcription stretch',
      `${r.words} consecutive words with revision ratio ${r.revision.toFixed(2)}, no edits behind the cursor, and steady speed (variation ${r.rateCv.toFixed(2)}): consistent with copying from another screen.`,
      transcriptionRuns.slice(0, 5).map((x) => ({ i: x.i0, label: `${x.words} words from ${clock(x.i0)}`, run: x })), BENIGN.transcription));
  }

  if (raw.awayBursts.length >= T.away_burst_count) {
    flags.push(flag('pattern', 'away', 'Away, then burst',
      `${raw.awayBursts.length} times the window lost focus for ${T.away_seconds}+ seconds and then ${T.away_burst_words}+ words arrived with no pause over ${T.away_burst_pause_s} seconds.`,
      raw.awayBursts.slice(0, 5).map((b) => ({ i: b.i, label: `${b.words} words after ${fmtDuration(b.awayMs)} away, ${clock(b.i)}` })), BENIGN.away));
  }

  // Class-relative flags switch on only above the minimum class size.
  const classOn = cohort.length >= T.min_class_size;
  if (classOn) {
    const mpw = cohort.map((c) => c.metrics.minutesPerWord).filter(Number.isFinite);
    const cut = percentile(mpw, T.fast_percentile);
    if (Number.isFinite(A.metrics.minutesPerWord) && A.metrics.minutesPerWord <= cut) {
      flags.push(flag('pattern', 'fast', 'Too fast for the length',
        `${fmtDuration(A.metrics.activeMin * 60_000)} of active writing for ${A.metrics.words} words is in the bottom ${T.fast_percentile}% of the class (${cohort.length} submissions).`,
        [{ i: 0, label: 'Start of writing' }], BENIGN.fast));
    }
    const others = cohort.filter((c) => c !== A).map((c) => c.metrics.ikiCv).filter(Number.isFinite);
    const { mean, sd } = meanSd(others);
    const x = A.metrics.ikiCv;
    if (Number.isFinite(x) && others.length && sd > 0 && x < mean - T.rhythm_z * sd && x < Math.min(...others)) {
      flags.push(flag('pattern', 'rhythm', 'Machine-regular rhythm',
        `Keystroke timing variation ${x.toFixed(2)} vs. a class average of ${mean.toFixed(2)}: more uniform than anyone else's in the class.`,
        [{ i: 0, label: 'Start of writing' }], BENIGN.rhythm));
    }
  }

  const prompts = buildPrompts(A, flags);
  const classStats = A.signals.map((s) => ({
    id: s.id,
    values: cohort.map((c) => c.signals.find((x) => x.id === s.id).metric).filter(Number.isFinite),
    priors: priors.map((p) => ({ title: p.config.title, value: p.signals.find((x) => x.id === s.id).metric })),
  }));
  return { ...A, flags, prompts, classStats, classOn, cohortSize: cohort.length };
}

function buildPrompts(A, flags) {
  const { raw, tl, events } = A;
  const clock = (i) => fmtClock(tl.clock[Math.max(0, Math.min(i, events.length - 1))]);
  const prompts = [];
  const used = new Set();
  const add = (p) => {
    if (prompts.length >= 5 || used.has(p.i) || p.i == null) return;
    used.add(p.i);
    prompts.push(p);
  };

  // Flagged moments first.
  for (const f of flags) {
    if (f.kind !== 'pattern') continue;
    const m = f.moments[0];
    if (!m) continue;
    let q;
    if (f.id === 'transcription') q = `This section ("${snippet(m.run.text)}") went in at ${clock(m.i)} with almost no changes. Did you plan it somewhere else first?`;
    else if (f.id === 'away') q = `At ${clock(m.i)} you came back to the window and wrote without stopping. What were you looking at just before?`;
    else if (f.id === 'retype') q = `At ${clock(m.i)} you tried to paste a passage, then typed one of about the same length. Where was that text from?`;
    else if (f.id === 'unusual') q = `At ${clock(m.i)} a long stretch of text arrived in one go (${m.label.split(' at ')[0]}). How did you enter that part?`;
    else if (f.id === 'gap') q = `The timestamps stop during ${m.label.replace('Gap ', '')}. What happened during that stretch?`;
    else if (f.id === 'untrusted') q = `At ${clock(m.i)} something other than the keyboard tried to change the text. Do you use any browser extensions while writing?`;
    else if (f.id === 'fast') q = 'You wrote this quickly for its length. Walk me through how you prepared before you started typing.';
    else if (f.id === 'rhythm') q = 'Your typing rhythm is unusually even. Tell me about how you typed this one: one sitting, any tools?';
    if (q) add({ i: m.i, title: f.title, question: q, flagged: true });
  }

  // 1. Largest deletion (not counting text that was cut only to be pasted elsewhere).
  const pasted = new Set(events.filter((e) => e.k === 'paste_in').map((e) => (e.x || '').trim()));
  const del = raw.delEpisodes.filter((d) => d.text.trim().length >= 30 && !pasted.has(d.text.trim()))
    .sort((a, b) => b.text.length - a.text.length)[0];
  if (del) {
    const w = countWords(del.text);
    add({
      i: del.i, title: 'Largest deletion',
      question: `At ${clock(del.i)} you cut ${w} word${w === 1 ? '' : 's'} from your ${ordinal(del.para)} paragraph ("${snippet(del.text, 6)}"). What was wrong with it?`,
    });
  }

  // 2. Longest pause before a structural change.
  const st = raw.structural.filter((s) => s.pause >= 30_000).sort((a, b) => b.pause - a.pause)[0];
  if (st) {
    add({
      i: st.i, title: 'Longest pause before a structural change',
      question: `You stopped for ${fmtDuration(st.pause)}, then ${st.what}. What were you thinking about?`,
    });
  }

  // 3. A moved paragraph.
  const cuts = raw.delEpisodes.filter((d) => d.text.trim().length >= 40);
  let moved = null;
  for (const e of events) {
    if (e.k !== 'paste_in' || isSrc(e) || (e.x || '').trim().length < 40) continue;
    const from = cuts.find((c) => c.endI < e.s && c.text.trim() === e.x.trim());
    if (from && (!moved || e.x.length > moved.e.x.length)) moved = { e, from };
  }
  if (moved) {
    const dir = moved.e.p < moved.from.p ? 'earlier' : 'later';
    add({
      i: moved.e.s, title: 'A moved passage',
      question: `At ${clock(moved.e.s)} you moved "${snippet(moved.e.x, 6)}" ${dir} in the piece. Why does it work better there?`,
    });
  }

  // 4. A source integration.
  const quote = events.find((e) => e.k === 'paste_in' && e.from === 'src' && (e.x || '').length >= 20);
  if (quote) {
    add({
      i: quote.s, title: 'A source integration',
      question: `You pasted this quote ("${snippet(quote.x, 6)}") at ${clock(quote.s)}. Walk me through how you decided where it goes.`,
    });
  } else if (raw.srcPastes.length) {
    const sp = raw.srcPastes[0];
    add({
      i: sp.i, title: 'A source',
      question: `At ${clock(sp.i)} you added "${snippet(sp.x, 6)}" to your sources. How did it shape what you wrote?`,
    });
  }

  // 5. The flattest stretch.
  const flat = raw.runs.filter((r) => r.words >= 60 && r.revision < 0.1).sort((a, b) => b.words - a.words)[0];
  if (flat) {
    add({
      i: flat.i0, title: 'The flattest stretch',
      question: `This section ("${snippet(flat.text)}") went in with almost no changes. Did you plan it somewhere else first?`,
    });
  }

  // Top up to three with the longest pauses if the piece offered few natural moments.
  const longPauses = raw.pauses.slice().sort((a, b) => b.ms - a.ms);
  for (const p of longPauses) {
    if (prompts.length >= 3) break;
    add({
      i: p.i, title: 'A long pause',
      question: `At ${clock(p.i)} you stopped for ${fmtDuration(p.ms)} before carrying on. What were you deciding?`,
    });
  }
  return prompts;
}

// ---------- replay rendering support ----------

// State after event i, with the index of the event that inserted each recent character.
// Characters inserted before `since` get origin -1.
export function stateAt(A, i, since = i - 40) {
  const { snapshots, events } = A;
  const from = Math.max(-1, Math.min(i, since));
  let snap = null;
  for (const s of snapshots) {
    if (s.i <= from) snap = s;
    else break;
  }
  const doc = snap ? snap.doc.clone() : new DocModel();
  let src = snap ? snap.src : '';
  const origin = new Array(doc.text.length).fill(-1);
  for (let k = snap ? snap.i + 1 : 0; k <= i && k < events.length; k++) {
    const e = events[k];
    try {
      if (isText(e) && isSrc(e)) src = applyOp(src, e);
      else if (isText(e)) {
        doc.apply(e);
        origin.splice(e.p, e.n || 0, ...new Array((e.x || '').length).fill(k));
      } else if (isFormatEvent(e) && !isSrc(e)) doc.apply(e);
    } catch {
      break;
    }
  }
  return { text: doc.text, doc, src, origin };
}
