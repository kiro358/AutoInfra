/**
 * Few-shot examples extracted from ground truth projects.
 * These are used in the extraction prompt to teach the model
 * the exact output format the estimator expects.
 *
 * Selected projects span simple → medium → complex scenarios.
 */

export interface ProjectMetadata {
  hasWatermain: boolean;
  hasSanitary: boolean;
  isLargeSubdivision: boolean;
  estimatedPageCount: number;
}

export interface FewShotExample {
  projectName: string;
  description: string;
  expectedOutput: object;
  metadata?: ProjectMetadata;
}

import fs from 'fs';
import path from 'path';

const STANDARD_FEE_LABELS = ['VIDEO', 'LAYOUT', 'AS BUILT'];
const MAX_DYNAMIC_FEW_SHOTS = 3;

function isStandardFeeLine(label: string): boolean {
  const upper = label.toUpperCase();
  return STANDARD_FEE_LABELS.some(fee => upper.includes(fee));
}

function loadDynamicFewShots(overridePath?: string): FewShotExample[] {
  try {
    let filePath = overridePath || path.resolve(__dirname, '../../few_shot_examples.json');
    if (!overridePath && !fs.existsSync(filePath)) {
      filePath = path.resolve(process.cwd(), 'few_shot_examples.json');
    }
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const examples: FewShotExample[] = [];

      for (const d of data) {
        // Validate required fields
        if (!d.projectName || (!d.manholes && !d.sewers)) {
          console.warn(`Skipping invalid dynamic few-shot: missing required fields (${d.projectName || 'unnamed'})`);
          continue;
        }

        // Filter out standard fee line items from sewer entries
        if (d.sewers && Array.isArray(d.sewers)) {
          d.sewers = d.sewers.filter((s: any) => {
            if (!s.runLabel) return true;
            return !isStandardFeeLine(s.runLabel);
          });
        }

        examples.push({
          projectName: d.projectName,
          description: d.description || 'Auto-added from optimization flywheel.',
          expectedOutput: d,
        });
      }

      // Cap at MAX_DYNAMIC_FEW_SHOTS to prevent prompt bloat
      if (examples.length > MAX_DYNAMIC_FEW_SHOTS) {
        console.warn(`Dynamic few-shots capped: ${examples.length} → ${MAX_DYNAMIC_FEW_SHOTS}`);
        return examples.slice(0, MAX_DYNAMIC_FEW_SHOTS);
      }
      return examples;
    }
  } catch (e) {
    console.error('Failed to load dynamic few shots', e);
  }
  return [];
}

/**
 * Example 1: Simple project — Georgian Dr, Barrie
 * 3 manholes, 7 sewer runs (3 pipe + 4 line items), 2 CB groups
 * Demonstrates: basic structure, non-pipe line items, CB grouping, no watermain
 */
