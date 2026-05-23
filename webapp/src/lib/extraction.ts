import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { ExtractionResult } from './types';
import { PIPE_DIAMETERS, MH_DIAMETERS } from './constants';
import { buildFewShotPromptSection } from './few-shot-examples';
import { setGlobalDispatcher, Agent } from 'undici';

// Globally override Undici's default 30-second headers/body timeout
try {
  setGlobalDispatcher(new Agent({
    headersTimeout: 300000, // 5 minutes in milliseconds
    bodyTimeout: 300000,
    connectTimeout: 300000
  }));
  console.log('      [extraction.ts] Undici global dispatcher configured with 5m timeouts.');
} catch (e) {
  console.warn('      [extraction.ts] Failed to configure Undici global dispatcher:', e);
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';


function getGenAI() {
  return new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: LOCATION,
    httpOptions: {
      timeout: 300000 // 5 minutes in milliseconds
    }
  });
}

function getSystemPrompt(projectName: string): string {
  return `You are a senior civil engineering cost estimator analyzing PDF construction/servicing drawings. Your task is to extract ALL infrastructure data from the drawings to populate a standardized cost estimation spreadsheet.

You have deep expertise in Ontario municipal servicing standards and know how cost estimators structure their takeoffs.

## SPREADSHEET STRUCTURE

The spreadsheet has 3 tabs. You must populate data for each:

### Tab 1: MANHOLES (1)
This tab has TWO sections:

**Section A — Structures & Special Items (Rows 11-50, Column B onward)**
List each structure and special item as a separate row:
- description: The label exactly as shown on drawings (e.g., "DCBMH 2", "MH 1/O.P.", "MH 5")
- depth: Depth in meters. Calculate from top elevation - lowest invert if not explicitly stated. Use null for non-structure items.
- addMaterials: Additional material costs ($). For actual structures, this includes grate/frame costs (~$900 for standard, $1500+ for special). For special items like GREENSTORM systems, tanks, etc., this is the total material cost.
- addLE: Additional labor & equipment costs ($). Typically $0 for standard structures, $500+ for connections requiring extra work.

IMPORTANT: This section also includes NON-STRUCTURE line items that the estimator adds:
- Section dividers: "SANITARY" (marks the boundary between storm and sanitary sections)
- Special systems: "GREENSTORM", "SAN XING" (sanitary crossing), "STM TANK" (stormwater tank)
- Site work: "SAW CUT &", "ASPALT REMOVALS", "GRAN*MHs" (granular around manholes), "ROAD RESTORATION", "REMOVALS"
- Fees: "CONSULTING FEE", "MOB." (mobilization)
These items have depth=null and carry costs in addMaterials/addLE.

**Section B — Catchbasin Groups (Rows 53-56)**
Catchbasins are COUNTED BY TYPE, not listed individually:
- SINGLE_CB: Count of single catchbasins on the drawings
- DOUBLE_CB: Count of double catchbasins
- DITCH_INLET_CB: Count of ditch inlet catchbasins
- DOUBLE_DITCH_INLET_CB: Count of double ditch inlet catchbasins

For each group: quantity, wallThickness (default 4"), depth (default 2.2m), grateEach ($), addMaterials ($, typically $900 per CB).

**Section C — Labor Rates (Rows 59-60)**
Default labor rates: SCB=$200, DCB=$250, DICB F&C=$465, DDICB F&C=$715

### Tab 2: SEWERS (1)
List every pipe run AND non-pipe line items:

**Pipe Runs:**
- runLabel: If the drawings explicitly label the pipe runs (e.g., "ST 1", "ST 2", "SAN 1"), use those EXACT explicit labels. ONLY if explicit labels are missing, construct a label in "FROM-TO" format (e.g., "CB 3-DCBMH 2", "MH 1-MH 2"). Add "/INS." if insulation is included. Add "CONN." for connections to existing infrastructure.
- isLineItem: false
- length: Pipe length in meters (from plan/profile)
- pipeDiameter: Pipe diameter in mm. MUST be one of: ${PIPE_DIAMETERS.join(', ')}
- typeClass: 2.35 for concrete storm, 1.3 for PVC (storm or sanitary)
- slope: Pipe slope in PERCENT (%). Default 1.1%. ⚠️ If drawings show slope in ‰ (per mille), DIVIDE BY 10 to convert to %. If slope reads "11‰", use 1.1%.
- depth: Average burial depth in meters (top of pipe to finished grade)
- addMaterials: Additional material costs (e.g., $80/m for insulation → length×80)
- addLE: Additional labor costs (e.g., $40/m for insulation → length×40)

**Non-Pipe Line Items (always appear at the end of the sewer list):**
- runLabel: Item name (e.g., "SWALE", "DEWATERING", "GREENSTORM")
- isLineItem: true
- All pipe fields (length, pipeDiameter, typeClass, slope, depth) = null
- addMaterials: Total cost for the item.
- addLE: 0 (usually)

**SANITARY section divider:** If the project has both storm AND sanitary sewers, insert a row with runLabel="SANITARY", isLineItem=true, all values null/0, between the storm and sanitary pipe runs.

### Tab 3: WATERMAIN (1)
Only populate if watermain work is shown on the drawings.
- sizeAndType: e.g., "200mm C900", "150mm PVC"
- length, pipeDiameter, ocSc (1.1=open-cut single, 1.2=open-cut dual, 2.1=shored single, 2.2=shored dual)
- addMaterials, addLE, avgCover (typically 1.5-2.0m)

If NO watermain work is shown, return EMPTY arrays. Do NOT hallucinate watermain data.

## CRITICAL RULES
1. **Read labels EXACTLY** from the drawings (e.g., "CBMH 1", "MH 10", "BOX MH"). NEVER use generic names like "STM MH-1".
2. **Pipe diameters** MUST be one of: ${PIPE_DIAMETERS.join(', ')} mm. If a diameter is shown in inches, convert to mm (e.g., 12" = 300mm).
3. **Slopes are in %**, not ‰. Convert if necessary: 11‰ → 1.1%.
4. **Look at BOTH plan views AND profile views** for complete data.
5. **Check for MH schedules/tables** on the drawings — these are the most reliable source for labels and elevations.
6. **Count catchbasins by type** — do NOT list them as individual manhole rows.
7. **DO NOT include standard fees** like VIDEO, LAYOUT, or AS BUILT. These will be added automatically by our system. ONLY include line items explicitly drawn or noted on the plans.
8. **Watermain Extraction**: ONLY extract watermain data if watermain work is explicitly shown on the drawings. If no watermain work is shown, return EMPTY arrays for all watermain sections.
9. **Include a confidence score** (0-1) for overall extraction quality.
10. **Abbreviate Structure Prefixes**: Drawings often label storm manholes as "STMH 1" or sanitary as "SANMH 1". Cost estimators abbreviate these to "MH 1" under their respective sections. You MUST drop the "ST", "STM", "SAN" prefixes for manhole descriptions (e.g., STMH 1 -> MH 1, STCBMH 2 -> CBMH 2).
11. **IGNORE EXISTING INFRASTRUCTURE**: Do NOT extract any structures, pipes, or catchbasins that are marked as "EX.", "EXIST.", "EXISTING", or are clearly shown as existing to remain. ONLY extract PROPOSED new infrastructure.

${buildFewShotPromptSection(projectName)}

## OUTPUT FORMAT
Return ONLY valid JSON matching this schema:
{
  "projectName": "string",
  "jobNumber": "string",
  "date": "string",
  "manholes": [{"description": "string", "topElevation": number|null, "lowInvert": number|null, "highInvert": number|null, "pipeOutDiameter": number|null, "structureType": "string"|null, "addMaterials": number, "addLE": number, "depth": number|null, "drop": number|null, "diameter": number|null}],
  "catchbasins": {
    "groups": [{"type": "SINGLE_CB"|"DOUBLE_CB"|"DITCH_INLET_CB"|"DOUBLE_DITCH_INLET_CB", "quantity": number, "wallThickness": number, "depth": number, "grateEach": number, "addMaterials": number}],
    "laborRates": {"scbLabor": number, "dcbLabor": number, "dicbFC": number, "ddicbFC": number}
  },
  "sewers": [{"runLabel": "string", "isLineItem": boolean, "lineItemType": "string"|null, "length": number|null, "pipeDiameter": number|null, "typeClass": number|null, "slope": number|null, "depth": number|null, "addMaterials": number, "addLE": number}],
  "watermain": [{"sizeAndType": "string", "length": number, "pipeDiameter": number, "ocSc": number, "addMaterials": number, "addLE": number, "avgCover": number}],
  "watermainSpecials": [{"specialName": "string", "quantity": number, "costEach": number, "thrustBlock": number, "anodeCost": number, "laborEach": number}],
  "watermainValves": [{"valveSize": "string", "quantity": number, "valveCost": number, "boxCost": number, "anodeCost": number, "laborPerValve": number}],
  "confidence": number,
  "warnings": ["string"]
}
`;
}

