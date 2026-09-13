import { describe, it, expect } from 'vitest';
import { EXTRACTION_MODES } from './DrawingConfig';

describe('DrawingConfig extraction modes', () => {
  it('defines all 4 required extraction pipeline modes', () => {
    const modeIds = EXTRACTION_MODES.map((m) => m.id);
    expect(modeIds).toEqual(['default', 'transcribe', 'hybrid', 'vector']);
  });

  it('sets default mode as recommended with standard storm badge', () => {
    const defaultMode = EXTRACTION_MODES.find((m) => m.id === 'default');
    expect(defaultMode).toBeDefined();
    expect(defaultMode?.recommended).toBe(true);
    expect(defaultMode?.badgeVariant).toBe('storm');
    expect(defaultMode?.badge).toBe('Standard');
  });

  it('assigns Ontario domain linework badge variants to extraction options', () => {
    const transcribeMode = EXTRACTION_MODES.find((m) => m.id === 'transcribe');
    expect(transcribeMode?.badgeVariant).toBe('sanitary');
    expect(transcribeMode?.badge).toBe('Precision');

    const hybridMode = EXTRACTION_MODES.find((m) => m.id === 'hybrid');
    expect(hybridMode?.badgeVariant).toBe('water');
    expect(hybridMode?.badge).toBe('Fast');

    const vectorMode = EXTRACTION_MODES.find((m) => m.id === 'vector');
    expect(vectorMode?.badgeVariant).toBe('structures');
    expect(vectorMode?.badge).toBe('Deterministic');
  });

  it('provides non-empty descriptions and names for all modes', () => {
    for (const mode of EXTRACTION_MODES) {
      expect(mode.name.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(0);
      expect(mode.icon).toBeDefined();
    }
  });
});
