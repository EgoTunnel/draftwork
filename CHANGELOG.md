# Changelog

Draftwork follows [semantic versioning](https://semver.org/). The file format is versioned separately: **`draftwork/1` is frozen** (see [docs/FORMAT.md](docs/FORMAT.md)), and every release must keep verifying files written by earlier releases.

## Unreleased

### For students
- **Footnotes:** Insert → Footnote, or Ctrl+Alt+F. They're numbered automatically, typed in a Footnotes section at the bottom of the page, and exported as real Word footnotes.
- **Font and size for selected text** from the toolbar, as in Word. The document's default moved to Format → Default font.
- **Header and page numbers** (Format): header text such as your last name, with page numbers top right (MLA), bottom centre, or none. Shown on the page, in print and in Word export.

### For instructors
- **Spell check option:** a new assignment setting allows or turns off the browser's spelling and grammar suggestions.
- **Clearer flags:** every flag has a plain-language title and explanation, with the measurements and thresholds in a smaller line beneath. For example, "Transcription stretch" is now "Typed straight through, like copying".
- **Integrity failures explained:** each failure names what was changed (for example "Submitted text doesn't match its history" or "Student name or start time was changed"), quotes the submitted and recorded versions where they differ, and says when in the writing it happened, with a button to jump there.
- **New flags:**
  - *Typing faster than people type*: long stretches at 140+ words a minute. Not applied to dictated text.
  - *Repeated paste attempts*: 3 or more blocked pastes.
- **More questions to ask:**
  - a paste without a source;
  - the student's AI-use disclosure;
  - the most reworked paragraph;
  - returning to the opening as the draft grew;
  - the most productive return session.
  Five appear as before; up to four more are under **More questions**.

- **Colour-coded submissions:** green for no flags, amber for one or two minor flags, red for a major flag or three or more. Each flag is marked major or minor, and there's a new "Major flags" filter.
- **"File" instead of "Integrity: Passed":** the list now says "Unaltered" or "Altered", and the report's "File integrity" section explains that these checks confirm only that the file is an unaltered Draftwork record, not who wrote it or how.
- **Sample class:** four students who misuse AI in different ways (retyping a chatbot answer from a phone, typing up a chatbot draft from another window, an "AI humaniser" auto-typing tool, and laundering a chatbot essay through the sources panel), each with an AI-use disclosure to compare against the record.
- **Class comparisons hold up when several students cheat:** "Written unusually quickly" also flags anyone under a third of the class's typical time, and "Unnaturally even typing" compares against the class median, so a few outliers don't hide each other.
- The AI-use question asks about what the student said AI was used for (drafting, editing, ideas or feedback).

### Fixes
- The "Where's this from?" prompt shows the pasted text cleanly over two lines.
- **Replay scrolling:** the replay now keeps the writing in view as it plays, instead of jumping back to the top. Scrolling away while it plays is left alone, and a **Follow writing** button brings you back.
- "Written unusually quickly" no longer applies to text that was mostly dictated.

The file format stays `draftwork/1`. The new fields are optional, and documents without them hash exactly as before.

## 0.9.0 — 2026-10-15 (pilot release)

First public release, intended for no-stakes pilots.

### For students
- A word-processor-style editor that records every change, with:
  - styles, lists, page breaks and a Works Cited style;
  - find & replace, smart quotes and special characters;
  - page and full-width views, zoom, print and .docx export.
- Preview shows exactly what the instructor sees; students can add a note to any flag.
- Autosave, earlier versions, save reminders, one tab per draft, and a receipt for every saved file.
- A "Where's this from?" prompt after pasting from outside, and an optional AI-use disclosure.
- A consent notice, a privacy page and a help page.

### For instructors
- Assignments with paste policy, sources panel, word limits, due date, AI disclosure and flag thresholds.
- Open single files or an LMS submissions zip (Canvas, Moodle, Blackboard, Brightspace).
- Five integrity checks, including timestamps that must chain to an approved service.
- Separate flags (never a score), including shared passages between students and heavy quoting.
- The writing-process graph, questions to ask, a replay, and the formatted document.
- Check-in notes, a print summary, and spreadsheet export (named or anonymised).
- Backup and restore of assignments and notes, with warnings when they aren't backed up.

### Hosting
- Node server with a timestamp relay (rotation and fallback across FreeTSA, DigiCert and Sectigo), Dockerfile, serverless relay, and a GitHub Pages workflow with a server-free demo.

### Security
- Script, extension and `execCommand` input is refused and logged, as are synthetic clipboard and drop events.
- Timestamps must chain to pinned CA keys.
- A content security policy on every page.
