# Security policy

Draftwork's value depends on its record being hard to fake, so we want to hear about weaknesses before they're public.

## Reporting

Please **don't open a public issue**. Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**. Include what you did, what you expected, and a minimal example (a crafted `.draftwork` file is fine; please don't send real student work).

We'll acknowledge reports within a week and agree on a disclosure date once a fix is ready.

## In scope

- Getting a file to pass integrity checks when it was edited or built outside the sandbox.
- Getting text into the document that bypasses the paste policy without being logged.
- Timestamp verification accepting a token it shouldn't.
- Leaking student text or personal data from the browser, the relay or the viewer.
- Cross-site scripting or similar in the pages (e.g. via a crafted file opened in the viewer).

## Known limits (not vulnerabilities)

These are documented in the spec's threat model:

- Retyping text from another device, or a carefully human-paced autotyper, produces a genuine-looking record. The check-in conversation is the defence.
- Anyone can build a whole log with a fake history if they also control a timestamp service that Draftwork accepts. Only pinned public services are accepted.
- The demo timestamp service proves nothing; it is only accepted by assignments marked as tests.
