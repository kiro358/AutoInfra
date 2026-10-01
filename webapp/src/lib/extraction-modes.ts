/**
 * Interpretation paths `extractFromPDF` can take — see CLAUDE.md "Pipeline".
 * Kept in its own dependency-free module so request validation and the browser
 * can import the list without pulling in the whole extraction stack.
 */
export const EXTRACTION_MODES = ['hybrid', 'transcribe', 'single-pass', 'vector'] as const;
export type ExtractionModeId = (typeof EXTRACTION_MODES)[number];
