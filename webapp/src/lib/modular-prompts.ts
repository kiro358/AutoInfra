import { PIPE_DIAMETERS } from './constants';

// IMPORTANT: these prompts extract PHYSICAL FACTS ONLY. The model must never be
// asked for dollar amounts, labor rates, surcharges, or fees — those are applied
// deterministically afterwards by priceTakeoff() (see costing-rules.ts).
const NO_PRICING_RULE = `## DO NOT ESTIMATE COSTS
Extract only what is physically shown on the drawings (labels, dimensions, elevations, counts, materials/classes). NEVER output dollar amounts, labor rates, surcharges, grate/frame costs, or fees — those are computed separately by our costing engine. There are no cost fields in the schema below; do not invent any.`;

/**
 * Page locator (thumbnail-based). Each page is supplied as one downscaled image,
 * preceded by a "Page N:" text marker. The model returns which pages carry the
 * servicing takeoff data, so we tile only those at high DPI.
 */
export function getPageLocatorPrompt(pageCount: number): string {
  return `You are indexing a ${pageCount}-page civil engineering drawing set. Each image is ONE page, labelled "Page N:" in the text immediately before it.

Identify the pages that contain SERVICING TAKEOFF DATA an estimator needs:
- Site SERVICING / grading plans showing PROPOSED storm or sanitary sewers, manholes, and catchbasins (pipe sizes, lengths, slopes, inverts, structure labels).
- PROFILE sheets for those pipes.
- Pipe / Manhole / Catchbasin SCHEDULE tables.
- Watermain plans, profiles, or schedules.

EXCLUDE pages that are: erosion / siltation / sediment control, standard details (OPSD etc.), cover or title sheets, general notes / specifications, legend-only sheets, geotechnical, landscape, architectural, structural, electrical, mechanical, or bid / tender forms.

Be INCLUSIVE within servicing: if a page shows ANY proposed pipe or structure takeoff data, include it. It is better to include a borderline servicing page than to drop one.

Return ONLY JSON: { "relevantPages": [number, ...] }`;
}

/**
 * Single-pass extraction prompt — asks for ALL facts (structures, catchbasins,
 * sewers, watermain) in one structured call over high-DPI image tiles of the
 * located pages. Schedule-first. Output schema matches parseFacts().
 */
