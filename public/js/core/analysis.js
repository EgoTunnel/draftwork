// Viewer analysis: integrity checks (layer 1), flags (2), process signals (3), conversation prompts (4).
// Flags are listed separately and are never combined into a score.
import { canonical, sha256Hex } from './canon.js';
import {
  applyOp, isText, isSrc, eventsHash, checkpointHash, chainSeed, thresholdsFor, countWords,
} from './format.js';
import { DocModel, isFormatEvent } from './doc.js';
import { verifyToken } from './tsa.js';
import { anchorsFor } from './trust.js';

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
  if (h < 48) return `${h} h ${m % 60} min`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

export function snippet(text, words = 8) {
  const w = String(text).replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').split(' ');
  return w.slice(0, words).join(' ') + (w.length > words ? '…' : '');
}

// A run of typing may start with a short title line; quote from the first real paragraph.
const bodyOf = (t) => String(t).split('\n').find((l) => l.trim().length >= 40 && /[.!?]["”’)]?\s|[.!?]["”’)]?$/.test(l.trim())) || t;

// [start, end] of the first paragraph long enough to be the opening (skipping a title).
function openingSpan(text) {
  let a = 0;
  while (a < text.length) {
    let b = text.indexOf('\n', a);
    if (b < 0) b = text.length;
    if (b - a >= 150) return [a, b];
    a = b + 1;
  }
  return null;
}

const ORDINALS =['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
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
  const charOrigin = [];
  let replayError = null;
  let replayErrorAt = null;
  let curI = 0;
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
  const openingVisits = [];
  let inOpeningPrev = false;
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
      curI = i;
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

          // returns to the opening paragraph once the draft has moved well past it
          {
            const op = openingSpan(text);
            const inOpening = !!op && e.p >= op[0] && e.p <= op[1] && text.length - op[1] >= 600;
            if (inOpening && !inOpeningPrev) openingVisits.push({ i, len: text.length });
            inOpeningPrev = inOpening;
          }

          if (x.length > T.unusual_insert_chars) largeInserts.push({ i, len: x.length, k: e.k, it: e.it, from: e.from, label: inputLabel(e, config.policy) });

          textEvents++;
          if (behindCurrentSentence(text, e.p)) behindEvents++;

          const end = restBlank(text, e.p + n);
          model.apply(e);
          text = model.text;
          atEnd.splice(e.p, n, ...new Array(x.length).fill(end));
          // Which event wrote each character (negative: quoted from the sources panel).
          charOrigin.splice(e.p, n, ...new Array(x.length).fill(e.k === 'paste_in' && e.from === 'src' ? -1 - i : i));
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
    replayErrorAt = curI;
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
      srcPastes, openingVisits, textEvents, behindEvents, typed, deletedChars, atEnd, active, charOrigin,
    },
  };

  A.integrity = await integrityChecks(A, { replayError, replayErrorAt, problems, cpEnds, expectedConfigHash, knownConfigHashes });
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

