# The `.draftwork` file format, version `draftwork/1`

This is the stable description of the file Draftwork writes, so that anyone can build an independent viewer or verifier. `draftwork/1` is **frozen**: later versions of Draftwork must keep verifying every `draftwork/1` file, and new fields may only be added as optional fields that don't change anything already hashed. A change that would alter hashing gets a new format version.

Reference implementation: `public/js/core/` (`format.js`, `doc.js`, `recorder.js`, `analysis.js`, `tsa.js`, `trust.js`).

## Container

A gzip-compressed UTF-8 JSON object (an uncompressed JSON file is also accepted by readers):

```json
{
  "header": { ... },
  "assignment": { "config": { ... }, "config_hash": "<hex>" },
  "events": [ ... ],
  "checkpoints": [ ... ],
  "final": { "text": "...", "hash": "<hex>", "format": { ... } }
}
```

## Canonical JSON and hashes

- **Canonical JSON:** sorted object keys, no whitespace, members whose value is `undefined` omitted, arrays in order, and JSON string escaping as produced by `JSON.stringify`.
- **Hashes:** lowercase hex SHA-256 of the UTF-8 bytes.

## Header

| Field | Hashed? | Meaning |
|---|---|---|
| `format` | — | `"draftwork/1"` |
| `app_version` | no | writer version |
| `student_label` | via chain seed | free text the student typed; the only personal data |
| `created` | via chain seed | ISO time the file was started |
| `process_notes` | no | student's notes about how they worked |
| `dictation_mode` | no | boolean |
| `attachments` | no | `[{ filename, sha256, added }]`: outline files, never their content |
| `doc_style` | no | display settings: `font`, `size` (pt), `line`, `after`, `firstLine`, `pageNumbers`, `headerText`, `pageNum` (`footer`, `header` or `none`) |
| `consent` | no | `{ at, notice }`: when the student accepted the recording notice |
| `flag_notes` | no | `{ flagId: text }`: the student's responses to flags |
| `ai_use` | no | `{ used, detail }`: the student's AI-use disclosure |

Unhashed fields are the student's own statements and settings; they may change after writing.

## Assignment

- **`config`:** stored verbatim. Its shape is `{ v: 1, title, nonce, created, policy: { paste: "block" | "allow", sources_pane, words_min, words_max }, tsa_url, thresholds }`, plus these optional fields:
  - `allow_demo_tsa`;
  - `tsa_anchors: [{ name, spki }]`;
  - `due`;
  - `ai_disclosure`.
- **`config_hash`:** `SHA-256(canonical(config))`.

## Events

**Common fields.** Each event has these, plus fields that depend on its kind:
- `s`: sequence number, from 0, contiguous;
- `t`: milliseconds since its session started;
- `k`: kind.

**Text events** change the essay, or the sources panel when `pane: "src"`. They delete `n` characters at position `p`, then insert `x` at `p`. Positions are UTF-16 code units, and paragraphs are separated by `\n`.

| Kind | Meaning |
|---|---|
| `ins`, `del`, `rep` | typing, deleting, replacing; `it` is the browser's input type |
| `paste_in` | paste of text copied inside the sandbox; `from: "src"` when copied from the sources panel |
| `paste_src` | paste into the sources panel (`pane: "src"`) |
| `ime` | text committed by an input method or dictation composition |

**Formatting of inserted text.** A text event may carry either of these; the default mask is `0`.
- `m`: one mark mask for all the inserted text.
- `mr`: run-length masks, `[[count, mask], ...]`.

A mark is an integer from 0 to 65535:
- **Bits 0–6 are flags:** bold 1, italic 2, underline 4, strikethrough 8, superscript 16, subscript 32, highlight 64.
- **Bits 7–10 are a font index** into `["", times, georgia, garamond, palatino, arial, calibri, verdana, courier]`.
- **Bits 11–15 are a size index** into `[0, 8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 36]` (points).

Index 0 means "the document's default". Both tables are append-only.

**Footnotes.** A footnote is the character U+FFFC in the text, and the notes are kept in anchor order:
- **Inserting** an anchor (through any text event) adds an empty note at that position.
- **Deleting** an anchor removes its note.
- **Note text** is edited with `note` events and is a single line.

**Formatting events**

