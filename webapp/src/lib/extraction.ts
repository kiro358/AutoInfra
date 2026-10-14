import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { TakeoffFacts, CatchbasinGroupFact, TileTranscript, WatermainFact, WatermainSpecialFact, WatermainValveFact, EntityCounts, ExtractionDiagnostics, PageDiagnostics, TileDiagnostics } from './types';
import { buildExtractionDiagnostics, deriveRenderedPerPage, entityCountsByKind, tileDiagnosticsWarnings } from './diagnostics';
import type { ExtractionModeId } from './extraction-modes';
import { PIPE_DIAMETERS } from './constants';
import { snapToPipeDiameter, normalizeSlope } from './geometry';
import { buildFewShotPromptSection } from './few-shot-examples';
import { setGlobalDispatcher, Agent, ProxyAgent } from 'undici';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { getSinglePassPrompt, getPageLocatorPrompt, getTranscriptionPrompt, getWatermainExtractionPrompt } from './modular-prompts';
import { renderTilesFlat, renderPageThumbnails, IMAGE_MIME } from './rasterize';
import { normalizeLabel, runSignature } from './compare-facts';
import { assembleTranscriptTakeoff } from './transcript-takeoff';
import { mergeTakeoffs, dropSpecNoteStructures, dropImplausibleCatchbasinGroups, reconcileTakeoff } from './reconcile';
import { appendCoverageWarnings } from './coverage-checks';
import { appendPhysicsWarnings } from './physics-checks';
import { withConfidence } from './confidence';
import { extractPageText, isTextyPage, hasAnnotationForm, PageText } from './pdf-text';
import { verifyStructureProvenance } from './provenance';
import { assembleTextTakeoff } from './text-takeoff';
import { extractVectorTakeoff, type VectorVerifier } from './vector-takeoff';
import type { VerificationAnswer } from './vector-verifier';

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
      connectTimeout: 300000,
      // Larger tiled inference calls take many seconds server-side; without TCP
      // keepalive the idle socket gets closed on the path (UND_ERR_SOCKET) before
      // the response arrives. Enable SO_KEEPALIVE probes to hold it open, and don't
      // reuse potentially-dead keep-alive sockets.
      keepAliveTimeout: 2000,
      keepAliveMaxTimeout: 5000,
      pipelining: 0,
      connect: { timeout: 60000, keepAlive: true, keepAliveInitialDelay: 5000 },
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

// Extraction model (override for A/B, e.g. EXTRACTION_MODEL=gemini-2.5-pro).
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || 'gemini-2.5-flash';

// Per-PDF prep is deterministic (located pages + rendered/uploaded tiles), so memoize it by
// source hash. This makes GOLDEN_REPEATS (and any repeated extraction of the same PDF in one
// process) skip the locator call + re-render + re-upload — big time saving and it avoids
// re-sending the locator thumbnails on every repeat. Process-scoped, so production (one
// extraction per PDF) never hits it. Disable with REUSE_PREP=false.
const REUSE_PREP = process.env.REUSE_PREP !== 'false';

// Tiling knobs — the image-token cost of an extraction scales with rasterized
// pixel area (≈ DPI²), so these are the primary cost levers. Kept configurable so
// the eval can A/B cost vs accuracy on stable infra (see cost telemetry on facts.cost).
// For knobs where 0 is a real setting (no overlap, thinking off): `Number(x) || def` turns an
// explicit 0 back into the default, so THINKING_BUDGET=0 silently meant 8192.
export function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const TILE_DPI = Number(process.env.TILE_DPI) || 150;
const TILE_PX = Number(process.env.TILE_PX) || 1600;
const TILE_OVERLAP = envNumber(process.env.TILE_OVERLAP, 160);

// Tiles are emitted row-major and truncated, so a per-page cap below what the
// sheet actually needs silently discards its BOTTOM rows. A 36x48 sheet at
// 150 DPI needs 4x5 = 20 tiles; the old hardcoded 16 threw away 20% of every
// E-size drawing. Derive the cap from geometry instead of guessing it.
//
// This MIRRORS the real tiling geometry in rasterize.ts::renderPdfPagesToTiles
// (the Math.ceil on the rasterized viewport and the Math.max(1, ...) floor on
// step are deliberate — keep them identical or the two can silently disagree by
// a tile). Exported so extraction.test.ts can pin the arithmetic.
export function tilesNeededPerPage(widthPt: number, heightPt: number): number {
  const step = Math.max(1, TILE_PX - TILE_OVERLAP);
  const W = Math.ceil(widthPt * (TILE_DPI / 72));
  const H = Math.ceil(heightPt * (TILE_DPI / 72));
  const cols = Math.max(1, Math.ceil((W - TILE_OVERLAP) / step));
  const rows = Math.max(1, Math.ceil((H - TILE_OVERLAP) / step));
  return cols * rows;
}
const MAX_TILES_PER_PAGE = Number(process.env.PER_PAGE) || 24;

// Explicit output ceiling: thinking tokens + JSON response share this budget.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 32768;
// CAP THINKING. gemini-2.5-flash uses "dynamic" thinking by default, and on VERTEX the
// pipe-scan-first prompt drove it to ~31k tokens/call — which (a) devoured the output
// budget so the JSON response truncated (structures, emitted last, collapsed to 0 on
// dense projects) and (b) was the dominant token COST. AI Studio's smaller default
// thinking masked this locally. Capping thinking fixes the truncation AND cuts cost.
const THINKING_BUDGET = envNumber(process.env.THINKING_BUDGET, 8192);

// Sum a streamed/one-shot response's usageMetadata into a per-extraction cost accumulator.
export type CostAcc = { promptTokens: number; outputTokens: number; totalTokens: number; llmCalls: number; tiles: number; dpi: number };
function addUsage(cost: CostAcc, usage: any) {
  if (!usage) return;
  cost.llmCalls++;
  cost.promptTokens += usage.promptTokenCount || 0;
  cost.outputTokens += usage.candidatesTokenCount || 0;
  cost.totalTokens += usage.totalTokenCount || 0;
}
const locatorMemo = new Map<string, number[]>();
const tilePartsMemo = new Map<string, any[]>();


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

import fs from 'fs';

/**
 * RETIRED (PR 2, 2026-10): no longer injected into any prompt. dynamic-rules.json
 * is frozen at the June baseline (34.67%, every accuracyDelta null) and its one
 * heuristic references fields (invertOut/invertIn) that do not exist in the
 * facts schema — injecting it taught the model a stale, wrong vocabulary.
 * Kept only until the file is regenerated from current eval data; do not
 * re-wire without that regeneration.
 */
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

const EVAL_CACHE_DIR = path.resolve(__dirname, '../../../.eval-cache');

async function getCachedOrCallLLM(
  pdfIdentifier: string,
  prompt: string,
  agentType: string,
  callLLM: () => Promise<string>,
  projectName?: string
): Promise<string> {
  // The eval cache is a dev/eval tool: off in production unless explicitly enabled
  // (in the container its directory resolves to an unwritable path anyway).
  const isCacheEnabled =
    process.env.ENABLE_EVAL_CACHE === 'true' ||
    (process.env.ENABLE_EVAL_CACHE !== 'false' && process.env.NODE_ENV !== 'production');
  if (!isCacheEnabled) {
    return await callLLM();
  }

  // Cache I/O failures must never cause a second model call: the previous version
  // re-ran callLLM() from its catch, so a failed call ran its whole retry loop
  // twice and a failed cache WRITE after a successful call paid for it twice.
  let cachePath: string | null = null;
  try {
    if (!fs.existsSync(EVAL_CACHE_DIR)) {
      fs.mkdirSync(EVAL_CACHE_DIR, { recursive: true });
    }
    const pdfHash = crypto.createHash('sha256').update(pdfIdentifier).digest('hex');
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    cachePath = path.join(EVAL_CACHE_DIR, `${agentType}_${pdfHash}_${promptHash}.json`);
    if (fs.existsSync(cachePath)) {
      console.log(`      [extraction.ts] ⚡ Local Cache Hit for ${agentType}!`);
      return fs.readFileSync(cachePath, 'utf8');
    }
  } catch (err) {
    console.warn(`      [extraction.ts] Eval cache unavailable (${(err as Error).message}); calling the model directly.`);
    cachePath = null;
  }

  const resultText = await callLLM();
  if (cachePath && resultText && resultText !== '{}') {
    try {
      fs.writeFileSync(cachePath, resultText, 'utf8');
    } catch (err) {
      console.warn(`      [extraction.ts] Could not write eval cache: ${(err as Error).message}`);
    }
  }
  return resultText;
}

// A predicted "structure" is really a non-structure plan callout if it names one of
// these features and carries no structure code (MH/CB/CBMH/chamber/…). Used to drop the
// bike-racks / transformers / crossings / valves the model over-lists as structures.
// The third alternation is DEMOLITION and sitework: on a removals sheet the model lists
// "TREE REMOVAL (TYP.)", "MONUMENT RELOCATION", "WATER SERVICE ABANDONMENT" and friends as
// structures. They are scope, but they are not structures and the estimator's takeoff never
// carries them as one. (Measured over the golden set: drops 10 predictions, 0 of them real.)
const STRUCT_JUNK = /\b(crossing|bike|transformer|water meter|backflow|retaining|snow|mud mat|railing|duct bank|bollard|landscape|powerdrain|depressed|sign|infiltration|gallery|wye|inspection\s*port)\b|\b(meter|valve|wall|fence|curb|entrance|rack|pole)\b|\b(removals?|removed?|relocat(?:e|ed|ion)|abandon(?:ment|ed)?|coordination|topsoil|sod|asphalt|interlocking|gravel\s*path|monument|cistern|tree)\b|^\s*(sanitary|storm)\s*$/i;
const STRUCT_CODE = /\b(D?CBMH|DI?CB|MH|CB|HS|OS|OGS|CHAMBER|TANK|STMH|SANMH)\b/i;
export function isNonStructure(desc: string): boolean {
  return STRUCT_JUNK.test(desc) && !STRUCT_CODE.test(desc);
}

// Plain catchbasins (CB/DCB/DICB/DDICB + number — NOT CBMH/DCBMH, which ARE structures) belong
// in the CB count block by type, not the manhole/structure list. The model routinely lists them
// as individual structures and leaves catchbasins empty; return the CB type so we can reclassify.
function plainCatchbasinType(desc: string): CatchbasinGroupFact['type'] | null {
  const n = String(desc).replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (/^DDICB\d/.test(n)) return 'DOUBLE_DITCH_INLET_CB';
  if (/^DICB\d/.test(n)) return 'DITCH_INLET_CB';
  if (/^DCB\d/.test(n)) return 'DOUBLE_CB';
  if (/^CB\d/.test(n)) return 'SINGLE_CB';
  return null;
}

// Detail / sub-drainage pipe callouts the pipe-scan picks up but the estimator's sewer
// takeoff never lists as mainline runs — they're sub-drainage or detail sheets, not storm/
// sanitary mains. Dropping them removes a chunk of the sewer over-extraction (precision) with
// low risk: scoped to unambiguous sub-drainage/detail terms. NOTE: keeps runs TO a tank
// ("INF.TANK"/"DET.TANK"), which ARE mainline runs the estimator lists — only GALLERY/BED match.
const NON_MAINLINE_SEWER = /INFILTRATION\s*(?:GALLERY|BED)|\bINF\.?\s*(?:GALLERY|BED)|\bPICP\b|SUB-?DRAIN|PERFORATED|\bDETAIL\b/i;
export function isNonMainlineSewer(label: string): boolean {
  return NON_MAINLINE_SEWER.test(String(label || ''));
}

