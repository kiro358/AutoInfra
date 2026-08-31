/**
 * Dataset discovery + drawing-PDF selection, shared by the eval runner and the
 * dataset-manifest builder. Civil drawing sets are often nested in subfolders
 * ("… / Drawings / … Civil Drawings.pdf"), so PDF discovery recurses.
 */
import fs from 'fs';
import path from 'path';

// PATH-level hard excludes: strong "not a drawing" signals that disqualify a PDF
// wherever they appear in its path (e.g. a "granular quote/" subfolder).
export const PDF_HARD_EXCLUDE_PATH = [
  'quote', 'quotation', 'invoice', 'geotechnical', 'geotech', 'hydrogeological',
  'estimate', 'pricing', 'budget', 'proposal', 'unit price',
];

// BASENAME-level hard excludes: never a drawing set, but matched on the filename
// only so a real "…Civil.pdf" inside e.g. a "… & TENDER FORM" folder isn't dropped.
export const PDF_HARD_EXCLUDE = [
  'breakdown', 'letter', 'backup', 'addendum', 'bid form', 'tender_form',
  'tender form', 'tipp', 'report', 'rpt', 'contracting', 'designated substance',
  'bid leveling', 'leveling', 'locate', 'locates',
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
 * Whole-word (token) match: `hasWord('topsite bid', 'site')` is false, but
 * `hasWord('site servicing plan', 'site')` is true. Prevents civil hints like
 * "site" from firing on unrelated substrings ("topSITE", "offSITE").
 */
const hasWord = (text: string, kw: string) =>
  new RegExp('(?:^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'i').test(text);

/**
 * Choose the civil drawing PDFs from a list of relative paths.
 * HARD/SOFT excludes match the FILENAME (so a folder like "… & TENDER FORM" that
 * holds a servicing drawing isn't wrongly dropped); civil HINTS match the full
 * path (so a "Civil/" or "Drawings/" folder counts as a signal).
 */
export function selectDrawingPdfs(relPaths: string[]): string[] {
  const base = (f: string) => lc(path.basename(f));
  const notHard = relPaths.filter((f) =>
    !PDF_HARD_EXCLUDE_PATH.some((b) => lc(f).includes(b)) &&
    !PDF_HARD_EXCLUDE.some((b) => base(f).includes(b))
  );
  const keep = notHard.filter((f) =>
    PDF_STRONG_CIVIL.some((c) => hasWord(lc(f), c)) || !PDF_SOFT_EXCLUDE.some((b) => base(f).includes(b))
  );
  const civil = keep.filter((f) => PDF_CIVIL_HINTS.some((c) => hasWord(lc(f), c)));
  const chosen = civil.length > 0 ? civil : keep;
  return rankBySheetCode(chosen);
}

// Servicing sheets carry the takeoff; grading/erosion/detail sheets rarely do.
// Ranking (not filtering) means nothing is lost — the servicing plan is simply
// decoded first when a page/tile budget applies.
// Sheet codes are digit-adjacent (e.g., A01SS), so the leading boundary is [^a-z]
// (not a letter) rather than [^a-z0-9] (not a letter or digit).
const SHEET_CODE_RANK: [RegExp, number][] = [
  [/(?:^|[^a-z])(?:ss|site\s*servicing|servicing)(?:[^a-z0-9]|$)/i, 0],
  [/(?:^|[^a-z])(?:sg|grading)(?:[^a-z0-9]|$)/i, 1],
  [/(?:^|[^a-z])(?:ec|erosion)(?:[^a-z0-9]|$)/i, 2],
  [/(?:^|[^a-z])(?:d\d|det|detail)(?:[^a-z0-9]|$)/i, 3],
];

export function rankBySheetCode(paths: string[]): string[] {
  const rank = (p: string) => {
    const base = path.basename(p);
    for (const [re, r] of SHEET_CODE_RANK) if (re.test(base)) return r;
    return 2.5; // unknown code: ahead of details, behind servicing/grading/erosion
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
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