| Kind | Fields | Meaning |
|---|---|---|
| `fmt` | `{ p, n, set, clr, font?, size? }` | flags of characters `[p, p+n)` become `(m \| set) & ~clr`; `font` and `size` (indexes) replace those fields when present |
| `note` | `{ i, p, n, x }` | edits the text of footnote `i` like a text event |
| `fmt` | `{ p, mr }` | marks set exactly from runs |
| `para` | `{ a, b, set }` | paragraphs `a … a+b-1` get the attributes in `set` |
| `para` | `{ a, pa }` | paragraphs from `a` set exactly |

**Paragraph attributes.** Default attributes are omitted:
- `s`: style (`p`, `title`, `h1`, `h2`, `h3`, `quote`, `bib`);
- `al`: alignment (`l`, `c`, `r`, `j`);
- `li`: list (`""`, `ul`, `ol`);
- `in`: indent (0–5);
- `pb`: page break before; present only when true.

**Other events**

| Kind | Fields | Meaning |
|---|---|---|
| `session_start` | `w` (ISO wall clock) | a writing session began; `t` restarts at 0 |
| `session_end` | | |
| `blur`, `focus` | | the window lost or regained focus |
| `move` | `p`, `from` | cursor jump of more than 40 characters with no edit |
| `paste_blocked` | `len`, `it` | refused outside paste; content is not kept |
| `untrusted` | `it`, `len` | refused script or extension input |
| `cite` | `of`, `x` | the student's source details for the paste event `of` |

Readers must ignore event kinds they don't know.

### Paragraph rules (part of the replay)

Text events change paragraph attributes deterministically, as implemented in `DocModel.applyText` (`doc.js`).

**Deleting across `\n`** merges paragraphs. Let `k1` be the paragraph containing `p`:
- If `p` is at the start of `k1`, the attributes of the paragraph that follows are kept.
- Otherwise `k1` keeps its attributes.

**Inserting `\n`s** creates paragraphs. Let `base` be the attributes of the paragraph containing `p`. Then `next` is `base` with any heading style (`title`, `h1`–`h3`) changed to `p`, and with `pb` removed:
- At the start of a non-empty paragraph, copies of `next` are inserted before it.
- At the end of a paragraph, copies of `next` are inserted after it.
- In the middle, copies of `base` without `pb` are inserted after it.

## Checkpoints

```json
{ "c": 3, "range": [1500, 1999], "events_hash": "...", "doc_hash": "...", "prev": "...", "tsa": "<base64>" }
```

- **`events_hash`:** `SHA-256(join("\n", canonical(event) for each event in range))`.
- **`doc_hash`:** SHA-256 of the document after `range[1]`. It is the text alone when the document has no formatting. Once it has any, it is `text + "\u0000" + canonical({ marks: runs, paras, notes? })`, where `marks` are run-length masks over the whole text, `paras` is the attribute list, and `notes` is present only when there are footnotes.
- **`prev`:** for the first checkpoint, `SHA-256(canonical({ config_hash, student_label, created }))`. After that, the previous checkpoint's hash.
- **Checkpoint hash:** `SHA-256(canonical({ c, range, events_hash, doc_hash, prev }))`.
- **`tsa`:** an RFC 3161 TimeStampToken (CMS ContentInfo, base64 DER) over the checkpoint hash, with a SHA-256 message imprint.

Checkpoints must cover every event, contiguously from 0.

## Final

- **`text`:** the essay text.
- **`hash`:** `SHA-256(text)`.
- **`format`:** `{ marks, paras, notes? }`, only present when the document has formatting or footnotes.

Replaying all events from an empty document must reproduce `text`, and `format` when present, exactly.

## Verifying a file

1. **Replay:** replay the events; the result equals `final.text`, `final.hash`, and `final.format` when present.
2. **Chain:** recompute every checkpoint's `events_hash`, `doc_hash` and `prev` chain.
3. **Assignment:** `config_hash` equals `SHA-256(canonical(config))` and matches the instructor's copy.
4. **Times:** `t` never decreases within a session; sessions don't overlap.
5. **Timestamps:** each token verifies:
   - the imprint equals the checkpoint hash;
   - the CMS signature is valid;
   - the signer has the time-stamping extended key usage and was valid at `genTime`;
   - the signer chains, by verified signatures, to a pinned CA public key (SHA-256 of its SubjectPublicKeyInfo; built-in list in `trust.js`, plus `config.tsa_anchors`).

   `genTime` must not be earlier than the checkpoint's own time (minus a tolerance). Tokens from the demo authority are accepted only when `config.allow_demo_tsa` is true.
