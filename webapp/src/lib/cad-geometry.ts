/**
 * CAD Vector Path & Operator Extraction.
 *
 * Extracts low-level vector drawing operations (paths, polylines, arcs, stroke colors,
 * line widths, dash arrays, bounding boxes, and OCG layer names) from PDF pages
 * via pdfjs-dist getOperatorList().
 *
 * Coordinates are PDF user space (pt units, origin BOTTOM-LEFT, y grows upward).
 */
import { getPdfjs } from './pdfjs-loader';

export type CadPathClassification =
  | 'glyphCandidate'
  | 'lineworkCandidate'
  | 'symbolCandidate'
  | 'other';

export interface CadPoint {
  x: number;
  y: number;
}

export interface CadSegment {
  type: 'line' | 'curve';
  start: CadPoint;
  end: CadPoint;
  control1?: CadPoint;
  control2?: CadPoint;
  length: number;
}

export interface CadSubpath {
  points: CadPoint[];
  segments: CadSegment[];
  isClosed: boolean;
  length: number;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY]
}

export interface CadColor {
  r: number;
  g: number;
  b: number;
  hex: string;
}

export interface CadPath {
  id: string;
  subpaths: CadSubpath[];
  points: CadPoint[];
  bbox: [number, number, number, number];
  extent: {
    width: number;
    height: number;
    maxDim: number;
    minDim: number;
    aspectRatio: number;
  };
  totalLength: number;
  isClosed: boolean;
  strokeColor?: CadColor;
  fillColor?: CadColor;
  lineWidth: number;
  dashArray: number[];
  layerName?: string;
  classification: CadPathClassification;
  opType: 'stroke' | 'fill' | 'fillStroke';
}

export interface CadPolyline {
  id: string;
  points: CadPoint[];
  length: number;
  bbox: [number, number, number, number];
  strokeColor?: CadColor;
  lineWidth: number;
  dashArray: number[];
  layerName?: string;
}

export interface CadGeometryPage {
  page: number;
  width: number;
  height: number;
  paths: CadPath[];
  polylines: CadPolyline[];
  layers: string[];
  stats: {
    totalPaths: number;
    glyphCandidates: number;
    lineworkCandidates: number;
    symbolCandidates: number;
    otherPaths: number;
  };
}