async function integrityChecks(A, { replayError, replayErrorAt, problems, cpEnds, expectedConfigHash, knownConfigHashes }) {
  const { file, events, tl, T } = A;
  const checks = [];
  const N = events.length;
  const at = (i) => Math.max(0, Math.min(i, N - 1));
  const whenRange = (a, b) => {
    const day = new Date(tl.abs[at(a)]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${fmtClock(tl.clock[at(a)])}–${fmtClock(tl.clock[at(b)])} of writing time (from ${day})`;
  };

  // 1. replay reproduces final_text
  {
    const finalHash = await sha256Hex(file.final.text);
    let status = 'pass';
    let detail = `${N.toLocaleString()} edits replay to the submitted text exactly.`;
    let explain = null;
    if (replayError) {
      status = 'fail';
      detail = 'The recorded edits can’t be replayed.';
      explain = {
        title: 'Edit history is broken',
        text: 'Replaying the recorded edits fails partway through: one edit refers to part of the document that doesn’t exist. Files saved by Draftwork always replay cleanly, so this one was altered or damaged after it was written.',
        technical: replayError, i: replayErrorAt,
      };
    } else if (A.replayText !== file.final.text) {
      status = 'fail';
      const d = firstDiff(A.replayText, file.final.text);
      // Show both versions from a word boundary a little before the first difference.
      let s = Math.max(0, d - 30);
      if (s > 0) s = A.replayText.indexOf(' ', s) + 1 || s;
      if (s > d) s = d;
      const around = (t) => {
        if (s >= t.length) return '(nothing)';
        const out = (s > 0 ? '…' : '') + t.slice(s, d + 30).replace(/\s+/g, ' ') + (d + 30 < t.length ? '…' : '');
        return `“${out}”`;
      };
      const where = file.final.text.length ? Math.round((d / file.final.text.length) * 100) : 0;
      detail = 'The submitted text isn’t what the recorded edits produce.';
      explain = {
        title: 'Submitted text doesn’t match its history',
        text: `Replaying every recorded edit doesn’t give the text that was submitted. They first differ ${where <= 5 ? 'right at the start' : `about ${where}% of the way through`}: the submitted text reads ${around(file.final.text)}, but the edit history gives ${around(A.replayText)}. Files saved by Draftwork always match, so the submitted text or its history was changed by hand after writing.`,
        technical: `First difference at character ${d}.`,
      };
      // The edit that wrote that spot in the replayed text.
      const o = A.raw.charOrigin[Math.min(d, A.raw.charOrigin.length - 1)];
      if (o != null) explain.i = o < 0 ? -1 - o : o;
    } else if (finalHash !== file.final.hash) {
      status = 'fail';
      detail = 'The submitted text no longer matches its fingerprint.';
      explain = { title: 'Submitted text was altered', text: 'The submitted text no longer matches the fingerprint saved with it, so it was changed after the file was saved.' };
    } else if (canonical(A.replayFormat) !== canonical(file.final.format || null)) {
      status = 'fail';
      detail = 'The words match, but the formatting doesn’t.';
      explain = { title: 'Formatting was altered', text: 'The words match the edit history, but the formatting stored with the submission (styles, fonts, footnotes and so on) differs from what the edits produce, so it was changed after writing.' };
    }
    checks.push({
      id: 'replay', label: 'Edit history rebuilds the submitted text', status, detail, explain,
      tip: 'Replaying every recorded edit from an empty page must produce exactly the submitted document.',
    });
  }

  // 2. checkpoint chain
  A.cpHashes = [];
  {
    // Technical notes for the details line, and structured issues for the plain explanation.
    const errs = [];
    const issues = { missing: false, changed: [], docOff: [], seed: false, relinked: [], uncovered: 0, none: false, order: [] };
    if (problems.seq.length) {
      errs.push(`event sequence numbers skip or repeat (first at ${problems.seq[0]})`);
      issues.missing = true;
    }
    let prev = await chainSeed(file.assignment.config_hash, file.header);
    let expectStart = 0;
    for (let k = 0; k < file.checkpoints.length; k++) {
      const cp = file.checkpoints[k];
      if (cp.c !== k) {
        errs.push(`checkpoint ${k} is numbered ${cp.c}`);
        issues.order.push(k);
      }
      if (!Array.isArray(cp.range) || cp.range[0] !== expectStart || cp.range[1] < cp.range[0]) {
        errs.push(`checkpoint ${k} does not continue from event ${expectStart}`);
        issues.order.push(k);
        break;
      }
      const slice = events.slice(cp.range[0], cp.range[1] + 1);
      if (slice.length !== cp.range[1] - cp.range[0] + 1) {
        errs.push(`checkpoint ${k} covers events that are missing`);
        issues.missing = true;
      } else if (await eventsHash(slice) !== cp.events_hash) {
        errs.push(`events in checkpoint ${k} were changed`);
        issues.changed.push(cp.range);
      }
      const docAt = cpEnds.get(cp.range[1]);
      if (docAt == null || await sha256Hex(docAt) !== cp.doc_hash) {
        errs.push(`document at checkpoint ${k} does not match the replay`);
        issues.docOff.push(cp.range);
      }
      if (cp.prev !== prev) {
        errs.push(`checkpoint ${k} does not link to the one before it`);
        if (k === 0) issues.seed = true;
        else issues.relinked.push(k);
      }
      prev = await checkpointHash(cp);
      A.cpHashes.push(prev);
      expectStart = cp.range[1] + 1;
    }
    if (expectStart < N && file.checkpoints.length) {
      errs.push(`${N - expectStart} events after the last checkpoint are not covered`);
      issues.uncovered = N - expectStart;
    }
    if (!file.checkpoints.length && N) {
      errs.push('there are no checkpoints');
      issues.none = true;
    }

    const SEALS = 'As a student writes, Draftwork seals the edit history in blocks of about a minute and timestamps each seal.';
    let explain = null;
    if (issues.missing) {
      explain = { title: 'Edits are missing from the history', text: 'Draftwork numbers every edit as it is recorded. Some numbers are skipped or repeated, so edits were removed from, or added to, the history afterwards.' };
    } else if (issues.changed.length || issues.docOff.length) {
      // Edits changed in one block make every later document differ too; describe the cause.
      const blocks = issues.changed.length ? issues.changed : issues.docOff;
      const [a, b] = blocks[0];
      const more = blocks.length - 1;
      const knock = issues.docOff.some((r) => r[0] > a);
      explain = {
        title: 'Edit history was changed after it was recorded',
        text: `${SEALS} The edits recorded during ${whenRange(a, b)} no longer match their seal${more ? `, and neither ${more === 1 ? 'does 1 other block' : `do ${more} other blocks`}` : ''}, so they were changed after they were recorded.${knock ? ' Everything written after that point no longer matches its seals either, because it builds on the changed edits.' : ''}`,
        i: a,
      };
    } else if (issues.seed && !issues.relinked.length && !issues.order.length) {
      explain = { title: 'Student name or start time was changed', text: 'The sealed history is tied to the student’s name and the time the file was started. They no longer match, so the name or start time in the file was edited, for example to hand in someone else’s work under another name.' };
    } else if (issues.order.length || issues.relinked.length || issues.seed) {
      explain = { title: 'Parts of the history were removed or rearranged', text: `${SEALS} Each seal is linked to the one before it, and those links are broken, so sealed parts of the history were removed, reordered or replaced.` };
    } else if (issues.uncovered) {
      explain = { title: 'The end of the history isn’t sealed', text: `The last ${issues.uncovered.toLocaleString()} edits aren’t covered by any seal. Draftwork seals everything when it saves a file, so these edits were added to the file afterwards.`, i: N - issues.uncovered };
    } else if (issues.none) {
      explain = { title: 'The history has no seals', text: 'Draftwork seals and timestamps the history as students write. This file has none, so it wasn’t produced by Draftwork’s writing page.' };
    }
    if (explain) explain.technical = cap(errs.slice(0, 4).join('; ')) + '.';
    checks.push({
      id: 'chain',
      label: 'History has not been edited',
      tip: 'The checkpoint chain is unbroken, and the document at every checkpoint matches the replay.',
      status: errs.length ? 'fail' : 'pass',
      explain,
      detail: errs.length ? explain.title + '.'
        : file.checkpoints.length === 1 ? '1 sealed block, matching the replay.' : `${file.checkpoints.length} sealed blocks, all linked and matching.`,
    });
  }

  // 3. assignment config
  {
    const actual = await sha256Hex(canonical(file.assignment.config));
    let status;
    let detail;
    let explain = null;
    if (actual !== file.assignment.config_hash) {
      status = 'fail';
      detail = 'The assignment settings in the file were changed after writing.';
      explain = { title: 'Assignment settings were changed', text: 'The assignment’s settings stored in the file (such as whether pasting was allowed) were edited after writing, for example to make it look as if pasting had been permitted.' };
    } else if (expectedConfigHash) {
      status = actual === expectedConfigHash ? 'pass' : 'fail';
      detail = status === 'pass' ? `“${file.assignment.config.title}”` : 'Written for a different assignment.';
      if (status === 'fail') explain = { title: 'Written for a different assignment', text: `This file was written for “${file.assignment.config.title}”, not for this assignment.` };
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
      id: 'config', label: 'Written for this assignment', status, detail, explain,
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
      detail: errs.length ? 'The recorded times are impossible.' : `${S.length} session${S.length === 1 ? '' : 's'}, in order.`,
      explain: errs.length ? {
        title: 'Recorded times are impossible',
        text: 'The times recorded for the edits go backwards, or two writing sessions overlap. That can’t happen while writing normally, so the times in the file were edited.',
        technical: cap(errs.slice(0, 3).join('; ')) + '.',
      } : null,
    });
  }

  // 5. TSA tokens
  A.stamps = [];
  const anchors = anchorsFor(A.config);
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
        const v = await verifyToken(cp.tsa, hash, { anchors, allowDemo: !!A.config.allow_demo_tsa });
        st.ok = v.ok;
        st.genTime = v.genTime;
        st.signer = v.signer;
        if (v.signer) signers.add(v.anchor ? `${v.signer} (${v.anchor})` : v.signer);
        if (v.demo) demo = true;
        if (!v.ok) {
          const msg = v.errors[0];
          if (!errs.some((e) => e.endsWith(msg))) errs.push(`checkpoint ${k}: ${msg}`);
        }
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
    let explain = null;
    if (errs.length) {
      const e = errs[0];
      let text;
      if (/not an approved timestamp service/.test(e)) {
        text = `The timestamps in this file come from a service Draftwork doesn’t accept (“${[...signers][0] || 'unknown'}”). Real timestamps come from known public services, so these were most likely made by someone running their own service to backdate a history.`;
      } else if (/demo timestamp service/.test(e)) {
        text = 'The file was timestamped by Draftwork’s test service, which this assignment doesn’t accept. The student may have written in a test copy of Draftwork or used the wrong link; ask how they opened the assignment.';
      } else if (/before the time its events claim/.test(e)) {
        text = 'A timestamp shows a time earlier than the writing it covers, which is impossible, so the recorded times were edited.';
      } else if (/time-stamping certificate|valid at the stamp time/.test(e)) {
        text = 'A timestamp was signed with a certificate that isn’t valid for timestamping at that time, so it can’t vouch for when the writing happened.';
      } else {
        text = 'A timestamp doesn’t match the part of the history it’s attached to, so either the history or its timestamps were edited.';
      }
      explain = { title: 'Timestamps don’t check out', text, technical: cap(errs.slice(0, 3).join('; ')) + '.' };
    }
    const bits = [];
    if (errs.length) bits.push(`${explain.title}.`);
    else if (stamped) bits.push(`${stamped} verified, from ${[...signers].join(', ')}.`);
    if (demo && !errs.length) bits.push('Demo timestamps: accepted because this is a test assignment.');
    if (missing) bits.push(`${missing} not stamped.`);
    if (late) bits.push(`${late} stamped late.`);
    checks.push({
      id: 'tsa',
      label: 'Timestamps are verified',
      tip: 'Each checkpoint carries an RFC 3161 timestamp from an outside service. Each must be signed by an approved timestamp service (verified up to a pinned certificate authority), and its time must match the recorded times.',
      status,
      explain,
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
      transcription: 'Leaving the window, then writing quickly, again and again', benign: 'Checking notes or sources in another tab',
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

// ---------- shared passages between submissions ----------

const SHINGLE = 8;

// Normalised words of the final text with their character offsets. Words quoted from the
// sources panel are marked, so two students quoting the same source don't count as overlap.
function wordsOf(A) {
  if (A._words) return A._words;
  const text = A.file.final.text;
  const origin = A.raw.charOrigin;
  const words = [];
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!w) continue;
    const o = origin[m.index];
    words.push({ w, at: m.index, quote: o != null && o < 0, ev: o == null ? 0 : o < 0 ? -1 - o : o });
  }
  const index = new Map();
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    const key = words.slice(i, i + SHINGLE).map((x) => x.w).join(' ');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(i);
  }
  A._words = { words, index };
  return A._words;
}

// Longest runs of identical (non-quoted) words shared by A and B, at least `min` words long.
export function sharedPassages(A, B, min) {
  const a = wordsOf(A);
  const b = wordsOf(B);
  const runs = [];
  for (let i = 0; i + SHINGLE <= a.words.length; i++) {
    const key = a.words.slice(i, i + SHINGLE).map((x) => x.w).join(' ');
    const hitsB = b.index.get(key);
    if (!hitsB) continue;
    let best = 0;
    for (const j of hitsB) {
      let n = 0;
      while (i + n < a.words.length && j + n < b.words.length && a.words[i + n].w === b.words[j + n].w &&
        !a.words[i + n].quote && !b.words[j + n].quote) n++;
      best = Math.max(best, n);
    }
    if (best >= min) {
      const text = A.file.final.text.slice(a.words[i].at, a.words[i + best - 1].at + 40).split(/\s+/).slice(0, best).join(' ');
      runs.push({ words: best, at: a.words[i].at, ev: a.words[i].ev, text });
      i += best - 1;
    }
  }
  return runs;
}

// ---------- layer 2 and 4 ----------

const BENIGN = {
  integrity: ['A fault in Draftwork itself. It’s rare, but talk with the student before drawing conclusions, and ask whether they opened or saved the file in another program.'],
  gap: ['The internet connection dropped while they wrote', 'The laptop went to sleep with the page open', 'The timestamp service was briefly down'],
  untrusted: ['A browser extension (grammar checker, translator, password manager) tried to change the text. Nothing it tried went in.'],
  unusual: ['Dictation or a keyboard for another language, in a browser Draftwork doesn’t fully recognise', 'Autocorrect replacing a long stretch of text'],
  retype: ['They tried to paste their own notes or outline from another file, then typed them in', 'The lengths matched by coincidence'],
  transcription: ['Writing from a detailed outline', 'Drafted on paper first and typed it up', 'A fluent typist writing about familiar material', 'A confident writer who revises in their head'],
  away: ['Checking notes or sources in another tab', 'Reading the prompt or rubric in another window'],
  fast: ['A fast writer', 'Drafted on paper first, or planned it in detail', 'Dictation through software Draftwork didn’t recognise as dictation'],
  rhythm: ['A weak signal on its own: some practised typists are very regular', 'Typing up their own handwritten draft'],
  quotes: ['An assignment built around close reading or analysis of a text', 'Long block quotations the assignment asked for'],
  overlap: ['Both quoted the same source without using the sources panel', 'Wording from the assignment prompt or class notes', 'Collaboration the assignment allowed'],
  speed: ['A very fast typist (competitive typists can reach 150+ words a minute for short stretches)', 'Dictation software that types rather than using the browser’s own dictation'],
  pastes: ['Habit: pressing Ctrl+V for their own notes or outline', 'They didn’t realise pasting was turned off and kept trying'],
};

// reason: plain description. detail: the measurements and thresholds behind it, shown smaller.
function flag(kind, id, title, reason, moments, benign, detail) {
  return { kind, id, title, reason, detail: detail || '', moments: moments || [], benign: benign || [] };
}

const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const times = (n) => (n === 1 ? 'Once' : n === 2 ? 'Twice' : `${n} times`);

// Combines one analysis with its class and the student's earlier files.
// cohort: all analyses for the same assignment (including A). priors: the same student's earlier files.
export function finalize(A, { cohort = [A], priors = [] } = {}) {
  const { T, raw, tl, events } = A;
  const flags = [];
  const clock = (i) => fmtClock(tl.clock[Math.max(0, Math.min(i, events.length - 1))]);

  for (const c of A.integrity) {
    if (c.status !== 'fail') continue;
    const x = c.explain || { title: c.label, text: c.detail };
    const moments = x.i != null && events.length ? [{ i: Math.min(x.i, events.length - 1), label: `Where it starts, ${clock(x.i)}` }] : [];
    flags.push(flag('integrity', 'integrity-' + c.id, x.title, x.text, moments, BENIGN.integrity,
      `Failed check: ${c.label.toLowerCase()}.${x.technical ? ` ${x.technical}` : ''}`));
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
          flags.push(flag('pattern', 'gap', 'Stretch without timestamps',
            `For ${fmtDuration(ms)} of writing (${clock(a)}–${clock(b)} of writing time), no timestamps were recorded. Timestamps are what show when the writing happened, so in principle this part could have been written earlier or elsewhere and added to the file.`,
            [{ i: a, label: `Gap ${clock(a)}–${clock(b)}` }], BENIGN.gap,
            `Flagged when more than ${T.stamp_gap_min} minutes of writing pass between on-time timestamps.`));
        }
      }
    }
  }

  if (raw.untrusted.length) {
    const n = raw.untrusted.length;
    flags.push(flag('pattern', 'untrusted', 'Text inserted by a program',
      `${times(n)}, something other than the keyboard (a script, auto-typing tool or browser extension) tried to put text into the essay. Draftwork refused it${n === 1 ? '' : ' each time'}, so none of that text is in the submission.`,
      raw.untrusted.slice(0, 5).map((u) => ({ i: u.i, label: `Refused at ${clock(u.i)}` })), BENIGN.untrusted,
      `Input events the browser marked as not coming from the user: ${[...new Set(raw.untrusted.map((u) => u.it).filter(Boolean))].join(', ') || 'unknown type'}.`));
  }

  // Many refused pastes: the student had text from elsewhere they wanted in the essay.
  if (raw.pasteBlocked.length >= T.paste_attempts) {
    const total = raw.pasteBlocked.reduce((a, b) => a + b.len, 0);
    const longest = raw.pasteBlocked.reduce((a, b) => (b.len > a.len ? b : a));
    flags.push(flag('pattern', 'pastes', 'Repeated paste attempts',
      `The student tried to paste text from outside Draftwork ${raw.pasteBlocked.length} times (${plural(total, 'character')} in all, the longest ${plural(longest.len, 'character')}). Pasting is turned off for this assignment, so none of it went in, but it shows they had text from elsewhere they wanted to use. It’s worth asking what it was.`,
      raw.pasteBlocked.slice().sort((a, b) => b.len - a.len).slice(0, 5).map((p) => ({ i: p.i, label: `${plural(p.len, 'character')} at ${clock(p.i)}` })),
      BENIGN.pastes, `Flagged at ${T.paste_attempts} or more blocked pastes.`));
  }

  {
    const odd = raw.largeInserts.filter((l) => {
      if (l.k === 'paste_in' || l.k === 'ime' || l.k === 'paste_src') return false;
      if (TYPING_TYPES.has(l.it)) return false;
      if (l.it === 'insertFromPaste' && A.config.policy.paste === 'allow') return false;
      return true;
    });
    if (odd.length) {
      const biggest = odd.reduce((a, b) => (b.len > a.len ? b : a));
      flags.push(flag('pattern', 'unusual', 'Large text entered in one go',
        `${times(odd.length)}, a block of text (up to ${plural(biggest.len, 'character')}) appeared all at once instead of being typed, by ${[...new Set(odd.map((o) => o.label))].join(', ')}. People don’t normally enter that much text in one action, so this may have been a way around the paste block.`,
        odd.slice(0, 5).map((o) => ({ i: o.i, label: `${o.len} chars by ${o.label} at ${clock(o.i)}` })), BENIGN.unusual,
        `Single insertions over ${T.unusual_insert_chars} characters that weren’t typing, dictation, or an allowed paste.`));
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
      const h0 = hits[0];
      flags.push(flag('pattern', 'retype', 'Tried to paste, then typed the same amount',
        `At ${clock(h0.pb.i)} the student tried to paste ${plural(h0.pb.len, 'character')}, which was blocked. ${fmtDuration(Math.max(1000, tl.abs[h0.run.i0] - tl.abs[h0.pb.i]))} later they typed a passage of almost the same length (${plural(h0.len, 'character')}) straight through. That can mean they retyped the text they couldn’t paste.`,
        hits.flatMap((h) => [{ i: h.pb.i, label: `Blocked paste at ${clock(h.pb.i)}` }, { i: h.run.i0, label: `Typing starts at ${clock(h.run.i0)}` }]),
        BENIGN.retype,
        `A blocked paste of ${T.paste_retype_min_chars}+ characters, followed within ${T.paste_retype_window_min} minutes by uninterrupted typing within ${Math.round(T.paste_retype_tolerance * 100)}% of its length.${hits.length > 1 ? ` Happened ${hits.length} times.` : ''}`));
    }
  }

  const transcriptionRuns = raw.runs.filter((r) => r.words >= T.transcription_words && r.revision < T.transcription_revision &&
    Number.isFinite(r.rateCv) && r.rateCv < T.transcription_rate_cv);
  if (transcriptionRuns.length) {
    const r = transcriptionRuns.reduce((a, b) => (b.words > a.words ? b : a));
    flags.push(flag('pattern', 'transcription', 'Typed straight through, like copying',
      `${r.words} words (“${snippet(bodyOf(r.text), 6)}”) were typed in one go at a very steady speed, with almost no corrections and without going back to change anything. That’s typical of copying text from another screen or a printout; working out ideas while writing usually brings pauses and changes.${transcriptionRuns.length > 1 ? ` There ${transcriptionRuns.length === 2 ? 'is 1 other stretch' : `are ${transcriptionRuns.length - 1} other stretches`} like it.` : ''}`,
      transcriptionRuns.slice(0, 5).map((x) => ({ i: x.i0, label: `${x.words} words from ${clock(x.i0)}`, run: x })), BENIGN.transcription,
      `Corrections ${r.revision.toFixed(2)} (deleted ÷ typed; flagged below ${T.transcription_revision}); speed variation ${r.rateCv.toFixed(2)} (below ${T.transcription_rate_cv}); at least ${T.transcription_words} words.`));
  }

  if (raw.awayBursts.length >= T.away_burst_count) {
    flags.push(flag('pattern', 'away', 'Left the window, then wrote quickly',
      `${raw.awayBursts.length} times the student switched to another window or tab, came back, and then wrote a block of text (${T.away_burst_words}+ words) without stopping to think. That can mean reading text somewhere else and typing it in.`,
      raw.awayBursts.slice(0, 5).map((b) => ({ i: b.i, label: `${b.words} words after ${fmtDuration(b.awayMs)} away, ${clock(b.i)}` })), BENIGN.away,
      `Away for ${T.away_seconds}+ seconds, then ${T.away_burst_words}+ words with no pause over ${T.away_burst_pause_s} seconds; flagged at ${T.away_burst_count} or more times.`));
  }

  // Dictation is legitimately faster than typing, so speed flags don't apply to mostly dictated text.
  let dictated = 0;
  for (const o of raw.charOrigin) if (o >= 0 && events[o] && events[o].k === 'ime') dictated++;
  const mostlyDictated = !!A.header.dictation_mode || dictated > 0.3 * (raw.charOrigin.length || 1);

  // Sustained speed beyond human typing.
  if (!mostlyDictated) {
    const fast = raw.bursts.filter((b) => b.chars >= T.speed_chars && b.rate / 5 >= T.speed_wpm);
    if (fast.length) {
      const top = fast.reduce((a, b) => (b.rate > a.rate ? b : a));
      flags.push(flag('pattern', 'speed', 'Typing faster than people type',
        `${fast.length === 1 ? 'A stretch' : `${fast.length} stretches`} of typing ran at up to ${Math.round(top.rate / 5)} words a minute without a pause. Most people type 30–60 words a minute and very fast typists about 100, so speeds like this usually mean a program typed the text, or it was entered by something other than the keyboard.`,
        fast.slice(0, 5).map((b) => ({ i: b.i0, label: `${Math.round(b.rate / 5)} words a minute, ${b.chars} chars at ${clock(b.i0)}` })), BENIGN.speed,
        `Stretches of ${T.speed_chars}+ characters between pauses at ${T.speed_wpm}+ words a minute (5 characters a word).`));
    }
  }

  // Text moved into the essay from the sources panel is a quote; a lot of it, or one very long
  // passage, is how outside text could be brought in while pasting is blocked.
  {
    const origin = raw.charOrigin;
    const text = A.file.final.text;
    let quoted = 0;
    for (let j = 0; j < origin.length; j++) if (origin[j] < 0 && !/\s/.test(text[j])) quoted++;
    const nonSpace = text.replace(/\s/g, '').length || 1;
    const share = quoted / nonSpace;
    const longest = events.filter((e) => e.k === 'paste_in' && e.from === 'src').sort((a, b) => (b.x || '').length - (a.x || '').length)[0];
    const longLen = longest ? (longest.x || '').length : 0;
    if (share > T.quote_share || longLen > T.quote_chars) {
      const why = share > T.quote_share
        ? `${Math.round(share * 100)}% of the submitted text was pasted in from the sources panel`
        : `One passage of ${plural(longLen, 'character')} (about ${Math.round(longLen / 6)} words) was pasted in from the sources panel`;
      flags.push(flag('pattern', 'quotes', 'Heavy quoting',
        `${why}. Quoting is fine, but students can paste anything into the sources panel, so this is also a way to bring in text from elsewhere while pasting is blocked. Check that it reads as quotation.`,
        longest ? [{ i: longest.s, label: `${longLen.toLocaleString()}-character quote at ${clock(longest.s)}` }] : [], BENIGN.quotes,
        `Flagged when over ${Math.round(T.quote_share * 100)}% of the text is quoted, or one quote is over ${T.quote_chars} characters. Quoted: ${Math.round(share * 100)}%; longest quote ${longLen} characters.`));
    }
  }

  // Long passages that also appear in another student's submission for this assignment.
  {
    const me = String(A.header.student_label || '').trim().toLowerCase();
    const found = [];
    for (const B of cohort) {
      if (B === A || String(B.header.student_label || '').trim().toLowerCase() === me) continue;
      for (const run of sharedPassages(A, B, T.overlap_words)) found.push({ ...run, other: B.header.student_label || 'another student' });
    }
    if (found.length) {
      found.sort((x, y) => y.words - x.words);
      const others = [...new Set(found.map((f) => f.other))];
      flags.push(flag('pattern', 'overlap', 'Same wording as another student',
        `A passage of ${found[0].words} words (“${snippet(found[0].text, 8)}”) appears word for word in ${others.length === 1 ? `${others[0]}’s submission` : `the submissions of ${others.join(', ')}`}. Students rarely write that many identical words in a row independently.`,
        found.slice(0, 5).map((f) => ({ i: f.ev, label: `${f.words} words shared with ${f.other}`, text: f.text })), BENIGN.overlap,
        `Flagged at ${T.overlap_words}+ identical words in a row with another submission for this assignment. Quotes from the sources panel aren’t counted.`));
    }
  }

  // Class-relative flags switch on only above the minimum class size.
  const classOn = cohort.length >= T.min_class_size;
  if (classOn) {
    // Medians and the median absolute deviation, so that several outliers in one class
    // (say, a few students using the same tool) don't hide each other.
    const mpw = cohort.map((c) => c.metrics.minutesPerWord).filter(Number.isFinite);
    const cut = percentile(mpw, T.fast_percentile);
    const median = percentile(mpw, 50);
    const me = A.metrics.minutesPerWord;
    if (!mostlyDictated && Number.isFinite(me) && (me <= cut || me <= median * T.fast_ratio)) {
      flags.push(flag('pattern', 'fast', 'Written unusually quickly',
        `${A.metrics.words} words in ${fmtDuration(A.metrics.activeMin * 60_000)} of writing time. The typical student in this class took about ${fmtDuration(median * A.metrics.words * 60_000)} for the same length${me <= median * T.fast_ratio ? `, ${me > 0 ? `over ${Math.floor(median / me)} times as long` : 'far longer'}` : ''}.`,
        [{ i: 0, label: 'Start of writing' }], BENIGN.fast,
        `${me.toFixed(3)} minutes per word; class median ${median.toFixed(3)} (${cohort.length} submissions). Flagged in the fastest ${T.fast_percentile}% of the class, or under ${Math.round(T.fast_ratio * 100)}% of the median time.`));
    }
    const others = cohort.filter((c) => c !== A).map((c) => c.metrics.ikiCv).filter(Number.isFinite);
    const mid = percentile(others, 50);
    const spread = 1.4826 * percentile(others.map((v) => Math.abs(v - mid)), 50);
    const x = A.metrics.ikiCv;
    if (Number.isFinite(x) && others.length >= 2 && spread > 0 && x < mid - T.rhythm_z * spread) {
      flags.push(flag('pattern', 'rhythm', 'Unnaturally even typing',
        `The time between keystrokes is far more regular than for the rest of the class. People composing speed up and slow down as they think; copying text by hand, or an auto-typing program that types pasted text for you, keeps a much more constant beat.`,
        [{ i: 0, label: 'Start of writing' }], BENIGN.rhythm,
        `Keystroke timing variation ${x.toFixed(2)}, class median ${mid.toFixed(2)}; flagged more than ${T.rhythm_z} robust standard deviations below the class.`));
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
  // Five main questions, then up to four more under "More questions".
  const add = (p) => {
    if (prompts.length >= 9) return;
    if (p.i != null) {
      if (used.has(p.i)) return;
      used.add(p.i);
    }
    p.key = p.key || p.i;
    if (p.key == null) return;
    prompts.push(p);
  };

  // Flagged moments first.
  for (const f of flags) {
    if (f.kind !== 'pattern') continue;
    const m = f.moments[0];
    if (!m) continue;
    let q;
    if (f.id === 'transcription') q = `This section ("${snippet(bodyOf(m.run.text))}") went in at ${clock(m.i)} with almost no changes. Did you plan it somewhere else first?`;
    else if (f.id === 'away') q = `At ${clock(m.i)} you came back to the window and wrote without stopping. What were you looking at just before?`;
    else if (f.id === 'retype') q = `At ${clock(m.i)} you tried to paste a passage, then typed one of about the same length. Where was that text from?`;
    else if (f.id === 'unusual') q = `At ${clock(m.i)} a long stretch of text arrived in one go (${m.label.split(' at ')[0]}). How did you enter that part?`;
    else if (f.id === 'gap') q = `The timestamps stop during ${m.label.replace('Gap ', '')}. What happened during that stretch?`;
    else if (f.id === 'untrusted') q = `At ${clock(m.i)} something other than the keyboard tried to change the text. Do you use any browser extensions while writing?`;
    else if (f.id === 'quotes') q = `At ${clock(m.i)} you brought a long passage in from your sources. Where is it from, and how does it fit your argument?`;
    else if (f.id === 'overlap') q =`This passage ("${snippet(m.text)}") also appears in another submission. Where did the wording come from?`;
    else if (f.id === 'fast') q = 'You wrote this quickly for its length. Walk me through how you prepared before you started typing.';
    else if (f.id === 'rhythm') q = 'Your typing rhythm is unusually even. Tell me about how you typed this one: one sitting, any tools?';
    else if (f.id === 'speed') q = `At ${clock(m.i)} the text went in faster than most people can type. How did you enter that part?`;
    else if (f.id === 'pastes') q = 'You tried to paste text several times while writing. What were you trying to bring in, and where was it from?';
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

  // 5. Text pasted from outside without saying where it came from.
  {
    const cited = new Set(events.filter((e) => e.k === 'cite').map((e) => e.of));
    const outside = events.filter((e) => !cited.has(e.s) && (e.x || '').trim().length >= 20 &&
      (e.k === 'paste_src' || ((e.k === 'ins' || e.k === 'rep') && e.pane !== 'src' && (e.it === 'insertFromPaste' || e.it === 'insertFromDrop'))));
    const big = outside.sort((a, b) => b.x.length - a.x.length)[0];
    if (big) {
      add({
        i: big.s, title: 'A paste without a source',
        question: `At ${clock(big.s)} you pasted "${snippet(big.x, 6)}"${big.k === 'paste_src' ? ' into your sources' : ''} without noting where it came from. What's the source?`,
      });
    }
  }

  // 6. The student's AI-use disclosure.
  const ai = A.header.ai_use;
  if (ai && ai.used && ai.used !== 'none') {
    add({
      key: 'ai', title: 'AI use',
      question: (() => {
        const said = ai.detail ? ` ("${snippet(ai.detail, 12)}")` : '';
        switch (ai.used) {
          case 'drafting': return `You said AI drafted some of the text${said}. Which parts, and what did you change in what it gave you?`;
          case 'editing': return `You said you used AI for grammar or wording${said}. Show me a sentence it changed, and what it was before.`;
          case 'ideas': return `You said you used AI for ideas${said}. What did it suggest, and what did you decide to do differently?`;
          case 'feedback': return `You said you got feedback from AI${said}. What did it tell you, and what did you change because of it?`;
          default: return `You said you used AI for this${said}. What did you use it for, and which parts are most your own?`;
        }
      })(),
    });
  }

  // 7. The paragraph the student reworked most often.
  {
    const byPara = new Map();
    for (const d of raw.delEpisodes) {
      if (d.text.trim().length < 3) continue;
      if (!byPara.has(d.para)) byPara.set(d.para, []);
      byPara.get(d.para).push(d);
    }
    const [para, eps] = [...byPara].sort((a, b) => b[1].length - a[1].length)[0] || [];
    if (eps && eps.length >= 4) {
      const last = eps[eps.length - 1];
      add({
        i: last.i, title: 'The most reworked paragraph',
        question: `You went back to your ${ordinal(para)} paragraph ${eps.length} times to cut or rewrite parts of it. What were you trying to get right?`,
      });
    }
  }

  // 8. Coming back to the opening once the draft had grown.
  if (raw.openingVisits.length >= 2) {
    const v = raw.openingVisits[raw.openingVisits.length - 1];
    add({
      i: v.i, title: 'Back to the opening',
      question: `You returned to your opening paragraph ${raw.openingVisits.length} times as the draft grew. How did your introduction change as you worked out your argument?`,
    });
  }

  // 9. The later session that added the most.
  if (A.sessions.length > 1) {
    let best = null;
    for (let k = 1; k < A.sessions.length; k++) {
      const S = A.sessions[k];
      const before = S.i0 > 0 ? tl.len[S.i0 - 1] : 0;
      const grew = tl.len[S.i1] - before;
      if (!best || grew > best.grew) best = { S, grew };
    }
    if (best && best.grew >= 300) {
      const day = new Date(best.S.wall).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      add({
        i: best.S.i0, title: 'The most productive return',
        question: `When you came back to the piece on ${day}, you added about ${Math.round(best.grew / 6)} words. What did you work on that time, and had you planned it beforehand?`,
      });
    }
  }

  // 10. The flattest stretch.
  const flat = raw.runs.filter((r) => r.words >= 60 && r.revision < 0.1).sort((a, b) => b.words - a.words)[0];
  if (flat) {
    add({
      i: flat.i0, title: 'The flattest stretch',
      question: `This section ("${snippet(bodyOf(flat.text))}") went in with almost no changes. Did you plan it somewhere else first?`,
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
  prompts.forEach((p, k) => {
    if (k >= 5) p.extra = true;
  });
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
