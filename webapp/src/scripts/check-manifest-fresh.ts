/**
 * Fails when dataset-manifest.json is older than any module that produces it.
 * The manifest silently encoded 2026-07-03 code for seven weeks, costing one
 * golden project its entire score and hiding every watermain row. Derived
 * artifacts need a staleness signal, not good intentions.
 *
 * Usage: npm run manifest:check
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const MANIFEST = path.join(ROOT, 'dataset-manifest.json');
const SOURCES = [
  'webapp/src/lib/dataset.ts',
  'webapp/src/lib/truth-facts.ts',
  'webapp/src/scripts/build-dataset-manifest.ts',
  'truth-manifest.json',
];

if (!fs.existsSync(MANIFEST)) {
  console.error('dataset-manifest.json missing — run: npm run dataset:manifest');
  process.exit(1);
}
const manifestMtime = fs.statSync(MANIFEST).mtimeMs;
const stale = SOURCES.filter((rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) && fs.statSync(p).mtimeMs > manifestMtime;
});

if (stale.length) {
  console.error(`dataset-manifest.json is STALE — newer than:\n  ${stale.join('\n  ')}\nRun: npm run dataset:manifest`);
  process.exit(1);
}
console.log('dataset-manifest.json is up to date.');
