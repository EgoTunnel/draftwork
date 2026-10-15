// Builds a static copy of Draftwork in dist/ for GitHub Pages or any static host.
//
//   node tools/build-static.js [--relay https://your-relay.example.workers.dev] [--out dist] [--no-samples]
//
// Without --relay (or RELAY_URL), the site works as a demo: new assignments are test assignments
// whose timestamps are simulated in the browser. With a relay, real assignments work too.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateClass } from './simulate.js';
import { serializeFile, fileName, encodeConfig } from '../public/js/core/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 && args[args.indexOf(n) + 1] ? args[args.indexOf(n) + 1] : d);
const OUT = resolve(ROOT, opt('--out', 'dist'));
const RELAY = opt('--relay', process.env.RELAY_URL || '') || null;
// Who runs this copy (shown on the privacy page), e.g. "Writing Centre, Example College (writing@example.edu)".
const OPERATOR = opt('--operator', process.env.DRAFTWORK_OPERATOR || '') || null;

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, 'public'), OUT, { recursive: true });
await writeFile(join(OUT, '.nojekyll'), '');
await writeFile(join(OUT, 'site.json'), JSON.stringify({ static: true, relay: RELAY, operator: OPERATOR }, null, 2));

if (!args.includes('--no-samples')) {
  const dir = join(OUT, 'samples');
  await mkdir(dir, { recursive: true });
  const { config, prior, files } = await simulateClass();
  const names = [];
  for (const { file } of files) {
    const name = fileName(file);
    await writeFile(join(dir, name), await serializeFile(file));
    names.push(name);
  }
  await writeFile(join(dir, 'assignment-codes.txt'),
    `${config.title}\n${await encodeConfig(config)}\n\n${prior.title}\n${await encodeConfig(prior)}\n`);
  names.push('assignment-codes.txt');
  await writeFile(join(dir, 'index.json'), JSON.stringify(names));
  console.log(`Bundled ${files.length} sample submissions.`);
}
console.log(`Built ${OUT} (${RELAY ? `timestamps via ${RELAY}` : 'demo mode: simulated timestamps for test assignments'})`);
