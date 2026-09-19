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
  'estimate', 'pricing', 'budget', 'proposal', 'unit price', 'schedule of values',
];

// BASENAME-level hard excludes: never a drawing set, but matched on the filename
// only so a real "…Civil.pdf" inside e.g. a "… & TENDER FORM" folder isn't dropped.
export const PDF_HARD_EXCLUDE = [
  'breakdown', 'letter', 'backup', 'addendum', 'bid form', 'tender_form',
  'tender form', 'tipp', 'report', 'rpt', 'contracting', 'designated substance',
  'bid leveling', 'leveling', 'locate', 'locates', 'schedule of values',
  'base', 'background',
];

// SOFT excludes: discipline tags that co-occur with a bundled civil set. A STRONG
// civil hint overrides these (e.g. "05-Civil Drawings & Specs.pdf").
export const PDF_SOFT_EXCLUDE = [
  'specifications', 'specs', 'structural', 'architectural', 'landscape',
  'electrical', 'mechanical', 'cover sheet',
];

export const PDF_STRONG_CIVIL = [
  'civil', 'servicing', 'storm', 'sewer', 'watermain', 'grading', 'site servicing',
];
export const PDF_CIVIL_HINTS = [
  ...PDF_STRONG_CIVIL, 'drainage', 'plan', 'pnp', 'plan and profile', 'plan & profile', 'site',
];

// Standard civil drawing sheet-code patterns (e.g., SS-1, A01SS, C101A, STM-1, SAN-1, PNP)
const CIVIL_SHEET_PATTERN = /(?:^|[^a-z0-9])(?:ss|stm|san|wm|pnp|c\d{2,3})(?:-\d+|\d+)?(?:[^a-z0-9]|$)/i;

const lc = (f: string) => f.toLowerCase();

/**
 * Whole-word (token) match: `hasWord('topsite bid', 'site')` is false, but
 * `hasWord('site servicing plan', 'site')` is true. Prevents civil hints like
 * "site" from firing on unrelated substrings ("topSITE", "offSITE").
 */
const hasWord = (text: string, kw: string) =>
  new RegExp('(?:^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'i').test(text);

/**
 * Civil signals read from the FILENAME only. Deliberately not the full path —
 * see the narrowing step in selectDrawingPdfs for why a folder name must not
 * decide that a file is a drawing.
 */
const isCivilName = (f: string) =>
  PDF_CIVIL_HINTS.some((c) => hasWord(lc(path.basename(f)), c)) ||
  CIVIL_SHEET_PATTERN.test(path.basename(f));

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
    PDF_STRONG_CIVIL.some((c) => hasWord(lc(f), c)) ||
    CIVIL_SHEET_PATTERN.test(base(f)) ||
    !PDF_SOFT_EXCLUDE.some((b) => base(f).includes(b))
  );
  // Civil evidence in the FILENAME may narrow the set; civil evidence that exists
  // only in a FOLDER name may not. A folder is shared by everything inside it, so
  // one unrelated document sitting in a civil-sounding folder would otherwise
  // become the only "civil" file and discard the real drawings — which is exactly
  // how a tender acknowledgment checklist in ".../Site Services & Rough Grading/"
  // became the sole selection for 2026-018 Gerrard, scoring a hard 0%. Path-level
  // evidence still does its other job above, where a STRONG civil word anywhere in
  // the path rescues a file from the SOFT excludes — that only ever keeps more.
  const civil = keep.filter((f) => isCivilName(f));
  const chosen = civil.length > 0 ? civil : keep;
  const ranked = rankBySheetCode(chosen);

  // If dedicated servicing sheets (rank 0) exist, drop pure standard detail sheets (rank 3)
  // so they do not crowd out the tile/token budget on multi-file projects.
  const hasServicing = ranked.some((p) => getSheetCodeRank(p) === 0);
  if (hasServicing) {
    const withoutDetails = ranked.filter((p) => getSheetCodeRank(p) < 3);
    if (withoutDetails.length > 0) return withoutDetails;
  }
  return ranked;
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

export function getSheetCodeRank(p: string): number {
  const base = path.basename(p);
  for (const [re, r] of SHEET_CODE_RANK) if (re.test(base)) return r;
  return 2.5; // unknown code: ahead of details, behind servicing/grading/erosion
}

export function rankBySheetCode(paths: string[]): string[] {
  return [...paths].sort((a, b) => getSheetCodeRank(a) - getSheetCodeRank(b) || a.localeCompare(b));
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
