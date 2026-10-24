/**
 * The S2 vision hook: the offline half (candidate detection, prompt,
 * response parsing). The production reader that spends the model call
 * lives in extraction.ts and is injected into assembleHybridTakeoff as
 * `readWmTable`; with no reader injected the hook cannot fire, so
 * offline replays stay byte-identical.
 *
 * WHY THIS EXISTS. S2 (wm-table-miner.ts) mines printed WATERMAIN
 * LENGTHS tables, but on the one corpus project that prints one —
 * Panattoni — the table is stroke-font vector art: the text layer
 * yields single-character glyph items ('X'-garbage), and the table
 * cells exist in NO text channel. The hook issues ONE targeted
 * transcription of a candidate page, asking only for that table, and
 * feeds the result into S2's existing transcript grammar (channel
 * 'vision'). S2's validation, fill-only attach, conflict poisoning and
 * refusal rules apply unchanged.
 *
 * CANDIDATE SIGNATURE — PR50 REBASE (conjunctive, fail-closed; every
 * gate at routing/assembly time, every signal intrinsic to the page
 * itself — nothing depends on how a transcript roll happens to fall).
 * PR49's original signature keyed the candidate page off a FRAGMENT
 * of the table in the page's general transcript tile (scope-header +
 * bare number-pair lines). The PR49 live gate null result proved that
 * fragment is a frozen-cache artifact: the live roll transcribed 96
 * tiles where the cache had 143 and never produced the fragment tile,
 * so the hook never fired, though the table page itself satisfied
 * every page-intrinsic gate. The fragment condition is therefore
 * DROPPED ENTIRELY. What remains:
 *   0. S2 enabled (same kill switch, DISABLE_WM_TABLE_MINER) AND the
 *      first mining pass claimed ZERO tables — the hook is a last
 *      resort for tables no channel could read, never a second read
 *      of a table already claimed.
 *   1. The merged facts carry ≥1 watermain diameter whose every
 *      segment length is unstated (0) — a fill must be possible.
 *   2. The page is NOT texty (a texty page's layer routes it to the
 *      text paths already, and its table — if any — is S2's text /
 *      transcript channels' job, not the hook's).
 *   3. The page's text layer is glyph garbage: ≥50 items with ≥40%
 *      single-character items — the layer exists but cannot be read,
 *      which is what separates a stroke-font sheet from a clean
 *      raster scan (few/no items) and from a readable text page.
 *   4. The page is a LOCATED plan/servicing sheet, proven from the
 *      page itself:
 *      - it is in the run's located set (an unlocated page is never
 *        a candidate — the locator did not claim it as takeoff
 *        bearing), AND
 *      - its recorded Phase-0 classification (page-classifier.ts)
 *        is CLAIMED and of a text-bearing sheet kind (P2 annotation-
 *        form or P5 text-bearing — the only kinds a glyph-garbage
 *        page can carry: ≥50 items rules out P4/P6, and non-texty
 *        rules out P1/P3; a suspect classification is unmeasured
 *        evidence and never fires), AND
 *      - the layer's readable items carry the sheet's own title,
 *        title-shaped (a single item of ≤ 40 chars — the sheet title
 *        as printed in the title block, e.g. "SERVICING PLAN" /
 *        "SITE SERVICING PLAN", not a prose sentence mentioning the
 *        word), naming SERVICING. A watermain lengths table is a
 *        servicing-plan artifact; on the corpus this title gate is
 *        what separates Panattoni's three C101 servicing sheets
 *        (title item "SERVICING PLAN") from its five C100 grading
 *        sheets (title item "GRADING PLAN", zero SERVICING items)
 *        whose glyph layers are otherwise indistinguishable, and it
 *        fails closed on sheets whose titles are themselves glyphs
 *        (Panattoni's own C300/C301 below-ground servicing sheets,
 *        Wigmore) — a missed read costs today's behaviour, never a
 *        wrong one.
 *   Spend bound: at most WM_HOOK_MAX_CALLS_PER_JOB targeted reads per
 *   job (candidates in page order); further candidates are recorded
 *   as budget-refused in the S2 firing record, never silently dropped.
 *
 * Corpus census for this signature (PR50, pr50-census.ts over the 26
 * golden projects): fires on exactly 4 pages — Panattoni's three
 * located C101 servicing sheets (incl. p9, the table page) and
 * Milton's site servicing plan. See pr50_evidence.md.
 */
