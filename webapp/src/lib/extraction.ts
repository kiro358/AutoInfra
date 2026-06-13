import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { ExtractionResult } from './types';
import { PIPE_DIAMETERS, MH_DIAMETERS } from './constants';
import { buildFewShotPromptSection } from './few-shot-examples';
import { setGlobalDispatcher, Agent, ProxyAgent } from 'undici';
import crypto from 'crypto';
import { LOCATOR_SYSTEM_PROMPT, getManholeAgentPrompt, getSewerAgentPrompt, getWatermainAgentPrompt } from './modular-prompts';

// Globally override Undici's default 30-second headers/body timeout and configure proxy if present
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent({
      uri: proxyUrl,
      headersTimeout: 300000, // 5 minutes in milliseconds
      bodyTimeout: 300000,
      connectTimeout: 300000
    }));
    console.log(`      [extraction.ts] Undici global dispatcher configured with ProxyAgent pointing to ${proxyUrl}`);
  } else {
    setGlobalDispatcher(new Agent({
      headersTimeout: 300000, // 5 minutes in milliseconds
      bodyTimeout: 300000,
      connectTimeout: 300000
    }));
    console.log('      [extraction.ts] Undici global dispatcher configured with 5m timeouts (No Proxy).');
  }
} catch (e) {
  console.warn('      [extraction.ts] Failed to configure Undici global dispatcher:', e);
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';


function getGenAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  const useVertex = process.env.USE_VERTEX_AI === 'true' || !apiKey;

  if (useVertex) {
    console.log(`      [extraction.ts] Initializing Gemini client using Vertex AI (Project: ${PROJECT_ID})`);
    return new GoogleGenAI({
      vertexai: true,
      project: PROJECT_ID,
      location: LOCATION,
      httpOptions: {
        timeout: 300000 // 5 minutes in milliseconds
      }
    });
  } else {
    console.log('      [extraction.ts] Initializing Gemini client using Google AI Studio (Free Tier)');
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        timeout: 300000 // 5 minutes in milliseconds
      }
    });
  }
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

