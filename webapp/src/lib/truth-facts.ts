/**
 * Reads an estimator's filled workbook into TakeoffFacts (physical fields only),
 * so the redesigned facts-level metric (compare-facts.ts) can score the
 * extraction stage against ground truth. Pricing columns are deliberately ignored.
 *
 * Reads ALL numbered section sheets (MANHOLES (1)/(2)/…, SEWERS (1)…(4), etc.),
 * filters non-structure line-item rows out of the structures list, and reads the
 * grouped catchbasin block.
 */
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact } from './types';

function cell(sheet: ExcelJS.Worksheet, ref: string): string | number | null {
  const c = sheet.getCell(ref);
  const v = c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const f = v as ExcelJS.CellFormulaValue & { text?: string };
    if ('result' in f && f.result != null && typeof f.result !== 'object') return f.result as string | number;
    if (typeof f.text === 'string') return f.text;
    return null;
  }
  return v as string | number;
}

const num = (v: string | number | null): number | null => {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
};

// Rows the estimator lists in the structures column that are NOT physical structures
// (site line items, dividers, fees, special systems). Excluded from structure scoring.
const STRUCTURE_JUNK = /GRAN\s*\*|^SANITARY$|X-?ING|REMOVAL|SAW\s*CUT|ROAD\s*RESTOR|CONSULTING|RELOCATE|BIO-?SWALE|\bADS?\b|\bMOB\b|ASP[H]?[A]?LT|STM\s*TANK|GREENSTORM|LAYOUT|AS\s*BUILT|VIDEO|DEWATER|SWALE|LABOU?R/i;

const isMHSheet = (n: string) => /manhole|structure|\bmh\b/i.test(n) && !/sewer|watermain|summary/i.test(n);
const isSWSheet = (n: string) => /sewer/i.test(n) && !/summary/i.test(n);
const isWMSheet = (n: string) => /watermain|water/i.test(n) && !/summary/i.test(n);

const CB_ROW_TYPE: Record<number, CatchbasinGroupFact['type']> = {
  53: 'SINGLE_CB', 54: 'DOUBLE_CB', 55: 'DITCH_INLET_CB', 56: 'DOUBLE_DITCH_INLET_CB',
};

