# Draftwork — File Format & Replay Viewer Spec

Oct 14, 2026 · @Andrew

## Purpose and design principles

Draftwork (working title) records how a take-home piece of writing was produced, so an instructor can replay it and ask about it. It does not try to prove authorship; it makes faking authorship cost more than doing the work.

1. **Process, not product.** The submission is the final text plus the full edit history that produced it. The history must regenerate the text exactly.
2. **Online, desktop, no institutional backend.** Students write in a desktop browser with a live connection. Anyone who can't do that contacts their instructor. Work still lives in a file on the student's computer and travels through the existing LMS dropbox. The only network traffic is checkpoint hashes sent out for timestamping.
3. **Flags, never scores.** The viewer flags anything unusual, or anything matching a known misuse pattern, and says why. Each flag stands alone with its benign readings beside it. There is no composite "AI likelihood" number.
4. **The conversation is the enforcement.** The viewer's main job is to surface 3–5 specific moments an instructor can ask about in a five-minute check-in.
5. **The student sees what the instructor sees.** Students can open their own file in the viewer, flags included, before submitting.

## System overview

The system is two web pages and a file format, desktop-only and online-only for v1. The instructor page creates assignment configs and replays submissions; the student page is the writing sandbox. The institution adds no infrastructure: submission goes through the LMS it already has.

&#91;embedded content: submission flow · 2 static pages, existing LMS, optional timestamping\]

Before submission, only checkpoint hashes leave the student's computer, and every checkpoint is stamped. The highlighted box is where enforcement actually happens.

## File format

One gzipped JSON file per submission, extension `.draftwork`. It has five parts: header, assignment binding, event log, checkpoints, and final text.

### Header

```json
{
  "format": "draftwork/1",
  "app_version": "0.3.1",
  "student_label": "A. Student, 000123456",
  "created": "2026-10-14T13:02:11Z",
  "process_notes": "Outlined on paper first; used dictation for paragraph 3."
}
```

`student_label` is free text the student types; it is the only personal data in the file. `process_notes` is optional and student-written (see Fairness).

### Assignment binding

The instructor generates an assignment config in the viewer and gives students a short code or link. The config sets the title, a random nonce, and policy: paste rules, whether a sources pane exists, and word limits. The file stores the config verbatim plus its SHA-256 hash. A log written for a different assignment, or under looser paste rules, fails the check.

### Event log

One event per input action, captured from the browser's `beforeinput` and selection events.

```json
{ "s": 4182, "t": 1834551, "k": "ins", "p": 2210, "x": "e", "it": "insertText" }
{ "s": 4183, "t": 1834690, "k": "del", "p": 2205, "n": 6, "it": "deleteWordBackward" }
{ "s": 4184, "t": 1901220, "k": "blur" }
```

`s` is the sequence number. `t` is milliseconds since the session start, and each session start records the wall clock once. `p` is the document position, `x` is the inserted text, `n` is the deletion length, and `it` is the browser's raw input type. Events the browser marks as script-generated (isTrusted false) are refused, and the attempt is logged as untrusted.

| Kind | Recorded when | Why it matters |
| --- | --- | --- |
| `ins` / `del` / `rep` | Any text change, including autocorrect (`insertReplacementText`) | Core of the replay |
| `paste_in` | Paste of text copied inside this document | Moving your own paragraphs is normal revision |
| `paste_src` | Paste into the sources pane | Quoted material, tagged and kept separate |
| `paste_blocked` | External paste refused by policy | Logged with length only, not content |
| `ime` | Composition input (CJK, some dictation) committed as one chunk | Prevents false "large insertion" flags |
| `move` | Cursor jump over 40 chars with no edit | Shows going back to earlier text |
| `blur` / `focus` | Window loses or regains focus | Context for what follows |
| `session_start` / `session_end` | File opened or closed | Work spread across days |

### Checkpoints

Every 60 seconds of activity, or every 500 events, the app writes a checkpoint:

```json
{ "c": 37, "range": [4001, 4500], "events_hash": "…", "doc_hash": "…", "prev": "…", "tsa": "…" }
```

- `events_hash` is the hash of the canonical events in range.
- `doc_hash` is the hash of the document text at that moment.
- `prev` is the previous checkpoint's hash, which forms the chain.
- `tsa` is the RFC 3161 timestamp token over the checkpoint, requested the moment the checkpoint is written. A third party attests that this exact state existed at that time.

The chain makes any edit to past events visible. It does not stop someone from forging a whole new chain, since the hashing has no secret. The TSA tokens do that work: a forged history would have to be produced in real time, over the hours it claims to cover.