/** A finite number, or null — never NaN/Infinity (LLM fields are untrusted). */
export function num(x: unknown): number | null {
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/** The value if it is an array, else []. */
function arr(x: unknown): any[] {
  return Array.isArray(x) ? x : [];
}

export function parseFacts(raw: any, projectName: string): TakeoffFacts {
  // LLM output is untrusted JSON: a non-array where an array belongs, or a value
  // like "n/a" that Number() turns into NaN, must not reach costing. NaN used to
  // pass the old `!= null` check and flow into every downstream dollar figure.
  raw = raw && typeof raw === 'object' ? raw : {};
  // Drop non-structure callouts, then split real structures from plain catchbasins the model
  // mis-listed as structures (reclassified into the CB block below).
  const candidateStructs = arr(raw.manholes).filter((m: any) => !isNonStructure(String(m.description || '')));
  const realStructs = candidateStructs.filter((m: any) => !plainCatchbasinType(String(m.description || '')));

  // Merge the model's explicit CB groups with CBs reclassified from the structure list. Prefer
  // an explicit group quantity per type when present; else use the reclassified individual count
  // (max, so a project that populated both isn't double-counted).
  const cbFromStructs: Record<string, number> = {};
  for (const m of candidateStructs) {
    const t = plainCatchbasinType(String(m.description || ''));
    if (t) cbFromStructs[t] = (cbFromStructs[t] || 0) + 1;
  }
  const groupByType: Record<string, CatchbasinGroupFact> = {};
  for (const g of arr(raw.catchbasins?.groups)) {
    const t = String(g.type || 'SINGLE_CB') as CatchbasinGroupFact['type'];
    groupByType[t] = { type: t, quantity: Number(g.quantity) || 0, wallThickness: num(g.wallThickness), depth: num(g.depth) };
  }
  for (const [t, cnt] of Object.entries(cbFromStructs)) {
    if (!groupByType[t]) groupByType[t] = { type: t as CatchbasinGroupFact['type'], quantity: cnt, wallThickness: null, depth: null };
    else groupByType[t].quantity = Math.max(groupByType[t].quantity, cnt);
  }

  const parsed: TakeoffFacts = {
    projectName: raw.projectName || projectName,
    jobNumber: raw.jobNumber || '',
    date: raw.date || new Date().toISOString().split('T')[0],
    structures: realStructs.map((m: any) => ({
      description: String(m.description || ''),
      topElevation: num(m.topElevation),
      lowInvert: num(m.lowInvert),
      highInvert: num(m.highInvert),
      pipeOutDiameter: num(m.pipeOutDiameter),
      structureType: m.structureType ? String(m.structureType) : null,
      depth: num(m.depth),
    })),
    catchbasins: Object.values(groupByType),
    sewers: arr(raw.sewers).filter((s: any) => !isNonMainlineSewer(String(s.runLabel || ''))).map((s: Record<string, unknown>) => ({
      runLabel: String(s.runLabel || ''),
      isLineItem: Boolean(s.isLineItem),
      lineItemType: s.lineItemType ? String(s.lineItemType) : undefined,
      length: num(s.length),
      pipeDiameter: num(s.pipeDiameter) != null ? snapToPipeDiameter(num(s.pipeDiameter) as number) : null,
      typeClass: num(s.typeClass),
      slope: num(s.slope) != null ? normalizeSlope(num(s.slope) as number) : null,
      depth: num(s.depth),
    })),
    watermain: arr(raw.watermain).map((w: Record<string, unknown>) => ({
      sizeAndType: String(w.sizeAndType || ''),
      length: Number(w.length) || 0,
      pipeDiameter: snapToPipeDiameter(Number(w.pipeDiameter) || 0),
      ocSc: Number(w.ocSc) || 1.1,
      avgCover: Number(w.avgCover) || 1.8,
    })),
    watermainSpecials: arr(raw.watermainSpecials).map((sp: Record<string, unknown>) => ({
      specialName: String(sp.specialName || ''),
      quantity: Number(sp.quantity) || 0,
    })),
    watermainValves: arr(raw.watermainValves).map((v: Record<string, unknown>) => ({
      valveSize: String(v.valveSize || ''),
      quantity: Number(v.quantity) || 0,
    })),
    confidence: 0, // placeholder — assessed from signals below, never the model's self-report
    warnings: arr(raw.warnings).filter((w: unknown): w is string => typeof w === 'string'),
  };

  // Provenance: every fact here came from the model's single-pass read —
  // stamp it so method slicing and the confidence assessment can see the
  // origin instead of treating these facts as origin-less.
  for (const fact of [...parsed.structures, ...parsed.catchbasins, ...parsed.sewers, ...parsed.watermain]) {
    if (!fact.source) fact.source = { method: 'single-pass' };
  }
  // The model's self-reported confidence (and the 0.9 the caller used to
  // seed it) is NOT carried forward: the score is derived from signals —
  // see confidence.ts. Single-pass facts are uncorroborated by construction,
  // so the unverifiable-method deduction applies in full; that is the honest
  // successor to the old `Number(raw.confidence) || 0.5`.
  return withConfidence(parsed);
}

/** Run fn over items with at most `limit` in flight; preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 7, initialDelay = 6000): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const msg = (err.message || '').toLowerCase();
      const isRateLimit = err.status === 429 || msg.includes('429') || msg.includes('resource exhausted');
      const isAbort = err.name === 'AbortError' || err.message === 'This operation was aborted' || msg.includes('abort');
      const isServerError = err.status >= 500 && err.status <= 599;
      const isCancelled = err.status === 499 || msg.includes('499') || msg.includes('cancel');
      // Transient transport failures (undici): these previously fell through and
      // zeroed a whole project. They're almost always retryable.
      const isNetwork =
        err.name === 'TypeError' && msg.includes('fetch failed') ||
        msg.includes('fetch failed') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('socket hang up') ||
        msg.includes('network') ||
        msg.includes('terminated') ||
        (err.cause && String(err.cause.code || err.cause).toLowerCase().match(/econn|etimedout|und_err|enotfound|socket/) != null);

      if (attempt >= maxRetries || (!isRateLimit && !isAbort && !isServerError && !isCancelled && !isNetwork)) {
        throw err;
      }

      let errType = 'Timeout/Abort';
      if (isRateLimit) errType = '429 Rate Limit';
      else if (isCancelled) errType = '499 Cancelled';
      else if (isServerError) errType = `${err.status || '5xx'} Server Error`;
      else if (isNetwork) errType = 'Network/Transport';

      // Cap the backoff so a failing call doesn't burn minutes of dead sleep.
      const delay = Math.min(30000, initialDelay * Math.pow(2, attempt - 1)) + Math.random() * 2000;
      const causeStr = err.cause ? ` cause=${String(err.cause.code || err.cause.message || err.cause)}` : '';
      console.warn(`      [extraction.ts] Attempt ${attempt} failed with ${errType} (${err.message}${causeStr}). Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

import { PDFDocument } from 'pdf-lib';

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

/**
 * Page locator: render each page to a cheap thumbnail and ask the model which
 * pages carry servicing takeoff data (plans / profiles / schedules), so we tile
 * only those at high DPI. Returns 1-indexed page numbers (empty => caller tiles all).
 */
async function locateRelevantPages(
  ai: GoogleGenAI,
  pdfBuffer: Buffer,
  sourceHash: string,
  projectName: string,
  cost?: CostAcc
): Promise<number[]> {
  const thumbs = await renderPageThumbnails(pdfBuffer, { maxPx: 1500 });
  if (thumbs.length === 0) return [];

  const prompt = getPageLocatorPrompt(thumbs.length);
  const parts: any[] = [{ text: prompt }];
  for (const t of thumbs) {
    parts.push({ text: `Page ${t.page}:` });
    parts.push({ inlineData: { mimeType: IMAGE_MIME, data: t.img.toString('base64') } });
  }

  const text = await getCachedOrCallLLM(`${sourceHash}_pagelocator`, prompt, 'locator', async () => {
    const response = await callWithRetry(async () => ai.models.generateContent({
      model: EXTRACTION_MODEL,
      contents: [{ role: 'user', parts }],
      config: { temperature: 0, responseMimeType: 'application/json' },
    }));
    if (cost) addUsage(cost, (response as any).usageMetadata);
    return response.text || '{}';
  }, projectName);

  try {
    const parsed = JSON.parse(text);
    const pages: unknown = parsed.relevantPages;
    if (!Array.isArray(pages)) return [];
    return Array.from(new Set(
      pages.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= thumbs.length)
    )).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export { EXTRACTION_MODES, type ExtractionModeId } from './extraction-modes';

export interface ExtractOptions {
  /**
   * Per-call mode. Wins over the EXTRACTION_MODE env var, so a web request can
   * choose a path without mutating process.env (which concurrent requests share).
   */
  mode?: ExtractionModeId;
}

/**
 * Model calls that failed during the current extraction (after retries). Scoped
 * per extractFromPDF call via AsyncLocalStorage so concurrent jobs never mix.
 * Individual batch failures are tolerated (partial takeoff + warning), but a
 * run where calls failed and NOTHING came back is an error, not an empty
 * "successful" takeoff — previously quota/IAM outages returned HTTP 200 with
 * a blank spreadsheet.
 */
const extractionFailures = new AsyncLocalStorage<string[]>();

function recordCallFailure(what: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  extractionFailures.getStore()?.push(`${what}: ${msg}`);
}

export function countEntities(facts: TakeoffFacts): number {
  return (
    (facts.structures?.length ?? 0) +
    (facts.sewers?.length ?? 0) +
    (facts.watermain?.length ?? 0) +
    (facts.catchbasins?.length ?? 0) +
    (facts.watermainValves?.length ?? 0) +
    (facts.watermainSpecials?.length ?? 0)
  );
}

export interface HybridAssembly {
  facts: TakeoffFacts;
  transcript: TileTranscript[];
  /** Located pages routed to the text layer. */
  textyPageNums: number[];
  /** Pages actually vision-transcribed (non-texty + zero-yield fallbacks). */
  rasterPageNums: number[];
  /** Texty pages re-routed to vision because their text layer yielded zero entities. */
  fallbackPageNums: number[];
  /** Entity counts of the text-path assembly, before the merge (diagnostics). */
  textCounts: EntityCounts;
  /** Entity counts of the transcript-path assembly, before the merge;
   *  null when no page was transcribed. */
  transcriptCounts: EntityCounts | null;
  /** Per-page text yield for texty pages — the counts the zero-yield
   *  fallback check itself computed (diagnostics; not recomputed). */
  textyPageYields: Record<number, number>;
}

/**
 * EXTRACTION_MODE=hybrid core: text-layer pages are assembled exactly ($0);
 * non-texty pages are vision-transcribed and merged (text wins conflicts).
 * `transcribe` is injected so the routing is testable without the LLM.
 *
 * Zero-yield fallback: a page can pass isTextyPage while its drawing
 * annotations are absent from the text layer (annotation-bearing prose whose
 * callouts the grammar cannot assemble — spec/schedule sheets — or residual
 * SHX prose the classifier still admits). Its text assembly then contributes
 * ZERO entities and, pre-fix, the sheet was silently lost: no vision tiles
 * were ever rendered for it. Such a page is re-routed to vision transcription.
 * Attribution is per page — assembleTextTakeoff's spatial logic is per-page,
 * so a page that yields nothing alone contributes nothing to the joint
 * assembly. The guard is the cost control: the fallback fires ONLY on zero
 * yield, and when no page falls back the routing (and therefore the facts)
 * is byte-identical to the pre-fix behaviour.
 */
export async function assembleHybridTakeoff(
  pageTexts: PageText[],
  locatedPages: number[],
  projectName: string,
  transcribe: (pages: number[]) => Promise<TileTranscript[]>,
): Promise<HybridAssembly> {
  const textyPages = pageTexts.filter(isTextyPage);
  const textyPageNums = textyPages.map((p) => p.page);
  const textySet = new Set(textyPageNums);
  const rasterSet = new Set(locatedPages.filter((p) => !textySet.has(p)));

  const textFacts = assembleTextTakeoff(textyPages, projectName);

  const fallbackPageNums: number[] = [];
  const textyPageYields: Record<number, number> = {};
  for (const page of textyPages) {
    const y = countEntities(assembleTextTakeoff([page], projectName));
    textyPageYields[page.page] = y;
    if (y === 0) {
      fallbackPageNums.push(page.page);
      rasterSet.add(page.page);
    }
  }
  const rasterPageNums = [...rasterSet].sort((a, b) => a - b);

  const transcript = rasterPageNums.length > 0 ? await transcribe(rasterPageNums) : [];
  const transcriptFacts = transcript.length > 0 ? assembleTranscriptTakeoff(transcript, projectName) : null;
  const facts = transcriptFacts ? mergeTakeoffs(textFacts, transcriptFacts) : textFacts;
  return {
    facts, transcript, textyPageNums, rasterPageNums, fallbackPageNums,
    textCounts: entityCountsByKind(textFacts),
    transcriptCounts: transcriptFacts ? entityCountsByKind(transcriptFacts) : null,
    textyPageYields,
  };
}

export interface LocatedPageAddition {
  page: number;
  /** 'text-yield': the text assembler reads ≥2 entities from the page.
   *  'annotation-form': callout-shaped text in the layer but ZERO yield —
   *  the PR16-fallback class (real annotations, grammar-blind page). */
  reason: 'annotation-form' | 'text-yield';
}

export interface LocatedUnion {
  /** Located ∪ proven-bearing pages, deduplicated, ascending. */
  pages: number[];
  added: LocatedPageAddition[];
}

/**
 * Locator union (PR17; silent-cap audit class 2). The vision locator returns
 * ONE page set shared by all disciplines, and its only failure handling is
 * empty-result → tile-all. A PARTIAL miss — a plausible-looking subset that
 * quietly omits bearing pages — proceeded with no signal at all: 13 of 30
 * text-visible bearing pages across 8 golden projects were never selected
 * (Gerrard's three bearing pages among them, so its cached takeoff is ~0;
 * Eric Smith's 14 truth runs sit on 2 missed pages).
 *
 * The text layer can prove some of those pages bearing for $0, in hybrid
 * and every other mode that consumes the located set. Admission takes one
 * of two shapes — anything in between is not proof:
 *   - text yield ≥ 2: the text assembler reads the page's callout grammar
 *     more than once; the page is demonstrably takeoff-bearing;
 *   - annotation form with yield 0: numeric callout shapes (mm diameter,
 *     @ slope, INV/T/G/RIM with a value, numbered structure label) sit in
 *     the text layer but the grammar reads NOTHING from the page — the
 *     PR16-fallback shape (real annotations the text path cannot assemble,
 *     e.g. SHX strokes). Admitting it costs the text path nothing (it
 *     yields zero) and routes the page to vision, where its content lives.
 * A page whose entire yield is a SINGLE entity is deliberately refused:
 * lone endpoint-less fragments parsed out of notes, legends and key plans
 * are a known false-positive shape (measured on the golden A/B: every
 * yield-1 admission produced an unmatched entity, every yield ≥ 2 or
 * yield-0 admission produced gains or nothing), and one stray parse is
 * not evidence a page is bearing. Prose-only sheets (no forms, no yield)
 * stay out, and pages already located are never removed. Pure: callers
 * pass every page's text and decide what to do with the union.
 */
export function unionLocatedPages(
  locatedPages: number[],
  pageTexts: PageText[],
  projectName: string,
): LocatedUnion {
  const located = new Set(locatedPages);
  const added: LocatedPageAddition[] = [];
  for (const pt of pageTexts) {
    if (located.has(pt.page)) continue;
    const y = countEntities(assembleTextTakeoff([pt], projectName));
    if (y >= 2) {
      added.push({ page: pt.page, reason: 'text-yield' });
      located.add(pt.page);
    } else if (y === 0 && hasAnnotationForm(pt)) {
      added.push({ page: pt.page, reason: 'annotation-form' });
      located.add(pt.page);
    }
  }
  added.sort((a, b) => a.page - b.page);
  return { pages: [...located].sort((a, b) => a - b), added };
}

/** Pure: turn recorded failures into warnings, or an error when nothing survived. */
export function applyCallFailures(facts: TakeoffFacts, failures: string[]): TakeoffFacts {
  if (failures.length === 0) return facts;
  if (countEntities(facts) === 0) {
    throw new Error(`AI extraction failed (${failures.length} call(s)): ${failures[0]}`);
  }
  facts.warnings = [
    ...(facts.warnings ?? []),
    `${failures.length} AI call(s) failed during extraction, so this takeoff may be incomplete. First error: ${failures[0]}`,
  ];
  return facts;
}

export async function extractFromPDF(
  pdfInput: Buffer | Buffer[], // Single PDF buffer or array of buffers to merge
  projectName: string,
  gcsSourceUri?: string,
  options: ExtractOptions = {}
): Promise<TakeoffFacts> {
  const failures: string[] = [];
  const facts = await extractionFailures.run(failures, () =>
    extractFromPDFInner(pdfInput, projectName, gcsSourceUri, options)
  );
  return applyCallFailures(facts, failures);
}

async function extractFromPDFInner(
  pdfInput: Buffer | Buffer[],
  projectName: string,
  gcsSourceUri: string | undefined,
  options: ExtractOptions
): Promise<TakeoffFacts> {
  // If given multiple buffers, merge them first
  const pdfBuffer = Array.isArray(pdfInput)
    ? await mergePDFs(pdfInput)
    : pdfInput;

  const inputBuffers = Array.isArray(pdfInput) ? pdfInput : [pdfInput];
  const sourceHashes = inputBuffers.map(buf => crypto.createHash('sha256').update(buf).digest('hex'));
  const sourceHash = crypto.createHash('sha256').update(sourceHashes.join(',')).digest('hex');

  // --- Diagnostics state (PR18) -------------------------------------------
  // Accumulated as the run proceeds and attached to the facts at each
  // return (see attachDiagnostics). Purely observational: nothing below
  // reads this state to make an extraction decision.
  const runStartedAt = Date.now();
  let locatorRan = false;
  let locatorRawPicks: number[] = [];
  let tileAllFallback = false;
  let unionAdded: LocatedPageAddition[] = [];
  let unionPageTexts: PageText[] | null = null;
  // Tile accounting for the transcribe/hybrid paths, filled by
  // transcribeTiles (the single-pass path builds its own section — it does
  // not transcribe). `ran` stays false when no page was ever tiled.
  const tileAcc = {
    ran: false,
    renderFailed: false,
    plannedPages: [] as { page: number; planned: number }[],
    perPageRendered: [] as (number | null)[],
    rendered: null as number | null,
    uploaded: null as number | null,
    transcribed: null as number | null,
    missingAfterRetry: 0,
    degenerateDiscarded: 0,
    blocks: null as number | null,
  };

  const ai = getGenAI();
  const useVertex = process.env.USE_VERTEX_AI === 'true' || !process.env.GEMINI_API_KEY;
  const uploadedFiles: any[] = [];
  // Drawings are ingested as high-DPI image tiles (rasterize.ts) and the page
  // locator uses per-page thumbnails — neither uploads the whole PDF, so there is
  // no top-level PDF upload. preparePdfPart() (agents path + tile-render fallback)
  // still uploads on demand and registers files in uploadedFiles for cleanup.
  // gcsPath/isCacheHit are retained for the finally-block logging contract.
  const gcsPath: string | null = null;
  const isCacheHit = false;
  void gcsSourceUri;

  try {
    const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    console.log(`      [extraction.ts] Total pages in merged PDF: ${totalPages}`);

    let locatorIndex: { manholePages: number[], sewerPages: number[], watermainPages: number[] } | null = null;
    const cost: CostAcc = { promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: TILE_DPI };

    const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);

    // Thumbnail-based page locator: classify each page from a cheap downscaled
    // image and tile only the pages that carry servicing takeoff data. Falls back
    // to all pages on tiny sets or when the locator returns nothing. Disable with
    // ENABLE_PAGE_LOCATOR=false.
    if (totalPages <= 2 || process.env.ENABLE_PAGE_LOCATOR === 'false') {
      locatorIndex = { manholePages: allPages, sewerPages: allPages, watermainPages: allPages };
      console.log(`      [extraction.ts] Tiling all ${totalPages} page(s) (locator skipped).`);
    } else {
      locatorRan = true;
      let relevant: number[] = [];
      const memoedPages = REUSE_PREP ? locatorMemo.get(sourceHash) : undefined;
      if (memoedPages) {
        relevant = memoedPages;
        console.log(`      [extraction.ts] Reusing memoized locator pages (${relevant.length}).`);
      } else {
        try {
          relevant = await locateRelevantPages(ai, pdfBuffer, sourceHash, projectName, cost);
          if (REUSE_PREP && relevant.length > 0) {
            if (locatorMemo.size > 64) locatorMemo.clear(); // bound memory in long-lived servers
            locatorMemo.set(sourceHash, relevant);
          }
        } catch (e: any) {
          console.warn(`      [extraction.ts] Page locator failed (${e.message}); using all pages.`);
        }
      }
      locatorRawPicks = [...relevant];
      if (relevant.length > 0) {
        locatorIndex = { manholePages: relevant, sewerPages: relevant, watermainPages: relevant };
        console.log(`      [extraction.ts] Page locator selected ${relevant.length}/${totalPages} page(s):`, relevant);
      }
    }

    // Fallback: if the locator produced nothing usable, tile all pages.
    if (!locatorIndex ||
        (locatorIndex.manholePages.length === 0 &&
         locatorIndex.sewerPages.length === 0 &&
         locatorIndex.watermainPages.length === 0)) {
      tileAllFallback = true;
      locatorIndex = { manholePages: allPages, sewerPages: allPages, watermainPages: allPages };
      console.log(`      [extraction.ts] Locator empty — tiling all ${totalPages} page(s).`);
    }

    // Locator union (PR17, silent-cap audit class 2): the fallback above
    // covers only a locator that returns NOTHING. A partial miss proceeded
    // silently, so union the located set with the pages the text layer
    // proves bearing (unionLocatedPages) and let every downstream consumer
    // — tiling, hybrid text routing, the provenance check, the persisted
    // locatorIndex — see the recovered pages. Runs only when the located
    // set is a proper subset: an all-pages set (locator skipped, failed, or
    // empty above) has nothing to recover, and the empty-set tile-all
    // behaviour is untouched.
    if (locatorIndex) {
      const locatedSet = new Set([
        ...locatorIndex.manholePages, ...locatorIndex.sewerPages, ...locatorIndex.watermainPages,
      ]);
      if (locatedSet.size > 0 && locatedSet.size < totalPages) {
        try {
          unionPageTexts = await extractPageText(pdfBuffer);
          const union = unionLocatedPages([...locatedSet], unionPageTexts, projectName);
          unionAdded = union.added;
          if (union.added.length > 0) {
            locatorIndex = { manholePages: union.pages, sewerPages: union.pages, watermainPages: union.pages };
            console.log(
              `      [extraction.ts] Locator union: added ${union.added.length} text-layer-bearing page(s) ` +
              `the locator missed: ${union.added.map((a) => `p${a.page} (${a.reason})`).join(', ')}.`
            );
          }
        } catch (e: any) {
          console.warn(`      [extraction.ts] Locator union skipped (${e.message}); keeping the locator's set.`);
        }
      }
    }

    const shouldRunManholes = !locatorIndex || locatorIndex.manholePages.length > 0;
    const shouldRunSewers = !locatorIndex || locatorIndex.sewerPages.length > 0;
    const shouldRunWatermain = !locatorIndex || locatorIndex.watermainPages.length > 0;

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

    // Upload one image tile and return a fileData part. Inlining ~48 tiles (~30MB)
    // exceeds the request size limit and fails as a transport error, so tiles are
    // uploaded (Vertex -> GCS, AI Studio -> Files API) and referenced by URI.
    const prepareImagePart = async (buffer: Buffer): Promise<any> => {
      if (useVertex) {
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const fileName = `cached-tiles/${hash}.jpg`;
        const file = storage.bucket(BUCKET_NAME).file(fileName);
        const [exists] = await file.exists();
        if (!exists) {
          await file.save(buffer, { contentType: IMAGE_MIME, metadata: { cacheControl: 'public, max-age=31536000' } });
        }
        return { fileData: { fileUri: `gs://${BUCKET_NAME}/${fileName}`, mimeType: IMAGE_MIME } };
      }
      const tempPath = path.join(os.tmpdir(), `tile-${crypto.randomBytes(8).toString('hex')}.jpg`);
      fs.writeFileSync(tempPath, buffer);
      try {
        const up = await callWithRetry(() => ai.files.upload({ file: tempPath, config: { mimeType: IMAGE_MIME } }));
        uploadedFiles.push(up);
        return { fileData: { fileUri: up.uri || '', mimeType: IMAGE_MIME } };
      } finally {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    };

    // Upload tiles with bounded concurrency (Files API is one call per file).
    const uploadTiles = async (tiles: Buffer[]): Promise<any[]> => {
      const parts: any[] = new Array(tiles.length);
      let next = 0;
      const worker = async () => {
        while (next < tiles.length) {
          const my = next++;
          parts[my] = await prepareImagePart(tiles[my]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, tiles.length) }, worker));
      return parts;
    };

    // --- Diagnostics helpers (PR18) --------------------------------------
    // Page size in points from the already-loaded document (tilesNeededPerPage
    // needs the sheet geometry). Null on any failure — that page then plans 0
    // tiles and the per-page derivation fails to reconcile, leaving totals
    // authoritative and per-page rendered null (see diagnostics.ts).
    const pageDimsPt = (page: number): { width: number; height: number } | null => {
      try {
        const s = srcDoc.getPage(page - 1).getSize();
        return { width: s.width, height: s.height };
      } catch {
        return null;
      }
    };

    const textCharsByPage = (pts: PageText[] | null): Map<number, number> | null =>
      pts ? new Map(pts.map((pt) => [pt.page, pt.items.reduce((a, i) => a + i.text.length, 0)])) : null;

    // The tiles section of the diagnostics record, from tileAcc (the
    // single-pass path builds its own section — it renders but never
    // transcribes, so its transcription fields stay null).
    const transcribeTileSection = (): TileDiagnostics => {
      if (!tileAcc.ran) {
        return { planned: null, rendered: null, uploaded: null, transcribed: null, missingAfterRetry: null, degenerateDiscarded: null, blocks: null };
      }
      return {
        planned: tileAcc.plannedPages.reduce((a, p) => a + p.planned, 0),
        rendered: tileAcc.renderFailed ? 0 : tileAcc.rendered,
        uploaded: tileAcc.uploaded,
        transcribed: tileAcc.transcribed,
        missingAfterRetry: tileAcc.renderFailed ? null : tileAcc.missingAfterRetry,
        degenerateDiscarded: tileAcc.renderFailed ? null : tileAcc.degenerateDiscarded,
        blocks: tileAcc.blocks,
        ...(tileAcc.renderFailed ? { renderFailed: true as const } : {}),
      };
    };

    const tilePlanByPage = (): Map<number, { planned: number; rendered: number | null }> =>
      new Map(tileAcc.plannedPages.map((p, i) => [p.page, { planned: p.planned, rendered: tileAcc.perPageRendered[i] ?? null }]));

    // Attach the diagnostics record to finished facts (see diagnostics.ts).
    // Called at each mode's return, after every mutation of the facts.
    const attachDiagnostics = (
      facts: TakeoffFacts,
      mode: string,
      pages: PageDiagnostics[],
      tiles: TileDiagnostics,
      sources: ExtractionDiagnostics['assembly']['sources'],
      finalPages: number[],
    ): TakeoffFacts => {
      facts.diagnostics = buildExtractionDiagnostics({
        mode,
        durationMs: Date.now() - runStartedAt,
        locator: {
          ran: locatorRan,
          rawPicks: locatorRawPicks,
          unionAdded: unionAdded.map((a) => ({ page: a.page, reason: a.reason })),
          finalPages,
          tileAllFallback,
        },
        pages,
        tiles,
        sources,
        finalFacts: facts,
      });
      return facts;
    };

    // Render + upload tiles for `pages`, batch them, and transcribe each batch
    // verbatim with getTranscriptionPrompt (no takeoff interpretation — see
    // modular-prompts.ts). Shared by EXTRACTION_MODE=transcribe (all located
    // pages) and EXTRACTION_MODE=hybrid (only the non-texty subset), so the
    // streaming/retry/cache/cost-accounting pattern is written exactly once.
    const transcribeTiles = async (pages: number[]): Promise<TileTranscript[]> => {
      if (pages.length === 0) return [];

      // Diagnostics: plan the tile geometry for exactly the pages being
      // tiled, so rendered/transcribed/lost counts attribute per page.
      tileAcc.ran = true;
      const PER_PAGE = MAX_TILES_PER_PAGE;
      const maxTilesTotal = Math.min(Number(process.env.MAX_TILES_TOTAL) || 320, pages.length * PER_PAGE);
      tileAcc.plannedPages = pages.map((p) => {
        const d = pageDimsPt(p);
        return { page: p, planned: d ? tilesNeededPerPage(d.width, d.height) : 0 };
      });

      let tiles: Buffer[] = [];
      try {
        tiles = await renderTilesFlat(pdfBuffer, pages, {
          dpi: TILE_DPI, tilePx: TILE_PX, overlapPx: TILE_OVERLAP, maxTilesPerPage: PER_PAGE, maxTilesTotal,
        });
        tileAcc.rendered = tiles.length;
        tileAcc.perPageRendered = deriveRenderedPerPage(tileAcc.plannedPages, PER_PAGE, maxTilesTotal, tiles.length);
      } catch (e: any) {
        tileAcc.renderFailed = true;
        console.warn(`      [extraction.ts] Transcribe tile rendering failed (${e.message}).`);
        recordCallFailure('Rendering drawing tiles', e);
        return [];
      }

      const tileParts = await uploadTiles(tiles);
      tileAcc.uploaded = tileParts.length;
      cost.tiles += tileParts.length;
      console.log(`      [extraction.ts] Rendered + uploaded ${tileParts.length} tile(s) from ${pages.length} page(s) for transcription.`);

      const BATCH_TILES = Number(process.env.BATCH_TILES) || 16;
      const BATCH_CONCURRENCY = Number(process.env.BATCH_CONCURRENCY) || 3;
      const tileBatches: any[][] = [];
      for (let i = 0; i < tileParts.length; i += BATCH_TILES) tileBatches.push(tileParts.slice(i, i + BATCH_TILES));
      if (tileBatches.length === 0) {
        tileAcc.transcribed = 0;
        tileAcc.blocks = 0;
        return [];
      }

      // One transcription call: prompt -> stream -> parsed object. Shared by the first
      // pass and the single retry round below so the retry cannot drift from the
      // original request.
      const transcribeCall = async (
        batch: any[], tileOffset: number, cacheKey: string, label: string
      ): Promise<any> => {
        const prompt = getTranscriptionPrompt(batch.length, tileOffset);

        let text = '{}';
        try {
          text = await getCachedOrCallLLM(cacheKey, prompt, 'transcribe', async () => {
            // Same streaming pattern as the single-pass batch loop below: large
            // tiled inference takes many seconds, and a non-streaming request
            // leaves the socket idle long enough to be dropped (UND_ERR_SOCKET).
            return await callWithRetry(async () => {
              const stream = await ai.models.generateContentStream({
                model: EXTRACTION_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }, ...batch] }],
                config: {
                  temperature: Number(process.env.EXTRACTION_TEMPERATURE || '0'),
                  responseMimeType: 'application/json',
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                  thinkingConfig: { thinkingBudget: THINKING_BUDGET },
                },
              });
              let acc = '', usage: any = null, finishReason: string | null = null;
              for await (const chunk of stream) {
                acc += chunk.text || '';
                if (chunk.usageMetadata) usage = chunk.usageMetadata;
                // finishReason was previously DISCARDED. The model reported
                // MAX_TOKENS on every call of a silently-failing project and
                // nothing was listening — see findDegenerateRepetition.
                const fr = chunk.candidates?.[0]?.finishReason;
                if (fr) finishReason = String(fr);
              }
              addUsage(cost, usage);
              if (finishReason && finishReason !== 'STOP') {
                console.warn(`      [extraction.ts] finishReason=${finishReason} (response hit a limit — output may be truncated).`);
              }
              return acc || '{}';
            });
          }, projectName);
        } catch (e: any) {
          console.error(`      [extraction.ts] Transcribe ${label} failed: ${e.message}`);
          recordCallFailure(`Transcription ${label}`, e);
        }

        try {
          return tryParseJSONWithRepair(text);
        } catch (e: any) {
          console.error(`      [extraction.ts] Transcribe ${label} parse failed: ${e.message}`);
          return {};
        }
      };

      const batchResults = await mapLimit(tileBatches, BATCH_CONCURRENCY, async (batch, bi) => {
        const tileOffset = bi * BATCH_TILES;
        const label = `batch ${bi + 1}/${tileBatches.length}`;
        const parsed = await transcribeCall(
          batch, tileOffset, `${sourceHash}_transcribe_b${bi}of${tileBatches.length}`, label
        );

        const first = sanitizeTranscriptTiles(parsed?.tiles, tileOffset, batch.length);
        tileAcc.degenerateDiscarded += first.degenerate.length;
        for (const n of first.degenerate) {
          console.warn(`      [extraction.ts] ${label}: tile ${n} DISCARDED — decode repetition loop, not a read of the drawing.`);
        }
        if (first.missing.length === 0) return first.tiles;

        // A looping tile burns the batch's entire output budget, so every LATER tile
        // is truncated out of the response and repairTruncatedJson returns a valid
        // object without them (Bradford lost 52 of 60 tiles this way). Those tiles are
        // innocent — re-issue them ONCE, with the offender no longer in the request so
        // it cannot loop again. One round only: a retry that still comes back short is
        // reported, not retried, so a pathological sheet cannot fan out calls.
        console.warn(`      [extraction.ts] ${label}: ${first.missing.length} tile(s) absent from the response — re-issuing once.`);
        const out = [...first.tiles];
        for (const run of contiguousRuns(first.missing)) {
          const parts = run.map((n) => tileParts[n - 1]).filter(Boolean);
          if (parts.length === 0) continue;
          const retryOffset = run[0] - 1;
          const retryLabel = `${label} retry ${run[0]}-${run[run.length - 1]}`;
          const rp = await transcribeCall(
            parts, retryOffset, `${sourceHash}_transcribe_b${bi}r${run[0]}`, retryLabel
          );
          const again = sanitizeTranscriptTiles(rp?.tiles, retryOffset, parts.length);
          tileAcc.degenerateDiscarded += again.degenerate.length;
          tileAcc.missingAfterRetry += again.missing.length;
          for (const n of again.degenerate) {
            console.warn(`      [extraction.ts] ${retryLabel}: tile ${n} DISCARDED — decode repetition loop.`);
          }
          if (again.missing.length > 0) {
            console.warn(`      [extraction.ts] ${retryLabel}: STILL missing ${again.missing.length} tile(s) after one retry — giving up on them.`);
          }
          out.push(...again.tiles);
        }
        return out;
      });

      const allTiles = batchResults.flat();
      tileAcc.transcribed = allTiles.length;
      tileAcc.blocks = allTiles.reduce((a, t) => a + t.blocks.length, 0);
      return allTiles;
    };

    // --- TILED INGESTION ---
    // Combined facts calls over high-DPI image TILES of the located pages.
    // Large-format CAD sheets are illegible once the whole PDF is downsampled by
    // the model (it then fabricates), so we rasterize and tile the located pages to
    // keep annotation text at full fidelity (see rasterize.ts).
      console.log(`      [extraction.ts] Extracting facts from image tiles of located pages.`);
      const unionPages = locatorIndex
        ? Array.from(new Set([
            ...locatorIndex.manholePages,
            ...locatorIndex.sewerPages,
            ...locatorIndex.watermainPages,
          ])).sort((a, b) => a - b)
        : [];

      const BATCH_TILES = Number(process.env.BATCH_TILES) || 16;
      const BATCH_CONCURRENCY = Number(process.env.BATCH_CONCURRENCY) || 3;

      // EXTRACTION_MODE: defaults to 'hybrid' (text-layer for TrueType pages, vision
      // transcribe + deterministic grammar for raster/SHX pages). Setting
      // EXTRACTION_MODE=single-pass restores the legacy monolithic vision path.
      const mode = options.mode || process.env.EXTRACTION_MODE || 'hybrid';

      // EXTRACTION_MODE=vector: full CAD vector geometry and topology graph extraction ($0 LLM cost).
      if (mode === 'vector') {
        // Production verifier for the vector path's invariant violations:
        // one vision call per flagged sheet, answering only the targeted
        // queries built from that sheet's error-severity violations. Any
        // failure degrades to "no answers" — those queries are then
        // withheld for the estimator by resolveVerification.
        const verify: VectorVerifier = async (queries, page) => {
          try {
            const thumbs = await renderPageThumbnails(pdfBuffer, { maxPx: 2000 });
            const thumb = thumbs.find((t) => t.page === page);
            if (!thumb) return [];
            const listing = queries
              .map((q) => `- queryId: ${q.id} | entityId: ${q.entityId} | question: ${q.question}`)
              .join('\n');
            const prompt = [
              `You are verifying specific details on sheet ${page} of the civil servicing drawing for "${projectName}".`,
              'Answer ONLY the following targeted verification questions, using the attached sheet image:',
              listing,
              'Respond with JSON only: { "answers": [{ "queryId": string, "verifiedValue": string, "confidence": number }] }.',
              'Include an answer only when the sheet clearly shows the value; omit any question you cannot confirm from the drawing.',
            ].join('\n');
            const text = await getCachedOrCallLLM(`${sourceHash}_vectorverify_p${page}`, prompt, 'vector-verify', async () => {
              const response = await callWithRetry(async () => ai.models.generateContent({
                model: EXTRACTION_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: IMAGE_MIME, data: thumb.img.toString('base64') } }] }],
                config: { temperature: 0, responseMimeType: 'application/json' },
              }));
              if (cost) addUsage(cost, (response as any).usageMetadata);
              return response.text || '{}';
            }, projectName);
            const parsed = JSON.parse(text);
            const raw: unknown = parsed?.answers;
            if (!Array.isArray(raw)) return [];
            const byId = new Map(queries.map((q) => [q.id, q]));
            const out: VerificationAnswer[] = [];
            for (const a of raw) {
              const q = a ? byId.get(a.queryId) : undefined;
              if (!q) continue;
              out.push({
                queryId: q.id,
                entityId: q.entityId,
                verifiedValue: a.verifiedValue != null ? String(a.verifiedValue) : undefined,
                confidence: typeof a.confidence === 'number' ? a.confidence : 0,
              });
            }
            return out;
          } catch {
            return [];
          }
        };
        const facts = await extractVectorTakeoff(pdfBuffer, unionPages, projectName, { verify });
        facts.locatorIndex = locatorIndex;
        facts.cost = cost;
        // Diagnostics: the vector path renders no transcription tiles (the
        // verifier's thumbnails are on-demand, not tile accounting), so the
        // tiles section stays null; pages record the vector route.
        const vectorChars = textCharsByPage(unionPageTexts);
        attachDiagnostics(facts, 'vector',
          unionPages.map((p) => ({ page: p, route: 'vector' as const, textChars: vectorChars?.get(p) ?? null, textYield: null, tilesPlanned: null, tilesRendered: null })),
          transcribeTileSection(),
          [{ path: 'vector', counts: entityCountsByKind(facts) }],
          unionPages);
        console.log(`      [extraction.ts] vector-native: ${unionPages.length} located page(s). cost: ${cost.tiles} tiles @${cost.dpi}dpi, ${cost.llmCalls} LLM call(s), tokens in=${cost.promptTokens} out=${cost.outputTokens} total=${cost.totalTokens}`);
        return facts;
      }

      // EXTRACTION_MODE=transcribe: vision transcribes verbatim, deterministic code
      // does ALL the interpretation ($0 offline iteration).
      if (mode === 'transcribe') {
        const transcript = await transcribeTiles(unionPages);
        let facts = assembleTranscriptTakeoff(transcript, projectName);
        const transcriptCounts = entityCountsByKind(facts);

        // Two-pass watermain extraction: if no watermain runs were transcribed,
        // run a focused second pass specifically querying watermain linework/services.
        if (facts.watermain.length === 0 && (unionPages.length > 0 || pdfBuffer)) {
          await runSecondPassWatermain(facts, {
            projectName,
            sourceHash,
            tileBatches: [],
            pdfBuffer,
            preparePdfPart,
            ai,
            cost,
            batchConcurrency: BATCH_CONCURRENCY,
          });
          facts = reconcileTakeoff(facts);
        }

        // Partial-miss surfacing (warnings only — see coverage-checks.ts).
        facts = appendCoverageWarnings(facts);
        // Re-assess confidence on the final facts (the second pass and the
        // coverage warnings above postdate the assembler's own assessment).
        facts = withConfidence(facts);
        facts.transcript = transcript;
        facts.locatorIndex = locatorIndex;
        facts.cost = cost;
        // Physics surfacing (warnings only — see physics-checks.ts),
        // appended after the confidence assessment on the final facts.
        facts = appendPhysicsWarnings(facts);
        // Tile-loss surfacing + diagnostics (PR18): appended after the
        // confidence assessment, like the physics warnings, so the record
        // and the warnings describe the final facts without feeding back
        // into their confidence.
        const tilesDiagT = transcribeTileSection();
        facts.warnings = [...(facts.warnings ?? []), ...tileDiagnosticsWarnings(tilesDiagT)];
        const planT = tilePlanByPage();
        const charsT = textCharsByPage(unionPageTexts);
        attachDiagnostics(facts, 'transcribe',
          unionPages.map((p) => ({
            page: p, route: 'vision' as const,
            textChars: charsT?.get(p) ?? null, textYield: null,
            tilesPlanned: planT.get(p)?.planned ?? null, tilesRendered: planT.get(p)?.rendered ?? null,
          })),
          tilesDiagT,
          [{ path: 'transcript', counts: transcriptCounts }],
          unionPages);
        console.log(`      [extraction.ts] transcribe: cost: ${cost.tiles} tiles @${cost.dpi}dpi, ${cost.llmCalls} LLM call(s), tokens in=${cost.promptTokens} out=${cost.outputTokens} total=${cost.totalTokens}`);
        return facts;
      }

      // EXTRACTION_MODE=hybrid (default): text-layer pages are read exactly ($0 LLM cost);
      // only non-texty pages go through the transcribe path. Text layer wins on conflicts.
      if (mode === 'hybrid') {
        const pageTexts = await extractPageText(pdfBuffer, unionPages);
        // Routing + assembly live in assembleHybridTakeoff (incl. the
        // zero-yield fallback: a texty page that assembles to zero entities
        // is re-routed to vision instead of being silently dropped).
        const hybrid = await assembleHybridTakeoff(pageTexts, unionPages, projectName, transcribeTiles);
        const transcript = hybrid.transcript;
        if (hybrid.fallbackPageNums.length > 0) {
          console.log(`      [extraction.ts] hybrid: texty page(s) ${hybrid.fallbackPageNums.join(', ')} yielded zero entities from the text layer — re-routed to vision transcription.`);
        }

        let facts = hybrid.facts;

        // Two-pass watermain extraction if still 0 watermain runs
        if (facts.watermain.length === 0 && (unionPages.length > 0 || pdfBuffer)) {
          await runSecondPassWatermain(facts, {
            projectName,
            sourceHash,
            tileBatches: [],
            pdfBuffer,
            preparePdfPart,
            ai,
            cost,
            batchConcurrency: BATCH_CONCURRENCY,
          });
          facts = reconcileTakeoff(facts);
        }

        // Partial-miss surfacing on the MERGED facts (warnings only): a run
        // endpoint is only "dangling" once both paths' structures are in, so
        // this runs after the merge, not inside either sub-assembly.
        facts = appendCoverageWarnings(facts);
        // Re-assess confidence on the MERGED facts: mergeTakeoffs kept the
        // primary (text) path's assessment, which knows nothing of the
        // transcript half. See confidence.ts.
        facts = withConfidence(facts);
        if (transcript.length > 0) facts.transcript = transcript;
        facts.locatorIndex = locatorIndex;
        facts.cost = cost;
        // Physics surfacing on the MERGED facts (warnings only — see
        // physics-checks.ts): a run's endpoints may only both exist once
        // the two paths are merged, so this runs here, not inside either
        // sub-assembly alone. Appended after the confidence assessment.
        facts = appendPhysicsWarnings(facts);
        // Tile-loss surfacing + diagnostics (PR18), after the confidence
        // assessment like the physics warnings above.
        const tilesDiagH = transcribeTileSection();
        facts.warnings = [...(facts.warnings ?? []), ...tileDiagnosticsWarnings(tilesDiagH)];
        const planH = tilePlanByPage();
        const charsH = textCharsByPage(pageTexts);
        const rasterSetH = new Set(hybrid.rasterPageNums);
        const fallbackSetH = new Set(hybrid.fallbackPageNums);
        attachDiagnostics(facts, 'hybrid',
          unionPages.map((p) => ({
            page: p,
            route: (rasterSetH.has(p) ? 'vision' : 'text') as 'vision' | 'text',
            textChars: charsH?.get(p) ?? null,
            textYield: hybrid.textyPageYields[p] ?? null,
            tilesPlanned: planH.get(p)?.planned ?? null,
            tilesRendered: planH.get(p)?.rendered ?? null,
            ...(fallbackSetH.has(p) ? { zeroYieldFallback: true } : {}),
          })),
          tilesDiagH,
          [
            { path: 'text', counts: hybrid.textCounts },
            ...(hybrid.transcriptCounts ? [{ path: 'transcript' as const, counts: hybrid.transcriptCounts }] : []),
          ],
          unionPages);
        console.log(`      [extraction.ts] hybrid: ${hybrid.textyPageNums.length} texty / ${hybrid.rasterPageNums.length} raster of ${unionPages.length} located page(s). cost: ${cost.tiles} tiles @${cost.dpi}dpi, ${cost.llmCalls} LLM call(s), tokens in=${cost.promptTokens} out=${cost.outputTokens} total=${cost.totalTokens}`);
        return facts;
      }

      // Rasterize located pages to legible tiles; fall back to the raw PDF if rendering fails.
      let tileParts: any[] = [];
      let spRenderFailed = false;
      let spRenderedCount: number | null = null;
      const memoedTiles = REUSE_PREP ? tilePartsMemo.get(sourceHash) : undefined;
      if (memoedTiles) {
        tileParts = memoedTiles;
        console.log(`      [extraction.ts] Reusing ${tileParts.length} memoized tile(s) (skip re-render/upload).`);
      } else {
        try {
          // Cover EVERY located page fully. A flat 48-tile cap silently dropped ~half the
          // tiles on multi-page servicing sets, so big projects only "saw" part of the plan
          // and missed whole pipe systems (e.g. Panattoni's trunk sewers). Scale the budget
          // with page count (streaming + Vertex handle the extra batches); cap for cost.
          const PER_PAGE = MAX_TILES_PER_PAGE;
          const nPages = unionPages.length || 1;
          const maxTilesTotal = Math.min(Number(process.env.MAX_TILES_TOTAL) || 320, nPages * PER_PAGE);
          const tiles = await renderTilesFlat(pdfBuffer, unionPages, {
            dpi: TILE_DPI, tilePx: TILE_PX, overlapPx: TILE_OVERLAP, maxTilesPerPage: PER_PAGE, maxTilesTotal,
          });
          spRenderedCount = tiles.length;
          tileParts = await uploadTiles(tiles);
          if (REUSE_PREP && tileParts.length > 0) {
            if (tilePartsMemo.size > 64) tilePartsMemo.clear(); // bound memory in long-lived servers
            tilePartsMemo.set(sourceHash, tileParts);
          }
          console.log(`      [extraction.ts] Rendered + uploaded ${tileParts.length} tile(s) from ${unionPages.length || 'all'} page(s).`);
        } catch (e: any) {
          spRenderFailed = true;
          console.warn(`      [extraction.ts] Tile rendering failed (${e.message}); falling back to full PDF.`);
        }
      }

      cost.tiles = tileParts.length;

      const prompt =
        // Dynamic-rules injection retired (see getDynamicPromptAdditions):
        // the single-pass prompt no longer consumes dynamic-rules.json.
        getSinglePassPrompt(projectName, '') + '\n' +
        buildFewShotPromptSection(projectName, { name: projectName, hasWatermain: shouldRunWatermain, hasSanitary: shouldRunSewers });

      // A single call over many tiles times out / truncates its JSON above ~32
      // tiles, so split into batches of <=BATCH_TILES and merge the parsed facts.
      // Batches are independent, so run up to BATCH_CONCURRENCY of them at once.
      const tileBatches: any[][] = [];
      for (let i = 0; i < tileParts.length; i += BATCH_TILES) tileBatches.push(tileParts.slice(i, i + BATCH_TILES));
      if (tileBatches.length === 0) tileBatches.push([]); // no tiles -> PDF fallback below
      if (tileBatches.length > 1) console.log(`      [extraction.ts] Splitting ${tileParts.length} tiles into ${tileBatches.length} batched calls (concurrency ${BATCH_CONCURRENCY}).`);

      // Batches discarded for degenerate repetition — surfaced as a warning on the
      // facts so a 0-entity result is never mistaken for "the drawing was empty".
      const degenerateBatches: string[] = [];

      const parts = await mapLimit(tileBatches, BATCH_CONCURRENCY, async (batch, bi) => {
        const media = batch.length > 0 ? batch : [await preparePdfPart(pdfBuffer)];
        let text = '{}';
        try {
          text = await getCachedOrCallLLM(`${sourceHash}_single_b${bi}of${tileBatches.length}`, prompt, 'single', async () => {
            // Stream the response: large tiled inference takes many seconds, and a
            // non-streaming request leaves the socket idle long enough to be dropped
            // (UND_ERR_SOCKET). Streaming keeps tokens flowing so the socket stays live.
            return await callWithRetry(async () => {
              const stream = await ai.models.generateContentStream({
                model: EXTRACTION_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }, ...media] }],
                // gemini-2.5-flash thinking (~4k tokens) shares the maxOutputTokens
                // budget with the JSON response. Vertex defaults this to 8192, so on
                // dense projects thinking + the (longer, pipe-scan-first) response blew
                // past the cap and the response truncated — dropping structures (emitted
                // last) to 0 and halving sewers. Set an explicit, ample ceiling so the
                // full response always fits. (AI Studio's larger default masked this locally.)
                config: {
                  temperature: Number(process.env.EXTRACTION_TEMPERATURE || '0'),
                  responseMimeType: 'application/json',
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                  thinkingConfig: { thinkingBudget: THINKING_BUDGET },
                },
              });
              let acc = '', usage: any = null, finishReason: string | null = null;
              for await (const chunk of stream) {
                acc += chunk.text || '';
                if (chunk.usageMetadata) usage = chunk.usageMetadata;
                // finishReason was previously DISCARDED. The model reported
                // MAX_TOKENS on every call of a silently-failing project and
                // nothing was listening — see findDegenerateRepetition.
                const fr = chunk.candidates?.[0]?.finishReason;
                if (fr) finishReason = String(fr);
              }
              addUsage(cost, usage);
              if (finishReason && finishReason !== 'STOP') {
                console.warn(`      [extraction.ts] finishReason=${finishReason} (response hit a limit — output may be truncated).`);
              }
              return acc || '{}';
            });
          }, projectName);
        } catch (e: any) {
          console.error(`      [extraction.ts] Single-pass batch ${bi + 1}/${tileBatches.length} failed: ${e.message}`);
          recordCallFailure(`Extraction batch ${bi + 1}/${tileBatches.length}`, e);
        }
        try {
          const parsed = tryParseJSONWithRepair(text);
          // A decode loop yields VALID JSON that is nonetheless worthless: the
          // budget was spent repeating one element, so the keys carrying the
          // actual takeoff were never emitted. Without this check the batch looks
          // like a clean empty result and the project scores 0% silently.
          const { cleaned, dropped } = stripDegenerateKeys(parsed);
          for (const d of dropped) {
            console.error(
              `      [extraction.ts] Batch ${bi + 1}/${tileBatches.length}: dropped degenerate key "${d.key}" ` +
              `(${d.length} entries, longest identical run ${d.runLength}, e.g. ${JSON.stringify(d.sample)}). ` +
              `Decode loop, not a read of the drawing — other keys in this batch are kept.`
            );
            degenerateBatches.push(`batch ${bi + 1}: "${d.key}" x${d.length} (run ${d.runLength})`);
          }
          return cleaned;
        } catch (e: any) {
          console.error(`      [extraction.ts] Batch ${bi + 1} parse failed: ${e.message}`);
          return {} as any;
        }
      });

      const raw: any = { manholes: [], catchbasins: { groups: [] }, sewers: [], watermain: [], watermainSpecials: [], watermainValves: [], warnings: [] };
      for (const part of parts) {
        if (Array.isArray(part.manholes)) raw.manholes.push(...part.manholes);
        if (part.catchbasins?.groups) raw.catchbasins.groups.push(...part.catchbasins.groups);
        if (Array.isArray(part.sewers)) raw.sewers.push(...part.sewers);
        if (Array.isArray(part.watermain)) raw.watermain.push(...part.watermain);
        if (Array.isArray(part.watermainSpecials)) raw.watermainSpecials.push(...part.watermainSpecials);
        if (Array.isArray(part.watermainValves)) raw.watermainValves.push(...part.watermainValves);
        if (Array.isArray(part.warnings)) raw.warnings.push(...part.warnings);
      }

      const facts = parseFacts({
        manholes: deduplicateManholes(raw.manholes),
        catchbasins: { groups: mergeCatchbasinGroups(raw.catchbasins.groups) },
        sewers: deduplicateSewers(raw.sewers),
        watermain: deduplicateWatermain(raw.watermain),
        watermainSpecials: deduplicateSpecials(raw.watermainSpecials),
        watermainValves: deduplicateValves(raw.watermainValves),
        warnings: raw.warnings,
      }, projectName);
      // Assembly counts before the second pass / provenance / junk filters
      // mutate the facts — the single-pass source row of the diagnostics.
      const singlePassCounts = entityCountsByKind(facts);

      // Dedicated two-pass watermain extraction: on dense servicing drawings with 50+ sewer
      // and structure callouts, the model often exhausts its output token/attention budget
      // on sewers and emits 0 watermain runs. If single-pass extraction produces 0 watermain
      // runs, run a lightweight second pass specifically using getWatermainExtractionPrompt(projectName)
      // over the located page tiles.
      if (facts.watermain.length === 0 && (tileParts.length > 0 || pdfBuffer)) {
        await runSecondPassWatermain(facts, {
          projectName,
          sourceHash,
          tileBatches,
          pdfBuffer,
          preparePdfPart,
          ai,
          cost,
          batchConcurrency: BATCH_CONCURRENCY,
        });
      }

      // Fabrication check. Asked for a JSON list of structures the model continues label
      // sequences it never read — "DCBMH 1..DCBMH 29" where the drawing has one — with
      // complete arithmetic elevations attached, so nothing about the row itself gives it
      // away. Where the located pages carry a real text layer we can settle it against
      // evidence: a coded label printed nowhere was not read off the drawing. Costs no LLM
      // call, and fails open on every drawing whose labels are SHX/vector (most of them).
      try {
        const locatedPages = [...new Set([...(locatorIndex?.manholePages ?? []), ...(locatorIndex?.sewerPages ?? [])])];
        if (locatedPages.length > 0) {
          const prov = verifyStructureProvenance(facts.structures, await extractPageText(pdfBuffer, locatedPages));
          if (prov.dropped.length > 0) {
            facts.structures = prov.structures;
            facts.warnings.push(
              `Dropped ${prov.dropped.length} structure(s) whose label is not printed on the located drawing pages: ${prov.dropped.slice(0, 12).join(', ')}${prov.dropped.length > 12 ? ', …' : ''}`
            );
            console.log(`      [extraction.ts] provenance: dropped ${prov.dropped.length} unprinted structure label(s).`);
          }
        }
      } catch (e: any) {
        console.warn(`      [extraction.ts] Provenance check skipped: ${e.message}`);
      }

      // Junk filters. The default single-pass path does NOT route through
      // reconcileTakeoff (only the transcribe/hybrid/vector/text paths do), so the two
      // precision filters have to be applied here as well or they never run in
      // production. Both are pure and defined in reconcile.ts; see the notes there.
      {
        const note = dropSpecNoteStructures(facts.structures);
        if (note.dropped.length > 0) {
          facts.structures = note.structures;
          facts.warnings.push(
            `Dropped ${note.dropped.length} structure(s) whose description is a spec note, not a structure id: ` +
              `${note.dropped.slice(0, 8).join(' | ')}${note.dropped.length > 8 ? ' | …' : ''}`
          );
          console.log(`      [extraction.ts] dropped ${note.dropped.length} spec-note structure(s).`);
        }
        const networkSize = facts.structures.length + facts.sewers.filter((s) => !s.isLineItem).length;
        const cb = dropImplausibleCatchbasinGroups(facts.catchbasins, networkSize);
        if (cb.dropped.length > 0) {
          facts.catchbasins = cb.catchbasins;
          for (const d of cb.dropped) {
            facts.warnings.push(
              `Dropped catchbasin group ${d.type} qty ${d.quantity} — implausible against a drainage network ` +
                `of ${networkSize} rows; the quantity is a misread or an out-of-scope enumeration, ` +
                `not a takeoff count. Count these catchbasins manually.`
            );
            console.log(`      [extraction.ts] dropped implausible catchbasin group ${d.type} x${d.quantity}.`);
          }
        }
      }

      facts.warnings = [...facts.warnings, ...validateExtraction(facts)];
      if (degenerateBatches.length > 0) {
        facts.warnings.push(
          `${degenerateBatches.length} degenerate key(s) dropped from extraction batches ` +
          `(model repetition loop, not a read of the drawing): ${degenerateBatches.join('; ')}. ` +
          `Those responses hit the output ceiling mid-loop, so coverage is incomplete — re-run before trusting this takeoff.`
        );
      }
      // Tile truncation surfacing + diagnostics (PR18): this path renders
      // the same capped tile set as the transcribe path, so a cap-truncated
      // render is attributable here too. It never transcribes, so the
      // transcription fields stay null.
      const spPlannedPages = unionPages.map((p) => {
        const d = pageDimsPt(p);
        return { page: p, planned: d ? tilesNeededPerPage(d.width, d.height) : 0 };
      });
      const spPerPageCap = MAX_TILES_PER_PAGE;
      const spTotalCap = Math.min(Number(process.env.MAX_TILES_TOTAL) || 320, (unionPages.length || 1) * spPerPageCap);
      const spRendered = spRenderedCount ?? tileParts.length;
      const spTiles: TileDiagnostics = {
        planned: spPlannedPages.reduce((a, p) => a + p.planned, 0),
        rendered: spRendered,
        uploaded: tileParts.length,
        transcribed: null, missingAfterRetry: null, degenerateDiscarded: null, blocks: null,
        ...(spRenderFailed ? { renderFailed: true } : {}),
      };
      facts.warnings = [...facts.warnings, ...tileDiagnosticsWarnings(spTiles)];
      const spPerPageRendered = deriveRenderedPerPage(spPlannedPages, spPerPageCap, spTotalCap, spRendered);
      const spChars = textCharsByPage(unionPageTexts);
      attachDiagnostics(facts, 'single-pass',
        unionPages.map((p, i) => ({
          page: p, route: 'vision' as const,
          textChars: spChars?.get(p) ?? null, textYield: null,
          tilesPlanned: spPlannedPages[i]?.planned ?? null, tilesRendered: spPerPageRendered[i] ?? null,
        })),
        spTiles,
        [{ path: 'single-pass', counts: singlePassCounts }],
        unionPages);
      facts.locatorIndex = locatorIndex;
      facts.cost = cost;
      console.log(`      [extraction.ts] cost: ${cost.tiles} tiles @${cost.dpi}dpi, ${cost.llmCalls} LLM call(s), tokens in=${cost.promptTokens} out=${cost.outputTokens} total=${cost.totalTokens}`);
      return facts;

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

