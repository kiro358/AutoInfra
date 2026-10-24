/**
 * PR49 — the S2 vision hook: the offline half (candidate detection,
 * tile→page attribution, prompt, response parsing). The production
 * reader that spends the model call lives in extraction.ts and is
 * injected into assembleHybridTakeoff as `readWmTable`; with no reader
 * injected the hook cannot fire, so offline replays stay byte-identical.
 *
 * WHY THIS EXISTS. S2 (wm-table-miner.ts) mines printed WATERMAIN
 * LENGTHS tables, but on the one corpus project that prints one —
 * Panattoni — the table is stroke-font vector art: the text layer
 * yields single-character glyph items ('X'-garbage), and the table
 * cells exist in NO text channel. The general tile transcription DID
 * read the table's value columns (its tile carries "BLDG A | BLDG B"
 * and bare number pairs "167 | 70", "316 | 40", "39 | 27", "24 | 20")
 * but not its title, diameter column, or first row — so S2's grammar
 * cannot claim it from the general transcript. The hook issues ONE
 * targeted transcription of the candidate page, asking only for that
 * table, and feeds the result into S2's existing transcript grammar
 * (channel 'vision'). S2's validation, fill-only attach, conflict
 * poisoning and refusal rules apply unchanged.
 *
 * CANDIDATE SIGNATURE (conjunctive, fail-closed — every gate must
 * hold; corpus census 2026-10-24: fires on exactly one page of the 26
 * golden projects, Panattoni p9):
 *   0. S2 enabled (same kill switch, DISABLE_WM_TABLE_MINER) AND the
 *      first mining pass claimed ZERO tables — the hook is a last
 *      resort for tables no channel could read, never a second read
 *      of a table already claimed.
 *   1. The merged facts carry ≥1 watermain diameter whose every
 *      segment length is unstated (0) — a fill must be possible.
 *   2. The page is NOT texty (the text layer routes it to vision
 *      already) and its text layer is glyph garbage: ≥50 items with
 *      ≥40% single-character items — the layer exists but cannot be
 *      read, which is what separates a stroke-font sheet from a clean
 *      raster scan (few/no items) and from a readable text page.
 *   3. A tile ATTRIBUTED to the page carries the fragment signature:
 *      ≥1 scope-header line (a pipe line naming ≥2 scope tokens:
 *      BLDG/BUILDING/PHASE/BLK/BLOCK/AREA/SITE/SECTION) AND ≥2 bare
 *      number-pair lines ("167 | 70"). Either half alone occurs
 *      elsewhere (Woodbine's plan-and-profile legend has scope
 *      headers with no pairs); the conjunction is the table's shadow
 *      in the general transcript.
 */
import { isTextyPage, type PageText } from './pdf-text';
import { isSpecialistDisabled } from './specialists';
import type { TakeoffFacts, TileTranscript } from './types';
import { WM_TABLE_MINER_ID } from './wm-table-miner';

export const WM_HOOK_MIN_SCOPE_HEADERS = 1;
export const WM_HOOK_MIN_FRAGMENT_PAIRS = 2;
export const WM_HOOK_GLYPH_MIN_ITEMS = 50;
export const WM_HOOK_GLYPH_MIN_SINGLE_FRACTION = 0.4;

const SCOPE_TOKENS = new Set(['BLDG', 'BUILDING', 'PHASE', 'BLK', 'BLOCK', 'AREA', 'SITE', 'SECTION']);
/** A bare number-pair line: two plain numbers and a pipe, nothing else. */
const NUMBER_PAIR_RE = /^\s*\d+(?:\.\d+)?\s*\|\s*\d+(?:\.\d+)?\s*$/;

/** Scope tokens named in one line ("BLDG A | BLDG B" → 2). */
export function countScopeTokens(line: string): number {
  return line.toUpperCase().split(/[^A-Z]+/).filter((t) => SCOPE_TOKENS.has(t)).length;
}

/** A scope-header line: pipe-delimited and naming ≥2 scope tokens. */
export function isScopeHeaderLine(line: string): boolean {
  return line.includes('|') && countScopeTokens(line) >= 2;
}

export interface WmFragmentStats {
  scopeHeaders: number;
  pairs: number;
}

/** The fragment signature's two halves, counted over one tile. */
export function wmTableFragmentStats(tile: TileTranscript): WmFragmentStats {
  let scopeHeaders = 0;
  let pairs = 0;
  for (const block of tile.blocks ?? []) {
    const lines = Array.isArray(block) ? block : [String(block)];
    for (const line of lines) {
      if (isScopeHeaderLine(line)) scopeHeaders += 1;
      else if (NUMBER_PAIR_RE.test(line)) pairs += 1;
    }
  }
  return { scopeHeaders, pairs };
}

