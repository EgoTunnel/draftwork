// The .draftwork file format: assignment configs, events, checkpoints, replay, read/write.
import {
  canonical, sha256Hex, gzip, gunzipToString, isGzip, fromUtf8, toBase64Url, fromBase64Url, randomHex,
} from './canon.js';
import { DocModel, isFormatEvent } from './doc.js';

export const FORMAT = 'draftwork/1';
export const APP_VERSION = '0.9.0';
export const EXTENSION = '.draftwork';

export const CHECKPOINT_MS = 60_000;
export const CHECKPOINT_EVENTS = 500;

// Kinds that change text. `pane: "src"` marks sources-pane edits; everything else is the essay.
export const TEXT_KINDS = new Set(['ins', 'del', 'rep', 'paste_in', 'paste_src', 'ime']);

// Starting values to calibrate in a pilot. Instructors can tune them per assignment.
export const DEFAULT_THRESHOLDS = {
  stamp_gap_min: 10,
  stamp_lag_s: 120,
  unusual_insert_chars: 50,
  paste_retype_min_chars: 100,
  paste_retype_window_min: 10,
  paste_retype_tolerance: 0.2,
  transcription_words: 150,
  transcription_revision: 0.05,
  transcription_rate_cv: 0.35,
  away_seconds: 20,
  away_burst_words: 50,
  away_burst_pause_s: 2,
  away_burst_count: 3,
  fast_percentile: 5,
  rhythm_z: 2.5,
  min_class_size: 15,
  long_pause_s: 2,
  overlap_words: 30,
  quote_share: 0.25,
  quote_chars: 600,
  speed_wpm: 140,
  speed_chars: 300,
  paste_attempts: 3,
};

export const THRESHOLD_LABELS = {
  stamp_gap_min: 'Stretch without timestamps: minutes of writing',
  stamp_lag_s: 'Seconds a timestamp may lag and still count as on time',
  unusual_insert_chars: 'Large text entered in one go: minimum length (characters)',
  paste_retype_min_chars: 'Tried to paste, then typed it: minimum blocked paste (characters)',
  paste_retype_window_min: 'Tried to paste, then typed it: minutes after the blocked paste',
  paste_retype_tolerance: 'Tried to paste, then typed it: how close the lengths must be (fraction)',
  transcription_words: 'Typed straight through: minimum words in a row',
  transcription_revision: 'Typed straight through: corrections below (deleted ÷ typed)',
  transcription_rate_cv: 'Typed straight through: speed variation below',
  away_seconds: 'Left the window, then wrote quickly: seconds away',
  away_burst_words: 'Left the window, then wrote quickly: words written on return',
  away_burst_pause_s: 'Left the window, then wrote quickly: longest pause while writing (seconds)',
  away_burst_count: 'Left the window, then wrote quickly: times needed',
  fast_percentile: 'Written unusually quickly: fastest percent of the class',
  rhythm_z: 'Unnaturally even typing: standard deviations below the class',
  min_class_size: 'Class comparisons: minimum submissions',
  long_pause_s: 'Long pause (seconds)',
  overlap_words: 'Same wording as another student: words in a row',
  quote_share: 'Heavy quoting: share of the final text pasted from the sources panel',
  quote_chars: 'Heavy quoting: longest single quote (characters)',
  speed_wpm: 'Typing faster than people type: words per minute',
  speed_chars: 'Typing faster than people type: minimum stretch (characters)',
  paste_attempts: 'Repeated paste attempts: attempts needed',
};

export function newConfig({
  title, paste = 'block', sourcesPane = true, wordsMin = null, wordsMax = null, tsaUrl = '/tsa', thresholds = {},
  allowDemoTsa = false, tsaAnchors = [], due = null, aiDisclosure = false, spelling = true,
}) {
  const config = {
    v: 1,
    title: String(title || 'Untitled assignment').trim(),
    nonce: randomHex(16),
    created: new Date().toISOString(),
    policy: {
      paste,
      sources_pane: !!sourcesPane,
      words_min: wordsMin ? Number(wordsMin) : null,
      words_max: wordsMax ? Number(wordsMax) : null,
    },
    tsa_url: tsaUrl,
    thresholds,
  };
  // Optional fields are only present when used, so older configs keep their hashes.
  if (allowDemoTsa) config.allow_demo_tsa = true;
  if (tsaAnchors.length) config.tsa_anchors = tsaAnchors;
  if (due) config.due = due;
  if (aiDisclosure) config.ai_disclosure = true;
  if (!spelling) config.policy.spelling = false; // the browser's built-in spelling and grammar suggestions
  return config;
}

