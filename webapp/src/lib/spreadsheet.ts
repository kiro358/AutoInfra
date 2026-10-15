import ExcelJS from 'exceljs';
import path from 'path';
import { ExtractionResult, GlobalParams, WithheldItem } from './types';
import { DEFAULT_PARAMS, TEMPLATE_LAYOUT, RowBlock, blockCapacity } from './constants';
import { standardFeeKind } from './costing-rules';
import { classifySystems, groupBySystem, SystemClassification } from './system-classification';

import fs from 'fs';

let TEMPLATES_DIR = path.resolve(__dirname, '../../../empty_templates');
if (!fs.existsSync(TEMPLATES_DIR)) {
  TEMPLATES_DIR = path.join(process.cwd(), '..', 'empty_templates');
  if (!fs.existsSync(TEMPLATES_DIR)) {
    TEMPLATES_DIR = path.join(process.cwd(), 'empty_templates');
  }
}

export async function populateTemplate(
  extraction: ExtractionResult,
  params: GlobalParams = DEFAULT_PARAMS as unknown as GlobalParams
): Promise<Buffer> {
  const layout = TEMPLATE_LAYOUT[extraction.templateType === 'LONG' ? 'LONG' : 'SHORT'];
  const templatePath = path.join(TEMPLATES_DIR, layout.file);
  // Anything that cannot be placed is reported here (never silently dropped). The
  // caller returns `extraction` after this, so the warnings reach the user.
  if (!Array.isArray(extraction.warnings)) extraction.warnings = [];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  // Break shared formula chains in columns that forceSetCellValue will write to.
  // This must happen BEFORE any fill functions are called.
  ['MANHOLES (1)', 'MANHOLES (2)', 'MANHOLES (3)'].forEach(name => {
    const ws = workbook.getWorksheet(name);
    if (ws) {
      breakSharedFormulas(ws, ['J', 'K', 'L'], 11, 50);
    }
  });

  // Storm/sanitary classification drives the sectioned layout of the MANHOLES
  // and SEWERS sheets (the estimator's workbooks keep the systems in headed
  // sections — storm first, sanitary second). Classed once here so both fills
  // and the AUDIT note agree. Unclassed entities are never dropped or filed
  // under a guessed system: they get their own UNSPECIFIED section, a warning,
  // and an AUDIT note (see system-classification.ts for the evidence rules).
  const classification = classifySystems(extraction.manholes, extraction.sewers);
  const unspecifiedStructures = classification.structureSystems.filter((c) => c === 'UNKNOWN').length;
  const unspecifiedRuns = extraction.sewers.filter(
    (s, i) => !s.isLineItem && classification.sewerSystems[i] === 'UNKNOWN'
  ).length;
  if (unspecifiedStructures + unspecifiedRuns > 0) {
    extraction.warnings.push(
      `${unspecifiedStructures} structure(s) and ${unspecifiedRuns} sewer run(s) could not be classed storm or sanitary from their labels — they are listed under UNSPECIFIED at the end of the MANHOLES / SEWERS sheets, not filed under either system. Check each one's system before relying on the split.`
    );
  }

  fillManholes(workbook, extraction, params, layout, classification);
  fillSewers(workbook, extraction, params, layout, classification);
  fillWatermain(workbook, extraction, params, layout);
  addAuditSheet(workbook, extraction, { unspecifiedStructures, unspecifiedRuns });

  // Write to buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * The AUDIT sheet: every number in this workbook that was NOT read off the
 * drawings, in one place. Two sections, both rendered from the extraction's
 * withheld list (see WithheldItem in types.ts):
 *   1. Withheld & defaulted — values the estimator must confirm; where a
 *      convention default was applied so pricing could proceed, the value
 *      used and its source are shown next to the question.
 *   2. Derived — values computed at pricing from read values (rim − invert
 *      depths, pipe-inferred structure sizes).
 * A legacy extraction (no withheld list at all) says so explicitly rather
 * than presenting an empty sheet as a clean bill of health.
 */
function addAuditSheet(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  separation?: { unspecifiedStructures: number; unspecifiedRuns: number }
): void {
  const ws = workbook.addWorksheet('AUDIT');
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 26;
  ws.getColumn(4).width = 78;
  ws.getColumn(5).width = 14;
  ws.getColumn(6).width = 52;

  let row = 1;
  const title = ws.getCell(`A${row++}`);
  title.value = 'AUDIT — values not read off the drawings';
  title.font = { bold: true, size: 13 };
  const sub = ws.getCell(`A${row++}`);
  sub.value = 'Every value below was missing from the drawings and was withheld, defaulted by convention, or derived at pricing. Confirm each one before relying on this estimate.';
  row++;

  // Pipeline diagnostics summary (PR18): where this run could have lost
  // content — pages located, tiles planned vs rendered vs transcribed, and
  // entity counts per source path vs the final merged facts. Present only
  // when the extraction recorded diagnostics (legacy runs carry none).
  const diag = extraction.diagnostics;
  if (diag) {
    const dh = ws.getCell(`A${row++}`);
    dh.value = 'PIPELINE DIAGNOSTICS — where content could have been lost';
    dh.font = { bold: true, size: 11 };
    const loc = diag.locator;
    const unionNote = loc.unionAdded.length > 0
      ? `; locator union added ${loc.unionAdded.map((a) => `p${a.page} (${a.reason})`).join(', ')}`
      : '';
    const fallbackNote = loc.tileAllFallback ? '; locator returned nothing — all pages tiled' : '';
    ws.getCell(`A${row++}`).value =
      `Located pages: ${loc.finalPages.length > 0 ? loc.finalPages.join(', ') : 'none'} (mode ${diag.mode})${unionNote}${fallbackNote}.`;
    if (diag.tiles.planned != null) {
      const t = diag.tiles;
      ws.getCell(`A${row++}`).value =
        `Tiles: ${t.planned} planned, ${t.rendered ?? '—'} rendered, ${t.transcribed ?? '—'} transcribed` +
        ` (${t.missingAfterRetry ?? 0} lost after retry, ${t.degenerateDiscarded ?? 0} discarded as degenerate, ${t.blocks ?? '—'} transcript blocks).`;
    }
    const fmtCounts = (c: { structures: number; sewers: number; watermain: number; catchbasins: number }) =>
      `${c.structures} structures / ${c.sewers} sewer runs / ${c.watermain} watermain / ${c.catchbasins} catchbasin groups`;
    const srcNote = diag.assembly.sources.map((s) => `${s.path}: ${fmtCounts(s.counts)}`).join('; ');
    ws.getCell(`A${row++}`).value = `Entities by source — ${srcNote} → final: ${fmtCounts(diag.assembly.final)}.`;
    row++;
  }

  // Storm/sanitary separation note: present only when something could not be
  // classed. The MANHOLES / SEWERS sheets group entities under STORM and
  // SANITARY headings like the estimator's workbooks; anything unclassed sits
  // under UNSPECIFIED instead of being silently filed under a system.
  if (separation && separation.unspecifiedStructures + separation.unspecifiedRuns > 0) {
    const sh = ws.getCell(`A${row++}`);
    sh.value = 'STORM / SANITARY SEPARATION — entities whose system is not recorded';
    sh.font = { bold: true, size: 11 };
    ws.getCell(`A${row++}`).value =
      `${separation.unspecifiedStructures} structure(s) and ${separation.unspecifiedRuns} sewer run(s) could not be classed storm or sanitary from their labels. ` +
      'They are listed under the UNSPECIFIED heading at the end of the MANHOLES / SEWERS sheets — check each one\'s system before relying on the storm/sanitary split.';
    row++;
  }

  const items = extraction.withheld;
  if (!items) {
    ws.getCell(`A${row}`).value = 'No audit trail was recorded for this extraction (it predates provenance/withheld recording). Re-run the extraction to produce one.';
    return;
  }
  if (items.length === 0) {
    ws.getCell(`A${row}`).value = 'Nothing withheld: no defaults or derivations were applied at pricing beyond the costing rule table.';
    return;
  }

  const sections: { heading: string; kinds: WithheldItem['kind'][] }[] = [
    { heading: 'WITHHELD & DEFAULTED — questions for the estimator', kinds: ['withheld', 'defaulted'] },
    { heading: 'DERIVED — computed at pricing from read values', kinds: ['derived'] },
  ];
  for (const section of sections) {
    const rows = items.filter((i) => section.kinds.includes(i.kind));
    if (rows.length === 0) continue;
    const h = ws.getCell(`A${row++}`);
    h.value = section.heading;
    h.font = { bold: true, size: 11 };
    const header = ws.getRow(row++);
    ['Entity', 'Field', 'Status', 'Question / note', 'Value used', 'Value source'].forEach((t, c) => {
      const cell = header.getCell(c + 1);
      cell.value = t;
      cell.font = { bold: true };
    });
    for (const item of rows) {
      const r = ws.getRow(row++);
      r.getCell(1).value = item.entity;
      r.getCell(2).value = item.field;
      r.getCell(3).value =
        item.kind === 'withheld' ? 'WITHHELD — left blank'
        : item.kind === 'defaulted' ? 'DEFAULTED — default applied'
        : 'DERIVED';
      r.getCell(4).value = item.question;
      if (item.defaultApplied) {
        r.getCell(5).value = item.defaultApplied.value;
        r.getCell(6).value = item.defaultApplied.source;
      } else {
        r.getCell(5).value = '—';
        r.getCell(6).value = '—';
      }
    }
    row++;
  }
}

type Layout = (typeof TEMPLATE_LAYOUT)['SHORT'];

/** The (sheet, row) for the idx-th item of a block, or null when the block is full. */
function slotFor(
  workbook: ExcelJS.Workbook,
  block: RowBlock,
  idx: number
): { sheet: ExcelJS.Worksheet; row: number } | null {
  const perSheet = block.lastRow - block.firstRow + 1;
  const sheetName = block.sheets[Math.floor(idx / perSheet)];
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : undefined;
  if (!sheet) return null;
  return { sheet, row: block.firstRow + (idx % perSheet) };
}

function warnOverflow(extraction: ExtractionResult, what: string, total: number, capacity: number) {
  if (total > capacity) {
    extraction.warnings.push(
      `${total - capacity} of ${total} ${what} did not fit the ${extraction.templateType} template (max ${capacity}) and were NOT written to the workbook.`
    );
  }
}

/** One headed section of a data block, in workbook order. `heading: null` is a
 *  heading-less tail (sewer line items) that simply follows the last section. */
interface BlockSection<T> {
  heading: string | null;
  items: T[];
}

interface BlockPlan<T> {
  /** In-flow cells in slot order: data rows and mid-sheet heading rows. */
  cells: { sheet: ExcelJS.Worksheet; row: number; heading?: string; item?: T }[];
  /** Heading written in the row ABOVE a sheet's data block, per sheet. */
  headerHeadings: Map<ExcelJS.Worksheet, string>;
  placedItems: number;
  droppedItems: number;
}

/**
 * Lay sections out over a block's sheets the way the estimator's workbooks do:
 * sections in order; a section whose items begin a sheet (first section, a
 * section starting exactly at a sheet boundary, or one continuing onto the
 * next sheet) carries its heading in the row above the data block (MANHOLES
 * row 10 / SEWERS row 13 — the SHORT template even pre-fills "STORM:" there),
 * which costs no data slot; a section starting mid-sheet takes one in-flow
 * heading row. A heading never orphans on a sheet's last row — it moves to
 * the next sheet's header row, leaving that slot blank. Items that run past
 * the last sheet are counted as dropped (the caller warns with the real
 * numbers) — never silently truncated.
 */
function planSections<T>(
  workbook: ExcelJS.Workbook,
  block: RowBlock,
  sections: BlockSection<T>[]
): BlockPlan<T> {
  const perSheet = block.lastRow - block.firstRow + 1;
  const sheets = block.sheets
    .map((name) => workbook.getWorksheet(name))
    .filter(Boolean) as ExcelJS.Worksheet[];
  const totalSlots = perSheet * sheets.length;
  const headerHeadings = new Map<ExcelJS.Worksheet, string>();
  const cells: BlockPlan<T>['cells'] = [];
  let placedItems = 0;
  let totalItems = 0;
  let slot = 0;

  for (const section of sections) {
    totalItems += section.items.length;
    section.items.forEach((item, i) => {
      let sheetIdx = Math.floor(slot / perSheet);
      let pos = slot % perSheet;
      if (pos === 0 && section.heading && sheetIdx < sheets.length) {
        // This item heads its sheet: the section's heading goes in the header
        // row (section start at a boundary, or continuation from last sheet).
        headerHeadings.set(sheets[sheetIdx], section.heading);
      }
      if (i === 0 && pos !== 0 && section.heading) {
        if (pos === perSheet - 1 && sheetIdx < sheets.length - 1) {
          // Orphan avoidance: leave the last slot blank; the section starts
          // at the next sheet's top under its header-row heading.
          slot++;
          sheetIdx = Math.floor(slot / perSheet);
          pos = slot % perSheet;
          headerHeadings.set(sheets[sheetIdx], section.heading);
        } else {
          if (slot < totalSlots) {
            cells.push({ sheet: sheets[sheetIdx], row: block.firstRow + pos, heading: section.heading });
          }
          slot++;
          sheetIdx = Math.floor(slot / perSheet);
          pos = slot % perSheet;
        }
      }
      if (slot < totalSlots) {
        cells.push({ sheet: sheets[sheetIdx], row: block.firstRow + pos, item });
        placedItems++;
      }
      slot++;
    });
  }

  return { cells, headerHeadings, placedItems, droppedItems: totalItems - placedItems };
}

/** Write a plan's header-row headings and in-flow heading rows (column B only). */
function writePlanHeadings<T>(block: RowBlock, plan: BlockPlan<T>) {
  for (const [sheet, text] of plan.headerHeadings) {
    setCellValue(sheet, `B${block.firstRow - 1}`, text);
  }
  for (const cell of plan.cells) {
    if (cell.heading) setCellValue(cell.sheet, `B${cell.row}`, cell.heading);
  }
}

function fillManholes(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams,
  layout: Layout,
  classification: SystemClassification
) {
  const sheets = layout.manholes.sheets
    .map(name => workbook.getWorksheet(name))
    .filter(Boolean) as ExcelJS.Worksheet[];

  if (sheets.length === 0) return;

  // Fill header / project info and global params on all sheets
  sheets.forEach(sheet => {
    setCellValue(sheet, 'B2', extraction.projectName);
    setCellValue(sheet, 'B3', extraction.jobNumber);
    setCellValue(sheet, 'B5', extraction.date);

    setCellValue(sheet, 'F3', params.manholes.truckingPerCM);
    setCellValue(sheet, 'F4', params.manholes.concretePerCM);
    // F5 is "%DISCOUNT", and the two templates read it differently: LONG's precast formula
    // is *(100-F$5)/100 (F5 = 40 means 40%), SHORT's is *(1-F$5) (F5 = 0.35). Writing the
    // fraction into LONG made the discount 0.35% instead of 35%. Follow the template.
    const percent = discountIsPercent(sheet);
    const d = params.manholes.discount;
    setCellValue(sheet, 'F5', percent ? (d <= 1 ? d * 100 : d) : (d > 1 ? d / 100 : d));
    // SHORT's catchbasin factor L6 is written in the percent convention while its own
    // precast column uses the fraction one, so catchbasins got ~0.35% off, not 35%.
    const l6 = sheet.getCell('L6');
    if (!percent && /\(100-F\$?5\)\/100/.test(String(l6.formula ?? ''))) {
      l6.value = { formula: '(1-F5)*I3*I4' } as ExcelJS.CellFormulaValue;
    }
    setCellValue(sheet, 'F6', params.manholes.marginFactor);
    setCellValue(sheet, 'F7', params.manholes.metric ? 1 : 0);
    setCellValue(sheet, 'I3', params.manholes.fstFactor);
    setCellValue(sheet, 'I4', params.manholes.pstFactor);
    setCellValue(sheet, 'I5', params.manholes.modPerM);
    setCellValue(sheet, 'I6', params.manholes.mhFC);
    setCellValue(sheet, 'I7', params.manholes.cbFC);
    setCellValue(sheet, 'L4', params.manholes.laborPerHr);
    setCellValue(sheet, 'L7', params.manholes.frameCoverM);
  });

  // Data rows: the template's real formula block only (never the totals row),
  // grouped into the estimator's STORM / SANITARY sections (unclassed last,
  // under UNSPECIFIED). Within a section the facts' order is preserved.
  const groups = groupBySystem(extraction.manholes, classification.structureSystems);
  const plan = planSections(workbook, layout.manholes, [
    { heading: 'STORM', items: groups.storm },
    { heading: 'SANITARY', items: groups.sanitary },
    { heading: 'UNSPECIFIED', items: groups.unspecified },
  ]);
  if (plan.droppedItems > 0) {
    warnOverflow(extraction, 'structures', extraction.manholes.length, plan.placedItems);
  }
  writePlanHeadings(layout.manholes, plan);
  plan.cells.forEach((cell) => {
    const mh = cell.item;
    if (!mh) return; // heading row — written by writePlanHeadings
    const { sheet, row } = cell;

    setCellValue(sheet, `B${row}`, mh.description);
    // The template derives depth as Top El - Low Inv. Writing only one of the pair gives a
    // depth of minus the invert (MH 13 on 460 Bayly: -85.1), the precast VLOOKUP returns
    // #N/A, and that #N/A takes out the MANHOLES and SUMMARY totals. Write the pair only
    // when it makes a real depth; otherwise leave both blank and say so.
    const top = mh.topElevation, low = mh.lowInvert;
    const hasPair = Boolean(top && low && top > low);
    if (hasPair) {
      setCellValue(sheet, `C${row}`, top!);
      setCellValue(sheet, `D${row}`, low!);
    } else if (mh.structureType !== 'CHAMBER') {
      extraction.warnings.push(`${mh.description}: top elevation and low invert not both read — depth left blank, price it by hand.`);
    }
    // No depth means no precast price, and a diameter alone breaks it: LONG's lookup row for
    // 1200mm at 0m is a literal #N/A (SHORT's silently priced it ~$1,045). Leave L blank.
    const hasDepth = hasPair || (mh.depth != null && mh.depth > 0);
    setCellValue(sheet, `E${row}`, mh.highInvert || undefined);
    setCellValue(sheet, `F${row}`, mh.pipeOutDiameter || undefined);
    if (mh.structureType !== 'CHAMBER') setCellValue(sheet, `G${row}`, mh.structureType ?? undefined);
    if (mh.addMaterials) setCellValue(sheet, `H${row}`, mh.addMaterials);
    if (mh.addLE) setCellValue(sheet, `I${row}`, mh.addLE);
    if (mh.depth != null) forceSetCellValue(sheet, `J${row}`, mh.depth);
    if (mh.drop != null) forceSetCellValue(sheet, `K${row}`, mh.drop);
    if (mh.diameter != null && hasDepth) forceSetCellValue(sheet, `L${row}`, mh.diameter);
  });

  // Fill catchbasin groups (Rows 53-56) - only on MANHOLES (1)
  const primarySheet = sheets[0];
  if (extraction.catchbasins && extraction.catchbasins.groups) {
    const cbMap: Record<string, number> = {
      'SINGLE_CB': 53,
      'DOUBLE_CB': 54,
      'DITCH_INLET_CB': 55,
      'DOUBLE_DITCH_INLET_CB': 56
    };
    extraction.catchbasins.groups.forEach(g => {
      const row = cbMap[g.type];
      if (row) {
        setCellValue(primarySheet, `C${row}`, g.quantity || undefined);
        setCellValue(primarySheet, `D${row}`, g.wallThickness || undefined);
        setCellValue(primarySheet, `E${row}`, g.depth || undefined);
        setCellValue(primarySheet, `F${row}`, g.grateEach || undefined);
        setCellValue(primarySheet, `G${row}`, g.addMaterials || undefined);
      }
    });
  }

  // Fill catchbasin labor rates (Rows 59-60) - only on MANHOLES (1)
  if (extraction.catchbasins && extraction.catchbasins.laborRates) {
    const lr = extraction.catchbasins.laborRates;
    setCellValue(primarySheet, `C59`, lr.scbLabor || undefined);
    setCellValue(primarySheet, `C60`, lr.dcbLabor || undefined);
    setCellValue(primarySheet, `F59`, lr.dicbFC || undefined);
    setCellValue(primarySheet, `F60`, lr.ddicbFC || undefined);
  }
}

function fillSewers(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams,
  layout: Layout,
  classification: SystemClassification
) {
  const sheets = layout.sewers.sheets
    .map(name => workbook.getWorksheet(name))
    .filter(Boolean) as ExcelJS.Worksheet[];

  if (sheets.length === 0) return;

  // Fill header params on all sheets
  sheets.forEach(sheet => {
    setCellValue(sheet, 'F3', params.sewers.minTrenchWidth);
    setCellValue(sheet, 'F4', params.sewers.pipeCover);
    setCellValue(sheet, 'F5', params.sewers.mFinGrade);
    setCellValue(sheet, 'F6', params.sewers.dayCostPerDay);
    setCellValue(sheet, 'F7', params.sewers.extraPerDay);
    setCellValue(sheet, 'F8', params.sewers.productionMPerDay);
    setCellValue(sheet, 'I3', params.sewers.stoneImpT);
    setCellValue(sheet, 'I4', params.sewers.stoneMt);
    setCellValue(sheet, 'I5', params.sewers.granImpTn);
    setCellValue(sheet, 'I6', params.sewers.granMt);
    setCellValue(sheet, 'I7', params.sewers.truckingPerCM);
    setCellValue(sheet, 'P3', params.sewers.efficiency);
    setCellValue(sheet, 'P4', params.sewers.metric ? 1 : 0);
    setCellValue(sheet, 'P5', params.sewers.marginFactor);
    setCellValue(sheet, 'P6', params.sewers.openCutFactor);
    setCellValue(sheet, 'P7', params.sewers.dualTrSep);
    setCellValue(sheet, 'P8', params.sewers.concPipePct);
    setCellValue(sheet, 'P9', params.sewers.trenchClear);
    setCellValue(sheet, 'V3', params.sewers.provTax);
    setCellValue(sheet, 'V4', params.sewers.fedTax);
  });

  // SHORT pre-fills its own VIDEO / LAYOUT / AS BUILT rows. Route our standard fee
  // rows INTO those cells instead of appending duplicates (which double-counted them).
  // costing-rules.ts is the only source of dollars, so its amount OVERWRITES the
  // template's cell — including the template's `=15*C57` video formula, which
  // contradicts its own "$25/m" label. A template fee row with no matching priced fee
  // (no sewers => costing charges no fees) is zeroed for the same reason.
  const feeRows = layout.sewerFeeRows;
  const runRows = feeRows
    ? extraction.sewers.filter(sw => !(sw.isLineItem && standardFeeKind(sw.runLabel)))
    : extraction.sewers;

  if (feeRows) {
    const primary = sheets[0];
    const written = new Set<string>();
    for (const sw of extraction.sewers) {
      const kind = sw.isLineItem ? standardFeeKind(sw.runLabel) : null;
      if (!kind || written.has(kind)) continue;
      written.add(kind);
      const row = feeRows[kind];
      setCellValue(primary, `B${row}`, sw.runLabel);
      forceSetCellValue(primary, `H${row}`, sw.addMaterials || 0);
      if (sw.addLE) forceSetCellValue(primary, `I${row}`, sw.addLE);
    }
    for (const [kind, row] of Object.entries(feeRows)) {
      if (!written.has(kind)) forceSetCellValue(primary, `H${row}`, 0);
    }
  }

  // Data rows grouped into the estimator's sections, storm first: "STORM:"
  // (the heading the truth workbooks and the SHORT template itself use at the
  // top of the sheet), then "SANITARY", then unclassed runs under
  // "UNSPECIFIED". Line items are not network runs — they follow the last
  // section unheaded, as the estimator's fee rows do. runRows holds the same
  // object references as extraction.sewers, so the shared classification
  // (computed in populateTemplate) applies by identity.
  const systemOf = new Map(extraction.sewers.map((s, i) => [s, classification.sewerSystems[i]] as const));
  const runsOnly = runRows.filter((sw) => !sw.isLineItem);
  const groups = groupBySystem(runsOnly, runsOnly.map((sw) => systemOf.get(sw) ?? 'UNKNOWN'));
  const plan = planSections(workbook, layout.sewers, [
    { heading: 'STORM:', items: groups.storm },
    { heading: 'SANITARY', items: groups.sanitary },
    { heading: 'UNSPECIFIED', items: groups.unspecified },
    { heading: null, items: runRows.filter((sw) => sw.isLineItem) },
  ]);
  if (plan.droppedItems > 0) {
    warnOverflow(extraction, 'sewer rows', runRows.length, plan.placedItems);
  }
  writePlanHeadings(layout.sewers, plan);
  plan.cells.forEach((cell) => {
    const sw = cell.item;
    if (!sw) return; // heading row — written by writePlanHeadings
    const { sheet, row } = cell;

    setCellValue(sheet, `B${row}`, sw.runLabel);
    setCellValue(sheet, `C${row}`, sw.length || undefined);
    setCellValue(sheet, `D${row}`, sw.pipeDiameter || undefined);
    setCellValue(sheet, `E${row}`, sw.typeClass || undefined);
    setCellValue(sheet, `F${row}`, sw.slope || undefined);
    forceSetCellValue(sheet, `G${row}`, sw.depth || undefined);
    if (sw.addMaterials) setCellValue(sheet, `H${row}`, sw.addMaterials);
    if (sw.addLE) setCellValue(sheet, `I${row}`, sw.addLE);
  });
}

function fillWatermain(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams,
  layout: Layout
) {
  const sheets = layout.watermainRuns.sheets
    .map(name => workbook.getWorksheet(name))
    .filter(Boolean) as ExcelJS.Worksheet[];

  if (sheets.length === 0) return;

  // Fill header params on all sheets
  sheets.forEach(sheet => {
    setCellValue(sheet, 'F3', params.watermain.minTrenchWidth);
    setCellValue(sheet, 'F4', params.watermain.pipeCover);
    setCellValue(sheet, 'F5', params.watermain.mFinGrade);
    setCellValue(sheet, 'F6', params.watermain.dayCostPerDay);
    setCellValue(sheet, 'F7', params.watermain.extraPerDay);
    setCellValue(sheet, 'F8', params.watermain.productionMPerDay);
    setCellValue(sheet, 'I3', params.watermain.stoneImpTon);
    setCellValue(sheet, 'I4', params.watermain.stoneMtne);
    setCellValue(sheet, 'I5', params.watermain.granImpTon);
    setCellValue(sheet, 'I6', params.watermain.granMtne);
    setCellValue(sheet, 'I7', params.watermain.truckingPerCM);
    setCellValue(sheet, 'I8', params.watermain.peelRegionCover);
    setCellValue(sheet, 'O3', params.watermain.efficiency);
    setCellValue(sheet, 'O4', params.watermain.metric ? 1 : 0);
    setCellValue(sheet, 'O6', params.watermain.openCutFactor);
    setCellValue(sheet, 'O7', params.watermain.dualTrSep);
    setCellValue(sheet, 'O8', params.watermain.trenchClear);
    setCellValue(sheet, 'R4', params.watermain.precastPct);
    setCellValue(sheet, 'R7', params.watermain.modulocPerM);
    setCellValue(sheet, 'L3', params.watermain.c900_100);
    setCellValue(sheet, 'L4', params.watermain.c900_150);
    setCellValue(sheet, 'L5', params.watermain.c900_200);
    setCellValue(sheet, 'L6', params.watermain.c900_250);
    setCellValue(sheet, 'L7', params.watermain.c900_300);
    setCellValue(sheet, 'L8', params.watermain.concPerCM);
    setCellValue(sheet, 'U3', params.watermain.provTax);
    setCellValue(sheet, 'U4', params.watermain.fedTax);
  });

  // Runs: SHORT 13..18, LONG 14..19 (per TEMPLATE_LAYOUT).
  warnOverflow(extraction, 'watermain runs', extraction.watermain.length, blockCapacity(layout.watermainRuns));
  extraction.watermain.forEach((wm, idx) => {
    const slot = slotFor(workbook, layout.watermainRuns, idx);
    if (!slot) return; // over capacity — reported by warnOverflow above
    const { sheet, row } = slot;

    setCellValue(sheet, `B${row}`, wm.sizeAndType);
    setCellValue(sheet, `C${row}`, wm.length || undefined);
    setCellValue(sheet, `D${row}`, wm.pipeDiameter || undefined);
    setCellValue(sheet, `F${row}`, wm.ocSc);
    if (wm.addMaterials) setCellValue(sheet, `G${row}`, wm.addMaterials);
    if (wm.addLE) setCellValue(sheet, `H${row}`, wm.addLE);
    forceSetCellValue(sheet, `J${row}`, wm.avgCover);
  });

  // Specials: SHORT 24..53, LONG 25..54 — stops before the pre-filled "One Locks" rows.
  const sp = layout.watermainSpecials;
  const spSheet = workbook.getWorksheet(sp.sheet);
  const spCapacity = sp.lastRow - sp.firstRow + 1;
  warnOverflow(extraction, 'watermain specials', extraction.watermainSpecials.length, spCapacity);
  if (spSheet) {
    extraction.watermainSpecials.slice(0, spCapacity).forEach((special, idx) => {
      const row = sp.firstRow + idx;
      setCellValue(spSheet, `B${row}`, special.specialName);
      setCellValue(spSheet, `C${row}`, special.quantity || undefined);
      setCellValue(spSheet, `D${row}`, special.costEach || undefined);
      setCellValue(spSheet, `E${row}`, special.thrustBlock);
      setCellValue(spSheet, `F${row}`, special.anodeCost || undefined);
      setCellValue(spSheet, `G${row}`, special.laborEach || undefined);
    });
  }

  fillValves(workbook, extraction, layout);
}

/** First integer in a size label ("50 mm" -> 50, "200mm GV" -> 200), else null. */
export function parseSizeMm(label: unknown): number | null {
  const m = String(label ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * Valves go into the template's FIXED size table (O = size label, P = qty, Q = $/valve
 * for that size). The size column is never overwritten: each valve is matched to its
 * row by size and its quantity is ADDED into P, so the row's own $/valve applies.
 * A size with no row is reported, not written.
 */
function fillValves(workbook: ExcelJS.Workbook, extraction: ExtractionResult, layout: Layout) {
  const vt = layout.valveTable;
  const sheet = workbook.getWorksheet(vt.sheet);
  if (!sheet) return;

  const rowBySize = new Map<number, number>();
  for (let r = vt.firstRow; r <= vt.lastRow; r++) {
    const size = parseSizeMm(sheet.getCell(`O${r}`).value);
    if (size != null && !rowBySize.has(size)) rowBySize.set(size, r);
  }

  for (const v of extraction.watermainValves) {
    if (!(v.quantity > 0)) continue;
    const size = parseSizeMm(v.valveSize);
    const row = size != null ? rowBySize.get(size) : undefined;
    if (row === undefined) {
      const known = [...rowBySize.keys()].join('/');
      extraction.warnings.push(
        `Valve "${v.valveSize}" x${v.quantity}: size not in the template's valve table (${known} mm) — NOT written to the workbook.`
      );
      continue;
    }
    const pCell = sheet.getCell(`P${row}`);
    const existing = typeof pCell.value === 'number' ? pCell.value : 0;
    pCell.value = existing + v.quantity;
    if (v.valveCost) setCellValue(sheet, `Q${row}`, v.valveCost); // 0 => keep template's price
    setCellValue(sheet, `R${row}`, v.boxCost || undefined);
    setCellValue(sheet, `S${row}`, v.anodeCost || undefined);
    setCellValue(sheet, `T${row}`, v.laborPerValve || undefined);
  }
}

/**
 * Set a cell value WITHOUT destroying formulas in other cells.
 * Only writes if the value is defined and non-empty.
 */
/** Whether this MANHOLES sheet's precast formula reads F5 as a percent (40) or a fraction (0.4). */
function discountIsPercent(sheet: ExcelJS.Worksheet): boolean {
  return /100\s*-\s*F\$?5/.test(String(sheet.getCell('N11').formula ?? ''));
}

function setCellValue(
  sheet: ExcelJS.Worksheet,
  cellRef: string,
  value: string | number | undefined
) {
  if (value === undefined || value === null || value === '') return;
  const cell = sheet.getCell(cellRef);
  if (cell.type === ExcelJS.ValueType.Formula || (cell as any).sharedFormula) {
    return; // Do not overwrite existing formulas in the template
  }
  cell.value = value;
}

/**
 * Break shared formula chains on a sheet for specific columns.
 * Converts each shared formula (master or clone) into a standalone formula
 * so that individual cells can be overwritten without breaking the chain.
 *
 * Must be called ONCE after loading the template, before any forceSetCellValue calls.
 */
function breakSharedFormulas(
  sheet: ExcelJS.Worksheet,
  columns: string[],
  startRow: number,
  endRow: number
) {
  for (const col of columns) {
    // First pass: find master formulas and their templates
    const masters: Record<string, { formula: string; ref: string }> = {};

    for (let r = startRow; r <= endRow; r++) {
      const cell = sheet.getCell(`${col}${r}`);
      const v = cell.value as any;
      if (v && typeof v === 'object' && v.formula && v.ref) {
        // This is a master cell
        masters[`${col}${r}`] = { formula: v.formula, ref: v.ref };
      }
    }

    // Second pass: convert all cells (masters and clones) to individual formulas
    for (let r = startRow; r <= endRow; r++) {
      const cellRef = `${col}${r}`;
      const cell = sheet.getCell(cellRef);
      const v = cell.value as any;

      if (v && typeof v === 'object') {
        if (v.formula && v.ref) {
          // Master cell — convert to standalone formula (drop the ref/shareType)
          cell.value = { formula: v.formula } as ExcelJS.CellFormulaValue;
        } else if (v.sharedFormula) {
          // Clone cell — derive the formula from the master by row offset
          const masterRef = v.sharedFormula; // e.g., "J11"
          const masterCol = masterRef.replace(/\d+/g, '');
          const masterRow = parseInt(masterRef.replace(/\D+/g, ''), 10);
          const masterInfo = masters[masterRef];

          if (masterInfo) {
            // Adjust the master formula for this row's offset
            const rowOffset = r - masterRow;
            const adjustedFormula = adjustFormulaForRow(masterInfo.formula, rowOffset);
            cell.value = { formula: adjustedFormula } as ExcelJS.CellFormulaValue;
          }
        }
      }
    }
  }
}

/**
 * Adjust a formula for a row offset.
 * Replaces non-absolute row references (e.g., C11 → C15 for offset 4).
 * Preserves absolute references (e.g., F$7 stays F$7).
 */
export function adjustFormulaForRow(formula: string, rowOffset: number): string {
  if (rowOffset === 0) return formula;

  // Match cell references: column letters followed by optional $ and digits
  return formula.replace(/([A-Z]+)(\$?)(\d+)/g, (match, col, abs, row) => {
    if (abs === '$') {
      // Absolute row reference — don't change
      return match;
    }
    // Relative row reference — adjust
    return `${col}${parseInt(row, 10) + rowOffset}`;
  });
}

/**
 * Force-set a cell value, even if it contains a formula.
 * Used for calculated fields (like depth, diameter) where the estimator
 * manually overrides the formula with a known value.
 *
 * IMPORTANT: breakSharedFormulas() must be called first on the relevant columns
 * to avoid corrupting ExcelJS shared formula chains.
 */
function forceSetCellValue(
  sheet: ExcelJS.Worksheet,
  cellRef: string,
  value: string | number | undefined
) {
  if (value === undefined || value === null || value === '') return;
  try {
    const cell = sheet.getCell(cellRef);
    // Overwrite regardless of whether it's a formula or plain value.
    // Safe because breakSharedFormulas already converted shared formulas to standalone.
    cell.value = value;
  } catch {
    // Silently skip if we can't write
  }
}