function validateExtraction(data: TakeoffFacts): string[] {
  const warnings: string[] = [];

  // Filter out catchbasin groups with zero quantity to prevent false warnings
  if (data.catchbasins) {
    data.catchbasins = data.catchbasins.filter(g => g.quantity > 0);
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
    // avgCover is null when unstated — an absent cover is not an unusual one.
    if (wm.avgCover != null && (wm.avgCover < 1.0 || wm.avgCover > 4.0)) {
      warnings.push(
        `Watermain ${wm.sizeAndType}: unusual cover ${wm.avgCover}m (outside 1.0-4.0m)`
      );
    }
  }

  // Validate catchbasins
  if (data.catchbasins) {
    for (const g of data.catchbasins) {
      if (g.quantity <= 0) {
        warnings.push(`Catchbasin group ${g.type}: zero quantity`);
      }
    }
  }

  return warnings;
}

export function repairTruncatedJson(text: string): string {
  // Salvage a truncated JSON response by cutting back to the last point where the
  // document can be validly closed, then closing the still-open containers. Cut
  // points are recorded at every completed container (`}`/`]`) AND at every element
  // separator (`,`) inside a container — the latter is essential: a dense response
  // often truncates mid-string inside a big array (e.g. pipeScan / sewers), and the
  // old `}`/`]`-only logic would find no safe point and drop the ENTIRE batch. Cutting
  // just before the last comma keeps every complete element and discards the partial one.
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  let cutLen = -1;            // exclusive slice length of the salvageable prefix
  let cutStack: string[] = [];
  const record = (len: number) => { cutLen = len; cutStack = [...stack]; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (inString) { if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') {
      stack.push(c);
    } else if (c === '}') {
      if (stack[stack.length - 1] === '{') { stack.pop(); record(i + 1); }
    } else if (c === ']') {
      if (stack[stack.length - 1] === '[') { stack.pop(); record(i + 1); }
    } else if (c === ',') {
      if (stack.length) record(i); // cut BEFORE the comma — drops the incomplete trailing element
    }
  }

  if (cutLen === -1) return text;

  let closing = '';
  for (let j = cutStack.length - 1; j >= 0; j--) closing += cutStack[j] === '{' ? '}' : ']';
  return text.slice(0, cutLen) + closing;
}

