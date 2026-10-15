# Changelog

Draftwork follows [semantic versioning](https://semver.org/). The file format is versioned separately: **`draftwork/1` is frozen** (see [docs/FORMAT.md](docs/FORMAT.md)), and every release must keep verifying files written by earlier releases.

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
