import { describe, it, expect } from 'vitest';
import {
  getPageLocatorPrompt,
  getSinglePassPrompt,
  getWatermainExtractionPrompt,
  getTranscriptionPrompt,
} from './modular-prompts';

describe('modular-prompts', () => {
  describe('getPageLocatorPrompt', () => {
    it('generates a locator prompt with page count', () => {
      const prompt = getPageLocatorPrompt(5);
      expect(prompt).toContain('5-page civil engineering drawing set');
      expect(prompt).toContain('SERVICING TAKEOFF DATA');
    });
  });

  describe('getSinglePassPrompt', () => {
    it('includes project name, pipeScan cap, and watermain instructions', () => {
      const prompt = getSinglePassPrompt('Test Project', 'Rule 1');
      expect(prompt).toContain('Test Project');
      expect(prompt).toContain('Rule 1');
      expect(prompt).toContain('Cap "pipeScan" at 80 distinct callouts');
      expect(prompt).toContain('WATERMAIN SCHEDULE');
      expect(prompt).toContain('DOMESTIC WATER SERVICE');
      expect(prompt).toContain('FIRE SERVICE LEAD');
      expect(prompt).toContain('HYDRANT LEAD');
    });

    it('prohibits pricing in single-pass prompt', () => {
      const prompt = getSinglePassPrompt('Test Project', '');
      expect(prompt).toContain('DO NOT ESTIMATE COSTS');
    });

    it('requires the model designation for proprietary stormwater units', () => {
      const prompt = getSinglePassPrompt('Test Project', '');
      expect(prompt).toContain('PROPRIETARY STORMWATER UNITS & CHAMBERS');
      // Jellyfish designation must survive rather than collapsing to the brand.
      expect(prompt).toContain('"JF 4-1-1"');
      expect(prompt).toContain('NOT "JELLYFISH UNIT"');
      // Vault code + model code printed together -> keep the parenthesised model code.
      expect(prompt).toContain('HATCH JF2000 (JF6-3-1)');
      expect(prompt).toContain('PARENTHESISED model code');
      // Other proprietary families the estimator prices by model.
      expect(prompt).toContain('CULTEC C100HD');
      expect(prompt).toContain('MC-3500');
      expect(prompt).toContain('STC 4000');
      expect(prompt).toContain('DCVC-200');
      // Generic nouns are explicitly banned when a model code is printed.
      expect(prompt).toContain('STORM TANK');
      expect(prompt).toContain('INFILTRATION PIT');
      // Bradford has three distinct Jellyfish units; they must not be merged.
      expect(prompt).toContain('THREE rows, not one');
    });

    it('keeps the anti-repetition and stopping-criteria guards intact', () => {
      const prompt = getSinglePassPrompt('Test Project', '');
      expect(prompt).toContain('STOPPING CRITERIA');
      expect(prompt).toContain('NEVER generate synthetic counting sequences');
      expect(prompt).toContain('NEVER emit duplicate or repeating identical copies');
    });

    it('adds no pricing language alongside the proprietary-unit guidance', () => {
      const prompt = getSinglePassPrompt('Test Project', '');
      const unitSection = prompt.slice(
        prompt.indexOf('PROPRIETARY STORMWATER UNITS'),
        prompt.indexOf('## CATCHBASINS'),
      );
      expect(unitSection.length).toBeGreaterThan(0);
      // "priced by MODEL code" is a naming rule, not a request for dollars: assert no
      // currency/rate vocabulary leaked into the facts-only prompt.
      expect(unitSection).not.toMatch(/\$|\bunit (?:price|rate|cost)\b|\bsupply cost\b/i);
    });
  });

  describe('getWatermainExtractionPrompt', () => {
    it('generates a focused watermain extraction prompt', () => {
      const prompt = getWatermainExtractionPrompt('Watermain Site');
      expect(prompt).toContain('Watermain Site');
      expect(prompt).toContain('WATERMAIN FACTS ONLY');
      expect(prompt).toContain('WATERMAIN SCHEDULE');
      expect(prompt).toContain('DOMESTIC WATER SERVICE');
      expect(prompt).toContain('FIRE SERVICE LEAD');
      expect(prompt).toContain('HYDRANT LEAD');
      expect(prompt).toContain('DO NOT ESTIMATE COSTS');
    });
  });

  describe('getTranscriptionPrompt', () => {
    it('generates transcription prompt with tile counts', () => {
      const prompt = getTranscriptionPrompt(16, 0);
      expect(prompt).toContain('16 image tiles');
      expect(prompt).toContain('TRANSCRIBE, DO NOT INTERPRET');
    });

    it('lists proprietary unit callouts as a transcribable annotation kind', () => {
      const prompt = getTranscriptionPrompt(16, 0);
      // The kinds list is a closed whitelist, so unit callouts must be named
      // explicitly or they get skipped entirely.
      expect(prompt).toContain('Proprietary stormwater unit / chamber callouts');
      expect(prompt).toContain('PROPOSED JELLYFISH JF4-1-1 UNIT');
      expect(prompt).toContain('HATCH JF2000 (JF6-3-1)');
      expect(prompt).toContain('CULTEC C100HD CHAMBER ROW');
      expect(prompt).toContain('ADS STORMTECH MC-3500 CHAMBER');
      // Verbatim transcription already prevents collapse; the guard must stay.
      expect(prompt).toContain('VERBATIM');
    });
  });
});
