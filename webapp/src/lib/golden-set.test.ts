/**
 * golden-set.test.ts — guard rails for the golden evaluation set.
 *
 * The golden set is a list of *dataset folder names* (see golden-set.ts). Those
 * names are typed by hand and the dataset itself is gitignored, so a typo or a
 * renamed/removed folder silently turns into "no prediction cached — skipped" in
 * score-offline.ts and a quietly smaller benchmark. This test makes that loud:
 * every entry must exist on disk AND resolve to non-empty truth through the
 * canonical reader (truth-facts.ts::resolveTruthFacts + truth-manifest.json).
 *
 * The dataset is NOT in the repo, so the disk-backed block skips itself when
 * `existing_projects_training_data/` is absent (clean clone / CI). The pure
 * checks (uniqueness, label shape) always run.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS, FOCUS_SET } from './golden-set';
import { loadTruthManifest, resolveTruthFacts } from './truth-facts';

const ROOT = path.resolve(__dirname, '../../..');
const TRUTH_DIR = path.join(ROOT, 'existing_projects_training_data');
const MANIFEST_FILE = path.join(ROOT, 'truth-manifest.json');
const HAS_DATASET = fs.existsSync(TRUTH_DIR);

// Reading a workbook goes through exceljs; a few of these are large.
const READ_TIMEOUT_MS = 60_000;

describe('GOLDEN_PROJECTS (no dataset required)', () => {
  it('has unique folder names', () => {
    const seen = new Map<string, number>();
    for (const p of GOLDEN_PROJECTS) seen.set(p.folder, (seen.get(p.folder) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([f]) => f);
    expect(dupes, `duplicate golden folders: ${dupes.join(', ')}`).toEqual([]);
  });

  it('has unique labels and every entry is non-empty', () => {
    for (const p of GOLDEN_PROJECTS) {
      expect(p.folder.trim().length, 'empty folder name').toBeGreaterThan(0);
      expect(p.label.trim().length, `empty label for ${p.folder}`).toBeGreaterThan(0);
    }
    expect(new Set(GOLDEN_PROJECTS.map((p) => p.label)).size).toBe(GOLDEN_PROJECTS.length);
  });

  it('FOCUS_SET entries all match at least one golden project', () => {
    for (const needle of FOCUS_SET) {
      const hit = GOLDEN_PROJECTS.some(
        (p) =>
          p.folder.toLowerCase().includes(needle.toLowerCase()) ||
          p.label.toLowerCase().includes(needle.toLowerCase())
      );
      expect(hit, `FOCUS_SET entry "${needle}" matches no golden project`).toBe(true);
    }
  });
});

describe.skipIf(!HAS_DATASET)('GOLDEN_PROJECTS against the local dataset', () => {
  const manifest = HAS_DATASET ? loadTruthManifest(MANIFEST_FILE) : {};

  it.each(GOLDEN_PROJECTS.map((p) => [p.folder, p.label] as const))(
    '%s — folder exists and resolves to non-empty truth',
    async (folder) => {
      const dir = path.join(TRUTH_DIR, folder);
      expect(fs.existsSync(dir), `dataset folder missing: ${dir}`).toBe(true);

      const resolved = await resolveTruthFacts(dir, folder, manifest);
      expect(resolved, `no truth workbook resolved for ${folder}`).not.toBeNull();

      const f = resolved!.facts;
      const structures = f.structures.length;
      const sewers = f.sewers.filter((s) => !s.isLineItem).length;
      expect(
        structures + sewers,
        `${folder} resolved to empty truth (structures=${structures}, sewers=${sewers}, sources=${resolved!.sources.join('|')})`
      ).toBeGreaterThan(0);
    },
    READ_TIMEOUT_MS
  );
});
