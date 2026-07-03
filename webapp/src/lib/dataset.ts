/**
 * Dataset discovery + drawing-PDF selection, shared by the eval runner and the
 * dataset-manifest builder. Civil drawing sets are often nested in subfolders
 * ("… / Drawings / … Civil Drawings.pdf"), so PDF discovery recurses.
 */
import fs from 'fs';
import path from 'path';

// HARD excludes: never a drawing set; no civil hint can rescue.
export const PDF_HARD_EXCLUDE = [
  'quote', 'quotation', 'geotechnical', 'geotech', 'hydrogeological', 'proposal',
  'estimate', 'pricing', 'breakdown', 'budget', 'letter', 'backup', 'invoice',
  'addendum', 'bid form', 'tender_form', 'tender form', 'tipp', 'report', 'rpt',
  'contracting', 'designated substance', 'unit price',
];

// SOFT excludes: discipline tags that co-occur with a bundled civil set. A STRONG
// civil hint overrides these (e.g. "05-Civil Drawings & Specs.pdf").
export const PDF_SOFT_EXCLUDE = [
  'specifications', 'specs', 'structural', 'architectural', 'landscape',
  'electrical', 'mechanical', 'cover sheet',
];

export const PDF_STRONG_CIVIL = ['civil', 'servicing', 'storm', 'sewer', 'watermain', 'grading', 'site servicing'];
export const PDF_CIVIL_HINTS = [...PDF_STRONG_CIVIL, 'drainage', 'plan', 'pnp', 'plan and profile', 'plan & profile', 'site'];

const lc = (f: string) => f.toLowerCase();

/**
 * Choose the civil drawing PDFs from a list of relative paths.
 * HARD/SOFT excludes match the FILENAME (so a folder like "… & TENDER FORM" that
 * holds a servicing drawing isn't wrongly dropped); civil HINTS match the full
 * path (so a "Civil/" or "Drawings/" folder counts as a signal).
 */
export function selectDrawingPdfs(relPaths: string[]): string[] {
  const base = (f: string) => lc(path.basename(f));
  const notHard = relPaths.filter((f) => !PDF_HARD_EXCLUDE.some((b) => base(f).includes(b)));
  const keep = notHard.filter((f) =>
    PDF_STRONG_CIVIL.some((c) => lc(f).includes(c)) || !PDF_SOFT_EXCLUDE.some((b) => base(f).includes(b))
  );
  const civil = keep.filter((f) => PDF_CIVIL_HINTS.some((c) => lc(f).includes(c)));
  return civil.length > 0 ? civil : keep;
}

/** Recursively list all PDF paths (relative to projectDir), deduped by basename. */
export function walkProjectPdfs(projectDir: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'generated_spreadsheets' || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.pdf')) {
        out.push(path.relative(projectDir, full));
      }
    }
  };
  walk(projectDir, 0);
  // Dedupe by basename (same drawing set often duplicated across subfolders);
  // prefer the shallowest path.
  const byBase = new Map<string, string>();
  for (const rel of out.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)) {
    const base = path.basename(rel).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, rel);
  }
  return Array.from(byBase.values());
}

/** Recursively discover and select the civil drawing PDF paths for a project. */
export function chooseDrawingPdfs(projectDir: string): string[] {
  return selectDrawingPdfs(walkProjectPdfs(projectDir));
}
