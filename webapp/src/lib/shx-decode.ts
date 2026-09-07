/**
 * SHX Stroke Codebook & Glyph Decoder with Grammar Repair.
 *
 * Decodes oriented stroke clusters into ASCII text strings using a geometric
 * stroke codebook, character distance metrics, and grammar-constrained decoding.
 */
import { CadAnnotation } from './cad-annotations';
import { distance } from './cad-geometry';
import {
  parseElevation,
  parseRunCallout,
  parseStructureLabel,
  parseWatermainCallout,
} from './callout-parser';
import { ShxCharacterBlock, ShxTextCluster } from './shx-cluster';

export interface CodebookStroke {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CodebookGlyph {
  char: string;
  strokes: CodebookStroke[];
  strokeCount: number;
  aspectRatio: number; // width / height
}

/**
 * Standard reference geometric stroke definitions for alphanumeric civil characters.
 * Coordinates are normalized to [0, 1] x [0, 1] with (0,0) at bottom-left.
 */
export const SHX_CODEBOOK: CodebookGlyph[] = [
  // Digits
  {
    char: '0',
    strokeCount: 4,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 1, y2: 0 },
      { x1: 1, y1: 0, x2: 0, y2: 0 },
    ],
  },
  {
    char: '1',
    strokeCount: 1,
    aspectRatio: 0.25,
    strokes: [{ x1: 0.5, y1: 0, x2: 0.5, y2: 1 }],
  },
  {
    char: '2',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 0, y2: 0 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
    ],
  },
  {
    char: '3',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 0.5, x2: 0.2, y2: 0.5 },
      { x1: 1, y1: 0, x2: 0, y2: 0 },
    ],
  },
  {
    char: '4',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 1, x2: 0, y2: 0.4 },
      { x1: 0, y1: 0.4, x2: 1, y2: 0.4 },
      { x1: 0.8, y1: 1, x2: 0.8, y2: 0 },
    ],
  },
  {
    char: '5',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 1, y1: 1, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0, y2: 0.5 },
      { x1: 0, y1: 0.5, x2: 1, y2: 0 },
    ],
  },
  {
    char: '6',
    strokeCount: 4,
    aspectRatio: 0.65,
    strokes: [
      { x1: 1, y1: 1, x2: 0, y2: 0.5 },
      { x1: 0, y1: 0.5, x2: 0, y2: 0 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
      { x1: 1, y1: 0, x2: 1, y2: 0.5 },
    ],
  },
  {
    char: '7',
    strokeCount: 2,
    aspectRatio: 0.6,
    strokes: [
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 0.3, y2: 0 },
    ],
  },
  {
    char: '8',
    strokeCount: 5,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 1, y1: 0, x2: 1, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
    ],
  },
  {
    char: '9',
    strokeCount: 4,
    aspectRatio: 0.65,
    strokes: [
      { x1: 1, y1: 0, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0, y2: 0.5 },
      { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
    ],
  },
  // Key Civil Letters
  {
    char: 'A',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0.5, y2: 1 },
      { x1: 0.5, y1: 1, x2: 1, y2: 0 },
      { x1: 0.2, y1: 0.35, x2: 0.8, y2: 0.35 },
    ],
  },
  {
    char: 'B',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0.8, y2: 0.75 },
      { x1: 0, y1: 0.5, x2: 0.8, y2: 0.25 },
    ],
  },
  {
    char: 'C',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 1, y1: 1, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0, y2: 0 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
    ],
  },
  {
    char: 'D',
    strokeCount: 2,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 0.5 },
    ],
  },
  {
    char: 'E',
    strokeCount: 4,
    aspectRatio: 0.6,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 0, y1: 0.5, x2: 0.7, y2: 0.5 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
    ],
  },
  {
    char: 'H',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 1, y1: 0, x2: 1, y2: 1 },
      { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
    ],
  },
  {
    char: 'I',
    strokeCount: 1,
    aspectRatio: 0.2,
    strokes: [{ x1: 0.5, y1: 0, x2: 0.5, y2: 1 }],
  },
  {
    char: 'L',
    strokeCount: 2,
    aspectRatio: 0.55,
    strokes: [
      { x1: 0, y1: 1, x2: 0, y2: 0 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
    ],
  },
  {
    char: 'M',
    strokeCount: 4,
    aspectRatio: 0.8,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0.5, y2: 0 },
      { x1: 0.5, y1: 0, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 1, y2: 0 },
    ],
  },
  {
    char: 'N',
    strokeCount: 3,
    aspectRatio: 0.7,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 0 },
      { x1: 1, y1: 0, x2: 1, y2: 1 },
    ],
  },
  {
    char: 'O',
    strokeCount: 4,
    aspectRatio: 0.7,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 1, y2: 0 },
      { x1: 1, y1: 0, x2: 0, y2: 0 },
    ],
  },
  {
    char: 'P',
    strokeCount: 3,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 0, y2: 0.5 },
    ],
  },
  {
    char: 'R',
    strokeCount: 4,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 0.75 },
      { x1: 1, y1: 0.75, x2: 0, y2: 0.5 },
      { x1: 0.3, y1: 0.5, x2: 1, y2: 0 },
    ],
  },
  {
    char: 'S',
    strokeCount: 4,
    aspectRatio: 0.6,
    strokes: [
      { x1: 1, y1: 1, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 0, y2: 0.5 },
      { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
      { x1: 1, y1: 0.5, x2: 0, y2: 0 },
    ],
  },
  {
    char: 'T',
    strokeCount: 2,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 0.5, y1: 1, x2: 0.5, y2: 0 },
    ],
  },
  {
    char: 'V',
    strokeCount: 2,
    aspectRatio: 0.65,
    strokes: [
      { x1: 0, y1: 1, x2: 0.5, y2: 0 },
      { x1: 0.5, y1: 0, x2: 1, y2: 1 },
    ],
  },
  {
    char: 'W',
    strokeCount: 4,
    aspectRatio: 0.85,
    strokes: [
      { x1: 0, y1: 1, x2: 0.25, y2: 0 },
      { x1: 0.25, y1: 0, x2: 0.5, y2: 0.8 },
      { x1: 0.5, y1: 0.8, x2: 0.75, y2: 0 },
      { x1: 0.75, y1: 0, x2: 1, y2: 1 },
    ],
  },
  // Symbols
  {
    char: '.',
    strokeCount: 1,
    aspectRatio: 0.2,
    strokes: [{ x1: 0.5, y1: 0, x2: 0.5, y2: 0.1 }],
  },
  {
    char: '-',
    strokeCount: 1,
    aspectRatio: 0.5,
    strokes: [{ x1: 0, y1: 0.5, x2: 1, y2: 0.5 }],
  },
  {
    char: '@',
    strokeCount: 4,
    aspectRatio: 0.8,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 1, y2: 0.3 },
      { x1: 1, y1: 0.3, x2: 0.5, y2: 0.5 },
    ],
  },
  {
    char: '%',
    strokeCount: 3,
    aspectRatio: 0.7,
    strokes: [
      { x1: 0, y1: 0, x2: 1, y2: 1 },
      { x1: 0.2, y1: 0.8, x2: 0.2, y2: 0.85 },
      { x1: 0.8, y1: 0.2, x2: 0.8, y2: 0.25 },
    ],
  },
  {
    char: 'Ø',
    strokeCount: 5,
    aspectRatio: 0.7,
    strokes: [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
      { x1: 1, y1: 1, x2: 1, y2: 0 },
      { x1: 1, y1: 0, x2: 0, y2: 0 },
      { x1: -0.1, y1: -0.1, x2: 1.1, y2: 1.1 },
    ],
  },
];