function getDynamicPromptAdditions(componentFilter?: 'manholes' | 'sewers' | 'watermain', overridePath?: string): string {
  try {
    const filePath = overridePath || path.resolve(__dirname, 'dynamic-rules.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let output = '';
      
      if (data.promptAdditions && data.promptAdditions.length > 0) {
        // Filter rules by component
        const filtered = data.promptAdditions.filter((r: any) => {
          if (typeof r === 'string') return true;
          if (!componentFilter) return true;
          return !r.component || r.component === 'general' || r.component === componentFilter;
        });

        if (filtered.length > 0) {
          const rules = filtered.map((r: any) => typeof r === 'string' ? r : r.rule);
          output += '\n\n## DYNAMICALLY LEARNED RULES\n' + rules.map((r: string, i: number) => (i + 1) + '. ' + r).join('\n');
        }
      }

      if (data.heuristics && data.heuristics.length > 0) {
        const rules = data.heuristics.map((h: any) => typeof h === 'string' ? h : h.rule);
        output += '\n\n## DYNAMICALLY LEARNED HEURISTICS (ESTIMATOR PREFERENCES)\n' + rules.map((r: string, i: number) => (i + 1) + '. ' + r).join('\n');
      }

      return output;
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

function snapToMHSize(pipeOutDia: number | null): number {
  if (pipeOutDia === null || pipeOutDia <= 0) return 1200;
  if (pipeOutDia <= 450) return 1200;
  if (pipeOutDia <= 600) return 1500;
  if (pipeOutDia <= 825) return 1800;
  if (pipeOutDia <= 1050) return 2400;
  if (pipeOutDia <= 1500) return 3000;
  return 3600;
}

function applyDeterministicHeuristics(data: ExtractionResult): ExtractionResult {
  // Helper to extract clean manhole names from a sewer run label
  const getCleanMHTokens = (label: string): string[] => {
    if (!label || typeof label !== 'string') return [];
    // e.g. "MH 1 - MH 2/INS" -> tokens: ["MH1", "MH2"]
    const upper = label.toUpperCase();
    const withHyphen = upper.replace(/\bTO\b/gi, '-');
    const withoutSpaces = withHyphen.replace(/\s+/g, '');
    const cleanLabel = withoutSpaces.replace(/\/INS/g, '').replace(/CONN/g, '');
    return cleanLabel.split('-').filter(Boolean);
  };

  // Find all connected sewer diameters for each manhole
  const getConnectedSewerDiameters = (mhDesc: string): number[] => {
    const diameters: number[] = [];
    const normalizedMH = (mhDesc || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!normalizedMH) return [];

    for (const sw of data.sewers) {
      if (sw.isLineItem || !sw.runLabel || !sw.pipeDiameter) continue;

      const parts = getCleanMHTokens(sw.runLabel);
      if (parts.includes(normalizedMH)) {
        diameters.push(sw.pipeDiameter);
      }
    }
    return diameters;
  };

  // 1. Manholes post-processing
  data.manholes = data.manholes.map(mh => {
    let depth = mh.depth;
    const inv = (mh.lowInvert !== null && mh.highInvert !== null)
      ? Math.min(mh.lowInvert, mh.highInvert)
      : (mh.lowInvert !== null ? mh.lowInvert : mh.highInvert);
    if (mh.topElevation !== null && inv !== null) {
      const calcDepth = Math.round((mh.topElevation - inv) * 100) / 100;
      if (calcDepth > 0) {
        depth = calcDepth;
      }
    }

    // Determine diameter:
    // Find connected sewers
    const connectedDists = getConnectedSewerDiameters(mh.description);
    const maxPipeDia = connectedDists.length > 0 ? Math.max(...connectedDists) : 0;
    const effectivePipeOutDia = Math.max(mh.pipeOutDiameter || 0, maxPipeDia);

    let diameter = mh.diameter;
    if (diameter === null || diameter === 0) {
      const desc = mh.description.toUpperCase();
      if (desc.includes('DCBMH')) {
        diameter = 1500;
      } else {
        diameter = snapToMHSize(effectivePipeOutDia);
      }
    }

    let addMaterials = mh.addMaterials;
    let addLE = mh.addLE;

    if (addMaterials === 0) {
      const desc = mh.description.toUpperCase();
      if (desc.includes('DCBMH')) {
        addMaterials = 1800;
      } else if (desc.includes('CBMH')) {
        addMaterials = 900;
      } else if (desc.includes('DROP') || desc.includes('EXT.DROP')) {
        addMaterials = 3000;
        addLE = 3000;
      } else if (desc.includes('VALVE CHAMBER') || desc.includes('DCVC')) {
        addMaterials = 3000;
        addLE = 3000;
      }
    }

    return {
      ...mh,
      depth,
      diameter,
      addMaterials,
      addLE,
      pipeOutDiameter: effectivePipeOutDia || mh.pipeOutDiameter
    };
  });

  // 2. Catchbasin groups post-processing
  if (data.catchbasins && data.catchbasins.groups) {
    data.catchbasins.groups = data.catchbasins.groups.map(g => {
      let addMaterials = g.addMaterials;
      if (addMaterials === 0 || addMaterials === null) {
        addMaterials = 900;
      }
      return { ...g, addMaterials };
    });
  }

  // 3. Sewers runs post-processing
  data.sewers = data.sewers.map(sw => {
    let addMaterials = sw.addMaterials;
    let addLE = sw.addLE;

    if (sw.length && !sw.isLineItem) {
      const label = sw.runLabel.toUpperCase();
      if (label.includes('/INS') && addMaterials === 0) {
        addMaterials = sw.length * 80;
        addLE = sw.length * 40;
      } else if (label.includes('CONN') && addMaterials === 0) {
        addMaterials = 500;
        addLE = 250;
      } else if (label.includes('WYE') && addMaterials === 0) {
        addMaterials = 880;
      }
    }
    return { ...sw, addMaterials, addLE };
  });

  // 4. Calculate total pipe length for Video Inspection fee
  let totalSewerLength = 0;
  for (const s of data.sewers) {
    if (!s.isLineItem && s.length) {
      totalSewerLength += s.length;
    }
  }

  // 5. Append standard line items if there are any sewers
  if (data.sewers.length > 0) {
    const videoCost = totalSewerLength * 25; // $25/m

    const hasVideo = data.sewers.some(s => s.runLabel.toUpperCase().includes('VIDEO'));
    if (!hasVideo) {
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
    }

    const hasLayout = data.sewers.some(s => s.runLabel.toUpperCase().includes('LAYOUT'));
    if (!hasLayout) {
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
    }

    const hasAsBuilt = data.sewers.some(s => s.runLabel.toUpperCase().includes('AS BUILT'));
    if (!hasAsBuilt) {
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

async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 6, initialDelay = 10000): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.toLowerCase().includes('resource exhausted'));
      const isAbort = err.name === 'AbortError' || err.message === 'This operation was aborted' || (err.message && err.message.toLowerCase().includes('abort'));
      const isServerError = err.status >= 500 && err.status <= 599;
      const isCancelled = err.status === 499 || (err.message && err.message.includes('499')) || (err.message && err.message.toLowerCase().includes('cancel'));

      if (attempt >= maxRetries || (!isRateLimit && !isAbort && !isServerError && !isCancelled)) {
        throw err;
      }

      let errType = 'Timeout/Abort';
      if (isRateLimit) errType = '429 Rate Limit';
      else if (isCancelled) errType = '499 Cancelled';
      else if (isServerError) errType = `${err.status || '5xx'} Server Error`;

      const delay = initialDelay * Math.pow(2, attempt - 1) + Math.random() * 2000;
      console.warn(`      [extraction.ts] Attempt ${attempt} failed with ${errType}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

import { PDFDocument } from 'pdf-lib';

async function extractPagesFromPDF(pdfBuffer: Buffer, pages: number[]): Promise<Buffer> {
  if (!pages || pages.length === 0) {
    return pdfBuffer;
  }
  try {
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const dstDoc = await PDFDocument.create();
    const totalPages = srcDoc.getPageCount();
    const validIndices = pages
      .map(p => p - 1)
      .filter(idx => idx >= 0 && idx < totalPages);

    if (validIndices.length === 0) {
      return pdfBuffer;
    }

    const copiedPages = await dstDoc.copyPages(srcDoc, validIndices);
    copiedPages.forEach(page => dstDoc.addPage(page));

    const pdfBytes = await dstDoc.save();
    return Buffer.from(pdfBytes);
  } catch (e) {
    console.warn('      [extraction.ts] Failed to extract PDF pages, falling back to full PDF:', e);
    return pdfBuffer;
  }
}

/**
 * Merge multiple PDF buffers into a single consolidated PDF.
 * Used when a project's drawings are split across multiple PDF files.
 */
export async function mergePDFs(buffers: Buffer[]): Promise<Buffer> {
  if (buffers.length === 0) throw new Error('No PDF buffers to merge');
  if (buffers.length === 1) return buffers[0];

  console.log(`      [extraction.ts] Merging ${buffers.length} PDFs...`);
  const mergedDoc = await PDFDocument.create();

  for (let i = 0; i < buffers.length; i++) {
    try {
      const srcDoc = await PDFDocument.load(buffers[i], { ignoreEncryption: true });
      const pageCount = srcDoc.getPageCount();
      const indices = Array.from({ length: pageCount }, (_, j) => j);
      const copiedPages = await mergedDoc.copyPages(srcDoc, indices);
      copiedPages.forEach(page => mergedDoc.addPage(page));
      console.log(`      [extraction.ts]   PDF ${i + 1}: ${pageCount} pages merged`);
    } catch (e) {
      console.warn(`      [extraction.ts]   PDF ${i + 1}: FAILED to merge, skipping:`, e);
    }
  }

  const totalPages = mergedDoc.getPageCount();
  console.log(`      [extraction.ts] Merged PDF total: ${totalPages} pages`);

  const pdfBytes = await mergedDoc.save();
  return Buffer.from(pdfBytes);
}

export async function extractFromPDF(
  pdfInput: Buffer | Buffer[], // Single PDF buffer or array of buffers to merge
  projectName: string,
  gcsSourceUri?: string
): Promise<ExtractionResult> {
  // If given multiple buffers, merge them first
  const pdfBuffer = Array.isArray(pdfInput)
    ? await mergePDFs(pdfInput)
    : pdfInput;
  const ai = getGenAI();
  const apiKey = process.env.GEMINI_API_KEY;
  const useVertex = process.env.USE_VERTEX_AI === 'true' || !apiKey;
  const uploadedFiles: any[] = [];

  let fileUriToUse: string | null = null;
  let gcsPath: string | null = null;
  let isCacheHit = false;

  try {
    if (useVertex) {
      if (gcsSourceUri) {
        fileUriToUse = gcsSourceUri;
        console.log(`      [extraction.ts] Using direct GCS URI: ${fileUriToUse}`);
      } else if (pdfBuffer.length > 4 * 1024 * 1024) {
        const hash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
        const fileName = `cached-drawings/${hash}.pdf`;

        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(fileName);

        console.log(`      [extraction.ts] File size (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB) > 4MB. Checking GCS cache: gs://${BUCKET_NAME}/${fileName}`);

        const [exists] = await file.exists();
        if (exists) {
          console.log(`      [extraction.ts] ⚡ GCS Cache Hit! Reusing gs://${BUCKET_NAME}/${fileName}`);
          isCacheHit = true;
        } else {
          console.log(`      [extraction.ts] Cache Miss. Uploading to GCS: gs://${BUCKET_NAME}/${fileName}`);
          await file.save(pdfBuffer, {
            contentType: 'application/pdf',
            metadata: {
              cacheControl: 'public, max-age=31536000', // Cache for 1 year
            },
          });
        }

        gcsPath = fileName;
        fileUriToUse = `gs://${BUCKET_NAME}/${fileName}`;
      }
    } else {
      // Google AI Studio (Free Tier) - Always upload to Files API for robust PDF parsing
      if (pdfBuffer.length > 0 || gcsSourceUri) {
        const tempPath = path.join(os.tmpdir(), `locator-${crypto.randomBytes(8).toString('hex')}.pdf`);
        fs.writeFileSync(tempPath, pdfBuffer);
        try {
          console.log(`      [extraction.ts] File size (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB) > 0MB or GCS source specified. Uploading to Gemini Files API...`);
          const uploadedFileObj = await ai.files.upload({
            file: tempPath,
            config: { mimeType: 'application/pdf' }
          });
          fileUriToUse = uploadedFileObj.uri || null;
          uploadedFiles.push(uploadedFileObj);
          console.log(`      [extraction.ts] Uploaded successfully to Gemini Files API: ${uploadedFileObj.name} (${uploadedFileObj.uri})`);
        } finally {
          try {
            fs.unlinkSync(tempPath);
          } catch (err) {}
        }
      }
    }

    const pdfPart = fileUriToUse
      ? {
        fileData: {
          fileUri: fileUriToUse,
          mimeType: 'application/pdf',
        },
      }
      : {
        inlineData: {
          mimeType: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      };

    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    console.log(`      [extraction.ts] Total pages in merged PDF: ${totalPages}`);

    let locatorIndex: { manholePages: number[], sewerPages: number[], watermainPages: number[] } | null = null;

    if (totalPages <= 15) {
      const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
      locatorIndex = {
        manholePages: allPages,
        sewerPages: allPages,
        watermainPages: allPages
      };
      console.log(`      [extraction.ts] Small/Medium PDF (<= 15 pages). Skipping locator and using all pages:`, locatorIndex);
    } else {
      console.log(`      [extraction.ts] Stage 1: Running Table Locator Agent...`);
      const locatorResponse = await callWithRetry(async () => {
        return await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            {
              role: 'user',
              parts: [
                { text: LOCATOR_SYSTEM_PROMPT },
                pdfPart,
                { text: 'Analyze the drawing pages and return the JSON index.' }
              ]
            }
          ],
          config: {
            temperature: 0,
            responseMimeType: 'application/json'
          }
        });
      });

      try {
        const parsed = JSON.parse(locatorResponse.text || '{}');
        if (Array.isArray(parsed.manholePages) || Array.isArray(parsed.sewerPages) || Array.isArray(parsed.watermainPages)) {
          locatorIndex = {
            manholePages: parsed.manholePages || [],
            sewerPages: parsed.sewerPages || [],
            watermainPages: parsed.watermainPages || []
          };
        }
        console.log(`      [extraction.ts] Locator results:`, locatorIndex);
      } catch (e) {
        console.warn(`      [extraction.ts] Failed to parse locator response, falling back to all pages`, e);
      }
    }

    const shouldRunManholes = !locatorIndex || locatorIndex.manholePages.length > 0;
    const shouldRunSewers = !locatorIndex || locatorIndex.sewerPages.length > 0;
    const shouldRunWatermain = !locatorIndex || locatorIndex.watermainPages.length > 0;

    // Helper to generate instructions for focusing on specific pages
    const getPageInstructions = (pages: number[], desc: string, isSliced: boolean) => {
      if (isSliced && pages && pages.length > 0) {
        return `\nNote: The provided PDF has been pre-sliced to contain only the relevant pages (original page(s): ${pages.join(', ')}) containing ${desc}. Extract the data from these pages.`;
      }
      if (pages && pages.length > 0) {
        return `\nFocus ONLY on page(s) ${pages.join(', ')} of the provided PDF. These are the identified pages containing ${desc}. Do not extract from any other pages.`;
      }
      return '\nAnalyze the PDF to extract this data.';
    };

    const preparePdfPart = async (buffer: Buffer): Promise<any> => {
      if (useVertex) {
        if (buffer.length > 4 * 1024 * 1024) {
          const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          const fileName = `cached-drawings/${hash}.pdf`;
          const bucket = storage.bucket(BUCKET_NAME);
          const file = bucket.file(fileName);
          const [exists] = await file.exists();
          if (!exists) {
            await file.save(buffer, {
              contentType: 'application/pdf',
              metadata: { cacheControl: 'public, max-age=31536000' }
            });
          }
          return {
            fileData: {
              fileUri: `gs://${BUCKET_NAME}/${fileName}`,
              mimeType: 'application/pdf'
            }
          };
        }
        return {
          inlineData: {
            mimeType: 'application/pdf',
            data: buffer.toString('base64')
          }
        };
      } else {
        // Always upload chunk to Gemini Files API
        if (buffer.length > 0) {
          const tempPath = path.join(os.tmpdir(), `chunk-${crypto.randomBytes(8).toString('hex')}.pdf`);
          fs.writeFileSync(tempPath, buffer);
          try {
            console.log(`      [extraction.ts] File size (${(buffer.length / 1024 / 1024).toFixed(2)}MB) > 0MB. Uploading chunk to Gemini Files API...`);
            const uploadResponse = await ai.files.upload({
              file: tempPath,
              config: { mimeType: 'application/pdf' }
            });
            console.log(`      [extraction.ts] Uploaded successfully: ${uploadResponse.name} (${uploadResponse.uri})`);
            uploadedFiles.push(uploadResponse);
            return {
              fileData: {
                fileUri: uploadResponse.uri || '',
                mimeType: 'application/pdf'
              }
            };
          } finally {
            try {
              fs.unlinkSync(tempPath);
            } catch (err) {}
          }
        }
        return {
          inlineData: {
            mimeType: 'application/pdf',
            data: buffer.toString('base64')
          }
        };
      }
    };

    console.log(`      [extraction.ts] Running extraction agents (Manholes, Sewers, Watermain) in parallel with stagger...`);

    // Helper to add a delay before starting an agent (stagger to avoid simultaneous rate limit hits)
    const stagger = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // --- PARALLEL AGENT EXECUTION WITH STAGGER ---
    const agentTasks: Promise<void>[] = [];

    let manholesData: any = { manholes: [], catchbasins: { groups: [], laborRates: {} } };
    let sewersData: any = { sewers: [] };
    let watermainData: any = { watermain: [], watermainSpecials: [], watermainValves: [] };

    if (shouldRunManholes) {
      agentTasks.push((async () => {
        console.log(`      [extraction.ts] Stage 2: Slicing and Extracting Manholes & Catchbasins...`);
        const targetPages = locatorIndex?.manholePages || [];
        
        const CHUNK_SIZE = 15;
        const chunks: number[][] = [];
        for (let i = 0; i < targetPages.length; i += CHUNK_SIZE) {
          chunks.push(targetPages.slice(i, i + CHUNK_SIZE));
        }
        if (chunks.length === 0) {
          chunks.push([]);
        }

        console.log(`      [extraction.ts] Extracting manholes in ${chunks.length} parallel chunk(s)...`);
        const chunkPromises = chunks.map(async (chunk, chunkIdx) => {
          const slicedBuffer = await extractPagesFromPDF(pdfBuffer, chunk);
          const isSliced = slicedBuffer !== pdfBuffer;
          const subPdfPart = await preparePdfPart(slicedBuffer);

          const response = await callWithRetry(async () => {
            const fewShots = buildFewShotPromptSection(
              projectName,
              { name: projectName, hasWatermain: shouldRunWatermain, hasSanitary: shouldRunSewers },
              'manholes'
            );
            const prompt = getManholeAgentPrompt(projectName, getDynamicPromptAdditions('manholes')) + '\n' + fewShots + getPageInstructions(chunk, 'manholes or catchbasins schedules/plans', isSliced);
            return await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    subPdfPart
                  ]
                }
              ],
              config: {
                temperature: 0,
                responseMimeType: 'application/json'
              }
            });
          });
          
          try {
            const text = response.text || '{}';
            const parsed = tryParseJSONWithRepair(text);
            return parsed;
          } catch (e: any) {
            console.error(`      [extraction.ts] Failed to parse manholes response for chunk ${chunkIdx + 1}: ${e.message}`);
            if (response.candidates?.[0]) {
              console.error(`      [extraction.ts] FinishReason: ${response.candidates[0].finishReason} | Text length: ${response.text?.length || 0}`);
              console.error(`      [extraction.ts] Snippet: ${response.text?.slice(0, 200)} ... ${response.text?.slice(-200)}`);
            }
            return {};
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        const rawManholes: any[] = [];
        const cbGroupsMap = new Map<string, any>();
        let scbLabor = 200, dcbLabor = 250, dicbFC = 465, ddicbFC = 715;

        for (const res of chunkResults) {
          if (Array.isArray(res.manholes)) {
            rawManholes.push(...res.manholes);
          }
          if (res.catchbasins?.groups) {
            for (const g of res.catchbasins.groups) {
              const type = g.type || 'SINGLE_CB';
              const existing = cbGroupsMap.get(type);
              if (!existing) {
                cbGroupsMap.set(type, { ...g });
              } else {
                existing.quantity = (existing.quantity || 0) + (g.quantity || 0);
              }
            }
          }
          if (res.catchbasins?.laborRates) {
            const lr = res.catchbasins.laborRates;
            if (lr.scbLabor) scbLabor = lr.scbLabor;
            if (lr.dcbLabor) dcbLabor = lr.dcbLabor;
            if (lr.dicbFC) dicbFC = lr.dicbFC;
            if (lr.ddicbFC) ddicbFC = lr.ddicbFC;
          }
        }

        manholesData = {
          manholes: deduplicateManholes(rawManholes),
          catchbasins: {
            groups: Array.from(cbGroupsMap.values()),
            laborRates: { scbLabor, dcbLabor, dicbFC, ddicbFC }
          }
        };
        console.log(`      [extraction.ts] Combined manholes extraction: ${manholesData.manholes.length} manholes, ${manholesData.catchbasins.groups.length} catchbasin groups.`);
      })());
    } else {
      console.log(`      [extraction.ts] Stage 2: Skipping Manholes & Catchbasins (no pages located).`);
    }

    if (shouldRunSewers) {
      agentTasks.push((async () => {
        await stagger(2000); // 2s after manholes starts
        console.log(`      [extraction.ts] Stage 3: Slicing and Extracting Sewer Pipe Runs & Line Items...`);
        const targetPages = locatorIndex?.sewerPages || [];
        
        const CHUNK_SIZE = 15;
        const chunks: number[][] = [];
        for (let i = 0; i < targetPages.length; i += CHUNK_SIZE) {
          chunks.push(targetPages.slice(i, i + CHUNK_SIZE));
        }
        if (chunks.length === 0) {
          chunks.push([]);
        }

        console.log(`      [extraction.ts] Extracting sewers in ${chunks.length} parallel chunk(s)...`);
        const chunkPromises = chunks.map(async (chunk, chunkIdx) => {
          const slicedBuffer = await extractPagesFromPDF(pdfBuffer, chunk);
          const isSliced = slicedBuffer !== pdfBuffer;
          const subPdfPart = await preparePdfPart(slicedBuffer);

          const response = await callWithRetry(async () => {
            const fewShots = buildFewShotPromptSection(
              projectName,
              { name: projectName, hasWatermain: shouldRunWatermain, hasSanitary: shouldRunSewers },
              'sewers'
            );
            const prompt = getSewerAgentPrompt(projectName, getDynamicPromptAdditions('sewers')) + '\n' + fewShots + getPageInstructions(chunk, 'sewer profile views or plan tables', isSliced);
            return await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    subPdfPart
                  ]
                }
              ],
              config: {
                temperature: 0,
                responseMimeType: 'application/json'
              }
            });
          });
          
          try {
            const text = response.text || '{}';
            const parsed = tryParseJSONWithRepair(text);
            return parsed.sewers || [];
          } catch (e: any) {
            console.error(`      [extraction.ts] Failed to parse sewers response for chunk ${chunkIdx + 1}: ${e.message}`);
            if (response.candidates?.[0]) {
              console.error(`      [extraction.ts] FinishReason: ${response.candidates[0].finishReason} | Text length: ${response.text?.length || 0}`);
              console.error(`      [extraction.ts] Snippet: ${response.text?.slice(0, 200)} ... ${response.text?.slice(-200)}`);
            }
            return [];
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        const combinedSewersList = chunkResults.flat();
        sewersData = {
          sewers: deduplicateSewers(combinedSewersList)
        };
        console.log(`      [extraction.ts] Combined sewers extraction: ${sewersData.sewers.length} sewer runs.`);
      })());
    } else {
      console.log(`      [extraction.ts] Stage 3: Skipping Sewer Pipe Runs & Line Items (no pages located).`);
    }

    if (shouldRunWatermain) {
      agentTasks.push((async () => {
        await stagger(4000); // 4s after manholes starts
        console.log(`      [extraction.ts] Stage 4: Slicing and Extracting Watermain Infrastructure...`);
        const targetPages = locatorIndex?.watermainPages || [];
        
        const CHUNK_SIZE = 15;
        const chunks: number[][] = [];
        for (let i = 0; i < targetPages.length; i += CHUNK_SIZE) {
          chunks.push(targetPages.slice(i, i + CHUNK_SIZE));
        }
        if (chunks.length === 0) {
          chunks.push([]);
        }

        console.log(`      [extraction.ts] Extracting watermain in ${chunks.length} parallel chunk(s)...`);
        const chunkPromises = chunks.map(async (chunk, chunkIdx) => {
          const slicedBuffer = await extractPagesFromPDF(pdfBuffer, chunk);
          const isSliced = slicedBuffer !== pdfBuffer;
          const subPdfPart = await preparePdfPart(slicedBuffer);

          const response = await callWithRetry(async () => {
            const fewShots = buildFewShotPromptSection(
              projectName,
              { name: projectName, hasWatermain: shouldRunWatermain, hasSanitary: shouldRunSewers },
              'watermain'
            );
            const prompt = getWatermainAgentPrompt(projectName, getDynamicPromptAdditions('watermain')) + '\n' + fewShots + getPageInstructions(chunk, 'watermain tables/schedules', isSliced);
            return await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    subPdfPart
                  ]
                }
              ],
              config: {
                temperature: 0,
                responseMimeType: 'application/json'
              }
            });
          });
          
          try {
            const text = response.text || '{}';
            const parsed = tryParseJSONWithRepair(text);
            return parsed;
          } catch (e: any) {
            console.error(`      [extraction.ts] Failed to parse watermain response for chunk ${chunkIdx + 1}: ${e.message}`);
            if (response.candidates?.[0]) {
              console.error(`      [extraction.ts] FinishReason: ${response.candidates[0].finishReason} | Text length: ${response.text?.length || 0}`);
              console.error(`      [extraction.ts] Snippet: ${response.text?.slice(0, 200)} ... ${response.text?.slice(-200)}`);
            }
            return {};
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        const rawWatermain: any[] = [];
        const rawSpecials: any[] = [];
        const rawValves: any[] = [];

        for (const res of chunkResults) {
          if (Array.isArray(res.watermain)) rawWatermain.push(...res.watermain);
          if (Array.isArray(res.watermainSpecials)) rawSpecials.push(...res.watermainSpecials);
          if (Array.isArray(res.watermainValves)) rawValves.push(...res.watermainValves);
        }

        watermainData = {
          watermain: deduplicateWatermain(rawWatermain),
          watermainSpecials: deduplicateSpecials(rawSpecials),
          watermainValves: deduplicateValves(rawValves)
        };
        console.log(`      [extraction.ts] Combined watermain extraction: ${watermainData.watermain.length} runs, ${watermainData.watermainSpecials.length} specials, ${watermainData.watermainValves.length} valves.`);
      })());
    } else {
      console.log(`      [extraction.ts] Stage 4: Skipping Watermain Infrastructure (no pages located).`);
    }

    // Wait for all parallel agents to complete
    await Promise.all(agentTasks);

    // Combine structured extraction outputs
    const combinedText = JSON.stringify({
      projectName: manholesData.projectName || sewersData.projectName || projectName,
      jobNumber: manholesData.jobNumber || sewersData.jobNumber || '',
      date: manholesData.date || sewersData.date || new Date().toISOString().split('T')[0],
      manholes: manholesData.manholes || [],
      catchbasins: manholesData.catchbasins || { groups: [], laborRates: {} },
      sewers: sewersData.sewers || [],
      watermain: watermainData.watermain || [],
      watermainSpecials: watermainData.watermainSpecials || [],
      watermainValves: watermainData.watermainValves || [],
      confidence: (Number(manholesData.confidence) || 0.9 + Number(sewersData.confidence) || 0.9 + Number(watermainData.confidence) || 0.9) / 3,
      warnings: [
        ...(manholesData.warnings || []),
        ...(sewersData.warnings || []),
        ...(watermainData.warnings || [])
      ]
    });

    let parsed = parseRawExtraction(combinedText, projectName);

    // Run heuristic validation
    parsed.warnings = [...parsed.warnings, ...validateExtraction(parsed)];

    // Apply deterministic heuristics
    parsed = applyDeterministicHeuristics(parsed);

    parsed.locatorIndex = locatorIndex;

    return parsed;
  } catch (err: any) {
    console.error('      [extraction.ts] Error during Gemini extraction:', err);
    throw err;
  } finally {
    if (gcsPath) {
      if (isCacheHit) {
        console.log(`      [extraction.ts] Reused cached drawing: gs://${BUCKET_NAME}/${gcsPath}`);
      } else {
        console.log(`      [extraction.ts] Persisted new drawing in GCS cache: gs://${BUCKET_NAME}/${gcsPath}`);
      }
    }
    // Clean up files uploaded to Gemini Files API
    for (const f of uploadedFiles) {
      if (f.name) {
        try {
          console.log(`      [extraction.ts] Cleaning up Gemini Files API file: ${f.name}`);
          await ai.files.delete({ name: f.name });
        } catch (err: any) {
          console.warn(`      [extraction.ts] Failed to delete file ${f.name} from Gemini Files API:`, err.message);
        }
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

  // Filter out catchbasin groups with zero quantity to prevent false warnings
  if (data.catchbasins?.groups) {
    data.catchbasins.groups = data.catchbasins.groups.filter(g => g.quantity > 0);
  }

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

export function repairTruncatedJson(text: string): string {
  let lastValidEndIndex = -1;
  let inString = false;
  let escape = false;
  const bracketStack: string[] = [];
  const stackAtValidEnd: string[][] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{' || char === '[') {
        bracketStack.push(char);
      } else if (char === '}') {
        if (bracketStack[bracketStack.length - 1] === '{') {
          bracketStack.pop();
          lastValidEndIndex = i;
          stackAtValidEnd[i] = [...bracketStack];
        }
      } else if (char === ']') {
        if (bracketStack[bracketStack.length - 1] === '[') {
          bracketStack.pop();
          lastValidEndIndex = i;
          stackAtValidEnd[i] = [...bracketStack];
        }
      }
    }
  }

  if (lastValidEndIndex === -1) {
    return text;
  }

  let sliced = text.slice(0, lastValidEndIndex + 1);
  const openBrackets = stackAtValidEnd[lastValidEndIndex] || [];
  let closing = '';
  for (let j = openBrackets.length - 1; j >= 0; j--) {
    const b = openBrackets[j];
    if (b === '{') closing += '}';
    else if (b === '[') closing += ']';
  }

  return sliced + closing;
}

export function tryParseJSONWithRepair(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e: any) {
    console.warn(`      [extraction.ts] JSON parsing failed initially: ${e.message}. Attempting repair...`);
    try {
      const repaired = repairTruncatedJson(trimmed);
      const parsed = JSON.parse(repaired);
      console.log(`      [extraction.ts] 🎉 JSON successfully repaired and parsed!`);
      return parsed;
    } catch (repairErr: any) {
      console.error(`      [extraction.ts] ❌ JSON repair failed: ${repairErr.message}`);
      throw e;
    }
  }
}

export function deduplicateManholes(manholes: any[]): any[] {
  const seen = new Map<string, any>();
  for (const mh of manholes) {
    const key = String(mh.description || '').trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...mh });
    } else {
      // Merge complementary properties
      for (const k of Object.keys(mh)) {
        if (existing[k] == null && mh[k] != null) {
          existing[k] = mh[k];
        }
      }
      const existingScore = (existing.depth != null ? 1 : 0) + (existing.topElevation != null ? 1 : 0);
      const currentScore = (mh.depth != null ? 1 : 0) + (mh.topElevation != null ? 1 : 0);
      if (currentScore > existingScore) {
        const merged = { ...existing, ...mh };
        for (const k of Object.keys(merged)) {
          if (merged[k] == null && existing[k] != null) {
            merged[k] = existing[k];
          }
        }
        seen.set(key, merged);
      }
    }
  }
  return Array.from(seen.values());
}