// 2D Affine Transform Matrix: [a, b, c, d, e, f]
export type Matrix2D = [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

export function multiplyMatrices(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function transformPoint(p: CadPoint, m: Matrix2D): CadPoint {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

export function distance(p1: CadPoint, p2: CadPoint): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function approxBezierLength(
  p0: CadPoint,
  p1: CadPoint,
  p2: CadPoint,
  p3: CadPoint
): number {
  const chord = distance(p0, p3);
  const poly = distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
  return (chord + poly) / 2;
}

export function parseColor(val: any): CadColor | undefined {
  if (!val) return undefined;
  if (Array.isArray(val) && val.length === 1) {
    val = val[0];
  }
  if (typeof val === 'string') {
    let s = val.trim();
    if (s.startsWith('#')) s = s.slice(1);
    if (s.length === 6) {
      const r = parseInt(s.slice(0, 2), 16);
      const g = parseInt(s.slice(2, 4), 16);
      const b = parseInt(s.slice(4, 6), 16);
      return { r, g, b, hex: `#${s.toLowerCase()}` };
    }
  } else if (Array.isArray(val) && val.length >= 3) {
    let [r, g, b] = val;
    if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
      r = Math.round(r * 255);
      g = Math.round(g * 255);
      b = Math.round(b * 255);
    } else {
      r = Math.round(r);
      g = Math.round(g);
      b = Math.round(b);
    }
    const hex = `#${r.toString(16).padStart(2, '0')}${g
      .toString(16)
      .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    return { r, g, b, hex };
  }
  return undefined;
}

interface GraphicsState {
  ctm: Matrix2D;
  strokeColor?: CadColor;
  fillColor?: CadColor;
  lineWidth: number;
  dashArray: number[];
  layerName?: string;
}

function cloneGState(s: GraphicsState): GraphicsState {
  return {
    ctm: [...s.ctm] as Matrix2D,
    strokeColor: s.strokeColor ? { ...s.strokeColor } : undefined,
    fillColor: s.fillColor ? { ...s.fillColor } : undefined,
    lineWidth: s.lineWidth,
    dashArray: [...s.dashArray],
    layerName: s.layerName,
  };
}

/**
 * Classify a vector path based on geometric characteristics.
 */
export function classifyPath(
  bbox: [number, number, number, number],
  totalLength: number,
  isClosed: boolean,
  subpathCount: number,
  curveCount: number
): CadPathClassification {
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);
  const aspectRatio = maxDim > 0 ? minDim / maxDim : 1;

  // 1. Symbol Candidates:
  // Structures (MH, CB, CBMH, Hydrant, Valve) typically have diameter/extent 5pt - 32pt,
  // roughly circular or square (aspectRatio >= 0.55), with closed paths or circular curves/ticks.
  if (maxDim >= 4 && maxDim <= 32 && minDim >= 4 && aspectRatio >= 0.55) {
    if (isClosed || curveCount > 0 || subpathCount > 1) {
      return 'symbolCandidate';
    }
  }

  // 2. Glyph Candidates:
  // SHX vector stroke fonts: small extent (< 25pt), open strokes, short stroke segments
  if (maxDim < 25 && totalLength < 80 && !isClosed && curveCount === 0) {
    return 'glyphCandidate';
  }

  // 3. Linework Candidates:
  // Extended pipe runs, property lines, leader lines, or civil linework: length > 18pt or extent > 20pt
  if (totalLength >= 18 || maxDim >= 22) {
    return 'lineworkCandidate';
  }

  // Small open strokes that don't fit above
  if (maxDim < 25) {
    return 'glyphCandidate';
  }

  return 'other';
}

/**
 * Extracts vector CAD geometry from a PDF buffer.
 */
export async function extractCadGeometry(
  pdfBuffer: Uint8Array | ArrayBuffer | Buffer,
  pageIndex: number = 1
): Promise<CadGeometryPage> {
  const lib = await getPdfjs();
  let data: Uint8Array;
  if (Buffer.isBuffer(pdfBuffer)) {
    data = new Uint8Array(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength));
  } else if (pdfBuffer instanceof Uint8Array) {
    data = new Uint8Array(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength));
  } else {
    data = new Uint8Array(pdfBuffer);
  }

  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  try {
    const pageNum = pageIndex;
    if (pageNum < 1 || pageNum > doc.numPages) {
      throw new Error(`Invalid pageIndex ${pageIndex}. Document has ${doc.numPages} pages.`);
    }

    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });

    // Extract AutoCAD OCG layer names
    const layers: string[] = [];
    try {
      const optConfig = await doc.getOptionalContentConfig();
      if (optConfig) {
        const order = optConfig.getOrder?.() || [];
        for (const id of order) {
          const group = optConfig.getGroup?.(id);
          if (group?.name) {
            layers.push(String(group.name));
          }
        }
      }
    } catch {
      // OCG not supported or not present
    }

    const opList = await page.getOperatorList();
    const paths: CadPath[] = [];
    const polylines: CadPolyline[] = [];

    // State stacks
    let gState: GraphicsState = {
      ctm: [...IDENTITY_MATRIX],
      lineWidth: 1.0,
      dashArray: [],
    };
    const stateStack: GraphicsState[] = [];
    const markedContentStack: string[] = [];

    // In-progress path buffer for direct path ops (moveTo, lineTo, etc.)
    let activeSubpaths: {
      points: CadPoint[];
      segments: CadSegment[];
      isClosed: boolean;
    }[] = [];
    let currentPoint: CadPoint | null = null;
    let subpathStartPoint: CadPoint | null = null;

    let pathSeq = 0;

    function finishPath(opType: 'stroke' | 'fill' | 'fillStroke'): void {
      if (activeSubpaths.length === 0) return;

      const builtSubpaths: CadSubpath[] = [];
      const allPoints: CadPoint[] = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let totalLength = 0;
      let isPathClosed = false;
      let curveCount = 0;

      for (const sp of activeSubpaths) {
        if (sp.points.length === 0) continue;
        let spMinX = Infinity;
        let spMinY = Infinity;
        let spMaxX = -Infinity;
        let spMaxY = -Infinity;
        let spLength = 0;

        for (const pt of sp.points) {
          allPoints.push(pt);
          if (pt.x < spMinX) spMinX = pt.x;
          if (pt.y < spMinY) spMinY = pt.y;
          if (pt.x > spMaxX) spMaxX = pt.x;
          if (pt.y > spMaxY) spMaxY = pt.y;

          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }

        for (const seg of sp.segments) {
          spLength += seg.length;
          if (seg.type === 'curve') curveCount++;
        }

        totalLength += spLength;
        if (sp.isClosed) isPathClosed = true;

        builtSubpaths.push({
          points: sp.points,
          segments: sp.segments,
          isClosed: sp.isClosed,
          length: spLength,
          bbox: [
            Number.isFinite(spMinX) ? spMinX : 0,
            Number.isFinite(spMinY) ? spMinY : 0,
            Number.isFinite(spMaxX) ? spMaxX : 0,
            Number.isFinite(spMaxY) ? spMaxY : 0,
          ],
        });
      }

      activeSubpaths = [];
      currentPoint = null;
      subpathStartPoint = null;

      if (allPoints.length === 0) return;

      const bbox: [number, number, number, number] = [
        Number.isFinite(minX) ? minX : 0,
        Number.isFinite(minY) ? minY : 0,
        Number.isFinite(maxX) ? maxX : 0,
        Number.isFinite(maxY) ? maxY : 0,
      ];

      const width = bbox[2] - bbox[0];
      const height = bbox[3] - bbox[1];
      const maxDim = Math.max(width, height);
      const minDim = Math.min(width, height);
      const aspectRatio = maxDim > 0 ? minDim / maxDim : 1;

      const classification = classifyPath(
        bbox,
        totalLength,
        isPathClosed,
        builtSubpaths.length,
        curveCount
      );

      const pathObj: CadPath = {
        id: `path_${++pathSeq}`,
        subpaths: builtSubpaths,
        points: allPoints,
        bbox,
        extent: { width, height, maxDim, minDim, aspectRatio },
        totalLength,
        isClosed: isPathClosed,
        strokeColor: gState.strokeColor,
        fillColor: gState.fillColor,
        lineWidth: gState.lineWidth,
        dashArray: gState.dashArray,
        layerName: gState.layerName,
        classification,
        opType,
      };

      paths.push(pathObj);

      if (classification === 'lineworkCandidate' && allPoints.length >= 2) {
        polylines.push({
          id: `poly_${pathSeq}`,
          points: allPoints,
          length: totalLength,
          bbox,
          strokeColor: gState.strokeColor,
          lineWidth: gState.lineWidth,
          dashArray: gState.dashArray,
          layerName: gState.layerName,
        });
      }
    }

    const { OPS } = lib;

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      switch (fn) {
        case OPS.save:
          stateStack.push(cloneGState(gState));
          break;

        case OPS.restore:
          if (stateStack.length > 0) {
            gState = stateStack.pop()!;
          }
          break;

        case OPS.transform:
          if (Array.isArray(args) && args.length >= 6) {
            const m = args as Matrix2D;
            gState.ctm = multiplyMatrices(gState.ctm, m);
          }
          break;

        case OPS.setLineWidth:
          if (Array.isArray(args) && typeof args[0] === 'number') {
            gState.lineWidth = args[0];
          }
          break;

        case OPS.setDash:
          if (Array.isArray(args) && Array.isArray(args[0])) {
            gState.dashArray = args[0];
          }
          break;

        case OPS.setStrokeRGBColor:
        case OPS.setStrokeColor:
        case OPS.setStrokeColorN:
          gState.strokeColor = parseColor(args);
          break;

        case OPS.setFillRGBColor:
        case OPS.setFillColor:
        case OPS.setFillColorN:
          gState.fillColor = parseColor(args);
          break;

        case OPS.beginMarkedContent:
        case OPS.beginMarkedContentProps: {
          let layerName: string | undefined;
          if (Array.isArray(args)) {
            const props = args[1];
            if (typeof props === 'string') layerName = props;
            else if (props?.name) layerName = String(props.name);
          }
          if (layerName) {
            markedContentStack.push(layerName);
            gState.layerName = layerName;
          }
          break;
        }

        case OPS.endMarkedContent:
          if (markedContentStack.length > 0) {
            markedContentStack.pop();
            gState.layerName =
              markedContentStack.length > 0
                ? markedContentStack[markedContentStack.length - 1]
                : undefined;
          }
          break;

        case OPS.constructPath: {
          // args: [pathOp, subpaths, bbox]
          if (!Array.isArray(args) || args.length < 2) break;
          const [pathOp, subpathList] = args;

          let opType: 'stroke' | 'fill' | 'fillStroke' = 'stroke';
          if (
            pathOp === OPS.fill ||
            pathOp === OPS.eoFill ||
            pathOp === 22 ||
            pathOp === 23
          ) {
            opType = 'fill';
          } else if (
            pathOp === OPS.fillStroke ||
            pathOp === OPS.eoFillStroke ||
            pathOp === OPS.closeFillStroke ||
            pathOp === OPS.closeEOFillStroke ||
            pathOp === 24 ||
            pathOp === 25 ||
            pathOp === 26 ||
            pathOp === 27
          ) {
            opType = 'fillStroke';
          }

          activeSubpaths = [];

          if (Array.isArray(subpathList)) {
            for (const spData of subpathList) {
              const spPoints: CadPoint[] = [];
              const spSegments: CadSegment[] = [];
              let spClosed = false;

              // spData is an array-like buffer of opcodes and coordinates
              // 0 = moveTo(x, y), 1 = lineTo(x, y), 2 = curveTo(x1, y1, x2, y2, x3, y3), 4 = closePath
              let cur: CadPoint | null = null;
              let spStart: CadPoint | null = null;

              let idx = 0;
              const len = spData.length || Object.keys(spData).length;

              while (idx < len) {
                const op = spData[idx++];
                if (op === 0) {
                  // moveTo(x, y)
                  const rawX = spData[idx++];
                  const rawY = spData[idx++];
                  const pt = transformPoint({ x: rawX, y: rawY }, gState.ctm);
                  spPoints.push(pt);
                  cur = pt;
                  spStart = pt;
                } else if (op === 1) {
                  // lineTo(x, y)
                  const rawX = spData[idx++];
                  const rawY = spData[idx++];
                  const pt = transformPoint({ x: rawX, y: rawY }, gState.ctm);
                  spPoints.push(pt);
                  if (cur) {
                    spSegments.push({
                      type: 'line',
                      start: cur,
                      end: pt,
                      length: distance(cur, pt),
                    });
                  }
                  cur = pt;
                } else if (op === 2) {
                  // curveTo(x1, y1, x2, y2, x3, y3)
                  const c1 = transformPoint({ x: spData[idx++], y: spData[idx++] }, gState.ctm);
                  const c2 = transformPoint({ x: spData[idx++], y: spData[idx++] }, gState.ctm);
                  const pt = transformPoint({ x: spData[idx++], y: spData[idx++] }, gState.ctm);
                  spPoints.push(pt);
                  if (cur) {
                    spSegments.push({
                      type: 'curve',
                      start: cur,
                      end: pt,
                      control1: c1,
                      control2: c2,
                      length: approxBezierLength(cur, c1, c2, pt),
                    });
                  }
                  cur = pt;
                } else if (op === 4 || op === 18) {
                  // closePath
                  spClosed = true;
                  if (cur && spStart && distance(cur, spStart) > 0.001) {
                    spSegments.push({
                      type: 'line',
                      start: cur,
                      end: spStart,
                      length: distance(cur, spStart),
                    });
                    cur = spStart;
                  }
                }
              }

              if (spPoints.length > 0) {
                activeSubpaths.push({
                  points: spPoints,
                  segments: spSegments,
                  isClosed: spClosed,
                });
              }
            }
          }

          finishPath(opType);
          break;
        }

        case OPS.moveTo: {
          const pt = transformPoint({ x: args[0], y: args[1] }, gState.ctm);
          currentPoint = pt;
          subpathStartPoint = pt;
          activeSubpaths.push({
            points: [pt],
            segments: [],
            isClosed: false,
          });
          break;
        }

        case OPS.lineTo: {
          const pt = transformPoint({ x: args[0], y: args[1] }, gState.ctm);
          if (activeSubpaths.length === 0) {
            activeSubpaths.push({ points: [], segments: [], isClosed: false });
          }
          const currentSp = activeSubpaths[activeSubpaths.length - 1];
          currentSp.points.push(pt);
          if (currentPoint) {
            currentSp.segments.push({
              type: 'line',
              start: currentPoint,
              end: pt,
              length: distance(currentPoint, pt),
            });
          }
          currentPoint = pt;
          break;
        }

        case OPS.curveTo: {
          const c1 = transformPoint({ x: args[0], y: args[1] }, gState.ctm);
          const c2 = transformPoint({ x: args[2], y: args[3] }, gState.ctm);
          const pt = transformPoint({ x: args[4], y: args[5] }, gState.ctm);
          if (activeSubpaths.length === 0) {
            activeSubpaths.push({ points: [], segments: [], isClosed: false });
          }
          const currentSp = activeSubpaths[activeSubpaths.length - 1];
          currentSp.points.push(pt);
          if (currentPoint) {
            currentSp.segments.push({
              type: 'curve',
              start: currentPoint,
              end: pt,
              control1: c1,
              control2: c2,
              length: approxBezierLength(currentPoint, c1, c2, pt),
            });
          }
          currentPoint = pt;
          break;
        }

        case OPS.closePath:
        case OPS.closeStroke:
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke: {
          if (activeSubpaths.length > 0) {
            const currentSp = activeSubpaths[activeSubpaths.length - 1];
            currentSp.isClosed = true;
            if (currentPoint && subpathStartPoint && distance(currentPoint, subpathStartPoint) > 0.001) {
              currentSp.segments.push({
                type: 'line',
                start: currentPoint,
                end: subpathStartPoint,
                length: distance(currentPoint, subpathStartPoint),
              });
              currentPoint = subpathStartPoint;
            }
          }
          if (fn === OPS.closeStroke) finishPath('stroke');
          else if (fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke)
            finishPath('fillStroke');
          break;
        }

        case OPS.stroke:
          finishPath('stroke');
          break;

        case OPS.fill:
        case OPS.eoFill:
          finishPath('fill');
          break;

        case OPS.fillStroke:
        case OPS.eoFillStroke:
          finishPath('fillStroke');
          break;
      }
    }

    // Flush any remaining active path
    finishPath('stroke');

    let glyphCandidates = 0;
    let lineworkCandidates = 0;
    let symbolCandidates = 0;
    let otherPaths = 0;

    for (const p of paths) {
      if (p.classification === 'glyphCandidate') glyphCandidates++;
      else if (p.classification === 'lineworkCandidate') lineworkCandidates++;
      else if (p.classification === 'symbolCandidate') symbolCandidates++;
      else otherPaths++;
    }

    return {
      page: pageNum,
      width: viewport.width,
      height: viewport.height,
      paths,
      polylines,
      layers,
      stats: {
        totalPaths: paths.length,
        glyphCandidates,
        lineworkCandidates,
        symbolCandidates,
        otherPaths,
      },
    };
  } finally {
    await doc.destroy?.();
  }
}