const EXAMPLE_1: FewShotExample = {
  projectName: '201 GEORGIAN DRIVE, BARRIE (2026-067)',
  description:
    'Small commercial parking lot expansion. Storm sewer only with 2 manholes, ' +
    '1 DCBMH, 2 single catchbasins, 1 ditch inlet catchbasin. ' +
    'Also includes a GreenStorm system and sanitary connection is NOT included in this scope.',
  expectedOutput: {
    projectName: '201 GEORGIAN DRIVE , BARRIE',
    jobNumber: '2026-067',
    date: 'APR.19th,2026',
    manholes: [
      { description: 'DCBMH 2', depth: 2, addMaterials: 900, addLE: 0 },
      { description: 'MH 1/O.P.', depth: 1.7, addMaterials: 1500, addLE: 500 },
      { description: 'GREENSTORM', depth: null, addMaterials: 39835, addLE: 17430 },
    ],
    catchbasins: {
      groups: [
        { type: 'SINGLE_CB', quantity: 2, wallThickness: 4, depth: 2.2, grateEach: 0, addMaterials: 900 },
        { type: 'DITCH_INLET_CB', quantity: 1, wallThickness: 4, depth: 2.2, grateEach: 0, addMaterials: 900 },
      ],
      laborRates: { scbLabor: 200, dcbLabor: 250, dicbFC: 465, ddicbFC: 715 },
    },
    sewers: [
      { runLabel: 'CB 3-DCBMH 2', isLineItem: false, length: 21, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.7, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 1-MH 1/INS.', isLineItem: false, length: 9, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 720, addLE: 360 },
      { runLabel: 'DICB 1-CONN.', isLineItem: false, length: 17, pipeDiameter: 250, typeClass: 2.35, slope: 1.1, depth: 2.3, addMaterials: 500, addLE: 250 },
      { runLabel: 'SWALE', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 1774, addLE: 2376 },
      { runLabel: 'VIDEO ($25/m)', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 705, addLE: 0 },
      { runLabel: 'LAYOUT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
      { runLabel: 'AS BUILT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
    ],
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 0.85,
    warnings: [],
  },
};

/**
 * Example 2: Medium project — Holiday Inn, Trenton
 * 11 manholes (incl. sanitary section), 17 sewer runs, 1 CB group
 * Demonstrates: dual sewer types (storm + sanitary), deeper manholes, section headers
 */
const EXAMPLE_2: FewShotExample = {
  projectName: 'HOLIDAY INN, TRENTON (2026-068)',
  description:
    'Hotel development with storm + sanitary sewer. 6 storm manholes/CBMHs, ' +
    '3 sanitary manholes (MH 1A, 2A, 3A), 3 single catchbasins. ' +
    'Includes sanitary crossing (SAN XING) as a special item.',
  expectedOutput: {
    projectName: 'HOLIDAY INN',
    jobNumber: '2026-068',
    date: 'APRIL.13th2026',
    manholes: [
      { description: 'CBMH 1/RIP RAP', depth: 2.03, addMaterials: 1800, addLE: 500 },
      { description: 'CBMH 2', depth: 1.96, addMaterials: 900, addLE: 0 },
      { description: 'CBMH 4', depth: 1.49, addMaterials: 900, addLE: 0 },
      { description: 'CBMH 5', depth: 1.43, addMaterials: 900, addLE: 0 },
      { description: 'MH 9', depth: 1.29, addMaterials: 0, addLE: 0 },
      { description: 'HS 4/RIP RAP', depth: 1.73, addMaterials: 1000, addLE: 500 },
      { description: 'SAN XING', depth: null, addMaterials: 23870, addLE: 21040 },
      { description: 'SANITARY', depth: null, addMaterials: 0, addLE: 0 },
      { description: 'MH 1A-DH', depth: 3.64, addMaterials: 3000, addLE: 6000 },
      { description: 'MH 2A', depth: 3.06, addMaterials: 0, addLE: 0 },
      { description: 'MH 3A', depth: 1, addMaterials: 0, addLE: 0 },
    ],
    catchbasins: {
      groups: [
        { type: 'SINGLE_CB', quantity: 3, wallThickness: 4, depth: 2.2, grateEach: 0, addMaterials: 900 },
      ],
      laborRates: { scbLabor: 200, dcbLabor: 250, dicbFC: 465, ddicbFC: 715 },
    },
    sewers: [
      { runLabel: 'CBMH 1-RIP RAP/INS.', isLineItem: false, length: 13, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 1040, addLE: 520 },
      { runLabel: 'CBMH 1-CBMH 2/INS.', isLineItem: false, length: 20, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.7, addMaterials: 1600, addLE: 800 },
      { runLabel: 'CBMH 2-CB 3/INS.', isLineItem: false, length: 35, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.3, addMaterials: 2800, addLE: 1400 },
      { runLabel: 'HS 4-RIP RAP/INS.', isLineItem: false, length: 8, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 640, addLE: 320 },
      { runLabel: 'HS 4-CBMH 4/INS.', isLineItem: false, length: 16, pipeDiameter: 100, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 1280, addLE: 640 },
      { runLabel: 'CBMH 4-CBMH 5/INS.', isLineItem: false, length: 10, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.2, addMaterials: 800, addLE: 400 },
      { runLabel: 'CBMH 5-MH 9/INS.', isLineItem: false, length: 19, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.9, addMaterials: 1520, addLE: 760 },
      { runLabel: 'MH 9-PLUG/INS.', isLineItem: false, length: 6, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.3, addMaterials: 840, addLE: 240 },
      { runLabel: 'CBMH 4-CB 6/INS.', isLineItem: false, length: 12, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.1, addMaterials: 960, addLE: 480 },
      { runLabel: 'CBMH 5-CB 7/INS.', isLineItem: false, length: 12, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.1, addMaterials: 960, addLE: 480 },
      { runLabel: 'SANITARY', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 0, addLE: 0 },
      { runLabel: 'D.H.-MH 2A', isLineItem: false, length: 15, pipeDiameter: 200, typeClass: 2.35, slope: 2.1, depth: 3.2, addMaterials: 0, addLE: 0 },
      { runLabel: 'MH 2A-MH 1A', isLineItem: false, length: 20, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 0, addLE: 0 },
      { runLabel: 'MH 1A-PLUG', isLineItem: false, length: 37, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 150, addLE: 0 },
      { runLabel: 'VIDEO ($15/m)', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 3345, addLE: 0 },
      { runLabel: 'LAYOUT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
      { runLabel: 'AS BUILT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
    ],
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 0.9,
    warnings: [],
  },
};

/**
 * Example 3: Complex project — Aircraft Hangar, Waterloo Airport
 * 13 manholes (incl. sanitary + special items), 21 sewer runs, 10 CBs
 * Demonstrates: large CB count, multiple pipe diameters, stormwater tank, sanitary split
 */
const EXAMPLE_3: FewShotExample = {
  projectName: 'AIRCRAFT HANGAR, WATERLOO AIRPORT (2026-021)',
  description:
    'Industrial hangar with large storm system draining to a pond. ' +
    '5 storm manholes (MH 1-5) with increasing pipe diameters (200→525mm), ' +
    '10 single catchbasins connecting via wyes, stormwater tank, ' +
    'and separate sanitary sewer with 1 manhole (MH 6A).',
  expectedOutput: {
    projectName: 'AIRCRAFT HANGAR,WATERLOO AIRPORT',
    jobNumber: '2026-021',
    date: 'FEB.6th,2026',
    manholes: [
      { description: 'MH 5', depth: 2.75, addMaterials: 1720, addLE: 0 },
      { description: 'MH 4', depth: 2.71, addMaterials: 1650, addLE: 0 },
      { description: 'MH 3', depth: 2.63, addMaterials: 850, addLE: 0 },
      { description: 'MH 2', depth: 2.17, addMaterials: 570, addLE: 0 },
      { description: 'MH 1', depth: 1.83, addMaterials: 420, addLE: 0 },
      { description: 'SAW CUT &', depth: null, addMaterials: 0, addLE: 0 },
      { description: 'ASPALT REMOVALS', depth: null, addMaterials: 0, addLE: 0 },
      { description: 'GRAN*MHs', depth: null, addMaterials: 11200, addLE: 0 },
      { description: 'ROAD RESTORATION', depth: null, addMaterials: 0, addLE: 0 },
      { description: 'STM TANK', depth: null, addMaterials: 133360, addLE: 50000 },
      { description: 'CONSULTING FEE', depth: null, addMaterials: 50000, addLE: 0 },
      { description: 'SANITARY', depth: null, addMaterials: 0, addLE: 0 },
      { description: 'MH 6A', depth: 1.08, addMaterials: 200, addLE: 0 },
    ],
    catchbasins: {
      groups: [
        { type: 'SINGLE_CB', quantity: 10, wallThickness: 4, depth: 2.2, grateEach: 0, addMaterials: 900 },
      ],
      laborRates: { scbLabor: 200, dcbLabor: 250, dicbFC: 465, ddicbFC: 715 },
    },
    sewers: [
      { runLabel: 'CB 1-MH 1', isLineItem: false, length: 9, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 2-MH 1', isLineItem: false, length: 8, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 0, addLE: 0 },
      { runLabel: 'MH 1-MH 2', isLineItem: false, length: 50, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 2.4, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 3-WYE', isLineItem: false, length: 8, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 880, addLE: 0 },
      { runLabel: 'CB 4-WYE', isLineItem: false, length: 7, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 880, addLE: 0 },
      { runLabel: 'MH 2-MH 3', isLineItem: false, length: 57, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 1.7, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 5-MH 2', isLineItem: false, length: 8, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 6-WYE', isLineItem: false, length: 5, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 880, addLE: 0 },
      { runLabel: 'CB 7-WYE', isLineItem: false, length: 3, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 880, addLE: 0 },
      { runLabel: 'MH 3-MH 4', isLineItem: false, length: 28, pipeDiameter: 450, typeClass: 2.35, slope: 1.1, depth: 1.6, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 8-MH 4', isLineItem: false, length: 7, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 9-MH 4', isLineItem: false, length: 6, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 0, addLE: 0 },
      { runLabel: 'MH 4-MH 5', isLineItem: false, length: 39, pipeDiameter: 525, typeClass: 2.35, slope: 1.1, depth: 1.6, addMaterials: 0, addLE: 0 },
      { runLabel: 'CB 10-WYE', isLineItem: false, length: 4, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1.5, addMaterials: 880, addLE: 0 },
      { runLabel: 'MH 5-POND', isLineItem: false, length: 4, pipeDiameter: 525, typeClass: 2.35, slope: 1.1, depth: 1.6, addMaterials: 0, addLE: 0 },
      { runLabel: 'SANITARY', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 0, addLE: 0 },
      { runLabel: 'MH 6A-PLUG', isLineItem: false, length: 40, pipeDiameter: 200, typeClass: 2.35, slope: 1.1, depth: 1, addMaterials: 150, addLE: 0 },
      { runLabel: 'MH 6A-CONN.', isLineItem: false, length: 62, pipeDiameter: 200, typeClass: 2.35, slope: 2.1, depth: 1.2, addMaterials: 3000, addLE: 3000 },
      { runLabel: 'VIDEO ($25/m)', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 8625, addLE: 0 },
      { runLabel: 'LAYOUT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
      { runLabel: 'AS BUILT', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, addMaterials: 5000, addLE: 0 },
    ],
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 0.9,
    warnings: [],
  },
};

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [EXAMPLE_1, EXAMPLE_2, EXAMPLE_3];

function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(str1.toLowerCase().split(/\\W+/).filter(w => w.length > 2));
  const words2 = new Set(str2.toLowerCase().split(/\\W+/).filter(w => w.length > 2));
  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  return intersection;
}

/**
 * Builds the few-shot portion of the prompt as a string.
 * Each example includes the project context and the exact JSON output expected.
 */
export function buildFewShotPromptSection(targetProjectName: string): string {
  const dynamicFewShots = loadDynamicFewShots();
  const examples = [...FEW_SHOT_EXAMPLES, ...dynamicFewShots];

  // Filter out standard fees from the expected output so they don't contradict the prompt rules
  // AND exclude the target project itself to prevent the model from cheating
  const validExamples: FewShotExample[] = [];
  examples.forEach(ex => {
    // If the project name is heavily similar to the target, it's the same project. Skip it.
    if (calculateSimilarity(targetProjectName, ex.projectName) >= 3 || targetProjectName.includes(ex.projectName)) {
      return;
    }

    const out = ex.expectedOutput as any;
    if (out && out.sewers && Array.isArray(out.sewers)) {
      out.sewers = out.sewers.filter((s: any) => {
        if (!s.runLabel) return true;
        const lbl = s.runLabel.toUpperCase();
        return !lbl.includes('VIDEO') && !lbl.includes('LAYOUT') && !lbl.includes('AS BUILT');
      });
    }
    validExamples.push(ex);
  });

  const scoredExamples = validExamples.map(ex => {
    let score = calculateSimilarity(targetProjectName, ex.projectName);
    score += calculateSimilarity(targetProjectName, ex.description) * 0.5;
    return { example: ex, score };
  });

  scoredExamples.sort((a, b) => b.score - a.score);
  const selectedExamples = scoredExamples.slice(0, 3).map(s => s.example);

  const parts: string[] = [];
  parts.push(`\\n## FEW-SHOT EXAMPLES\\nThe following are real projects with their CORRECT extraction outputs. Study these carefully — your output must match this format exactly.\\n`);

  for (let i = 0; i < selectedExamples.length; i++) {
    const ex = selectedExamples[i];
    parts.push(`### EXAMPLE ${i + 1}: ${ex.projectName}`);
    parts.push(`Context: ${ex.description}`);
    parts.push(`CORRECT OUTPUT:\\n\`\`\`json\\n${JSON.stringify(ex.expectedOutput, null, 2)}\\n\`\`\`\\n`);
  }

  parts.push(`### KEY PATTERNS TO LEARN FROM THESE EXAMPLES:`);
  parts.push(`1. **Manholes section** includes BOTH physical structures (e.g., CBMH 1, MH 10, BOX MH) AND special line items (e.g., GREENSTORM, SAN XING, STM TANK, CONSULTING FEE, SAW CUT, REMOVALS, RESTORATION, GRAN*MHs). The line items have depth=null and use addMaterials/addLE for costs. Use EXACT labels from the drawings.`);
  parts.push(`2. **"SANITARY" appears as a section divider** — it's a row with description="SANITARY" and null/zero values, placed between storm and sanitary sections. All structures after this divider should be sanitary structures.`);
  parts.push(`3. **Catchbasins are GROUPED by type** (SINGLE_CB, DOUBLE_CB, DITCH_INLET_CB, DOUBLE_DITCH_INLET_CB) with a total quantity count, not listed individually.`);
  parts.push(`4. **Sewer run labels use exact format**: "FROM-TO" (e.g., "CB 3-DCBMH 2", "MH 1-MH 2"). Labels with "/INS." mean "including installation". Labels with "CONN." mean connection to existing.`);
  parts.push(`5. **Non-pipe sewer line items** include SWALE, DEWATERING, etc. These always appear at the end. DO NOT extract standard fees like VIDEO, LAYOUT, or AS BUILT.`);
  parts.push(`6. **Wye connections** (CB connecting to main via wye) have addMaterials of ~$880 per wye.`);
  parts.push(`7. **Default slope is 1.1%** unless profile view shows otherwise. typeClass defaults to 2.35 for concrete storm sewers, 1.3 for PVC.`);
  parts.push(`8. **If NO watermain work exists**, return empty arrays — do NOT hallucinate watermain data.`);

  return parts.join('\n');
}
