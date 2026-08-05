/**
 * provenance.ts — drop extracted structures whose label was never printed on the drawing.
 *
 * WHY THIS EXISTS. The single-pass vision path fabricates contiguous label runs: asked for
 * a JSON list of structures it emits "DCBMH 1..DCBMH 29" where the drawing has one, with
 * complete, plausible, arithmetically-generated elevations attached. Measured over the
 * golden set, no output-side heuristic separates those from real ones:
 *   - long contiguous run  -> 45% of REAL structures are in one too (MH 100..109 is real)
 *   - missing data         -> fabrications carry a full field set
 *   - no sewer endpoint    -> kills 115 bogus but loses 26 real (+1.3pp F1; rejected)
 * A fabricated "CBMH 12" and a real one are byte-identical. The distinguishing information
 * is not in the JSON — it was destroyed upstream.
 *
 * So don't filter on plausibility, verify against evidence: a coded label that appears
 * nowhere in the page's text objects was not read off the drawing. On the golden set's
 * worst case this drops 29 of 29 fabricated labels and 0 real ones.
 *
 * PASS ONLY THE LOCATED PAGES. This is load-bearing, not a detail. Measured over the
 * golden set, using the whole document as evidence REGRESSES the metric (F1 40.5% -> 38.7%,
 * 13 real structures deleted on Ultimate Drive): a drawing set's detail/spec sheets are
 * frequently the only ones with a text layer, and the labels on them belong to standard
 * details, not to this site's structures — enough coincidental hits to satisfy the
 * corroboration guard while the real plan sheet is pure SHX/vector. Restricted to the
 * pages the extractor actually read, the same check drops 30 bogus and 0 real.
 *
 * SCOPE. Deliberately narrow, because a false drop costs recall:
 *   - only pages with a real text layer (isTextyPage) are usable as evidence;
 *   - only CODED labels (MH 5, CBMH 12, DICB 3) are checked — those are printed verbatim.
 *     Estimator note suffixes ("MH 8/EXT.DROP") are matched on the code stem, and any
 *     label without a code stem is left alone;
 *   - the text layer must prove it actually carries structure labels (MIN_CORROBORATED)
 *     before any drop is allowed. A sheet whose title block is real text but whose labels
 *     are SHX/vector would otherwise delete the entire extraction.
 *
 * NOTE ON WHAT THIS BUYS. It verifies "was this printed on the drawing", not "is this in
 * the estimator's scope". A label genuinely on the plan but absent from the takeoff is
 * correctly kept here and still scores as a false positive against truth.
 */
import { StructureFact } from './types';
import { PageText, isTextyPage } from './pdf-text';

/** Leading structure code + number (+ optional letter), e.g. "MH 8/EXT.DROP" -> MH/8. */
const CODE_STEM = /^\s*(DDICB|DCBMH|CBMH|DICB|DCB|STMH|SANMH|MH|CB|HS|OS|OGS)\s*-?\s*(\d+)\s*([A-Z])?\b/i;

/**
 * How many coded labels must be corroborated before absence counts as evidence.
 * If the text layer yields fewer than this, we cannot conclude it carries structure
 * labels at all, so nothing is dropped. Two, not one, so a single coincidental hit
 * can't unlock mass deletion.
 */
const MIN_CORROBORATED = 2;

interface Stem { code: string; num: string; suffix: string }

function parseStem(description: string): Stem | null {
  const m = CODE_STEM.exec(String(description ?? ''));
  if (!m) return null;
  return { code: m[1].toUpperCase(), num: m[2], suffix: (m[3] ?? '').toUpperCase() };
}

/** "CBMH 12" -> "CBMH12"; null when the label carries no structure code. */
export function codeStem(description: string): string | null {
  const s = parseStem(description);
  return s ? `${s.code}${s.num}${s.suffix}` : null;
}

/**
 * Normalize page text to uppercase alphanumerics separated by single spaces. Punctuation
 * becomes a space rather than vanishing, so "CBMH-12" and "CBMH 12" normalize alike while
 * genuinely separate tokens stay separate.
 */
function normalizeText(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * Does this exact structure label appear in the drawing text?
 *
 * Matching is boundary-aware, which matters in both directions: a naive substring test
 * corroborates "MH 1" from the "MH1" inside "CBMH12", and corroborates "MH 12" from
 * "MH 120". The lookarounds forbid an adjacent letter/digit on either side. Whitespace
 * between the code and the number is optional because pdf.js frequently splits a label
 * into separate text items ("CBMH" + "12").
 */
function isPrinted(stem: Stem, text: string): boolean {
  const re = new RegExp(
    `(?<![A-Z0-9])${stem.code}\\s*${stem.num}${stem.suffix ? `\\s*${stem.suffix}` : ''}(?![A-Z0-9])`
  );
  return re.test(text);
}

export interface ProvenanceResult {
  structures: StructureFact[];
  /** Labels dropped as never-printed, for the warnings list. */
  dropped: string[];
  /** Why the check no-opped, when it did. */
  skipped?: 'no-text-layer' | 'labels-not-in-text-layer';
}

/**
 * Filter `structures` down to those whose coded label appears in the text of `pages`.
 * Non-coded labels — and every structure, when the evidence is too weak to trust —
 * pass through untouched.
 *
 * @param pages MUST be only the located//read pages, not the whole document. See the
 *   module header: passing everything measurably deletes real structures.
 */
export function verifyStructureProvenance(
  structures: StructureFact[],
  pages: PageText[]
): ProvenanceResult {
  const texty = pages.filter(isTextyPage);
  if (texty.length === 0) return { structures, dropped: [], skipped: 'no-text-layer' };

  const text = normalizeText(texty.flatMap((p) => p.items.map((i) => i.text)).join(' '));

  const coded = structures
    .map((s) => ({ s, stem: parseStem(s.description) }))
    .filter((x): x is { s: StructureFact; stem: Stem } => x.stem !== null);

  const corroborated = new Set(
    coded.filter((x) => isPrinted(x.stem, text)).map((x) => codeStem(x.s.description)!)
  );

  // The text layer has to demonstrate it carries structure labels before its silence
  // means anything. Otherwise a labels-are-SHX sheet would wipe the extraction.
  if (corroborated.size < MIN_CORROBORATED) {
    return { structures, dropped: [], skipped: 'labels-not-in-text-layer' };
  }

  const dropped: string[] = [];
  const kept = structures.filter((s) => {
    const stem = parseStem(s.description);
    if (stem === null) return true;              // no code to verify — leave it alone
    if (isPrinted(stem, text)) return true;
    dropped.push(s.description);
    return false;
  });

  return { structures: kept, dropped };
}
