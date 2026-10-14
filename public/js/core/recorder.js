// Turns input actions into the event log and writes the stamped checkpoint chain.
// Used by the student sandbox and by the simulator (with a fake clock and the demo TSA).
import { sha256Hex, canonical } from './canon.js';
import {
  CHECKPOINT_MS, CHECKPOINT_EVENTS, applyEvent, replay, eventsHash, checkpointHash, chainSeed, buildFile,
} from './format.js';

export class Recorder {
  constructor({ config, cfgHash, header, events = [], checkpoints = [], stamper, now = () => Date.now(), onChange = () => {} }) {
    this.config = config;
    this.cfgHash = cfgHash;
    this.header = header;
    this.events = events;
    this.checkpoints = checkpoints;
    this.stamper = stamper;
    this.now = now;
    this.onChange = onChange;
    const state = replay(events);
    this.doc = state.doc; // the essay, with formatting
    this.src = state.src;
    this.sessionStart = null;
    this.lastCpAt = now();
    this.cpQueue = Promise.resolve();
    this.covered = checkpoints.length ? checkpoints[checkpoints.length - 1].range[1] + 1 : 0;
    this.stamping = null;
  }

  static async create(opts) {
    const r = new Recorder(opts);
    r.prevHash = await chainSeed(opts.cfgHash, opts.header);
    return r;
  }

  // Continues an earlier file (another session). Throws if the file does not replay cleanly.
  static async resume(file, opts) {
    const r = new Recorder({
      ...opts,
      config: file.assignment.config,
      cfgHash: file.assignment.config_hash,
      header: { ...file.header },
      events: file.events.slice(),
      checkpoints: file.checkpoints.map((c) => ({ ...c })),
    });
    if (r.text !== file.final.text || canonical(r.doc.format()) !== canonical(file.final.format || null)) {
      throw new Error('This file does not replay to its own text, so it cannot be continued.');
    }
    const last = r.checkpoints[r.checkpoints.length - 1];
    r.prevHash = last ? await checkpointHash(last) : await chainSeed(r.cfgHash, r.header);
    return r;
  }

  get text() {
    return this.doc.text;
  }

  get inSession() {
    return this.sessionStart !== null;
  }

  startSession() {
    this.sessionStart = this.now();
    this.lastCpAt = this.sessionStart;
    this.push({ k: 'session_start', w: new Date(this.sessionStart).toISOString(), ua: this.header.ua_hint });
  }

  endSession() {
    if (!this.inSession) return;
    this.push({ k: 'session_end' });
    this.checkpoint();
    this.sessionStart = null;
  }

  // Records an event. Text and formatting events are applied first, so an invalid one throws
  // before anything is logged.
  record(partial) {
    if (!this.inSession) throw new Error('No session in progress');
    this.src = applyEvent(this.doc, this.src, partial);
    return this.push(partial);
  }

  push(partial) {
    const e = { s: this.events.length, t: Math.max(0, Math.round(this.now() - (this.sessionStart ?? this.now()))), ...partial };
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === '' && k !== 'x') delete e[k];
    if (e.n === 0) delete e.n;
    this.events.push(e);
    if (this.events.length - this.covered >= CHECKPOINT_EVENTS) this.checkpoint();
    this.onChange('event', e);
    return e;
  }

  // Call about once a second. Writes a checkpoint after 60 s of activity and retries stamps.
  tick() {
    if (this.events.length > this.covered && this.now() - this.lastCpAt >= CHECKPOINT_MS) this.checkpoint();
  }

  checkpoint() {
    if (this.events.length <= this.covered) return this.cpQueue;
    const range = [this.covered, this.events.length - 1];
    const slice = this.events.slice(range[0], range[1] + 1);
    const docState = this.doc.hashInput();
    this.covered = range[1] + 1;
    this.lastCpAt = this.now();
    this.cpQueue = this.cpQueue.then(async () => {
      const cp = {
        c: this.checkpoints.length,
        range,
        events_hash: await eventsHash(slice),
        doc_hash: await sha256Hex(docState),
        prev: this.prevHash,
      };
      this.prevHash = await checkpointHash(cp);
      cp.tsa = null;
      this.checkpoints.push(cp);
      this.onChange('checkpoint', cp);
      this.stampPending();
    });
    return this.cpQueue;
  }

  unstamped() {
    return this.checkpoints.filter((c) => !c.tsa);
  }

  // Requests stamps for every checkpoint that lacks one, oldest first. Stops at the first failure.
  stampPending() {
    if (!this.stamping) this.stamping = this.runStamps();
    return this.stamping;
  }

  async settle() {
    await this.cpQueue;
    await this.stampPending();
  }

  async runStamps() {
    try {
      for (const cp of this.checkpoints) {
        if (cp.tsa) continue;
        try {
          cp.tsa = await this.stamper(await checkpointHash(cp), cp);
          this.lastStampOk = this.now();
          this.stampError = null;
          this.onChange('stamp', cp);
        } catch (err) {
          this.stampError = err.message || String(err);
          this.onChange('stamp-error', cp);
          break;
        }
      }
    } finally {
      this.stamping = null;
    }
  }

  async toFile() {
    await this.cpQueue;
    return buildFile({
      header: this.header,
      config: this.config,
      cfgHash: this.cfgHash,
      events: this.events,
      checkpoints: this.checkpoints,
      finalText: this.text,
      finalHash: await sha256Hex(this.text),
      finalFormat: this.doc.format(),
    });
  }
}