Stamping is mandatory, so the sandbox will not start a session without a connection. If the connection drops mid-session, writing continues and unstamped checkpoints queue until it returns. A stretch of more than 10 minutes without a stamp shows in the viewer as a gap and raises a flag.

### Final text

`final_text` plus its hash. The verifier replays every event from an empty document and requires an exact match. This replay-consistency check is the core integrity guarantee: the log cannot be decorative.

### Size

A 2,000-word essay is about 12,000 characters. With revisions that comes to roughly 25,000–40,000 events, or about 2–3 MB of raw JSON. Gzipped, that is a few hundred KB, which fits comfortably under typical LMS upload limits.

## Replay viewer

The viewer opens a `.draftwork` file and shows four layers, in this order. First come integrity checks, which pass or fail. Second are flags, which name what looks unusual and why. Third are the process signals behind the flags, shown as observations. Fourth are conversation prompts, which are the point of the whole thing.

### Layer 1: Integrity checks

- [ ] The replay reproduces `final_text` exactly.
- [ ] The checkpoint chain is unbroken, and every `doc_hash` matches the replayed state.
- [ ] The assignment config hash matches the instructor's config.
- [ ] Timestamps are monotonic within each session, and sessions do not overlap.
- [ ] TSA tokens verify, and their times match the session wall clock within tolerance.

A failure here is a real finding: the file was altered or built outside the app. Every other layer is interpretive.

### Layer 2: Flags

The viewer flags anything unusual, or anything matching a pattern associated with AI misuse, and gives the reason in one line. There are two kinds:

- **Integrity flags** mean the file was altered or produced outside the sandbox.
- **Pattern flags** mean something is worth a conversation. Each one links to its moment in the replay, shows the matching benign explanations from the signals table, and becomes a conversation prompt automatically.

Flags are listed separately and are never combined into a score.

| Flag | Raised when | Why it suggests misuse |
| --- | --- | --- |
| Integrity failure | Any Layer 1 check fails | The file was edited or built outside the sandbox |
| Timestamp gap | Over 10 minutes of writing with no stamped checkpoint | A window in which the log could have been built elsewhere |
| Untrusted input | Any script-generated input event was attempted | Text injected by a script or extension rather than typed |
| Unusual input type | Insertion over 50 characters by drag-and-drop or any input type other than typing, dictation, IME, or internal paste | A route around the paste block |
| Paste, then retype | A blocked external paste, followed within 10 minutes by linear typing of similar length (±20%) | Tried to paste the text, then typed it in instead |
| Transcription stretch | 150+ consecutive words with revision ratio under 0.05, no edits behind the cursor, and steady speed | Copying from another screen |
| Away, then burst | Focus lost for 20+ seconds, then 50+ words with no pause over 2 seconds, three or more times | Reading from another window and typing it in |
| Too fast for the length | Active writing time in the bottom 5% of the class for the word count | Produced faster than composing usually allows |
| Machine-regular rhythm | Keystroke timing far more uniform than anyone else's in the class | An autotyper |

The thresholds above are starting values to calibrate in a pilot, and instructors can tune them per assignment. Class-relative flags only switch on above a minimum class size, such as 15 submissions.

### Layer 3: Process signals

The headline view is a **production graph**, the standard picture in writing-process research (Inputlog-style). Time runs left to right. It plots three lines: total characters ever typed, current document length, and cursor position.

In composed writing, the lines separate. Typed exceeds length because of deletions, and the cursor line drops whenever the writer goes back. In transcribed writing, the three lines run almost on top of one another.

| Signal | What it measures | Transcription tends to look like | Benign explanations |
| --- | --- | --- | --- |
| Time on task | Active time vs. elapsed time, sessions across days | One session, close to typing time for the length | Fast writers; drafted on paper first |
| Pause location | Share of long pauses (over 2 s) at sentence and paragraph boundaries vs. mid-word | Pauses spread evenly or tied to focus loss | Non-native writers pause mid-sentence to find words |
| Revision ratio | Characters deleted ÷ characters in final text | Under \~0.1, almost all local typo fixes | Confident writer; edited in a second, unlogged pass |
| Revision reach | Share of edits more than one sentence behind the cursor | Near zero | Short pieces; writers who revise in their heads |
| Linearity | Share of final text produced at the document's end vs. inserted earlier | Near 100% end-of-document | Writing to a detailed outline |
| Burst profile | Length and speed of typing runs between pauses | Long, steady runs at constant speed | Fluent typists on familiar material |
| Focus pattern | Window blurs followed by fast, pause-free bursts | "Away, then burst" repeated | Checking notes or sources in another tab |
| Large insertions | Any single event over 50 characters, labelled by input type | Absent if pasting is blocked | Dictation, IME, autocorrect |
| Survival | Share of all typed text that survives to the final version | Over 90% | Same as revision ratio |
| Keystroke rhythm | Spread of time between keystrokes | Unnaturally regular (simple autotypers) | Weak signal; a good autotyper defeats it |

