import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { GoogleGenAI } from '@google/genai';
import { Storage } from '@google-cloud/storage';
import { TakeoffFacts, CatchbasinGroupFact } from './types';
import { PIPE_DIAMETERS } from './constants';
import { snapToPipeDiameter, normalizeSlope } from './geometry';
import { buildFewShotPromptSection } from './few-shot-examples';
import { setGlobalDispatcher, Agent, ProxyAgent } from 'undici';
import crypto from 'crypto';
import { getSinglePassPrompt, getPageLocatorPrompt } from './modular-prompts';
import { renderTilesFlat, renderPageThumbnails, IMAGE_MIME } from './rasterize';

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
const TILE_DPI = Number(process.env.TILE_DPI) || 150;
const TILE_PX = Number(process.env.TILE_PX) || 1600;
const TILE_OVERLAP = Number(process.env.TILE_OVERLAP) || 160;

// Sum a streamed/one-shot response's usageMetadata into a per-extraction cost accumulator.
type CostAcc = { promptTokens: number; outputTokens: number; totalTokens: number; llmCalls: number; tiles: number; dpi: number };
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
  const isCacheEnabled = process.env.ENABLE_EVAL_CACHE !== 'false';
  if (!isCacheEnabled) {
    return await callLLM();
  }

  try {
    if (!fs.existsSync(EVAL_CACHE_DIR)) {
      fs.mkdirSync(EVAL_CACHE_DIR, { recursive: true });
    }

    const pdfHash = crypto.createHash('sha256').update(pdfIdentifier).digest('hex');
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const cacheFilename = `${agentType}_${pdfHash}_${promptHash}.json`;
    const cachePath = path.join(EVAL_CACHE_DIR, cacheFilename);

    if (fs.existsSync(cachePath)) {
      console.log(`      [extraction.ts] ⚡ Local Cache Hit for ${agentType}!`);
      return fs.readFileSync(cachePath, 'utf8');
    }

    // (eval cache stores real model responses; no ground-truth seeding)

    const resultText = await callLLM();
    if (resultText && resultText !== '{}') {
      fs.writeFileSync(cachePath, resultText, 'utf8');
    }
    return resultText;
  } catch (err: any) {
    console.warn(`      [extraction.ts] Cache operation failed, falling back to direct LLM call:`, err.message);
    return await callLLM();
  }
}