export function tileCarriesWmTableFragment(tile: TileTranscript): boolean {
  const s = wmTableFragmentStats(tile);
  return s.scopeHeaders >= WM_HOOK_MIN_SCOPE_HEADERS && s.pairs >= WM_HOOK_MIN_FRAGMENT_PAIRS;
}

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
 * Attribute a flat transcript back to its raster pages by NUMBER
 * RANGES — the same accounting diagnostics.ts uses to derive per-page
 * rendered counts: pages in render order own consecutive tile-number
 * ranges of min(planned, perPageCap) tiles, truncated by the total
 * cap. A tile belongs to the page whose range contains its number.
 *
 * Ranges (not positions) are what make this robust: a tile still
 * missing after the transcription recovery ladder leaves a HOLE in
 * its owner's range and shifts nothing — every surviving tile keeps
 * its true page. Returns null only when the accounting cannot be
 * trusted at all: a duplicate tile number, or a tile number outside
 * every range (the plan and the transcript genuinely disagree).
 * Planned counts are passed in so this module needs no import from
 * extraction.ts.
 */
export function attributeTilesToPages(
  rasterPages: { page: number; plannedTiles: number }[],
  transcript: TileTranscript[],
  perPageCap: number,
  totalCap: number,
): Map<number, TileTranscript[]> | null {
  const ranges: { page: number; lo: number; hi: number }[] = [];
  let assigned = 0;
  for (const rp of rasterPages) {
    const count = Math.max(0, Math.min(rp.plannedTiles, perPageCap, totalCap - assigned));
    ranges.push({ page: rp.page, lo: assigned + 1, hi: assigned + count });
    assigned += count;
  }
  const byPage = new Map<number, TileTranscript[]>(ranges.map((r) => [r.page, []]));
  const seen = new Set<number>();
  for (const t of transcript) {
    if (seen.has(t.tile)) return null;
    seen.add(t.tile);
    const r = ranges.find((x) => t.tile >= x.lo && t.tile <= x.hi);
    if (!r) return null;
    byPage.get(r.page)!.push(t);
  }
  for (const ts of byPage.values()) ts.sort((a, b) => a.tile - b.tile);
  return byPage;
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
  /** The fragment-carrying tile attributed to the page. */
  tile: number;
  scopeHeaders: number;
  pairs: number;
  /** Glyph-gate values for the page, for the firing record. */
  items: number;
  singleCharFraction: number;
}

export interface WmTableCandidateInput {
  pageTexts: PageText[];
  /** Tile attribution for the raster pages; null = unknown → no fire. */
  tilesByPage: Map<number, TileTranscript[]> | null;
  facts: TakeoffFacts;
  /** Tables the first mining pass already claimed (any channel). */
  tablesClaimed: number;
}

/** The conjunctive candidate detector (see the header for the gates). */
export function detectWmTableCandidates(input: WmTableCandidateInput): WmTableCandidate[] {
  if (isSpecialistDisabled(WM_TABLE_MINER_ID)) return [];
  if (input.tablesClaimed > 0) return [];
  if (!input.tilesByPage) return [];
  if (fillEligibleWmDiameters(input.facts).length === 0) return [];
  const candidates: WmTableCandidate[] = [];
  for (const pt of input.pageTexts) {
    if (isTextyPage(pt)) continue;
    const tiles = input.tilesByPage.get(pt.page);
    if (!tiles || tiles.length === 0) continue;
    const glyph = glyphGarbageStats(pt);
    if (glyph.items < WM_HOOK_GLYPH_MIN_ITEMS) continue;
    if (glyph.singleCharFraction < WM_HOOK_GLYPH_MIN_SINGLE_FRACTION) continue;
    let best: { tile: number; scopeHeaders: number; pairs: number } | null = null;
    for (const tile of tiles) {
      const s = wmTableFragmentStats(tile);
      if (s.scopeHeaders >= WM_HOOK_MIN_SCOPE_HEADERS && s.pairs >= WM_HOOK_MIN_FRAGMENT_PAIRS) {
        if (!best || s.pairs > best.pairs) best = { tile: tile.tile, scopeHeaders: s.scopeHeaders, pairs: s.pairs };
      }
    }
    if (best) {
      candidates.push({
        page: pt.page,
        tile: best.tile,
        scopeHeaders: best.scopeHeaders,
        pairs: best.pairs,
        items: glyph.items,
        singleCharFraction: glyph.singleCharFraction,
      });
    }
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