/**
 * Detect a degenerate decode loop in a parsed LLM response.
 *
 * gemini-2.5-flash at `temperature: 0` can fall into a repetition loop on a dense
 * sheet and burn the ENTIRE maxOutputTokens budget inside a single key. Measured
 * on White Oak (2026-09-12, Vertex, `finishReason: MAX_TOKENS` on every call) in
 * two distinct shapes:
 *
 *   1. "300mm PVC SOW-30 STM @ 1.00%" emitted 1160 CONSECUTIVE times into
 *      "pipeScan" — 99.3% of the array — so "sewers"/"manholes" (emitted later in
 *      key order) never appeared at all.
 *   2. An incrementing counter, "SMH 30".."SMH 277": 248 UNIQUE labels on a sheet
 *      whose truth is 31 structures. Because every label differs,
 *      deduplicateManholes() cannot collapse it — this is the "structure
 *      fabrication" shape CLAUDE.md documents.
 *
 * In both cases repairTruncatedJson() then returns a *valid* object, the batch
 * merge contributes nothing, and the project scores 0% with no error raised. The
 * point of this function is to make that silent failure loud.
 *
 * Thresholds are set from measured data, deliberately well clear of real drawings:
 *   - MAX_IDENTICAL_RUN=50: identical pipe callouts DO recur legitimately (same
 *     spec, many segments), but the observed loops ran 927-1160 long.
 *   - MAX_ARRAY_LEN=150: the densest golden project (Panattoni) has 89 runs / 85
 *     structures in truth; the observed fabrications were 248-309.
 */