import fs from 'fs';
import path from 'path';

function getDynamicPromptAdditions(overridePath?: string): string {
  try {
    const filePath = overridePath || path.resolve(__dirname, 'dynamic-rules.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.promptAdditions && data.promptAdditions.length > 0) {
        // Support both v1 (plain strings) and v2 (objects with metadata)
        const rules = data.promptAdditions.map((r: string | { rule: string }) =>
          typeof r === 'string' ? r : r.rule
        );
        return '\n\n## DYNAMICALLY LEARNED RULES\n' + rules.map((r: string, i: number) => (i + 1) + '. ' + r).join('\n');
      }
    }
  } catch (e) {
    console.error('Failed to load dynamic rules', e);
  }
  return '';
}

function getDynamicHeuristics(overridePath?: string): string[] {
  try {
    const filePath = overridePath || path.resolve(__dirname, 'dynamic-rules.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.heuristics && data.heuristics.length > 0) {
        // Support both v1 (plain strings) and v2 (objects with metadata)
        return data.heuristics.map((h: string | { rule: string }) =>
          typeof h === 'string' ? h : h.rule
        );
      }
    }
  } catch (e) {
    console.error('Failed to load dynamic heuristics', e);
  }
  return [];
}

function applyDeterministicHeuristics(data: ExtractionResult): ExtractionResult {
  // 1. Calculate total pipe length for Video Inspection fee
  let totalSewerLength = 0;
  for (const s of data.sewers) {
    if (!s.isLineItem && s.length) {
      totalSewerLength += s.length;
    }
  }

  // 2. Append standard line items if there are any sewers
  if (data.sewers.length > 0) {
    const videoCost = totalSewerLength * 25; // $25/m
    data.sewers.push({
      item: data.sewers.length + 1,
      runLabel: 'VIDEO ($25/m)',
      isLineItem: true,
      lineItemType: undefined,
      length: null,
      pipeDiameter: null,
      typeClass: null,
      slope: null,
      depth: null,
      addMaterials: videoCost,
      addLE: 0
    });
    
    data.sewers.push({
      item: data.sewers.length + 2,
      runLabel: 'LAYOUT',
      isLineItem: true,
      lineItemType: undefined,
      length: null,
      pipeDiameter: null,
      typeClass: null,
      slope: null,
      depth: null,
      addMaterials: 5000,
      addLE: 0
    });
    
    data.sewers.push({
      item: data.sewers.length + 3,
      runLabel: 'AS BUILT',
      isLineItem: true,
      lineItemType: undefined,
      length: null,
      pipeDiameter: null,
      typeClass: null,
      slope: null,
      depth: null,
      addMaterials: 5000,
      addLE: 0
    });
  }

  return data;
}