Thresholds in the middle column are illustrative starting points to calibrate on real data, not validated cutoffs.

The viewer offers two comparisons: the student's own earlier files when available, and the class distribution for this assignment. It never compares against a fixed population norm.

### Layer 4: Conversation prompts

The viewer picks 3–5 moments, flagged moments first, and frames each as a question, with a scrubber that jumps to that point in the replay:

1. **Largest deletion.** "At 0:42 you cut 180 words from your second section. What was wrong with it?"
2. **Longest pause before a structural change.** "You stopped for four minutes, then moved your conclusion to the top. What were you thinking about?"
3. **A moved paragraph.** "Why does this example come before the claim now?"
4. **A source integration.** "You pasted this quote at 1:10. Walk me through how you decided where it goes."
5. **The flattest stretch.** "This section went in with almost no changes. Did you plan it somewhere else first?"

A student who wrote the piece answers these in seconds. A student who transcribed it has nothing to remember. The fifth prompt is phrased so a legitimate answer ("I outlined it on paper") is easy to give.

## Fairness and accommodations

The students most likely to look "linear" are not cheaters. They include students who draft on paper, multilingual writers who compose in their heads, and students using assistive technology. The design has to absorb them without forcing any of them to disclose a disability.

- **Dictation and IME.** Chunked input is logged by its raw input type and labelled as such, never flagged as a large insertion. A student-chosen "dictation mode" adds a note to the header.
- **Paper or offline drafting.** The `process_notes` field lets a student say so up front. An optional "attach outline" button stores a photo hash and filename only, as evidence that something existed, without storing the image.
- **Self-baselines.** After two or three assignments, the most meaningful comparison is the student against themselves.
- **Policy wording.** Instructors should adopt this language: *a process pattern can only ever lead to a conversation, never directly to a penalty.* The viewer prints it in its footer.
- **Student preview.** Students can see every signal before they submit, so nothing about the record comes as a surprise.

Students who can't work online at a desktop for an assignment contact their instructor, who arranges an alternative. The sandbox shows this instruction whenever it refuses to start.

## Threat model

Every attack below is possible. The goal is that each one costs more effort than writing the essay, or fails the five-minute conversation.

| Attack | Effort for the student | What catches it |
| --- | --- | --- |
| Paste AI text | None | Blocked by policy; the attempt is logged |
| Retype AI text from a phone | Low: typing time | Transcription stretch and paste-then-retype flags; then the conversation |
| Retype, then add fake revisions | Medium | Revisions are shallow and local; the conversation |
| Autotyper with human-like timing | Medium: install a tool, run it for hours | Weak rhythm signals; mainly the conversation |
| Hand-edit the JSON | Medium | Replay mismatch and a broken chain |
| Rebuild the whole log and chain offline | High | Every checkpoint is stamped, so the forgery must run in real time; gaps are flagged |
| Inject events through devtools while writing | High | Untrusted-input flag catches naive scripts; otherwise the conversation |
| Use AI for ideas, then write it yourself | Low | Not caught, and arguably not the target. This is a policy question, not a tooling one |

The last row matters. The tool enforces *who did the writing*. It cannot enforce *where the ideas came from*, and it should not pretend to.

## Open questions

- [ ] **Timestamping from the browser.** Public RFC 3161 authorities may not allow browser (CORS) requests. If they don't, a tiny stateless relay is needed. Stamping is now mandatory, so that relay's uptime matters. What should the sandbox do during an outage that outlasts the 10-minute gap?
- [ ] **Calibration data.** The flag thresholds need a pilot. One option is a small set of known-composed and known-transcribed essays from consenting volunteers.
- [ ] **Flag tuning.** Decide whether instructors may loosen thresholds or only tighten them, and whether flags are visible to students before submission.
- [ ] **Sources pane rules.** How long can a pasted quote be? Should the viewer link each pasted source to where it appears in the final text?
- [ ] **Formats beyond prose.** Code, math, and lab reports each need their own event kinds. Prose comes first.
- [ ] **Browser coverage.** `beforeinput` input types vary between desktop browsers, especially for dictation. A compatibility matrix is needed before any pilot.