import { isTextyPage, type PageText } from './pdf-text';
import { isSpecialistDisabled } from './specialists';
import type { PageClassification, TakeoffFacts, TileTranscript } from './types';
import { WM_TABLE_MINER_ID } from './wm-table-miner';

export const WM_HOOK_GLYPH_MIN_ITEMS = 50;
export const WM_HOOK_GLYPH_MIN_SINGLE_FRACTION = 0.4;
/** Per-job spend bound for targeted reads (the registry-budget
 *  discipline: a specialist's live cost is capped, and the cap's
 *  refusals are recorded). Set to the corpus's largest defensible
 *  candidate count in one job — Panattoni's three located servicing-
 *  titled glyph sheets. */
export const WM_HOOK_MAX_CALLS_PER_JOB = 3;
/** A sheet title is a short printed line, not a sentence: the title
 *  items measured on the corpus are ≤19 chars ("SITE SERVICING
 *  PLAN"); the measured prose negative (a Milton note sentence,
 *  "GRADING PLAN COMPLETED FOR THE SUBDIVISION BY SCS …") is ~50. */
export const WM_HOOK_TITLE_MAX_CHARS = 40;

const SERVICING_TITLE_RE = /\bSERVICING\b/i;

export interface GlyphGarbageStats {
  items: number;
  /** Fraction of items whose trimmed text is ≤1 character. */
  singleCharFraction: number;
}

/** The stroke-font signature: a text layer full of single glyphs. */
export function glyphGarbageStats(pt: PageText): GlyphGarbageStats {
  const items = pt.items.length;
  if (items === 0) return { items: 0, singleCharFraction: 0 };
  const single = pt.items.filter((i) => i.text.trim().length <= 1).length;
  return { items, singleCharFraction: single / items };
}

/**
 * The sheet's own title, when the layer's readable items carry it
 * title-shaped: a single short item naming SERVICING ("SERVICING
 * PLAN", "SITE SERVICING PLAN"). Returns the item's text, or null.
 * Prose mentions (long sentence items) are not titles and never
 * qualify — the title block is the sheet's identity, printed as a
 * standalone line; a note talking about servicing is not the sheet
 * being a servicing sheet.
 */
export function servicingTitleOf(pt: PageText): string | null {
  for (const item of pt.items) {
    const text = item.text.trim();
    if (text.length > 0 && text.length <= WM_HOOK_TITLE_MAX_CHARS && SERVICING_TITLE_RE.test(text)) {
      return text;
    }
  }
  return null;
}

/** Watermain diameters present in the facts with NO stated segment
 *  length — the only diameters a table fill could ever land on. */
export function fillEligibleWmDiameters(facts: TakeoffFacts): number[] {
  const present = new Set<number>();
  const stated = new Set<number>();
  for (const w of facts.watermain ?? []) {
    if (w.pipeDiameter == null || !(w.pipeDiameter > 0)) continue;
    present.add(w.pipeDiameter);
    if ((w.length ?? 0) > 0) stated.add(w.pipeDiameter);
  }
  return [...present].filter((d) => !stated.has(d)).sort((a, b) => a - b);
}

export interface WmTableCandidate {
  page: number;
  /** The page's claimed Phase-0 kind (P2 or P5 — see the header). */
  kind: string;
  /** The sheet-title item that proved the servicing sheet. */
  title: string;
  /** Glyph-gate values for the page, for the firing record. */
  items: number;
  singleCharFraction: number;
}

export interface WmTableCandidateInput {
  pageTexts: PageText[];
  /** The run's located pages — a page outside this set never fires. */
  locatedPages: number[];
  /** Phase-0 classification per page, as recorded for diagnostics;
   *  null (unmeasured) → no fire: unproven sheet, no spend. */
  classifications: Map<number, PageClassification> | null;
  facts: TakeoffFacts;
  /** Tables the first mining pass already claimed (any channel). */
  tablesClaimed: number;
}