function parseRawExtraction(text: string, projectName: string): ExtractionResult {
  try {
    const raw = JSON.parse(text);
    return {
      projectName: raw.projectName || projectName,
      jobNumber: raw.jobNumber || '',
      date: raw.date || new Date().toISOString().split('T')[0],
      templateType: determineTemplateType(raw),
      manholes: (raw.manholes || []).map((m: any, i: number) => ({
        item: i + 1,
        description: String(m.description || ''),
        topElevation: m.topElevation != null ? Number(m.topElevation) : null,
        lowInvert: m.lowInvert != null ? Number(m.lowInvert) : null,
        highInvert: m.highInvert != null ? Number(m.highInvert) : null,
        pipeOutDiameter: m.pipeOutDiameter != null ? Number(m.pipeOutDiameter) : null,
        structureType: m.structureType ? String(m.structureType) : null,
        addMaterials: Number(m.addMaterials) || 0,
        addLE: Number(m.addLE) || 0,
        depth: m.depth != null ? Number(m.depth) : null,
        drop: m.drop != null ? Number(m.drop) : null,
        diameter: m.diameter != null ? snapToPipeDiameter(Number(m.diameter)) : null,
      })),
      catchbasins: {
        groups: (raw.catchbasins?.groups || []).map((g: any) => ({
          type: String(g.type || 'SINGLE_CB'),
          quantity: Number(g.quantity) || 0,
          wallThickness: Number(g.wallThickness) || 4,
          depth: Number(g.depth) || 2.2,
          grateEach: Number(g.grateEach) || 0,
          addMaterials: Number(g.addMaterials) || 0,
        })),
        laborRates: {
          scbLabor: Number(raw.catchbasins?.laborRates?.scbLabor) || 200,
          dcbLabor: Number(raw.catchbasins?.laborRates?.dcbLabor) || 250,
          dicbFC: Number(raw.catchbasins?.laborRates?.dicbFC) || 465,
          ddicbFC: Number(raw.catchbasins?.laborRates?.ddicbFC) || 715,
        },
      },
      sewers: (raw.sewers || []).map((s: Record<string, unknown>, i: number) => ({
        item: i + 1,
        runLabel: String(s.runLabel || ''),
        isLineItem: Boolean(s.isLineItem),
        lineItemType: s.lineItemType ? String(s.lineItemType) : undefined,
        length: s.length != null ? Number(s.length) : null,
        pipeDiameter: s.pipeDiameter != null ? snapToPipeDiameter(Number(s.pipeDiameter)) : null,
        typeClass: s.typeClass != null ? Number(s.typeClass) : null,
        slope: s.slope != null ? normalizeSlope(Number(s.slope)) : null,
        depth: s.depth != null ? Number(s.depth) : null,
        addMaterials: Number(s.addMaterials) || 0,
        addLE: Number(s.addLE) || 0,
      })),
      watermain: (raw.watermain || []).map((w: Record<string, unknown>, i: number) => ({
        item: i + 1,
        sizeAndType: String(w.sizeAndType || ''),
        length: Number(w.length) || 0,
        pipeDiameter: snapToPipeDiameter(Number(w.pipeDiameter) || 0),
        ocSc: Number(w.ocSc) || 1.1,
        addMaterials: Number(w.addMaterials) || 0,
        addLE: Number(w.addLE) || 0,
        avgCover: Number(w.avgCover) || 1.8,
      })),
      watermainSpecials: (raw.watermainSpecials || []).map(
        (sp: Record<string, unknown>, i: number) => ({
          item: i + 1,
          specialName: String(sp.specialName || ''),
          quantity: Number(sp.quantity) || 0,
          costEach: Number(sp.costEach) || 0,
          thrustBlock: Number(sp.thrustBlock) || 0,
          anodeCost: Number(sp.anodeCost) || 100,
          laborEach: Number(sp.laborEach) || 0,
        })
      ),
      watermainValves: (raw.watermainValves || []).map(
        (v: Record<string, unknown>, i: number) => ({
          item: i + 1,
          valveSize: String(v.valveSize || ''),
          quantity: Number(v.quantity) || 0,
          valveCost: Number(v.valveCost) || 0,
          boxCost: Number(v.boxCost) || 285,
          anodeCost: Number(v.anodeCost) || 150,
          laborPerValve: Number(v.laborPerValve) || 150,
        })
      ),
      confidence: Number(raw.confidence) || 0.5,
      warnings: raw.warnings || [],
    };
  } catch (e: any) {
    throw new Error(`Failed to parse Gemini response as JSON: ${text.slice(0, 500)}`);
  }
}