export const thresholdsFor = (config) => ({ ...DEFAULT_THRESHOLDS, ...((config && config.thresholds) || {}) });

export const configHash = (config) => sha256Hex(canonical(config));

export async function encodeConfig(config) {
  return toBase64Url(await gzip(canonical(config)));
}

export async function decodeConfig(code) {
  code = String(code).trim();
  const m = code.match(/[#?&]a=([A-Za-z0-9_-]+)/);
  if (m) code = m[1];
  const config = JSON.parse(await gunzipToString(fromBase64Url(code)));
  if (config.v !== 1 || !config.nonce || !config.policy) throw new Error('Not a Draftwork assignment code');
  return config;
}

// ---------- events and replay ----------

export function applyOp(text, e) {
  const n = e.n || 0;
  if (e.p < 0 || e.p + n > text.length) throw new Error(`Event ${e.s} edits outside the document`);
  return text.slice(0, e.p) + (e.x || '') + text.slice(e.p + n);
}

export const isText = (e) => TEXT_KINDS.has(e.k) && typeof e.p === 'number';
export const isSrc = (e) => e.pane === 'src';

// Applies one event to the essay model or the sources-pane text. Returns the new sources text.
export function applyEvent(doc, src, e) {
  if (isText(e)) {
    if (isSrc(e)) return applyOp(src, e);
    doc.apply(e);
  } else if (isFormatEvent(e) && !isSrc(e)) doc.apply(e);
  return src;
}

// Replays every event from an empty document.
export function replay(events) {
  const doc = new DocModel();
  let src = '';
  for (const e of events) src = applyEvent(doc, src, e);
  return { text: doc.text, src, doc };
}

// Single replacement op between two strings, or null if equal.
export function diffOp(before, after) {
  if (before === after) return null;
  let start = 0;
  const minLen = Math.min(before.length, after.length);
  while (start < minLen && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  return { p: start, n: endB - start, x: after.slice(start, endA) };
}

// ---------- checkpoints ----------

export const eventsHash = (slice) => sha256Hex(slice.map(canonical).join('\n'));

export const checkpointBody = (cp) => ({
  c: cp.c, range: cp.range, events_hash: cp.events_hash, doc_hash: cp.doc_hash, prev: cp.prev,
});

export const checkpointHash = (cp) => sha256Hex(canonical(checkpointBody(cp)));

// Binds the chain to the assignment and to the student label chosen at the start.
export const chainSeed = (cfgHash, header) =>
  sha256Hex(canonical({ config_hash: cfgHash, student_label: header.student_label, created: header.created }));

// ---------- files ----------

export function buildFile({ header, config, cfgHash, events, checkpoints, finalText, finalHash, finalFormat = null }) {
  return {
    header: { ...header, format: FORMAT, app_version: APP_VERSION },
    assignment: { config, config_hash: cfgHash },
    events,
    checkpoints,
    final: finalFormat ? { text: finalText, hash: finalHash, format: finalFormat } : { text: finalText, hash: finalHash },
  };
}

// The final document as a model (formatting falls back to plain if it does not fit the text).
export function finalDoc(file) {
  try {
    return DocModel.fromFormat(file.final.text, file.final.format);
  } catch {
    return new DocModel(file.final.text);
  }
}

export async function serializeFile(file) {
  return gzip(JSON.stringify(file));
}

export async function parseFile(bytes) {
  const json = isGzip(bytes) ? await gunzipToString(bytes) : fromUtf8(bytes);
  const file = JSON.parse(json);
  if (!file.header || !String(file.header.format || '').startsWith('draftwork/')) throw new Error('Not a .draftwork file');
  if (file.header.format !== FORMAT) throw new Error(`Unsupported format ${file.header.format}`);
  for (const key of ['assignment', 'events', 'checkpoints', 'final']) {
    if (!file[key]) throw new Error(`File is missing "${key}"`);
  }
  return file;
}

export function fileName(file) {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${slug(file.assignment.config.title) || 'assignment'}-${slug(file.header.student_label) || 'student'}${EXTENSION}`;
}

export function countWords(text) {
  const m = text.match(/[^\s]+/g);
  return m ? m.length : 0;
}