export function getSinglePassPrompt(projectName: string, dynamicRules: string): string {
  return `You are a senior civil engineering estimator extracting infrastructure FACTS from civil servicing drawings for the project: "${projectName}".

The images provided are overlapping high-resolution TILES of one or more large-format drawing sheets. Read the actual printed text/annotations. The SAME structure or pipe run appears in multiple overlapping tiles — CONSOLIDATE duplicates into a single entry; do NOT emit a row per tile or per drawn segment.

## STEP 0 — MANDATORY PIPE SCAN (do this FIRST, before anything else)
Before extracting structures or anything else, sweep EVERY tile pipe-by-pipe and copy the VERBATIM
dimension callout of every storm/sanitary pipe segment into a "pipeScan" string array — e.g.
"17.34m-825mmØ CONC STM @0.5%", "12.91m-250mm PVC STM @1.0%", "Ex.1200Ø CONC STM 58.7m @0.34%".
Do not stop until you have swept all tiles; a servicing plan has many pipes, and skipping this step
is the #1 cause of missed runs. Then derive the "sewers" array below with ONE row per PROPOSED
(non-"Ex.") entry in pipeScan. Emit "pipeScan" in your output (it is your working list, kept for audit).
Doing the pipe scan first also prevents the common error of dumping catchbasins into the structure list.

OUTPUT KEY ORDER (important): emit the JSON keys in this exact order — "pipeScan", "sewers",
"catchbasins", "watermain", "watermainSpecials", "watermainValves", "manholes", "warnings". Sewers
MUST come before manholes so that if the response is truncated, the pipe runs (the hardest-won and
most important data) are already emitted rather than lost at the end.

Work SCHEDULE-FIRST where a Manhole/Catchbasin/Pipe schedule table exists. Otherwise read plan and profile annotations (e.g. "DCBMH 2 TOP 260.15", "17.1m-250mm PVC STM @ 0.79%", "CB 3", "DICB 1") and assemble ONE row per PROPOSED run/structure using the EXACT labels printed on the drawing.

Extract these four groups in a single JSON object:

## STRUCTURES ("manholes")
Each PROPOSED manhole/structure (and non-structure line items like "SANITARY", "GREENSTORM", "MOB.") as a row.
List each proposed structure exactly ONCE. Do NOT list existing structures (labelled "EX."/"EXIST."),
structures on adjacent properties/streets, or the same structure seen in several overlapping tiles more
than once — over-listing structures is a common error. Prefer the boxed/bubbled structure labels on the plan.
- description (exact label; drop ST/STM/SAN prefixes: STMH 1 -> MH 1), topElevation, lowInvert, highInvert,
  pipeOutDiameter (mm), structureType, depth (m, if stated). Use null where not shown.

## CATCHBASINS ("catchbasins.groups")
Counted by type (SINGLE_CB, DOUBLE_CB, DITCH_INLET_CB, DOUBLE_DITCH_INLET_CB): quantity, wallThickness (in, or null), depth (m, or null).

## SEWERS ("sewers") — THIS IS THE MOST IMPORTANT SECTION; DO NOT SKIP IT
One row per PROPOSED pipe run BETWEEN TWO STRUCTURES. A servicing plan ALWAYS has pipe runs
connecting its structures — if you found N storm/sanitary structures there are usually a
similar number of pipe runs. Returning structures with an EMPTY sewers list is almost always a
MISTAKE: go back and read the pipe segments. Every proposed pipe on the plan carries a dimension
callout next to it like "23.38m-250mmØ PVC STM @0.5%" or "16.78m-300mmØ PVC STM @0.5%" — EACH of
those callouts is one sewer run; scan every pipe line and list them all.
- EMIT EVERY proposed pipe run you can see — most site plans annotate runs only with a
  dimension callout on the pipe (e.g. "30.0m-375mm PVC STM @ 1.69%") rather than a schedule
  table; extract each one. NEVER drop a pipe just because it's hard to label.
- Prefer to label runLabel by the two connected structures as "FROM-TO" using their EXACT
  labels — e.g. "MH 5-MH 4", "CBMH 2-MH 3", "CB 3-WYE" — tracing the pipe to the structure at
  each end. If you genuinely cannot determine both end structures, STILL emit the run and use
  the printed callout text as runLabel; put the numbers in the fields regardless.
  - If the downstream end ties into an existing / off-site structure, use "-CONN." (e.g. "MH 1A-CONN.").
  - Add a "/INS." suffix only if the run is marked insulated.
- Put the pipe's numbers in the FIELDS (not the label): isLineItem=false, length (m), pipeDiameter
  (mm, one of: ${PIPE_DIAMETERS.join(', ')}), typeClass, slope (%; convert ‰ by /10), depth (m).
- DO NOT create a run for: pipe CROSSINGS ("SEWER CROSSING", "STM/SAN CROSSING"), bare notes about
  connecting to existing infrastructure that aren't a new pipe, or landscape/architectural callouts.
  One physical proposed pipe = one row; consolidate the same run seen across overlapping tiles.
Non-pipe line items that still belong on the sewer sheet (SWALE, DEWATERING, ...): isLineItem=true
with null pipe fields.

## WATERMAIN ("watermain", "watermainSpecials", "watermainValves")
Runs: sizeAndType, length, pipeDiameter, ocSc, avgCover. Specials/valves: name/size + quantity only.
If no watermain work is shown, return empty arrays.

${NO_PRICING_RULE}

## CRITICAL RULES
- IGNORE EXISTING INFRASTRUCTURE ("EX.", "EXIST.", "EXISTING", existing-to-remain). Extract only proposed/modified work.
- Only use plan/profile views and schedules. Ignore cost-estimate tables, bid items, and notes/spec pages.
- DO NOT include VIDEO / LAYOUT / AS BUILT — appended automatically by our system.

${dynamicRules}

## OUTPUT FORMAT
Return ONLY valid JSON:
{
  "manholes": [{"description": "string", "topElevation": number|null, "lowInvert": number|null, "highInvert": number|null, "pipeOutDiameter": number|null, "structureType": "string"|null, "depth": number|null}],
  "catchbasins": {"groups": [{"type": "SINGLE_CB"|"DOUBLE_CB"|"DITCH_INLET_CB"|"DOUBLE_DITCH_INLET_CB", "quantity": number, "wallThickness": number|null, "depth": number|null}]},
  "sewers": [{"runLabel": "string", "isLineItem": boolean, "lineItemType": "string"|null, "length": number|null, "pipeDiameter": number|null, "typeClass": number|null, "slope": number|null, "depth": number|null}],
  "watermain": [{"sizeAndType": "string", "length": number, "pipeDiameter": number, "ocSc": number, "avgCover": number}],
  "watermainSpecials": [{"specialName": "string", "quantity": number}],
  "watermainValves": [{"valveSize": "string", "quantity": number}],
  "confidence": number,
  "warnings": ["string"]
}
`;
}