export async function extractFromPDF(
  pdfBuffer: Buffer, // The raw PDF buffer
  projectName: string
): Promise<ExtractionResult> {
  const ai = getGenAI();
  let gcsFileUri: string | null = null;
  let gcsPath: string | null = null;

  try {
    // If the PDF buffer size is larger than 4MB, use GCS upload to avoid HTTP payload limits
    if (pdfBuffer.length > 4 * 1024 * 1024) {
      const fileName = `temp-uploads/${Date.now()}-${Math.random().toString(36).substring(2, 9)}.pdf`;
      console.log(`      [extraction.ts] File size (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB) > 4MB. Uploading to GCS: gs://${BUCKET_NAME}/${fileName}`);
      
      const bucket = storage.bucket(BUCKET_NAME);
      const file = bucket.file(fileName);
      await file.save(pdfBuffer, {
        contentType: 'application/pdf',
        metadata: {
          cacheControl: 'no-cache',
        },
      });
      
      gcsPath = fileName;
      gcsFileUri = `gs://${BUCKET_NAME}/${fileName}`;
    }

    const pdfPart = gcsFileUri 
      ? {
          fileData: {
            fileUri: gcsFileUri,
            mimeType: 'application/pdf',
          },
        }
      : {
          inlineData: {
            mimeType: 'application/pdf',
            data: pdfBuffer.toString('base64'),
          },
        };

    console.log(`      [extraction.ts] Running Single-Pass Gemini Extraction...`);
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            { text: `Project: ${projectName}\n\n${getSystemPrompt(projectName)}${getDynamicPromptAdditions()}` },
            pdfPart,
            {
              text: 'Analyze ALL the above drawing pages and extract the complete infrastructure data. Return ONLY valid JSON matching the schema. Remember: read labels exactly from the drawings, count catchbasins by type, include SANITARY section dividers, and do NOT extract standard fees like VIDEO, LAYOUT, or AS BUILT.',
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    let parsed = parseRawExtraction(response.text || '{}', projectName);

    // Run heuristic validation
    parsed.warnings = [...parsed.warnings, ...validateExtraction(parsed)];

    // Apply deterministic heuristics
    parsed = applyDeterministicHeuristics(parsed);

    return parsed;
  } catch (err: any) {
    console.error('      [extraction.ts] Error during Gemini extraction:', err);
    throw err;
  } finally {
    if (gcsPath) {
      try {
        console.log(`      [extraction.ts] Cleaning up GCS file: gs://${BUCKET_NAME}/${gcsPath}`);
        await storage.bucket(BUCKET_NAME).file(gcsPath).delete();
      } catch (cleanupErr: any) {
        console.error(`      [extraction.ts] GCS cleanup error:`, cleanupErr.message);
      }
    }
  }
}

function determineTemplateType(data: any): 'SHORT' | 'LONG' {
  const sewerCount = (data.sewers || []).length;
  if (sewerCount > 40) return 'LONG';
  return 'SHORT';
}

function snapToPipeDiameter(value: number): number {
  if (value <= 0) return 0;
  // Find closest standard diameter
  let closest = PIPE_DIAMETERS[0];
  let minDiff = Math.abs(value - closest);
  for (const d of PIPE_DIAMETERS) {
    const diff = Math.abs(value - d);
    if (diff < minDiff) {
      minDiff = diff;
      closest = d;
    }
  }
  return closest;
}

/**
 * Normalize slope values — if the model outputs ‰ (per mille) instead of %,
 * convert by dividing by 10. Heuristic: if slope > 10, it's likely ‰.
 */
function normalizeSlope(slope: number): number {
  if (slope > 10) {
    // Likely per-mille, convert to %
    return slope / 10;
  }
  return slope;
}

function validateExtraction(data: ExtractionResult): string[] {
  const warnings: string[] = [];

  // Validate sewers
  for (const sw of data.sewers) {
    if (sw.isLineItem) continue;

    if (sw.length != null && sw.length <= 0) {
      warnings.push(`Sewer ${sw.runLabel}: zero or negative length`);
    }
    if (sw.depth != null && sw.depth > 0 && (sw.depth < 0.5 || sw.depth > 10)) {
      warnings.push(
        `Sewer ${sw.runLabel}: unusual depth ${sw.depth}m (outside 0.5-10m range)`
      );
    }
    if (sw.pipeDiameter != null && !PIPE_DIAMETERS.includes(sw.pipeDiameter) && sw.pipeDiameter > 0) {
      warnings.push(
        `Sewer ${sw.runLabel}: non-standard diameter ${sw.pipeDiameter}mm`
      );
    }
    if (sw.slope != null && sw.slope > 10) {
      warnings.push(
        `Sewer ${sw.runLabel}: slope ${sw.slope}% seems too high — may be ‰ not %`
      );
    }
  }

  // Validate watermain
  for (const wm of data.watermain) {
    if (wm.length <= 0) {
      warnings.push(`Watermain ${wm.sizeAndType}: zero or negative length`);
    }
    if (wm.avgCover < 1.0 || wm.avgCover > 4.0) {
      warnings.push(
        `Watermain ${wm.sizeAndType}: unusual cover ${wm.avgCover}m (outside 1.0-4.0m)`
      );
    }
  }

  // Validate catchbasins
  if (data.catchbasins?.groups) {
    for (const g of data.catchbasins.groups) {
      if (g.quantity <= 0) {
        warnings.push(`Catchbasin group ${g.type}: zero quantity`);
      }
    }
  }

  return warnings;
}
