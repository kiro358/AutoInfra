/**
 * Synthetic CAD Servicing Drawing Generator.
 *
 * Generates pure vector CAD servicing drawing PDFs using pdf-lib so the entire
 * vector geometry, symbol detection, network topology, annotation binding,
 * invariant validation, and convention pipeline (Phases 1-4) can be unit-tested
 * deterministically in CI from a clean clone without requiring the gitignored dataset.
 */
import {
  Color,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';

export interface SyntheticStructureDef {
  id: string; // e.g. "STMH 1", "CB 1", "SAN MH 1", "DCBMH 1", "HYD 1", "VLV 1"
  type: 'MH' | 'CB' | 'CBMH' | 'DCBMH' | 'HYDRANT' | 'VALVE';
  x: number; // centroid x (PDF user space pt)
  y: number; // centroid y (PDF user space pt)
  size?: number; // outer diameter / width in pt (default 12pt)
  rimElevation?: number; // e.g. 100.50
  invertElevation?: number; // e.g. 97.50
  station?: string; // e.g. "0+000.00"
  drawLabel?: boolean; // whether to draw text label near structure (default true)
  labelOffset?: { x: number; y: number };
}

export interface SyntheticPipeDef {
  id: string; // e.g. "STM-RUN-1", "SAN-RUN-1", "WM-RUN-1"
  fromStructureId: string;
  toStructureId: string;
  system: 'STORM' | 'SAN' | 'WATERMAIN';
  diameterMm: number; // e.g. 300, 200, 150
  material?: string; // e.g. "PVC", "PVC DR35", "HDPE"
  slopePercent?: number; // e.g. 0.50
  lengthMeters?: number; // e.g. 40.0
  calloutText?: string; // e.g. "40.0m - 300mmØ PVC STORM @ 0.50%"
  calloutPosition?: { x: number; y: number; rotationDeg?: number };
  leaderLine?: boolean; // whether to draw leader line to pipe midpoint
  vertices?: { x: number; y: number }[]; // intermediate vertices if multi-segment
  strokeColor?: Color | { r: number; g: number; b: number };
  lineWidth?: number;
  dashArray?: number[];
}

export interface SyntheticLegendDef {
  x: number;
  y: number;
  width?: number;
  height?: number;
  title?: string;
  entries: {
    symbolType: 'MH' | 'CB' | 'CBMH' | 'DCBMH' | 'HYDRANT' | 'VALVE' | 'STORM_PIPE' | 'SAN_PIPE' | 'WM_PIPE';
    description: string; // e.g. "PROPOSED STORM MANHOLE", "PROPOSED CATCHBASIN"
  }[];
}

export interface SyntheticScheduleRow {
  structure: string;
  station?: string;
  rim?: string | number;
  invert?: string | number;
  pipeIn?: string;
  pipeOut?: string;
}

export interface SyntheticScheduleTableDef {
  x: number;
  y: number;
  width?: number;
  rowHeight?: number;
  title?: string;
  headers?: string[];
  rows: SyntheticScheduleRow[];
}

export interface SyntheticCadPdfOptions {
  width?: number; // default 842 (A1 landscape or custom)
  height?: number; // default 595
  title?: string;
  structures?: SyntheticStructureDef[];
  pipes?: SyntheticPipeDef[];
  legend?: SyntheticLegendDef | boolean;
  schedule?: SyntheticScheduleTableDef | boolean;
  layers?: string[]; // AutoCAD OCG layer names
  scaleRatio?: number; // e.g. 1m = 5pt (default 5.0)
}

// Canonical default civil colors matching CAD drafting standards
export const CAD_COLORS = {
  storm: rgb(0, 0.55, 0.85), // Cyan/Blue for Storm
  sanitary: rgb(0, 0.65, 0.15), // Green for Sanitary
  watermain: rgb(0, 0.2, 0.9), // Deep Blue for Watermain
  structure: rgb(0.1, 0.1, 0.1), // Dark Gray/Black outline
  annotation: rgb(0.15, 0.15, 0.15),
  grid: rgb(0.7, 0.7, 0.7),
  cb: rgb(0.85, 0.45, 0), // Orange/Brown for Catchbasin
};

export const DEFAULT_SYNTHETIC_STRUCTURES: SyntheticStructureDef[] = [
  {
    id: 'STMH 1',
    type: 'MH',
    x: 150,
    y: 400,
    size: 14,
    rimElevation: 100.5,
    invertElevation: 97.5,
    station: '0+000.00',
    labelOffset: { x: -10, y: 15 },
  },
  {
    id: 'STMH 2',
    type: 'MH',
    x: 350,
    y: 400,
    size: 14,
    rimElevation: 100.3,
    invertElevation: 97.3,
    station: '0+040.00',
    labelOffset: { x: 10, y: 15 },
  },
  {
    id: 'CB 1',
    type: 'CB',
    x: 350,
    y: 480,
    size: 12,
    rimElevation: 100.1,
    invertElevation: 98.5,
    station: '0+040.00',
    labelOffset: { x: 15, y: 0 },
  },
  {
    id: 'SAN MH 1',
    type: 'MH',
    x: 150,
    y: 260,
    size: 14,
    rimElevation: 100.5,
    invertElevation: 96.8,
    station: '0+000.00',
    labelOffset: { x: -10, y: 15 },
  },
  {
    id: 'SAN MH 2',
    type: 'MH',
    x: 350,
    y: 260,
    size: 14,
    rimElevation: 100.3,
    invertElevation: 96.64,
    station: '0+040.00',
    labelOffset: { x: 10, y: 15 },
  },
  {
    id: 'HYD 1',
    type: 'HYDRANT',
    x: 420,
    y: 330,
    size: 12,
    labelOffset: { x: 12, y: 0 },
  },
  {
    id: 'VLV 1',
    type: 'VALVE',
    x: 250,
    y: 330,
    size: 12,
    labelOffset: { x: 0, y: 10 },
  },
];

export const DEFAULT_SYNTHETIC_PIPES: SyntheticPipeDef[] = [
  {
    id: 'STM-1',
    fromStructureId: 'STMH 1',
    toStructureId: 'STMH 2',
    system: 'STORM',
    diameterMm: 300,
    material: 'PVC',
    slopePercent: 0.5,
    lengthMeters: 40.0,
    calloutText: '40.0m - 300mmØ PVC STORM @ 0.50%',
    calloutPosition: { x: 200, y: 415 },
    leaderLine: true,
  },
  {
    id: 'CB-LEAD-1',
    fromStructureId: 'CB 1',
    toStructureId: 'STMH 2',
    system: 'STORM',
    diameterMm: 200,
    material: 'PVC',
    slopePercent: 1.0,
    lengthMeters: 16.0,
    calloutText: '16.0m - 200mmØ PVC CB LEAD @ 1.00%',
    calloutPosition: { x: 360, y: 440 },
    leaderLine: true,
  },
  {
    id: 'SAN-1',
    fromStructureId: 'SAN MH 1',
    toStructureId: 'SAN MH 2',
    system: 'SAN',
    diameterMm: 200,
    material: 'PVC',
    slopePercent: 0.4,
    lengthMeters: 40.0,
    calloutText: '40.0m - 200mmØ PVC SANITARY @ 0.40%',
    calloutPosition: { x: 200, y: 240 },
    leaderLine: true,
  },
  {
    id: 'WM-1',
    fromStructureId: 'VLV 1',
    toStructureId: 'HYD 1',
    system: 'WATERMAIN',
    diameterMm: 150,
    material: 'PVC',
    lengthMeters: 34.0,
    calloutText: '34.0m - 150mmØ PVC WATERMAIN',
    calloutPosition: { x: 300, y: 345 },
    leaderLine: true,
    vertices: [
      { x: 250, y: 330 },
      { x: 420, y: 330 },
    ],
  },
];

export const DEFAULT_SYNTHETIC_LEGEND: SyntheticLegendDef = {
  x: 520,
  y: 380,
  width: 280,
  height: 180,
  title: 'LEGEND',
  entries: [
    { symbolType: 'MH', description: 'PROPOSED STORM / SANITARY MANHOLE' },
    { symbolType: 'CB', description: 'PROPOSED CATCHBASIN' },
    { symbolType: 'CBMH', description: 'PROPOSED CATCHBASIN MANHOLE' },
    { symbolType: 'DCBMH', description: 'PROPOSED DOUBLE CBMH' },
    { symbolType: 'HYDRANT', description: 'PROPOSED FIRE HYDRANT' },
    { symbolType: 'VALVE', description: 'PROPOSED WATERMAIN GATE VALVE' },
    { symbolType: 'STORM_PIPE', description: 'PROPOSED STORM SEWER' },
    { symbolType: 'SAN_PIPE', description: 'PROPOSED SANITARY SEWER' },
    { symbolType: 'WM_PIPE', description: 'PROPOSED WATERMAIN' },
  ],
};

export const DEFAULT_SYNTHETIC_SCHEDULE: SyntheticScheduleTableDef = {
  x: 500,
  y: 60,
  width: 310,
  rowHeight: 18,
  title: 'STORM SEWER SCHEDULE',
  headers: ['STRUCTURE', 'STATION', 'RIM', 'INVERT', 'PIPE OUT'],
  rows: [
    {
      structure: 'STMH 1',
      station: '0+000.00',
      rim: '100.50',
      invert: '97.50',
      pipeOut: '300mm @ 0.50%',
    },
    {
      structure: 'STMH 2',
      station: '0+040.00',
      rim: '100.30',
      invert: '97.30',
      pipeOut: '300mm @ 0.50%',
    },
    {
      structure: 'CB 1',
      station: '0+040.00',
      rim: '100.10',
      invert: '98.50',
      pipeOut: '200mm @ 1.00%',
    },
  ],
};

export const DEFAULT_SYNTHETIC_LAYERS = [
  '3-STORM',
  '2-SANITARY',
  '1-WATERMAIN',
  '0-STRUCTURES',
  'G-ANNO-TEXT',
  'G-ANNO-LEGN',
  'G-ANNO-SCHD',
];

function resolveColor(c: Color | { r: number; g: number; b: number } | undefined, fallback: Color): Color {
  if (!c) return fallback;
  if ('r' in c && typeof c.r === 'number') {
    return rgb(c.r, c.g, c.b);
  }
  return c as Color;
}

/**
 * Draw a CAD structure symbol vectorially at centroid (x, y).
 */
export function drawStructureSymbol(
  page: any,
  type: SyntheticStructureDef['type'],
  x: number,
  y: number,
  size: number = 12
): void {
  const radius = size / 2;

  switch (type) {
    case 'MH': {
      // Single circle for standard manhole
      page.drawCircle({
        x,
        y,
        size: radius,
        borderColor: CAD_COLORS.structure,
        borderWidth: 1.5,
      });
      break;
    }
    case 'CB': {
      // Single square for catchbasin
      page.drawRectangle({
        x: x - radius,
        y: y - radius,
        width: size,
        height: size,
        borderColor: CAD_COLORS.cb,
        borderWidth: 1.5,
      });
      break;
    }
    case 'CBMH': {
      // Concentric circles: outer circle (radius) and inner circle (radius * 0.55)
      page.drawCircle({
        x,
        y,
        size: radius,
        borderColor: CAD_COLORS.structure,
        borderWidth: 1.5,
      });
      page.drawCircle({
        x,
        y,
        size: radius * 0.55,
        borderColor: CAD_COLORS.cb,
        borderWidth: 1.2,
      });
      break;
    }
    case 'DCBMH': {
      // Double concentric circles with center cross
      page.drawCircle({
        x,
        y,
        size: radius,
        borderColor: CAD_COLORS.structure,
        borderWidth: 1.5,
      });
      page.drawCircle({
        x,
        y,
        size: radius * 0.65,
        borderColor: CAD_COLORS.cb,
        borderWidth: 1.2,
      });
      page.drawCircle({
        x,
        y,
        size: radius * 0.35,
        borderColor: CAD_COLORS.cb,
        borderWidth: 1.0,
      });
      break;
    }
    case 'HYDRANT': {
      // Circle with cross ticks (standard civil hydrant symbol)
      page.drawCircle({
        x,
        y,
        size: radius * 0.6,
        borderColor: CAD_COLORS.watermain,
        borderWidth: 1.5,
      });
      const tick = radius * 0.9;
      // Horizontal tick
      page.drawLine({
        start: { x: x - tick, y },
        end: { x: x + tick, y },
        thickness: 1.5,
        color: CAD_COLORS.watermain,
      });
      // Vertical tick
      page.drawLine({
        start: { x, y: y - tick },
        end: { x, y: y + tick },
        thickness: 1.5,
        color: CAD_COLORS.watermain,
      });
      break;
    }
    case 'VALVE': {
      // Bow-tie gate valve symbol (two opposing triangles)
      const w = radius * 0.9;
      const h = radius * 0.7;
      // Left triangle
      page.drawLine({ start: { x: x - w, y: y - h }, end: { x: x - w, y: y + h }, thickness: 1.2, color: CAD_COLORS.watermain });
      page.drawLine({ start: { x: x - w, y: y + h }, end: { x, y }, thickness: 1.2, color: CAD_COLORS.watermain });
      page.drawLine({ start: { x, y }, end: { x: x - w, y: y - h }, thickness: 1.2, color: CAD_COLORS.watermain });
      // Right triangle
      page.drawLine({ start: { x: x + w, y: y - h }, end: { x: x + w, y: y + h }, thickness: 1.2, color: CAD_COLORS.watermain });
      page.drawLine({ start: { x: x + w, y: y + h }, end: { x, y }, thickness: 1.2, color: CAD_COLORS.watermain });
      page.drawLine({ start: { x, y }, end: { x: x + w, y: y - h }, thickness: 1.2, color: CAD_COLORS.watermain });
      break;
    }
  }
}

/**
 * Creates a synthetic CAD servicing drawing PDF buffer.
 */
export async function createSyntheticCadPdf(
  options: SyntheticCadPdfOptions = {}
): Promise<Uint8Array> {
  const width = options.width ?? 842;
  const height = options.height ?? 595;
  const structures = options.structures ?? DEFAULT_SYNTHETIC_STRUCTURES;
  const pipes = options.pipes ?? DEFAULT_SYNTHETIC_PIPES;
  const legendDef =
    options.legend === false
      ? null
      : options.legend === true || options.legend === undefined
      ? DEFAULT_SYNTHETIC_LEGEND
      : options.legend;
  const scheduleDef =
    options.schedule === false
      ? null
      : options.schedule === true || options.schedule === undefined
      ? DEFAULT_SYNTHETIC_SCHEDULE
      : options.schedule;
  const layers = options.layers ?? DEFAULT_SYNTHETIC_LAYERS;

  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // Setup AutoCAD OCG layers in document catalog
  if (layers.length > 0) {
    const ocgRefs = layers.map((name) => {
      const ocg = doc.context.obj({
        Type: 'OCG',
        Name: PDFString.of(name),
      });
      return doc.context.register(ocg);
    });
    const ocgListRef = doc.context.register(doc.context.obj(ocgRefs));
    const defaultView = doc.context.obj({
      BaseState: 'ON',
      Order: ocgListRef,
    });
    const ocProperties = doc.context.obj({
      OCGs: ocgListRef,
      D: defaultView,
    });
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.register(ocProperties));
  }

  // Draw title block / border
  page.drawRectangle({
    x: 20,
    y: 20,
    width: width - 40,
    height: height - 40,
    borderColor: CAD_COLORS.grid,
    borderWidth: 1.0,
  });

  const sheetTitle = options.title ?? 'SITE SERVICING & UTILITIES PLAN';
  page.drawText(sheetTitle, {
    x: 40,
    y: height - 50,
    size: 14,
    font: boldFont,
    color: CAD_COLORS.structure,
  });
  page.drawText('SCALE 1:200  |  DRAWING NO. SS-101', {
    x: 40,
    y: height - 66,
    size: 8,
    font,
    color: CAD_COLORS.annotation,
  });

  // Map structures by ID for fast coordinate lookup
  const structureMap = new Map<string, SyntheticStructureDef>();
  for (const s of structures) {
    structureMap.set(s.id, s);
  }

  // Draw pipe runs (polylines + stroke styles)
  for (const pipe of pipes) {
    let vertices: { x: number; y: number }[] = [];
    if (pipe.vertices && pipe.vertices.length >= 2) {
      vertices = pipe.vertices;
    } else {
      const from = structureMap.get(pipe.fromStructureId);
      const to = structureMap.get(pipe.toStructureId);
      if (from && to) {
        vertices = [
          { x: from.x, y: from.y },
          { x: to.x, y: to.y },
        ];
      }
    }

    if (vertices.length < 2) continue;

    // Stroke style defaults by system
    let color: Color;
    let dashArray = pipe.dashArray;
    let lineWidth = pipe.lineWidth ?? 2.0;

    if (pipe.strokeColor) {
      color = resolveColor(pipe.strokeColor, CAD_COLORS.storm);
    } else {
      if (pipe.system === 'STORM') {
        color = CAD_COLORS.storm;
        dashArray = dashArray ?? [6, 3];
      } else if (pipe.system === 'SAN') {
        color = CAD_COLORS.sanitary;
        dashArray = dashArray ?? [];
      } else {
        color = CAD_COLORS.watermain;
        dashArray = dashArray ?? [];
        lineWidth = pipe.lineWidth ?? 2.5;
      }
    }

    // Draw polyline segments
    for (let i = 0; i < vertices.length - 1; i++) {
      const start = vertices[i];
      const end = vertices[i + 1];
      page.drawLine({
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        thickness: lineWidth,
        color,
        dashArray,
      });
    }

    // Draw pipe callout annotation if present
    if (pipe.calloutText) {
      const midIdx = Math.floor(vertices.length / 2);
      const segStart = vertices[Math.max(0, midIdx - 1)];
      const segEnd = vertices[midIdx];
      const midX = (segStart.x + segEnd.x) / 2;
      const midY = (segStart.y + segEnd.y) / 2;

      const calloutPos = pipe.calloutPosition ?? { x: midX - 40, y: midY + 12 };
      const rot = pipe.calloutPosition?.rotationDeg ?? 0;

      page.drawText(pipe.calloutText, {
        x: calloutPos.x,
        y: calloutPos.y,
        size: 8,
        font,
        color: CAD_COLORS.annotation,
        rotate: rot ? degrees(rot) : undefined,
      });

      // Draw leader line if requested
      if (pipe.leaderLine) {
        const textAnchorX = calloutPos.x + 20;
        const textAnchorY = calloutPos.y - 2;
        page.drawLine({
          start: { x: textAnchorX, y: textAnchorY },
          end: { x: midX, y: midY },
          thickness: 0.8,
          color: CAD_COLORS.annotation,
        });
      }
    }
  }

  // Draw structures and structure labels
  for (const s of structures) {
    drawStructureSymbol(page, s.type, s.x, s.y, s.size ?? 12);

    if (s.drawLabel !== false) {
      const offset = s.labelOffset ?? { x: 8, y: 8 };
      page.drawText(s.id, {
        x: s.x + offset.x,
        y: s.y + offset.y,
        size: 9,
        font: boldFont,
        color: CAD_COLORS.annotation,
      });

      if (s.rimElevation != null || s.invertElevation != null) {
        const elevLines: string[] = [];
        // Ontario servicing drawings write the rim as "T/G=" (top of grate) and the
        // invert as "INV=" — verified against the corpus text layers (158 T/G tokens,
        // zero "RIM"). Emitting "RIM" here would have tested a notation no real
        // drawing uses, and callout-parser's grammar rightly does not accept it.
        if (s.rimElevation != null) elevLines.push(`T/G=${s.rimElevation.toFixed(2)}`);
        if (s.invertElevation != null) elevLines.push(`INV=${s.invertElevation.toFixed(2)}`);
        let lineY = s.y + offset.y - 9;
        for (const el of elevLines) {
          page.drawText(el, {
            x: s.x + offset.x,
            y: lineY,
            size: 7,
            font,
            color: CAD_COLORS.annotation,
          });
          lineY -= 8;
        }
      }
    }
  }

  // Draw Legend box if configured
  if (legendDef) {
    const lx = legendDef.x;
    const ly = legendDef.y;
    const lw = legendDef.width ?? 280;
    const lh = legendDef.height ?? 180;

    // Outer frame
    page.drawRectangle({
      x: lx,
      y: ly,
      width: lw,
      height: lh,
      borderColor: CAD_COLORS.grid,
      borderWidth: 1.0,
    });

    // Title bar
    page.drawText(legendDef.title ?? 'LEGEND', {
      x: lx + 10,
      y: ly + lh - 16,
      size: 10,
      font: boldFont,
      color: CAD_COLORS.structure,
    });
    page.drawLine({
      start: { x: lx, y: ly + lh - 22 },
      end: { x: lx + lw, y: ly + lh - 22 },
      thickness: 1.0,
      color: CAD_COLORS.grid,
    });

    let entryY = ly + lh - 38;
    for (const entry of legendDef.entries) {
      const symX = lx + 20;
      const symY = entryY + 4;

      if (entry.symbolType === 'STORM_PIPE') {
        page.drawLine({
          start: { x: symX - 10, y: symY },
          end: { x: symX + 10, y: symY },
          thickness: 2.0,
          color: CAD_COLORS.storm,
          dashArray: [6, 3],
        });
      } else if (entry.symbolType === 'SAN_PIPE') {
        page.drawLine({
          start: { x: symX - 10, y: symY },
          end: { x: symX + 10, y: symY },
          thickness: 2.0,
          color: CAD_COLORS.sanitary,
        });
      } else if (entry.symbolType === 'WM_PIPE') {
        page.drawLine({
          start: { x: symX - 10, y: symY },
          end: { x: symX + 10, y: symY },
          thickness: 2.5,
          color: CAD_COLORS.watermain,
        });
      } else {
        drawStructureSymbol(page, entry.symbolType, symX, symY, 10);
      }

      page.drawText(entry.description, {
        x: lx + 42,
        y: entryY,
        size: 7.5,
        font,
        color: CAD_COLORS.annotation,
      });

      entryY -= 15;
    }
  }

  // Draw Schedule table if configured
  if (scheduleDef) {
    const sx = scheduleDef.x;
    const sy = scheduleDef.y;
    const sw = scheduleDef.width ?? 310;
    const rh = scheduleDef.rowHeight ?? 18;
    const headers = scheduleDef.headers ?? ['STRUCTURE', 'STATION', 'RIM', 'INVERT', 'PIPE OUT'];
    const totalRows = scheduleDef.rows.length + 1; // header + data
    const tableHeight = totalRows * rh + 20;

    // Table boundary
    page.drawRectangle({
      x: sx,
      y: sy,
      width: sw,
      height: tableHeight,
      borderColor: CAD_COLORS.grid,
      borderWidth: 1.0,
    });

    // Title
    const tblTitle = scheduleDef.title ?? 'STRUCTURE SCHEDULE';
    page.drawText(tblTitle, {
      x: sx + 8,
      y: sy + tableHeight - 14,
      size: 9,
      font: boldFont,
      color: CAD_COLORS.structure,
    });

    // Column widths
    const colWidth = sw / headers.length;

    // Header row
    const headerY = sy + tableHeight - 20 - rh;
    page.drawLine({
      start: { x: sx, y: headerY + rh },
      end: { x: sx + sw, y: headerY + rh },
      thickness: 1.0,
      color: CAD_COLORS.grid,
    });

    for (let c = 0; c < headers.length; c++) {
      page.drawText(headers[c], {
        x: sx + c * colWidth + 4,
        y: headerY + 5,
        size: 7,
        font: boldFont,
        color: CAD_COLORS.structure,
      });
    }

    page.drawLine({
      start: { x: sx, y: headerY },
      end: { x: sx + sw, y: headerY },
      thickness: 1.0,
      color: CAD_COLORS.grid,
    });

    // Data rows
    let currentY = headerY - rh;
    for (const row of scheduleDef.rows) {
      const vals = [
        row.structure,
        row.station ?? '-',
        row.rim != null ? String(row.rim) : '-',
        row.invert != null ? String(row.invert) : '-',
        row.pipeOut ?? '-',
      ];
      for (let c = 0; c < headers.length; c++) {
        page.drawText(vals[c] || '-', {
          x: sx + c * colWidth + 4,
          y: currentY + 5,
          size: 7,
          font,
          color: CAD_COLORS.annotation,
        });
      }
      page.drawLine({
        start: { x: sx, y: currentY },
        end: { x: sx + sw, y: currentY },
        thickness: 0.5,
        color: CAD_COLORS.grid,
      });
      currentY -= rh;
    }

    // Vertical column divider lines
    for (let c = 1; c < headers.length; c++) {
      page.drawLine({
        start: { x: sx + c * colWidth, y: sy },
        end: { x: sx + c * colWidth, y: sy + tableHeight - 20 },
        thickness: 0.5,
        color: CAD_COLORS.grid,
      });
    }
  }

  return await doc.save();
}