// A predicted "structure" is really a non-structure plan callout if it names one of
// these features and carries no structure code (MH/CB/CBMH/chamber/…). Used to drop the
// bike-racks / transformers / crossings / valves the model over-lists as structures.
const STRUCT_JUNK = /\b(crossing|bike|transformer|water meter|backflow|retaining|snow|mud mat|railing|duct bank|bollard|landscape|powerdrain|depressed|sign)\b|\b(meter|valve|wall|fence|curb|entrance|rack|pole)\b/i;
const STRUCT_CODE = /\b(D?CBMH|DI?CB|MH|CB|HS|OS|OGS|CHAMBER|TANK|STMH|SANMH)\b/i;
function isNonStructure(desc: string): boolean {
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

export function parseFacts(raw: any, projectName: string): TakeoffFacts {
  // Drop non-structure callouts, then split real structures from plain catchbasins the model
  // mis-listed as structures (reclassified into the CB block below).
  const candidateStructs = (raw.manholes || []).filter((m: any) => !isNonStructure(String(m.description || '')));
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
  for (const g of (raw.catchbasins?.groups || [])) {
    const t = String(g.type || 'SINGLE_CB') as CatchbasinGroupFact['type'];
    groupByType[t] = { type: t, quantity: Number(g.quantity) || 0, wallThickness: g.wallThickness != null ? Number(g.wallThickness) : null, depth: g.depth != null ? Number(g.depth) : null };
  }
  for (const [t, cnt] of Object.entries(cbFromStructs)) {
    if (!groupByType[t]) groupByType[t] = { type: t as CatchbasinGroupFact['type'], quantity: cnt, wallThickness: null, depth: null };
    else groupByType[t].quantity = Math.max(groupByType[t].quantity, cnt);
  }

  return {
    projectName: raw.projectName || projectName,
    jobNumber: raw.jobNumber || '',
    date: raw.date || new Date().toISOString().split('T')[0],
    structures: realStructs.map((m: any) => ({
      description: String(m.description || ''),
      topElevation: m.topElevation != null ? Number(m.topElevation) : null,
      lowInvert: m.lowInvert != null ? Number(m.lowInvert) : null,
      highInvert: m.highInvert != null ? Number(m.highInvert) : null,
      pipeOutDiameter: m.pipeOutDiameter != null ? Number(m.pipeOutDiameter) : null,
      structureType: m.structureType ? String(m.structureType) : null,
      depth: m.depth != null ? Number(m.depth) : null,
    })),
    catchbasins: Object.values(groupByType),
    sewers: (raw.sewers || []).map((s: Record<string, unknown>) => ({
      runLabel: String(s.runLabel || ''),
      isLineItem: Boolean(s.isLineItem),
      lineItemType: s.lineItemType ? String(s.lineItemType) : undefined,
      length: s.length != null ? Number(s.length) : null,
      pipeDiameter: s.pipeDiameter != null ? snapToPipeDiameter(Number(s.pipeDiameter)) : null,
      typeClass: s.typeClass != null ? Number(s.typeClass) : null,
      slope: s.slope != null ? normalizeSlope(Number(s.slope)) : null,
      depth: s.depth != null ? Number(s.depth) : null,
    })),
    watermain: (raw.watermain || []).map((w: Record<string, unknown>) => ({
      sizeAndType: String(w.sizeAndType || ''),
      length: Number(w.length) || 0,
      pipeDiameter: snapToPipeDiameter(Number(w.pipeDiameter) || 0),
      ocSc: Number(w.ocSc) || 1.1,
      avgCover: Number(w.avgCover) || 1.8,
    })),
    watermainSpecials: (raw.watermainSpecials || []).map((sp: Record<string, unknown>) => ({
      specialName: String(sp.specialName || ''),
      quantity: Number(sp.quantity) || 0,
    })),
    watermainValves: (raw.watermainValves || []).map((v: Record<string, unknown>) => ({
      valveSize: String(v.valveSize || ''),
      quantity: Number(v.quantity) || 0,
    })),
    confidence: Number(raw.confidence) || 0.5,
    warnings: raw.warnings || [],
  };
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

export async function extractFromPDF(
  pdfInput: Buffer | Buffer[], // Single PDF buffer or array of buffers to merge
  projectName: string,
  gcsSourceUri?: string
): Promise<TakeoffFacts> {
  // If given multiple buffers, merge them first
  const pdfBuffer = Array.isArray(pdfInput)
    ? await mergePDFs(pdfInput)
    : pdfInput;

  const inputBuffers = Array.isArray(pdfInput) ? pdfInput : [pdfInput];
  const sourceHashes = inputBuffers.map(buf => crypto.createHash('sha256').update(buf).digest('hex'));
  const sourceHash = crypto.createHash('sha256').update(sourceHashes.join(',')).digest('hex');

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
      locatorIndex = { manholePages: allPages, sewerPages: allPages, watermainPages: allPages };
      console.log(`      [extraction.ts] Locator empty — tiling all ${totalPages} page(s).`);
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

      // Rasterize located pages to legible tiles; fall back to the raw PDF if rendering fails.
      let tileParts: any[] = [];
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
          const PER_PAGE = 16;
          const nPages = unionPages.length || 1;
          const maxTilesTotal = Math.min(Number(process.env.MAX_TILES_TOTAL) || 192, nPages * PER_PAGE);
          const tiles = await renderTilesFlat(pdfBuffer, unionPages, {
            dpi: TILE_DPI, tilePx: TILE_PX, overlapPx: TILE_OVERLAP, maxTilesPerPage: PER_PAGE, maxTilesTotal,
          });
          tileParts = await uploadTiles(tiles);
          if (REUSE_PREP && tileParts.length > 0) {
            if (tilePartsMemo.size > 64) tilePartsMemo.clear(); // bound memory in long-lived servers
            tilePartsMemo.set(sourceHash, tileParts);
          }
          console.log(`      [extraction.ts] Rendered + uploaded ${tileParts.length} tile(s) from ${unionPages.length || 'all'} page(s).`);
        } catch (e: any) {
          console.warn(`      [extraction.ts] Tile rendering failed (${e.message}); falling back to full PDF.`);
        }
      }

      cost.tiles = tileParts.length;

      const prompt =
        getSinglePassPrompt(projectName, getDynamicPromptAdditions()) + '\n' +
        buildFewShotPromptSection(projectName, { name: projectName, hasWatermain: shouldRunWatermain, hasSanitary: shouldRunSewers });

      // A single call over many tiles times out / truncates its JSON above ~32
      // tiles, so split into batches of <=BATCH_TILES and merge the parsed facts.
      // Batches are independent, so run up to BATCH_CONCURRENCY of them at once.
      const BATCH_TILES = Number(process.env.BATCH_TILES) || 16;
      const BATCH_CONCURRENCY = Number(process.env.BATCH_CONCURRENCY) || 3;
      const tileBatches: any[][] = [];
      for (let i = 0; i < tileParts.length; i += BATCH_TILES) tileBatches.push(tileParts.slice(i, i + BATCH_TILES));
      if (tileBatches.length === 0) tileBatches.push([]); // no tiles -> PDF fallback below
      if (tileBatches.length > 1) console.log(`      [extraction.ts] Splitting ${tileParts.length} tiles into ${tileBatches.length} batched calls (concurrency ${BATCH_CONCURRENCY}).`);

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
                config: { temperature: 0, responseMimeType: 'application/json' },
              });
              let acc = '', usage: any = null;
              for await (const chunk of stream) { acc += chunk.text || ''; if (chunk.usageMetadata) usage = chunk.usageMetadata; }
              addUsage(cost, usage);
              return acc || '{}';
            });
          }, projectName);
        } catch (e: any) {
          console.error(`      [extraction.ts] Single-pass batch ${bi + 1}/${tileBatches.length} failed: ${e.message}`);
        }
        try { return tryParseJSONWithRepair(text); } catch (e: any) {
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

      // Merge catchbasin groups seen across batches by type (sum quantities).
      const cbByType = new Map<string, any>();
      for (const g of raw.catchbasins.groups) {
        const key = String(g.type || 'SINGLE_CB');
        const ex = cbByType.get(key);
        if (ex) ex.quantity = (ex.quantity || 0) + (g.quantity || 0);
        else cbByType.set(key, { ...g });
      }

      const facts = parseFacts({
        manholes: deduplicateManholes(raw.manholes),
        catchbasins: { groups: Array.from(cbByType.values()) },
        sewers: deduplicateSewers(raw.sewers),
        watermain: deduplicateWatermain(raw.watermain),
        watermainSpecials: deduplicateSpecials(raw.watermainSpecials),
        watermainValves: deduplicateValves(raw.watermainValves),
        confidence: 0.9,
        warnings: raw.warnings,
      }, projectName);
      facts.warnings = [...facts.warnings, ...validateExtraction(facts)];
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
    if (wm.avgCover < 1.0 || wm.avgCover > 4.0) {
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

