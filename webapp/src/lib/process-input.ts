/**
 * Validation for POST /api/process. Pure (no I/O) so every rule is unit-tested.
 *
 * Everything that reaches the extraction pipeline from the browser passes through
 * here: the PDF itself, the extraction mode, and the unit-rate overrides from the
 * Settings page. Anything unexpected is rejected with a message a user can act on,
 * rather than surfacing later as a 500 from deep inside extraction.
 */
import { DEFAULT_PARAMS } from './constants';
import { EXTRACTION_MODES, type ExtractionModeId } from './extraction-modes';
import type { GlobalParams } from './types';

/**
 * Cloud Run rejects request bodies over 32 MiB before they reach the app, so
 * anything larger can never be processed — say so up front with a clear message.
 */
export const MAX_PDF_BYTES = 30 * 1024 * 1024;

export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

/** A real PDF starts with `%PDF-` (allowing a little leading junk, per the spec). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

export function validatePdf(bytes: Uint8Array, fileName: string): void {
  if (bytes.byteLength === 0) {
    throw new InputError(`"${fileName}" is empty.`);
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    throw new InputError(
      `"${fileName}" is ${mb} MB; the limit is ${MAX_PDF_BYTES / 1024 / 1024} MB. ` +
        'Upload only the servicing sheets, or compress the PDF.',
      413
    );
  }
  if (!looksLikePdf(bytes)) {
    throw new InputError(`"${fileName}" is not a PDF file.`);
  }
}

/** `null`/empty → server default. Anything else must be a known mode id. */
export function parseMode(raw: unknown): ExtractionModeId | undefined {
  if (raw == null || raw === '' || raw === 'default') return undefined;
  if (typeof raw === 'string' && (EXTRACTION_MODES as readonly string[]).includes(raw)) {
    return raw as ExtractionModeId;
  }
  throw new InputError(
    `Unknown extraction mode "${String(raw)}". Expected one of: ${EXTRACTION_MODES.join(', ')}.`
  );
}

type Section = keyof typeof DEFAULT_PARAMS;
const SECTIONS = Object.keys(DEFAULT_PARAMS) as Section[];

/**
 * Merge unit-rate overrides onto DEFAULT_PARAMS.
 *
 * Only keys that already exist in DEFAULT_PARAMS are accepted, and only when the
 * default is a number and the override is a finite, non-negative number. That
 * blocks prototype-pollution keys (`__proto__`), typos that would silently do
 * nothing, and strings/NaN that would poison every downstream formula.
 */
export function parseParams(raw: unknown): GlobalParams {
  const params = structuredClone(DEFAULT_PARAMS) as unknown as Record<
    Section,
    Record<string, unknown>
  >;
  if (raw == null || raw === '') return params as unknown as GlobalParams;

  let overrides: unknown;
  try {
    overrides = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new InputError('Unit-rate settings are not valid JSON. Reset them on the Unit rates page.');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new InputError('Unit-rate settings must be an object.');
  }

  for (const section of SECTIONS) {
    const incoming = (overrides as Record<string, unknown>)[section];
    if (incoming == null) continue;
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new InputError(`Unit-rate section "${section}" must be an object.`);
    }
    const defaults = DEFAULT_PARAMS[section] as Record<string, unknown>;
    for (const [key, value] of Object.entries(incoming)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue; // stale/unknown key
      if (typeof defaults[key] !== 'number') continue; // only numeric rates are user-editable
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        throw new InputError(`Unit rate ${section}.${key} must be a non-negative number.`);
      }
      params[section][key] = n;
    }
  }
  return params as unknown as GlobalParams;
}

/** Project names end up in file names and the quote header — keep them sane. */
export function parseProjectName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f]/g, '').trim() : '';
  return (name || 'Untitled Project').slice(0, 120);
}