export interface DegenerateRepetition {
  key: string;
  runLength: number;
  length: number;
  sample: string;
}

const MAX_IDENTICAL_RUN = 50;
const MAX_ARRAY_LEN = 150;

export function findDegenerateRepetition(parsed: any): DegenerateRepetition | null {
  if (!parsed || typeof parsed !== 'object') return null;

  for (const [key, value] of Object.entries(parsed)) {
    let arr: any[] | null = null;
    if (Array.isArray(value)) {
      arr = value;
    } else if (value && typeof value === 'object' && Array.isArray((value as any).groups)) {
      arr = (value as any).groups;
    }
    if (!arr || arr.length === 0) continue;

    // Compare by a stable string form so plain strings (pipeScan) and row
    // objects (manholes/sewers/catchbasin groups) are covered by the same scan.
    const asText = arr.map((v) =>
      typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    );

    let longestRun = 1;
    let run = 1;
    let runSample = asText[0];
    for (let i = 1; i < asText.length; i++) {
      if (asText[i] === asText[i - 1]) {
        run++;
        if (run > longestRun) { longestRun = run; runSample = asText[i]; }
      } else {
        run = 1;
      }
    }

    if (longestRun >= MAX_IDENTICAL_RUN) {
      return { key, runLength: longestRun, length: arr.length, sample: runSample.slice(0, 120) };
    }
    if (arr.length >= MAX_ARRAY_LEN) {
      return { key, runLength: longestRun, length: arr.length, sample: asText[asText.length - 1].slice(0, 120) };
    }
  }

  return null;
}

