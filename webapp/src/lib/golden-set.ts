/**
 * golden-set.ts — single source of truth for the 16-project golden evaluation
 * set and its curated FOCUS_SET subset.
 *
 * Cut verbatim out of evaluate-golden.ts (Task 5) so evaluate-text.ts (the
 * zero-cost text-layer eval) and evaluate-golden.ts (the LLM eval) share one
 * definition instead of drifting. See constants.ts::GOLDEN_PROJECTS for the
 * older, legacy 10-project list — that one stays as-is for its existing
 * consumers; this module is canonical for new code.
 */

// Golden set: 16 curated projects from the dataset manifest — all "usable"
// (standard-template, has runs, has a findable civil drawing, not hand-scoped) and
// not oversize. Stratified across complexity (truth runs 3 -> 89) incl. multi-sheet.
// See build-dataset-manifest.ts. Override count with GOLDEN_REPEATS to average.
export const GOLDEN_PROJECTS = [
  { folder: '2026-067 201 GEORGIAN DR,BARRIE', label: 'Georgian Dr (2/3)' },
  { folder: '2026-020 559 KING FOREST BURLINGTON', label: 'King Forest (5/8)' },
  { folder: '2026-007 17551 WOODBINE AVE.,EAST GWILLIMBURY', label: 'Woodbine Ave (11/12)' },
  { folder: '2026-068 HOLIDAY INN,TRENTON', label: 'Holiday Inn (9/13)' },
  { folder: '2026-009 55 ERIC T. SMITH WAY,AURORA', label: 'Eric Smith Way (11/14)' },
  { folder: '2026-021 MATTHEWS HANGER WATERLOO', label: 'Matthews Hangar (6/17)' },
  { folder: '2026-001 ECOLE SECONDAIRE CATHOLIQUE-BRAMPTON', label: 'Ecole Secondaire (14/19)' },
  { folder: '2026-006 OAKVILLE FIRE HALL 9', label: 'Oakville Fire Hall (10/20)' },
  { folder: '2026-010 NEW ORILLIA E.S', label: 'New Orillia (12/20)' },
  { folder: '2026-002 BRADFORD WEST GWILLIMBURY CIVIC CENTRE', label: 'Bradford Civic (10/21)' },
  { folder: '2026-029 WHITE OAL -12131 WOODBINEAVE', label: 'White Oak Woodbine (19/22)' },
  { folder: '2026-033 MILTON # 13 ELEMENTARY SCHOOL', label: 'Milton #13 (17/27)' },
  { folder: '2026-025 INDUSTRIAL DEVELOPMENT-ULTIMATE DRIVE', label: 'Ultimate Drive (19/29)' },
  { folder: '2026-005 ONTARIO TECH UNIVERSITY STUDENT COMMUNITY BLDG 1A & 1B', label: 'Ontario Tech (25/36)' },
  { folder: '2026-060 PROPOSED COMMERCIAL DEVELOPMENT', label: 'Proposed Commercial (32/56, multi)' },
  { folder: '2026-050 PANATTONI-6500 MISSISSAUGA ROAD', label: 'Panattoni (85/89, multi)' },
];

// Two-tier workflow: iterate on a small FOCUS set fast, then run the full set as a
// regression gate. GOLDEN_FILTER=<substrings> runs an arbitrary subset; GOLDEN_FOCUS=true
// uses the curated focus set (current run-extraction / high-variance problem projects).
export const FOCUS_SET = ['orillia', 'woodbine', 'king forest', 'oakville', 'ultimate', 'ecole', 'white oak', 'matthews'];