export async function readTruthFacts(xlsxPath: string, projectName: string): Promise<TakeoffFacts> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  const structures: StructureFact[] = [];
  const catchbasins: CatchbasinGroupFact[] = [];
  const sewers: SewerFact[] = [];
  const watermain: WatermainFact[] = [];

  for (const ws of wb.worksheets) {
    const name = ws.name;

    if (isMHSheet(name)) {
      // Structures (rows 11-50)
      for (let r = 11; r <= 50; r++) {
        const desc = cell(ws, `B${r}`);
        if (desc === null || desc === '') continue;
        const label = String(desc);
        if (label.toUpperCase().includes('TOTAL') || STRUCTURE_JUNK.test(label)) continue;
        // Skip "STORM:" / "SANITARY:" section-header rows — they're not structures
        // (mirrors the sewer branch's header skip below). "UNSPECIFIED" is the
        // heading generated workbooks give entities whose system is not
        // recorded; it never appears in estimator workbooks (corpus census,
        // PR21) but must not parse as a structure when reading generated ones.
        if (/^(storm|sanitary|stm|san|unspecified)\s*:?\s*$/i.test(label.trim())) continue;
        const s: StructureFact = {
          description: label,
          topElevation: num(cell(ws, `C${r}`)),
          lowInvert: num(cell(ws, `D${r}`)),
          highInvert: num(cell(ws, `E${r}`)),
          pipeOutDiameter: num(cell(ws, `F${r}`)),
          structureType: cell(ws, `G${r}`) != null ? String(cell(ws, `G${r}`)) : null,
          depth: num(cell(ws, `J${r}`)),
        };
        // Keep only rows that look like real structures: some physical value present,
        // or a structure-ID label (MH/CB/CBMH/DCBMH/DICB/… + optional number).
        const hasPhysical = [s.topElevation, s.lowInvert, s.highInvert, s.pipeOutDiameter, s.depth].some((x) => x != null);
        // Two label shapes count as a structure ID:
        //  1. a standalone token — "MH", "MH 12", "CB", "CHAMBER 1" (original test);
        //  2. a COMPACT ID — the token fused with its number/suffix, "MH6N",
        //     "DCBMH5N", "DICB2", "CB3", "STMH1". The \b test can never see these
        //     (letters and digits are both word chars, so there is no boundary
        //     inside "MH6N"), which silently dropped generated-workbook rows
        //     whose physical cells were also unreadable — e.g. depth written as
        //     an unevaluated formula when rim/invert weren't both read, so the
        //     row parses all-null. Require the ID at the label start or after a
        //     separator, immediately followed by a digit, so prose that merely
        //     mentions an ID doesn't qualify.
        // Template chrome ("MH F&C $", "CB F&C $") never counts on the label
        // path — F&C price rows are not structures.
        // PR55: the compact form also admits a fused alpha qualifier between
        // the token and the number ("MHTEE111" = MH + TEE + 111) and the EF
        // unit token ("EF4") — both are real generated-workbook structure
        // labels with all-null physicals that the scorer silently dropped.
        const looksLikeStructure =
          !/F\s*&\s*C/i.test(label) &&
          (/\b(D?CBMH|DI?CB|MH|CB|HS|OS|CHAMBER)\b/i.test(label) ||
            /(?:^|[\s\-/,(])(D?CBMH|DI?CB|STMH|SANMH|MH|CB|EF)[A-Z]*\s*-?\s*\d/i.test(label));
        if (hasPhysical || looksLikeStructure) structures.push(s);
      }
      // Catchbasin group block (rows 53-56)
      for (const rStr of Object.keys(CB_ROW_TYPE)) {
        const r = Number(rStr);
        const qty = num(cell(ws, `C${r}`));
        if (qty && qty > 0) {
          catchbasins.push({
            type: CB_ROW_TYPE[r],
            quantity: qty,
            wallThickness: num(cell(ws, `D${r}`)),
            depth: num(cell(ws, `E${r}`)),
          });
        }
      }
    } else if (isSWSheet(name)) {
      for (let r = 14; r <= 55; r++) {
        const label = cell(ws, `B${r}`);
        if (label === null || label === '' || String(label).toUpperCase().includes('TOTAL')) continue;
        // Skip "STORM:" / "SANITARY:" section-header rows — they're not sewer runs.
        // "UNSPECIFIED" likewise: the generated workbooks' heading for runs
        // whose system is not recorded (never present in estimator workbooks).
        // Without this, a generated UNSPECIFIED heading would parse back as a
        // phantom line-item run.
        if (/^(storm|sanitary|stm|san|unspecified)\s*:?\s*$/i.test(String(label).trim())) continue;
        const length = num(cell(ws, `C${r}`));
        sewers.push({
          runLabel: String(label),
          isLineItem: length === null,
          length,
          pipeDiameter: num(cell(ws, `D${r}`)),
          typeClass: num(cell(ws, `E${r}`)),
          // NOTE: this estimator's sewer sheet has NO slope column — column F is a
          // constant "V/‖ O/OO" factor (always ~1.1), not the pipe slope. Reading it as
          // slope poisons attribute-matching (rejects real pipes on a bogus slope delta)
          // and makes the slope field-metric meaningless. The drawings carry slope, the
          // truth sheet doesn't, so we can't score it — leave it null.
          slope: null,
          depth: num(cell(ws, `G${r}`)),
        });
      }
    } else if (isWMSheet(name)) {
      for (let r = 13; r <= 19; r++) {
        // The "SIZE & TYPE" label (col B) is usually blank — the real data is length (C) +
        // diameter (D). Key on those, not B, or we drop every watermain run (and then score
        // the model's correct watermain as a false positive). Derive a label from the size.
        const length = num(cell(ws, `C${r}`));
        const dia = num(cell(ws, `D${r}`));
        if (length == null && dia == null) continue;
        const size = cell(ws, `B${r}`);
        if (size != null && /total/i.test(String(size))) continue;
        watermain.push({
          sizeAndType: size != null && String(size) !== '' ? String(size) : (dia != null ? `${dia}mm` : ''),
          length: length ?? 0,
          pipeDiameter: dia ?? 0,
          // Blank stays null (unstated). The reader used to substitute the
          // estimator defaults (1.1 / 1.8) here, which wrote invented values
          // into "truth" — a prediction could then never disagree with a
          // default nobody observed. Defaults belong at pricing time
          // (costing-rules), not in ground truth.
          ocSc: num(cell(ws, `F${r}`)),
          avgCover: num(cell(ws, `J${r}`)),
        });
      }
    }
  }

  return {
    projectName,
    jobNumber: '',
    date: '',
    structures,
    catchbasins,
    sewers,
    watermain,
    watermainSpecials: [],
    watermainValves: [],
    confidence: 1,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Truth selection & merging
//
// A project folder can hold several .xlsx: the real takeoff, near-identical
// copies, non-matching alternate designs, empty appendix/removals sheets, and
// genuine per-block/street SPLITS of one site. The eval historically picked
// `xlsxFiles[0]` (readdir order), which silently landed on EMPTY or PARTIAL
// workbooks for several projects (truth => 0 => the model's correct extraction
// scored as all false positives). resolveTruthFacts() replaces that with:
//   1. a curated manifest (merge genuine splits / pin the canonical file /
//      exclude unscoreable projects), else
//   2. auto-pick the RICHEST NON-EMPTY candidate — never an empty decoy.
// ---------------------------------------------------------------------------

// Files in a project folder that are never ground truth (generated runs,
// backups, quotes, material-quote sheets). NOTE: unlike the old filter this
// does NOT drop "budget"/"sand" wholesale — some projects' only estimate is a
// "…BUDGET.xlsx", and "sand" only appears in "Sand & Gravel Material Quotes".
const TRUTH_JUNK = /eval_run_|backup|\bquote\b|material\s*quote|sand\s*&\s*gravel/i;

export interface TruthManifestEntry {
  truth?: string;       // single canonical workbook (basename)
  merge?: string[];     // genuine multi-workbook split to combine (basenames)
  exclude?: boolean;    // unscoreable — skip this project
  note?: string;
}
export type TruthManifest = Record<string, TruthManifestEntry>;

export function loadTruthManifest(manifestPath: string): TruthManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete raw._readme;
    return raw as TruthManifest;
  } catch {
    return {};
  }
}

