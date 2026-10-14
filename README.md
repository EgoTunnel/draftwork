# Draftwork

Records how a take-home piece of writing was produced, so an instructor can replay it and ask about it. Built from [Draftwork — File Format & Replay Viewer Spec](./Draftwork%20—%20File%20Format%20&%20Replay%20Viewer%20Spec.md).

Two static pages and a file format, plus a tiny stateless timestamp relay:

- **Student sandbox** (`student.html`): writes the event log, checkpoints every 60 s of activity or 500 events, stamps each checkpoint (RFC 3161), autosaves to IndexedDB, and saves a gzipped `.draftwork` file for the LMS dropbox. **Preview** shows exactly what the instructor will see.
- **Instructor viewer** (`instructor.html`): creates assignment links (title, nonce, paste policy, sources pane, word limits, flag thresholds), then opens one or many `.draftwork` files and shows the four layers: integrity checks, flags, process signals (production graph and signals table with class and self-baseline comparisons) and 3–5 conversation prompts, with a scrubbable replay.
- **Relay** (`server.js`): serves the pages and forwards `POST /tsa` to a public RFC 3161 authority, because those don't accept browser (CORS) requests.

No dependencies. Node 20+.

## Run it

```bash
npm start
```

Open http://localhost:8080. Timestamps go to `https://freetsa.org/tsr` by default. Use `--tsa <url>` to pick another authority.

To work offline, use the demo TSA. It signs real CMS tokens, but the viewer marks them "not trusted":

```bash
npm run start:mock
```

To generate a demo class (15 composed essays, a transcriber, an autotyper, a dictation user, a stamp outage, a tampered file and one earlier assignment for a self-baseline) for **Load the demo class** in the viewer:

```bash
npm run simulate
```

```bash
npm test
```

`node tools/report.js samples` prints the integrity results, flags and prompts for a folder of files.

## Layout

```
server.js                 static server + /tsa relay (--mock-tsa for offline)
public/
  index.html student.html instructor.html
  css/app.css
  js/core/canon.js        canonical JSON, SHA-256, gzip, base64
  js/core/asn1.js         minimal DER reader/writer
  js/core/tsa.js          RFC 3161 request, fetch and token verification (WebCrypto)
  js/core/format.js       configs, events, replay, checkpoint hashing, file read/write
  js/core/recorder.js     event log + checkpoint chain + stamp queue
  js/core/analysis.js     integrity checks, signals, flags, prompts
  js/core/store.js        IndexedDB autosave
  js/ui/report.js         the viewer (shared by instructor page and student preview)
  js/ui/graph.js          production graph
  js/student.js, js/instructor.js
tools/mock-tsa.js         demo time-stamping authority
tools/simulate.js         synthetic class generator (drives the real Recorder)
tools/report.js           CLI summary
tests/draftwork.test.js
```

## Decisions where the spec left room

- **Timestamping from the browser** (open question): the sandbox posts to a relay URL set in the assignment config (`/tsa` by default, served by `server.js`). The relay keeps no state. The sandbox won't start a session until a test stamp succeeds. During an outage, writing continues and checkpoints queue. After 8 minutes the student gets a warning, and the viewer flags any stretch over 10 minutes. A stamp issued more than `stamp_lag_s` (120 s) after its checkpoint counts as late: it doesn't anchor time, so the stretch shows as a gap.
- **TSA verification** checks the message imprint, the CMS `messageDigest` and the signature against the certificate embedded in the token (RSA and ECDSA). It does **not** chain that certificate to a trusted root; the viewer says so.
- **What is stamped**: `SHA-256(canonical({c, range, events_hash, doc_hash, prev}))`. The first checkpoint's `prev` is a seed that binds the chain to the config hash, `student_label` and `created`. Relabelling someone else's file therefore breaks the chain.
- **Format additions**: header `dictation_mode` and `attachments` (outline filename and SHA-256 only); `w` (wall clock) on `session_start`; `pane: "src"` on sources-pane edits; `from: "src"` on quotes pasted from the sources pane; `len` on `paste_blocked`; an `untrusted` event kind for refused script input. Programmatic `textarea.value` changes (which fire no event) are also reverted and logged as untrusted.
- **Flag thresholds** live in the assignment config, so the student preview uses the same values as the instructor. The UI lets instructors both loosen and tighten them; that policy question is still open.
- **Flags are visible to students before submission**, following principle 5.
- **Class-relative flags** (too fast, machine-regular rhythm) switch on at `min_class_size` (15) submissions for the same config hash. Comparisons are only against the loaded class and the same student's other files (matched by `student_label`).
- **Signal definitions**, where the spec is informal: *revision reach* is the share of edits made before the last sentence of the document. *Linearity* is the share of final characters that were inserted with only whitespace after them. A *transcription stretch* is a run of typing at the cursor; speed variation is measured over 100-character chunks, excluding time spent in another window. *Paste, then retype* matches the length of a linear run at its end, or at any pause of 5 s or more inside it.

All thresholds are starting values to calibrate in a pilot.
