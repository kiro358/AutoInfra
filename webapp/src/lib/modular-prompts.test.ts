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
  });
});
