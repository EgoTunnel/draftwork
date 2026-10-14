// Prints a text summary of every .draftwork file in a folder: integrity, flags, prompts.
//   node tools/report.js samples
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFile } from '../public/js/core/format.js';
import { analyzeFile, finalize } from '../public/js/core/analysis.js';

const dir = process.argv[2] || 'samples';
const names = (await readdir(dir)).filter((n) => n.endsWith('.draftwork'));
const analyses = [];
for (const n of names) analyses.push(await analyzeFile(await parseFile(new Uint8Array(await readFile(join(dir, n))))));
for (const A of analyses) {
  const cohort = analyses.filter((x) => x.cfgHash === A.cfgHash);
  const priors = analyses.filter((x) => x !== A && x.cfgHash !== A.cfgHash && x.header.student_label === A.header.student_label);
  const F = finalize(A, { cohort, priors });
  console.log(`\n== ${A.header.student_label} — ${A.config.title} (${A.events.length} events)`);
  console.log('  integrity: ' + F.integrity.map((c) => `${c.id}:${c.status}`).join(' '));
  for (const c of F.integrity) if (c.status !== 'pass') console.log(`    ${c.id}: ${c.detail}`);
  for (const f of F.flags) console.log(`  FLAG ${f.title}: ${f.reason}`);
  for (const p of F.prompts) console.log(`  ? ${p.question}`);
}