export function listTruthCandidates(projectDir: string): string[] {
  return fs.readdirSync(projectDir).filter(
    (f) => f.toLowerCase().endsWith('.xlsx') && !TRUTH_JUNK.test(f)
  );
}

function truthTotal(t: TakeoffFacts): number {
  return (
    t.sewers.filter((x) => !x.isLineItem).length +
    t.watermain.length +
    t.structures.length +
    t.catchbasins.reduce((a, c) => a + (c.quantity || 0), 0)
  );
}

/** Combine several workbooks (a genuine site split) into one TakeoffFacts. */
export function mergeTruthFacts(parts: TakeoffFacts[], projectName: string): TakeoffFacts {
  const merged: TakeoffFacts = {
    projectName, jobNumber: '', date: '',
    structures: [], catchbasins: [], sewers: [], watermain: [],
    watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [],
  };
  for (const p of parts) {
    merged.structures.push(...p.structures);
    merged.sewers.push(...p.sewers);
    merged.watermain.push(...p.watermain);
    for (const cb of p.catchbasins) {
      const ex = merged.catchbasins.find((c) => c.type === cb.type);
      if (ex) ex.quantity += cb.quantity;
      else merged.catchbasins.push({ ...cb });
    }
  }
  return merged;
}

export interface ResolvedTruth {
  facts: TakeoffFacts;
  sources: string[];   // workbook basenames that fed the truth
  primary: string;     // best single file (for the legacy cell metric)
}

/**
 * Resolve a project's ground truth robustly. Returns null when the project is
 * excluded or has no usable workbook. Manifest overrides win; otherwise the
 * richest non-empty candidate is chosen (so empty decoys are never selected).
 */
export async function resolveTruthFacts(
  projectDir: string,
  projectName: string,
  manifest: TruthManifest = {}
): Promise<ResolvedTruth | null> {
  const entry = manifest[projectName];
  if (entry?.exclude) return null;

  const candidates = listTruthCandidates(projectDir);
  if (candidates.length === 0) return null;

  let chosen: string[];
  if (entry?.merge?.length) {
    chosen = entry.merge;
  } else if (entry?.truth) {
    chosen = [entry.truth];
  } else if (candidates.length === 1) {
    chosen = candidates;
  } else {
    // Auto: score every candidate, prefer the richest non-empty one.
    const scored = await Promise.all(
      candidates.map(async (f) => {
        try {
          return { f, total: truthTotal(await readTruthFacts(path.join(projectDir, f), projectName)) };
        } catch {
          return { f, total: -1 };
        }
      })
    );
    scored.sort((a, b) => b.total - a.total);
    chosen = [scored[0].f];
  }

  const parts = await Promise.all(chosen.map((f) => readTruthFacts(path.join(projectDir, f), projectName)));
  const facts = parts.length === 1 ? parts[0] : mergeTruthFacts(parts, projectName);
  // Primary = the richest of the chosen files (used by the legacy cell metric,
  // which can only compare against a single workbook).
  let primary = chosen[0], best = -1;
  for (let i = 0; i < parts.length; i++) {
    const t = truthTotal(parts[i]);
    if (t > best) { best = t; primary = chosen[i]; }
  }
  return { facts, sources: chosen, primary };
}