export function deduplicateSewers(sewers: any[]): any[] {
  const seen = new Map<string, any>();
  for (const sw of sewers) {
    const key = String(sw.runLabel || '').trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...sw });
    } else {
      // Merge complementary properties
      for (const k of Object.keys(sw)) {
        if (existing[k] == null && sw[k] != null) {
          existing[k] = sw[k];
        }
      }
      const existingScore = (existing.length != null ? 1 : 0) + (existing.pipeDiameter != null ? 1 : 0);
      const currentScore = (sw.length != null ? 1 : 0) + (sw.pipeDiameter != null ? 1 : 0);
      if (currentScore > existingScore) {
        const merged = { ...existing, ...sw };
        for (const k of Object.keys(merged)) {
          if (merged[k] == null && existing[k] != null) {
            merged[k] = existing[k];
          }
        }
        seen.set(key, merged);
      }
    }
  }
  return Array.from(seen.values());
}

export function deduplicateWatermain(watermain: any[]): any[] {
  const seen = new Map<string, any>();
  for (const wm of watermain) {
    const key = String(wm.sizeAndType || '').trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...wm });
    } else {
      existing.length = (existing.length || 0) + (wm.length || 0);
    }
  }
  return Array.from(seen.values());
}

export function deduplicateSpecials(specials: any[]): any[] {
  const seen = new Map<string, any>();
  for (const sp of specials) {
    const key = String(sp.specialName || '').trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...sp });
    } else {
      existing.quantity = (existing.quantity || 0) + (sp.quantity || 0);
    }
  }
  return Array.from(seen.values());
}

export function deduplicateValves(valves: any[]): any[] {
  const seen = new Map<string, any>();
  for (const v of valves) {
    const key = String(v.valveSize || '').trim().toLowerCase();
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...v });
    } else {
      existing.quantity = (existing.quantity || 0) + (v.quantity || 0);
    }
  }
  return Array.from(seen.values());
}

