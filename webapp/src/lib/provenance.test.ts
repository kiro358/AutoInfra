import { describe, it, expect } from 'vitest';
import { verifyStructureProvenance, codeStem } from './provenance';
import { StructureFact } from './types';
import { PageText } from './pdf-text';

const struct = (description: string): StructureFact => ({
  description, topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null,
});

/**
 * A page whose text layer contains `words`. isTextyPage requires >=10 callout-keyword
 * hits, so pad every fixture with real callout text to clear that bar — these tests are
 * about provenance, not about the texty classifier.
 */
const TEXTY_PAD = ['250mm', 'PVC', 'STM', 'INV', '300mm', 'SAN', 'HDPE', 'T/G', 'WM', '450mm', 'STORM'];
const page = (words: string[]): PageText => ({
  page: 1,
  width: 2000,
  height: 1400,
  items: [...words, ...TEXTY_PAD].map((text, i) => ({ text, x: i * 10, y: i * 10, width: 40, height: 8 })),
});

/** A page with effectively no text layer (scanned / SHX linework). */
const scannedPage = (): PageText => ({ page: 1, width: 2000, height: 1400, items: [] });

describe('codeStem', () => {
  it('pulls the code + number out of a plain label', () => {
    expect(codeStem('CBMH 12')).toBe('CBMH12');
    expect(codeStem('DCBMH 14')).toBe('DCBMH14');
    expect(codeStem('MH 2')).toBe('MH2');
  });

  it('ignores an estimator note suffix', () => {
    expect(codeStem('MH 8/EXT.DROP')).toBe('MH8');
    expect(codeStem('MH 1/O.P.')).toBe('MH1');
  });

  it('keeps a trailing letter, which distinguishes a real structure', () => {
    expect(codeStem('MH 1A')).toBe('MH1A');
  });

  it('returns null for a label with no structure code', () => {
    expect(codeStem('TREE REMOVAL (TYP.)')).toBeNull();
    expect(codeStem('SANITARY')).toBeNull();
  });
});

describe('verifyStructureProvenance', () => {
  // The Bradford case: DCBMH 1 and 14 are printed, DCBMH 2..29 are fabricated.
  it('drops coded labels that appear nowhere in the page text', () => {
    const structures = [struct('DCBMH 1'), struct('DCBMH 14'), struct('DCBMH 2'), struct('DCBMH 3')];
    const r = verifyStructureProvenance(structures, [page(['DCBMH', '1', 'DCBMH', '14', 'PLAN'])]);
    expect(r.structures.map((s) => s.description)).toEqual(['DCBMH 1', 'DCBMH 14']);
    expect(r.dropped).toEqual(['DCBMH 2', 'DCBMH 3']);
  });

  it('matches a label split across separate text items', () => {
    const r = verifyStructureProvenance(
      [struct('CBMH 12'), struct('MH 3'), struct('CBMH 99')],
      [page(['CBMH', '12', 'MH', '3', 'MH', '4'])]
    );
    expect(r.structures.map((s) => s.description)).toEqual(['CBMH 12', 'MH 3']);
  });

  it('does not confuse MH 1A with MH 1', () => {
    const r = verifyStructureProvenance(
      [struct('MH 1'), struct('MH 2'), struct('MH 1A')],
      [page(['MH', '1', 'MH', '2', 'MH', '3'])]
    );
    expect(r.dropped).toEqual(['MH 1A']);
  });

  // A naive substring test corroborates "MH 1" from the "MH1" inside "CBMH 12",
  // which would let a fabricated MH sequence ride in on unrelated catchbasin labels.
  it('does not corroborate MH 1 from the MH inside CBMH 12', () => {
    const r = verifyStructureProvenance(
      [struct('CBMH 12'), struct('CBMH 13'), struct('MH 1')],
      [page(['CBMH', '12', 'CBMH', '13'])]
    );
    expect(r.dropped).toEqual(['MH 1']);
  });

  // Likewise "MH 12" must not be corroborated by "MH 120" on the sheet.
  it('does not corroborate a label from a longer number that starts with it', () => {
    const r = verifyStructureProvenance(
      [struct('MH 120'), struct('MH 121'), struct('MH 12')],
      [page(['MH', '120', 'MH', '121'])]
    );
    expect(r.dropped).toEqual(['MH 12']);
  });

  it('matches a hyphenated label printed as CBMH-12', () => {
    const r = verifyStructureProvenance(
      [struct('CBMH 12'), struct('CBMH 13')],
      [page(['CBMH-12', 'CBMH-13'])]
    );
    expect(r.dropped).toEqual([]);
  });

  // Guards. A false drop costs recall, so the check must fail open.
  it('does nothing when there is no text layer at all', () => {
    const structures = [struct('CBMH 1'), struct('CBMH 2')];
    const r = verifyStructureProvenance(structures, [scannedPage()]);
    expect(r.structures).toHaveLength(2);
    expect(r.skipped).toBe('no-text-layer');
  });

  it('does nothing when the text layer carries no structure labels', () => {
    // Title block and notes are real text; the labels themselves are SHX linework.
    const structures = [struct('CBMH 1'), struct('CBMH 2'), struct('MH 7')];
    const r = verifyStructureProvenance(structures, [page(['GENERAL', 'NOTES', 'SCALE', 'DRAWN', 'BY'])]);
    expect(r.structures).toHaveLength(3);
    expect(r.skipped).toBe('labels-not-in-text-layer');
  });

  it('needs more than one corroborated label before it will drop anything', () => {
    const structures = [struct('MH 1'), struct('MH 2'), struct('MH 3')];
    const r = verifyStructureProvenance(structures, [page(['MH', '1', 'NOTES'])]);
    expect(r.structures).toHaveLength(3);
    expect(r.skipped).toBe('labels-not-in-text-layer');
  });

  it('leaves labels without a structure code alone', () => {
    const structures = [struct('MH 1'), struct('MH 2'), struct('OIL GRIT SEPARATOR')];
    const r = verifyStructureProvenance(structures, [page(['MH', '1', 'MH', '2'])]);
    expect(r.structures.map((s) => s.description)).toContain('OIL GRIT SEPARATOR');
  });

  it('only counts pages that have a usable text layer as evidence', () => {
    const structures = [struct('MH 1'), struct('MH 2'), struct('MH 9')];
    const r = verifyStructureProvenance(structures, [scannedPage(), page(['MH', '1', 'MH', '2'])]);
    expect(r.dropped).toEqual(['MH 9']);
  });

  it('keeps everything when every label checks out', () => {
    const structures = [struct('MH 1'), struct('MH 2')];
    const r = verifyStructureProvenance(structures, [page(['MH', '1', 'MH', '2'])]);
    expect(r.structures).toHaveLength(2);
    expect(r.dropped).toEqual([]);
  });
});
