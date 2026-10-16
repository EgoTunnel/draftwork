// Backups of an instructor's assignments and check-in notes, and merging them.
// A backup is plain JSON; a "shared" backup carries only chosen assignments (and, optionally,
// their notes) for a colleague, and never removals.

export const BACKUP_TYPE = 'draftwork-backup';

export function makeBackup({ assignments, notes = {}, removed = {}, shared = false, from = '' }) {
  return {
    type: BACKUP_TYPE, // first, so a file can be recognised from its opening bytes
    version: 1,
    exported: new Date().toISOString(),
    from,
    shared: shared || undefined,
    assignments: assignments.map((a) => ({ config: a.config, added: a.added })),
    notes,
    removed: shared ? undefined : removed,
  };
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file isn’t a Draftwork backup.');
  }
  if (!data || data.type !== BACKUP_TYPE || !Array.isArray(data.assignments)) throw new Error('That file isn’t a Draftwork backup.');
  return data;
}

// Notes are keyed by submission, and each submission's key starts with its assignment's hash.
export const notesFor = (notes, hashes) => Object.fromEntries(Object.entries(notes).filter(([k]) => hashes.has(k.split(':')[0])));

const filled = (v) => v !== undefined && v !== null && v !== '';

// One submission's notes from two places (two computers, or two colleagues). Anything filled in
// on only one side is kept; where both filled in the same thing, the more recently updated copy wins.
export function mergeNote(a, b) {
  if (!a || typeof a !== 'object') return b;
  if (!b || typeof b !== 'object') return a;
  const [older, newer] = String(a.updated || '') > String(b.updated || '') ? [b, a] : [a, b];
  const pick = (o, n) => (filled(n) ? n : o);
  const prompts = {};
  for (const k of new Set([...Object.keys(older.prompts || {}), ...Object.keys(newer.prompts || {})])) {
    const o = (older.prompts || {})[k] || {};
    const n = (newer.prompts || {})[k] || {};
    prompts[k] = { answer: pick(o.answer, n.answer) || '', outcome: pick(o.outcome, n.outcome) || '' };
  }
  const flags = {};
  for (const k of new Set([...Object.keys(older.flags || {}), ...Object.keys(newer.flags || {})])) {
    flags[k] = pick((older.flags || {})[k], (newer.flags || {})[k]) || '';
  }
  return { ...older, ...newer, prompts, flags, summary: pick(older.summary, newer.summary) || '', updated: newer.updated || older.updated };
}

// Returns the merged notes and how many submissions gained something.
export function mergeNotes(mine, theirs) {
  const out = { ...mine };
  let changed = 0;
  for (const [key, n] of Object.entries(theirs || {})) {
    if (!n || typeof n !== 'object') continue;
    const merged = mergeNote(mine[key], n);
    if (JSON.stringify(merged) !== JSON.stringify(mine[key])) changed++;
    out[key] = merged;
  }
  return { notes: out, changed };
}

// Removed assignments, as { hash: when }. The later removal wins.
export function mergeRemoved(a = {}, b = {}) {
  const out = { ...a };
  for (const [h, t] of Object.entries(b || {})) if (!out[h] || String(t) > String(out[h])) out[h] = t;
  return out;
}

// An assignment stays removed unless it was added again after it was removed.
export const isRemoved = (removed, hash, added) => !!removed[hash] && String(removed[hash]) >= String(added || '');
