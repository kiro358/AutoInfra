/**
 * page-classifier.ts — the recorded page classifier (PR47 Phase 0).
 *
 * The conventions study (pdf_schedule_conventions.md) found the corpus is
 * not one kind of input: 135 located pages across 26 projects fall into
 * six page kinds (P1–P6) and a set of convention families whose global
 * rules kept vetoing each other. The routing design's first phase is
 * therefore a SUBSTRATE, not a router: classify every located page from
 * routing-time signals only, RECORD the classification in the run's
 * diagnostics, and dispatch nothing on it. This module is the classifier.
 * It is pure (signals in, classification out) so the same rule that runs
 * in production diagnostics also runs over the golden corpus and the
 * holdouts offline.
 *
 * The kind rule mirrors the study's §1a signatures, which were themselves
 * assigned by a deterministic rule over these same signals:
 *   P1 texty, elevations present — the generalist's home turf
 *   P2 annotation form present, texty density not met — union-admissible
 *   P3 texty but elevationItems == 0 at keywordHits >= 50 — PARTIAL layer
 *   P4 items < 30 and chars < 600, neither texty nor annotation-form
 *   P5 the rest of the text-bearing pages — details / notes / spec
 *   P6 no text items at all — raster-scan
 *
 * Family tags follow §2.2's detector sketches, restricted to what is
 * determinable from routing-time signals TODAY: `partial-layer` (the
 * PR46 dual-read conjunction — claimed only when every conjunct,
 * including the drawn-content count, was measured), `drawn-schedule`
 * (suspect under a claimed partial-layer; its confirmation lives in the
 * transcript, which is the drawn-schedule specialist's own detector,
 * not the page classifier's), and `shx-dialect` (the page's text needed
 * symbol-font decoding — PageText.symbolFontItems). Families whose
 * detectors need assembly- or transcript-side evidence (detached-
 * elevation, enumeration-scope, value-first, label-dialect, wm-table,
 * profile-band, rotated-callout) are claimed by their specialists' own
 * firing records in diagnostics, not here.
 *
 * Confidence tiers: 'claimed' means the full signature was MEASURED;
 * 'suspect' means a deciding signal was unmeasured or the page sits on
 * a boundary. Suspect dispatches nothing — by design, in every phase.
 */
import type { FamilyTag, PageClassification, PageClassificationSignals, PageKind } from './types';

/** One page's routing-time signals — PageClassificationSignals plus
 *  the page number. Callers assemble these from what the run actually
 *  computed (see extraction.ts attachDiagnostics); unmeasured = null. */
export interface PageSignalInput extends PageClassificationSignals {
  page: number;
}

/** The partial-layer family's annotation-density conjunct — the same
 *  value as PR46's DUAL_READ_MIN_KEYWORD_HITS (extraction.ts). Kept as
 *  a local mirror so this module stays dependency-free (extraction.ts
 *  imports this module's consumers; a cycle would invert that). */
export const PARTIAL_LAYER_MIN_KEYWORD_HITS = 50;
/** The partial-layer family's drawn-content conjunct — the same value
 *  as PR46's DUAL_READ_MIN_PATH_OPS (extraction.ts). */
export const PARTIAL_LAYER_MIN_PATH_OPS = 10_000;

type Tier = 'claimed' | 'suspect';

export function classifyPage(input: PageSignalInput): PageClassification {
  const { items, chars, texty, annotationForm, soloYield, soloRunYield, elevationItems, keywordHits, pathOps, imageOps, symbolFontItems } = input;

  let kind: PageKind;
  let kindTier: Tier;
  if (items === 0) {
    // No text layer at all: a scan (image measured) or an unmeasured
    // blank — the kind is P6 either way, the tier carries the doubt.
    kind = 'P6';
    kindTier = imageOps != null && imageOps >= 1 ? 'claimed' : 'suspect';
  } else if (items == null) {
    // The run never extracted this page's text (no PageText): chars from
    // the page diagnostics are all that separates a text-bearing page
    // from a raster one, and neither can be claimed on that alone.
    kind = chars != null && chars > 0 ? 'P5' : 'P6';
    kindTier = 'suspect';
  } else if (texty === true) {
    if (elevationItems === 0 && keywordHits != null && keywordHits >= PARTIAL_LAYER_MIN_KEYWORD_HITS) {
      // The partial-layer signature on its face: the layer carries the
      // plan's annotation set but not one elevation value.
      kind = 'P3';
      kindTier = 'claimed';
    } else if (elevationItems === 0) {
      // Zero elevation items but the density conjunct unproven (keyword
      // hits unmeasured or under the bar): the layer may be partial, the
      // evidence is not there — P1 by elimination, tier suspect.
      kind = 'P1';
      kindTier = 'suspect';
    } else {
      kind = 'P1';
      // Claimed when the page provably bears (solo yields) or provably
      // carries elevations; suspect when neither was measured.
      kindTier =
        (soloYield != null && soloYield >= 1 && soloRunYield != null && soloRunYield >= 1) ||
        (elevationItems != null && elevationItems >= 1)
          ? 'claimed'
          : 'suspect';
    }
  } else if (annotationForm === true) {
    // Annotation-shaped text under the texty density bar. (Also reached
    // when the texty verdict itself was unmeasured — then the tier
    // carries the doubt.)
    kind = 'P2';
    kindTier = texty === false ? 'claimed' : 'suspect';
  } else if (items < 30 && chars != null && chars < 600) {
    kind = 'P4';
    kindTier = texty === false && annotationForm === false ? 'claimed' : 'suspect';
  } else {
    kind = 'P5';
    kindTier = items >= 30 && texty === false && annotationForm === false ? 'claimed' : 'suspect';
  }

  const families: FamilyTag[] = [];

  // partial-layer: the PR46 conjunction. Claimed only when every
  // conjunct was measured and holds — solo bearing (yield >= 1 WITH a
  // pipe run), zero elevation items, keyword density, drawn content.
  const partialSignature =
    texty === true && elevationItems === 0 && keywordHits != null && keywordHits >= PARTIAL_LAYER_MIN_KEYWORD_HITS;
  if (partialSignature) {
    const bearing = soloYield != null && soloYield >= 1 && soloRunYield != null && soloRunYield >= 1;
    const claimed =
      bearing && pathOps != null && pathOps >= PARTIAL_LAYER_MIN_PATH_OPS;
    families.push({ tag: 'partial-layer', tier: claimed ? 'claimed' : 'suspect' });
    if (claimed) {
      // A claimed partial layer is where a drawn schedule can hide; the
      // schedule itself is confirmed from transcript rows by the
      // drawn-schedule specialist's detector, so here it stays suspect.
      families.push({ tag: 'drawn-schedule', tier: 'suspect' });
    }
  }

  // shx-dialect: the page's own items needed symbol-font decoding.
  if (symbolFontItems != null && symbolFontItems >= 2) {
    families.push({ tag: 'shx-dialect', tier: 'claimed' });
  } else if (symbolFontItems === 1) {
    families.push({ tag: 'shx-dialect', tier: 'suspect' });
  }

  return {
    page: input.page,
    kind,
    kindTier,
    families,
    signals: {
      items, chars, texty, annotationForm, soloYield, soloRunYield,
      elevationItems, keywordHits, pathOps, imageOps, symbolFontItems,
    },
  };
}

export function classifyPages(inputs: PageSignalInput[]): PageClassification[] {
  return inputs.map(classifyPage);
}
