# Deploying Draftwork

Students need to reach Draftwork over **HTTPS** at a stable address. Drafts and instructors' saved assignments live in the browser per address, so don't change the address mid-term.

Draftwork has two parts:

- **The pages** (`public/`): static files.
- **The timestamp relay** (`/tsa`): forwards a hash to a public RFC 3161 service, because those services don't accept requests from browsers. It keeps no state and never sees student text.

## Option 0: a free public demo on GitHub Pages

The repository includes `.github/workflows/pages.yml`. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. Every push to `main` then publishes the site with the sample class.

- **Without a relay**, new assignments are **test assignments**: timestamps are simulated in the browser. That's right for a demo, but not for grading.
- **To enable real assignments**, deploy the relay from Option B and set the repository variable `DRAFTWORK_RELAY_URL` (**Settings → Secrets and variables → Actions → Variables**) to its URL. The next publish uses it.

To build the same site locally, run the command below. The site goes into `dist/`; add `--relay <url>` to point it at a relay.

```bash
npm run build
```

## Option A: one container (simplest)

The Docker image serves the pages and the relay together.

```bash
docker build -t draftwork .
```

```bash
docker run -p 8080:8080 draftwork
```

- **Where to run it:** any container host works (Render, Fly.io, Railway, Azure Container Apps, a school VM). Put it behind the host's HTTPS.
- **Proxy:** `TRUST_PROXY=1` is set in the image, so rate limiting uses the client address from the proxy.
- **Health check:** `/healthz`.
- **Timestamp services:** the relay tries FreeTSA, then DigiCert, then Sectigo, and remembers whichever answered last. Override the order with `DRAFTWORK_TSA=url1,url2,...`.
- **Rate limit:** 60 requests per minute per client. Students stamp about once a minute.

Without Docker: `node server.js --port 8080 --host 0.0.0.0` (Node 20+).

## Option B: static pages plus a serverless relay

1. Put `public/` on any static host (GitHub Pages, Netlify, Cloudflare Pages, a school web server).
2. Deploy `deploy/relay-worker.js` as a Cloudflare Worker or another fetch-style serverless function. It has the same fallback list and allows cross-origin requests.
3. When creating assignments, open **Advanced → Timestamp service** and enter the relay's URL, e.g. `https://draftwork-relay.example.workers.dev`.

## Before a real class

- **Test the server:** create a test assignment and write a few sentences as a student. Preview should show **Timestamps are verified**, from a named service.
- **Trusted services:** new assignments accept FreeTSA, DigiCert, Sectigo, GlobalSign and SSL.com, pinned by CA public key in `public/js/core/trust.js`. To use another service, add its CA key fingerprint under **Advanced → Extra approved timestamp services**.
- **Live check:** `node tests/live-tsa.js` confirms every pinned service still answers and verifies.
- **Never use `--mock-tsa` for real classes.** It is for offline testing, and its timestamps prove nothing. Students' pages refuse to start a real assignment against a test-mode server.
- **Data notice:** adapt `docs/student-data-notice.md` for your institution and link to it alongside `privacy.html`.