/**
 * Split tile indices into ascending contiguous runs. Truncation always drops a
 * SUFFIX of a batch (the model emits tiles in order until the budget runs out),
 * so in practice this returns a single run — but a run is what the retry needs
 * either way, because getTranscriptionPrompt numbers tiles
 * offset+1..offset+count, making [start..end] exactly {offset: start-1}.
 */
export function contiguousRuns(indices: number[]): number[][] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

export interface SanitizedTranscript {
  tiles: TileTranscript[];
  /** Tiles returned but discarded as a decode loop. Never retried — they would loop again. */
  degenerate: number[];
  /** Tiles requested but absent from the response: the collateral of a loop, worth retrying. */
  missing: number[];
}

/**
 * Apply findDegenerateRepetition to a TRANSCRIBE batch response, and report what
 * the response failed to contain.
 *
 * findDegenerateRepetition scans a parsed object's top-level arrays. A transcribe
 * response is `{ tiles: [{ tile, blocks: [...] }] }`, so its only top-level array
 * is `tiles` — at most BATCH_TILES long, with every element distinct. The guard
 * therefore returned null on every degenerate transcript ever produced: the loops
 * live one level down, inside `blocks`. Handing it `{ blocks }` per tile makes it
 * fire correctly on all of them (measured on the 2026-09-18 cache: Bradford t18
 * run=639 and t51 run=2021 via the identical-run rule; Bradford t2 len=369,
 * Ecole t3 862, t17 880, Stevenson t14 314 via the array-length rule).
 *
 * `missing` matters more than `degenerate`. A looping tile eats the batch's whole
 * maxOutputTokens, so every LATER tile in that batch is truncated away and
 * repairTruncatedJson quietly returns a valid object without them — Bradford lost
 * 52 of 60 tiles that way. Dropping the bad blocks is worth ~0.3pp; re-issuing the
 * innocent tiles is where the recall is.
 */