/** The conjunctive candidate detector (see the header for the gates). */
export function detectWmTableCandidates(input: WmTableCandidateInput): WmTableCandidate[] {
  if (isSpecialistDisabled(WM_TABLE_MINER_ID)) return [];
  if (input.tablesClaimed > 0) return [];
  if (!input.classifications) return [];
  if (fillEligibleWmDiameters(input.facts).length === 0) return [];
  const located = new Set(input.locatedPages);
  const candidates: WmTableCandidate[] = [];
  for (const pt of input.pageTexts) {
    if (!located.has(pt.page)) continue;
    if (isTextyPage(pt)) continue;
    const glyph = glyphGarbageStats(pt);
    if (glyph.items < WM_HOOK_GLYPH_MIN_ITEMS) continue;
    if (glyph.singleCharFraction < WM_HOOK_GLYPH_MIN_SINGLE_FRACTION) continue;
    const cls = input.classifications.get(pt.page);
    if (!cls || cls.kindTier !== 'claimed') continue;
    if (cls.kind !== 'P2' && cls.kind !== 'P5') continue;
    const title = servicingTitleOf(pt);
    if (!title) continue;
    candidates.push({
      page: pt.page,
      kind: cls.kind,
      title,
      items: glyph.items,
      singleCharFraction: glyph.singleCharFraction,
    });
  }
  return candidates.sort((a, b) => a.page - b.page);
}

/** The fail-closed read prompt: transcribe ONLY a printed watermain
 *  lengths table, verbatim, or report none. No measuring, no
 *  inference, no other content. */
export function buildWmTableReadPrompt(projectName: string, page: number, tileCount: number): string {
  return [
    `You are reading sheet ${page} of the civil servicing drawings for "${projectName}".`,
    `The attached ${tileCount} image(s) are overlapping tiles of that one sheet, in reading order.`,
    '',
    'TASK: Find a printed table titled "WATERMAIN LENGTHS" (or "WATERMAIN LENGTH") — a table whose rows are watermain diameters (for example "100mm") and whose columns are lengths in metres, possibly split by scope (for example "BLDG A" and "BLDG B") or with a "TOTAL" column.',
    '',
    'Transcribe that table EXACTLY as printed: its title, its header row, and every data row, cell by cell. Copy numbers digit for digit. Do NOT add, estimate, measure, scale, convert or correct anything. Do NOT report any other table, and do NOT report watermain information from anywhere else on the sheet — no callouts, no pipe labels, no notes.',
    '',
    'If the sheet does not legibly contain such a table, respond: {"tablePresent": false}',
    '',
    'Otherwise respond with JSON only:',
    '{"tablePresent": true, "title": "<the title exactly as printed>", "header": ["<cell>", ...], "rows": [["<diameter cell>", "<number cell>", ...], ...]}',
    'The header array is the table\'s header row in column order; its first cell is the diameter column\'s header (use "" if that corner cell is blank). If the table has no header row, set "header": null. Each row\'s first cell is the diameter exactly as printed (for example "100mm").',
  ].join('\n');
}

/**
 * Validate a targeted-read response and convert it to ONE synthetic
 * transcript tile (title line, pipe-joined header, pipe-joined rows)
 * for S2's transcript grammar. Anything malformed → null: the read is
 * discarded whole, never partially trusted. S2 re-validates the grid
 * (title shape, diameter rows, header semantics) before any fill.
 */
export function parseWmTableReadResponse(parsed: unknown, _page: number): TileTranscript | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.tablePresent !== true) return null;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!title || !/\bWATERMAIN\b/i.test(title) || !/\bLENGTH/i.test(title)) return null;
  const cellText = (c: unknown): string | null => {
    if (typeof c === 'string') return c.trim();
    if (typeof c === 'number' && Number.isFinite(c)) return String(c);
    return null;
  };
  let headerLine: string | null = null;
  if (obj.header != null) {
    if (!Array.isArray(obj.header)) return null;
    const cells: string[] = [];
    for (const c of obj.header) {
      const t = cellText(c);
      if (t == null) return null;
      cells.push(t);
    }
    if (cells.length < 2) return null;
    headerLine = cells.join(' | ');
  }
  if (!Array.isArray(obj.rows) || obj.rows.length < 2) return null;
  const rowLines: string[] = [];
  for (const r of obj.rows) {
    if (!Array.isArray(r) || r.length < 2) return null;
    const cells: string[] = [];
    for (const c of r) {
      const t = cellText(c);
      if (t == null) return null;
      cells.push(t);
    }
    if (!cells[0]) return null;
    rowLines.push(cells.join(' | '));
  }
  const lines = [title, ...(headerLine ? [headerLine] : []), ...rowLines];
  // Tile 0 marks a synthetic read, not a transcription tile; provenance
  // rides on the table's channel ('vision') and page, set by the miner.
  return { tile: 0, blocks: [lines] };
}
