# Contributing to Draftwork

Thanks for helping. Draftwork is used to talk with students about their writing, so changes are judged by two questions: does it keep the record trustworthy, and is it fair to students?

## Ways to help

- **Try it with a class** and tell us what was confusing, what helped, and what the flags got wrong. Calibration data (the anonymised export) is especially valuable; please share it only with your students' and institution's consent.
- **Test browsers and assistive technology** we can't easily cover: Safari, Firefox, Mac and Windows dictation, Chinese/Japanese/Korean input methods, NVDA, JAWS, VoiceOver.
- **Report bugs** with the browser and steps. If a file fails a check it shouldn't, say so, but don't attach a student's file without their permission.
- **Security issues:** see [SECURITY.md](SECURITY.md). Please don't open public issues for ways to bypass the record.

## Development

No dependencies. You need Node 20+ and, for browser tests, Chrome or Edge.

```bash
npm start            # http://localhost:8080 (real timestamps)
npm run start:mock   # offline, demo timestamps
npm run simulate     # generate the demo class in samples/
npm test             # unit and integration tests
npm run test:e2e     # real-browser tests (Chrome/Edge)
npm run test:live    # check the approved timestamp services (needs internet)
```

The code is plain ES modules; `public/js/core` runs in both the browser and Node, `public/js/ui` is browser-only. Match the surrounding style, keep comments for the non-obvious, and add a test for behaviour changes.

## Ground rules for changes

- **Never break existing files.** A `.draftwork` file written by any released version must keep verifying. New fields must be optional; anything that changes what is hashed needs a new format version.
- **Replay must stay deterministic.** If you change how events apply to the document (`public/js/core/doc.js`), existing logs must replay identically.
- **Flags, never scores.** Don't add a combined score or ranking. Every new flag needs a one-line reason and innocent explanations shown beside it.
- **Students see what instructors see.** Anything added to the viewer should also appear in the student's Preview.
- **No new data leaves the student's computer** without discussion first. Today only checkpoint hashes do.

## Pull requests

Keep them focused, describe the user-visible change, and say how you tested it. `npm test` must pass; run `npm run test:e2e` for editor changes.

By contributing, you agree your contributions are licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