export function sanitizeTranscriptTiles(
  rawTiles: any[],
  tileOffset: number,
  batchLen: number
): SanitizedTranscript {
  const tiles: TileTranscript[] = [];
  const degenerate: number[] = [];
  const seen = new Set<number>();
  for (const raw of Array.isArray(rawTiles) ? rawTiles : []) {
    if (!raw || typeof raw !== 'object') continue;
    const n = Number((raw as any).tile);
    if (!Number.isFinite(n)) continue;
    // Same normalisation the inline tile loop did before this was extracted:
    // drop non-array blocks and coerce every line to a string, so the grammar
    // downstream can rely on string[][] . Done BEFORE the degeneracy check so the
    // guard scans exactly what would have been kept.
    const blocks: string[][] = (Array.isArray((raw as any).blocks) ? (raw as any).blocks : [])
      .filter((b: any) => Array.isArray(b))
      .map((b: any[]) => b.map((line) => String(line)));
    seen.add(n);
    const hit = findDegenerateRepetition({ blocks });
    if (hit) {
      degenerate.push(n);
      tiles.push({ tile: n, blocks: [] });
      continue;
    }
    tiles.push({ tile: n, blocks });
  }
  const missing: number[] = [];
  for (let i = tileOffset + 1; i <= tileOffset + batchLen; i++) if (!seen.has(i)) missing.push(i);
  return { tiles, degenerate, missing };
}