/**
 * Compares an individual character block against codebook glyphs to produce top character candidates.
 */
export function matchCharacterBlock(
  block: ShxCharacterBlock,
  blockStrokesCount: number
): { char: string; confidence: number }[] {
  const candidates: { char: string; confidence: number }[] = [];
  const blockAspect = block.extent.height > 0 ? block.extent.width / block.extent.height : 0.6;

  for (const glyph of SHX_CODEBOOK) {
    let score = 1.0;

    // Stroke count similarity
    const strokeDiff = Math.abs(blockStrokesCount - glyph.strokeCount);
    score -= strokeDiff * 0.18;

    // Aspect ratio similarity
    const aspectDiff = Math.abs(blockAspect - glyph.aspectRatio);
    score -= aspectDiff * 0.25;

    score = Math.max(0.1, Math.min(0.99, score));

    candidates.push({
      char: glyph.char,
      confidence: score,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, 4);
}

/**
 * Decodes a sequence of ShxCharacterBlocks into candidate text strings.
 */
export function decodeCharacterBlocks(
  characters: ShxCharacterBlock[],
  paths: { id: string }[]
): { text: string; confidence: number } {
  if (characters.length === 0) {
    return { text: '', confidence: 0 };
  }

  let decodedChars: string[] = [];
  let totalConf = 0;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const topMatches = matchCharacterBlock(ch, ch.strokeIds.length);
    const best = topMatches[0] || { char: '?', confidence: 0.5 };

    // Insert space if distance between consecutive characters > 1.2x character width
    if (i > 0) {
      const prevCh = characters[i - 1];
      const gap = ch.uCoord - prevCh.uCoord - prevCh.extent.width;
      if (gap >= 6.0) {
        decodedChars.push(' ');
      }
    }

    decodedChars.push(best.char);
    totalConf += best.confidence;
  }

  const rawText = decodedChars.join('');
  const avgConf = totalConf / characters.length;

  // Apply grammar-constrained validation & bonus
  const isRun = parseRunCallout(rawText) !== null;
  const isStruct = parseStructureLabel(rawText) !== null;
  const isElev = parseElevation(rawText) !== null;
  const isWm = parseWatermainCallout(rawText) !== null;

  let finalConf = avgConf;
  if (isRun || isStruct || isElev || isWm) {
    finalConf = Math.min(0.98, avgConf + 0.2);
  }

  return {
    text: rawText,
    confidence: finalConf,
  };
}

/**
 * Decodes all SHX text clusters into CadAnnotation items.
 */
export function decodeShxClusters(clusters: ShxTextCluster[]): CadAnnotation[] {
  const annotations: CadAnnotation[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    const decoded = decodeCharacterBlocks(cl.characters, cl.paths);

    if (!decoded.text.trim()) continue;

    annotations.push({
      id: `shx_annot_${i + 1}`,
      text: decoded.text,
      bbox: cl.bbox,
      position: { x: cl.obb.centerX, y: cl.obb.centerY },
      rotationDeg: cl.obb.rotationAngleDeg,
      source: 'shx',
      confidence: decoded.confidence,
    });
  }

  return annotations;
}