/**
 * Remove or salvage degenerate keys from a parsed batch.
 *
 * For prompt scratch keys ("pipeScan"), the degenerate array is dropped completely.
 * For actual takeoff arrays ("sewers", "manholes"), collapsing consecutive identical
 * loops and capping the array prevents a repetition loop at the end of a batch from
 * completely discarding the legitimate rows emitted before the loop started.
 */
export function stripDegenerateKeys(parsed: any): { cleaned: any; dropped: DegenerateRepetition[] } {
  if (!parsed || typeof parsed !== 'object') return { cleaned: parsed, dropped: [] };

  const dropped: DegenerateRepetition[] = [];
  const cleaned: any = {};

  for (const [key, value] of Object.entries(parsed)) {
    const hit = findDegenerateRepetition({ [key]: value });
    if (hit) {
      dropped.push(hit);
      if (key === 'pipeScan' || !Array.isArray(value) || hit.runLength < MAX_IDENTICAL_RUN) {
        // Drop scratch keys or massive synthetic sequence arrays (e.g. SMH 30..277)
        continue;
      }
      // If the failure was an identical repeating run (e.g. same pipe emitted 50+ times),
      // collapse the repeating run and salvage legitimate preceding rows.
      const asText = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)));
      const salvaged: any[] = [];
      for (let i = 0; i < value.length; i++) {
        if (i > 0 && asText[i] === asText[i - 1]) continue;
        salvaged.push(value[i]);
        if (salvaged.length >= 80) break;
      }
      if (salvaged.length > 0 && salvaged.length < MAX_ARRAY_LEN) {
        cleaned[key] = salvaged;
      }
      continue;
    }
    cleaned[key] = value;
  }

  return { cleaned, dropped };
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
    // Dedup by the SAME normalization the metric uses to MATCH structures, so
    // "CBMH 15" / "CBMH15" / "CBMH 15/O.P." collapse to one instead of surviving
    // as 3 predicted structures (over-extraction → precision collapse).
    const key = normalizeLabel(String(mh.description || ''));
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
    // Dedup real runs by ENDPOINT SIGNATURE (order-insensitive, ignores /INS & case) —
    // the same key the metric matches on — so "MH 5-MH 4" and "MH 4-MH 5" collapse to
    // one run instead of both counting (over-extraction → precision collapse). Line-items
    // (VIDEO/LAYOUT/…) have no endpoints, so key them by exact label.
    const sig = sw.isLineItem ? '' : runSignature(String(sw.runLabel || ''));
    const key = sig || String(sw.runLabel || '').trim().toLowerCase();
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

// Merge catchbasin groups across batches by type, taking the MAX quantity per type
// (not the sum) because overlapping tile-batches re-report the same CBs — see the call
// site. Pure + exported so the double-count fix is unit-tested.
export function mergeCatchbasinGroups(groups: any[]): any[] {
  const byType = new Map<string, any>();
  for (const g of groups || []) {
    const key = String(g.type || 'SINGLE_CB');
    const ex = byType.get(key);
    if (ex) {
      ex.quantity = Math.max(ex.quantity || 0, g.quantity || 0);
      ex.wallThickness ??= g.wallThickness;
      ex.depth ??= g.depth;
    } else {
      byType.set(key, { ...g });
    }
  }
  return Array.from(byType.values());
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

export interface WatermainExtractionRaw {
  watermain?: any[];
  watermainSpecials?: any[];
  watermainValves?: any[];
  warnings?: string[];
}

export function parseWatermainFacts(raw: WatermainExtractionRaw): {
  watermain: WatermainFact[];
  watermainSpecials: WatermainSpecialFact[];
  watermainValves: WatermainValveFact[];
  warnings: string[];
} {
  const rawWatermain = (raw.watermain || []).map((w: Record<string, unknown>) => {
    const parsedLen = typeof w.length === 'number' ? w.length : (parseFloat(String(w.length || '')) || 0);
    let parsedDia = typeof w.pipeDiameter === 'number' ? w.pipeDiameter : (parseFloat(String(w.pipeDiameter || '')) || 0);
    if (!parsedDia) {
      const match = String(w.sizeAndType || '').match(/(\d+)\s*(?:mm)?/i);
      if (match) parsedDia = parseFloat(match[1]) || 0;
    }
    return {
      sizeAndType: String(w.sizeAndType || ''),
      length: parsedLen,
      pipeDiameter: snapToPipeDiameter(parsedDia),
      ocSc: Number(w.ocSc) || 1.1,
      avgCover: Number(w.avgCover) || 1.8,
    };
  });

  const dedupedWm = deduplicateWatermain(rawWatermain).filter((w: WatermainFact) => w.length > 0);
  const dedupedSpecials = deduplicateSpecials(raw.watermainSpecials || []).map((sp: Record<string, unknown>) => ({
    specialName: String(sp.specialName || ''),
    quantity: typeof sp.quantity === 'number' ? sp.quantity : (parseInt(String(sp.quantity || ''), 10) || 0),
  })).filter((sp: WatermainSpecialFact) => sp.quantity > 0);

  const dedupedValves = deduplicateValves(raw.watermainValves || []).map((v: Record<string, unknown>) => ({
    valveSize: String(v.valveSize || ''),
    quantity: typeof v.quantity === 'number' ? v.quantity : (parseInt(String(v.quantity || ''), 10) || 0),
  })).filter((v: WatermainValveFact) => v.quantity > 0);

  return {
    watermain: dedupedWm,
    watermainSpecials: dedupedSpecials,
    watermainValves: dedupedValves,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

export function applySecondPassWatermain(
  facts: TakeoffFacts,
  secondPassRaw: WatermainExtractionRaw
): boolean {
  if (facts.watermain && facts.watermain.length > 0) {
    return false;
  }
  const parsed = parseWatermainFacts(secondPassRaw);
  if (parsed.watermain.length > 0) {
    facts.watermain = parsed.watermain;
    facts.watermainSpecials = deduplicateSpecials([
      ...(facts.watermainSpecials || []),
      ...parsed.watermainSpecials,
    ]);
    facts.watermainValves = deduplicateValves([
      ...(facts.watermainValves || []),
      ...parsed.watermainValves,
    ]);
    if (parsed.warnings.length > 0) {
      facts.warnings = [...(facts.warnings || []), ...parsed.warnings];
    }
    console.log(`      [extraction.ts] Two-pass watermain extraction found ${facts.watermain.length} watermain run(s).`);
    return true;
  }
  return false;
}

export async function runSecondPassWatermain(
  facts: TakeoffFacts,
  options: {
    projectName: string;
    sourceHash: string;
    tileBatches: any[][];
    pdfBuffer: Buffer;
    preparePdfPart: (buffer: Buffer) => Promise<any>;
    ai: any;
    cost: CostAcc;
    batchConcurrency?: number;
  }
): Promise<boolean> {
  if (facts.watermain && facts.watermain.length > 0) {
    return false;
  }
  const { projectName, sourceHash, tileBatches, pdfBuffer, preparePdfPart, ai, cost, batchConcurrency = 3 } = options;
  if (!tileBatches || (tileBatches.length === 0 && !pdfBuffer)) {
    return false;
  }

  console.log(`      [extraction.ts] Initial watermain extraction returned 0 runs; running dedicated second pass...`);
  const wmPrompt = getWatermainExtractionPrompt(projectName);
  const batches = tileBatches.length > 0 ? tileBatches : [[]];

  const wmParts = await mapLimit(batches, batchConcurrency, async (batch, bi) => {
    const media = batch.length > 0 ? batch : [await preparePdfPart(pdfBuffer)];
    let text = '{}';
    try {
      text = await getCachedOrCallLLM(`${sourceHash}_watermain_b${bi}of${batches.length}`, wmPrompt, 'watermain', async () => {
        return await callWithRetry(async () => {
          const stream = await ai.models.generateContentStream({
            model: EXTRACTION_MODEL,
            contents: [{ role: 'user', parts: [{ text: wmPrompt }, ...media] }],
            config: {
              temperature: Number(process.env.EXTRACTION_TEMPERATURE || '0'),
              responseMimeType: 'application/json',
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              thinkingConfig: { thinkingBudget: THINKING_BUDGET },
            },
          });
          let acc = '', usage: any = null, finishReason: string | null = null;
          for await (const chunk of stream) {
            acc += chunk.text || '';
            if (chunk.usageMetadata) usage = chunk.usageMetadata;
            const fr = chunk.candidates?.[0]?.finishReason;
            if (fr) finishReason = String(fr);
          }
          addUsage(cost, usage);
          if (finishReason && finishReason !== 'STOP') {
            console.warn(`      [extraction.ts] finishReason=${finishReason} (response hit a limit — output may be truncated).`);
          }
          return acc || '{}';
        });
      }, projectName);
    } catch (e: any) {
      console.error(`      [extraction.ts] Watermain batch ${bi + 1}/${batches.length} failed: ${e.message}`);
      recordCallFailure(`Watermain batch ${bi + 1}/${batches.length}`, e);
    }
    try {
      const parsed = tryParseJSONWithRepair(text);
      const { cleaned, dropped } = stripDegenerateKeys(parsed);
      for (const d of dropped) {
        console.error(
          `      [extraction.ts] Watermain batch ${bi + 1}/${batches.length}: dropped degenerate key "${d.key}" ` +
          `(${d.length} entries, longest identical run ${d.runLength}, e.g. ${JSON.stringify(d.sample)}).`
        );
      }
      return cleaned;
    } catch (e: any) {
      console.error(`      [extraction.ts] Watermain batch ${bi + 1} parse failed: ${e.message}`);
      return {} as any;
    }
  });

  const rawWm: any = { watermain: [], watermainSpecials: [], watermainValves: [], warnings: [] };
  for (const part of wmParts) {
    if (Array.isArray(part.watermain)) rawWm.watermain.push(...part.watermain);
    if (Array.isArray(part.watermainSpecials)) rawWm.watermainSpecials.push(...part.watermainSpecials);
    if (Array.isArray(part.watermainValves)) rawWm.watermainValves.push(...part.watermainValves);
    if (Array.isArray(part.warnings)) rawWm.warnings.push(...part.warnings);
  }

  return applySecondPassWatermain(facts, rawWm);
}


