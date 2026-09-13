# Frontend Redesign: Modern Precision CAD Takeoff Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the AutoInfra web frontend from a monolithic 762-line page into a high-precision, dark/light CAD Takeoff Studio with modular components, interactive sortable/searchable data tables, multi-step pipeline progress animation, and an accuracy benchmark dashboard.

**Architecture:** Decompose UI responsibilities into single-purpose components in `webapp/src/components/` (UI primitives, Layout, Upload, Processing, Benchmark, and Results views). Centralize zero-dependency CSS design tokens and CAD styling in `webapp/src/app/globals.css`. Make `page.tsx` a lean state machine controller.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Zero-dependency CSS custom properties, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-frontend-redesign.md`

## Global Constraints
- Primary working directory for webapp files: `webapp/` (or paths prefixed with `webapp/`).
- Zero new external runtime dependencies: use pure CSS tokens and inline SVG icons.
- Must preserve all existing API contracts (`/api/process`, `/api/performance`, `/api/download/:id`).
- Number formatting must use `IBM Plex Mono` with `font-variant-numeric: tabular-nums`.
- Maintain domain color accents: Storm `#10b981`, Sanitary `#f59e0b`, Watermain `#0284c7`, Structures `#8b5cf6`.
- `npm test` and `npm run build` (`next build`) must remain clean with 0 errors.

---

### Task 1: Design Tokens, Typography & Base CSS in `globals.css`

**Files:**
- Modify: `webapp/src/app/globals.css`
- Test: `webapp/src/lib/formatters.test.ts` (test formatting utilities that work with these tokens)

**Interfaces:**
- Produces: CSS variables for surfaces (`--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--bg-hover`), borders (`--border-subtle`, `--border-active`, `--border-hairline`), domain accents (`--storm`, `--sanitary`, `--water`, `--structures`, `--alarm`, `--success`, `--muted`), typography classes (`.font-mono`, `.font-condensed`, `.tabular-nums`), and table utilities.

- [ ] **Step 1: Write formatters and unit tests for numbers, currency, and dimensions**

Create `webapp/src/lib/formatters.ts` and `webapp/src/lib/formatters.test.ts`:

```typescript
// webapp/src/lib/formatters.ts
export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return '$0';
  return '$' + Math.round(amount).toLocaleString('en-US');
}

export function formatNumber(val: number | null | undefined, decimals = 1): string {
  if (val == null || isNaN(val)) return '—';
  return Number(val).toFixed(decimals);
}

export function formatPercent(val: number | null | undefined, decimals = 1): string {
  if (val == null || isNaN(val)) return '—%';
  return (val * 100).toFixed(decimals) + '%';
}

export function formatMeters(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '— m';
  return Number(val).toFixed(1) + ' m';
}

export function formatMm(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '— mm';
  return Math.round(val) + ' mm';
}
```

```typescript
// webapp/src/lib/formatters.test.ts
import { describe, it, expect } from 'vitest';
import { formatCurrency, formatNumber, formatPercent, formatMeters, formatMm } from './formatters';

describe('formatters', () => {
  it('formats currency cleanly without decimals', () => {
    expect(formatCurrency(124500.75)).toBe('$124,501');
    expect(formatCurrency(0)).toBe('$0');
    expect(formatCurrency(null)).toBe('$0');
  });

  it('formats precision numbers and meters', () => {
    expect(formatNumber(12.345, 2)).toBe('12.35');
    expect(formatMeters(45.6)).toBe('45.6 m');
    expect(formatMeters(null)).toBe('— m');
    expect(formatMm(375)).toBe('375 mm');
  });

  it('formats percentages correctly', () => {
    expect(formatPercent(0.485, 1)).toBe('48.5%');
    expect(formatPercent(null)).toBe('—%');
  });
});
```

- [ ] **Step 2: Run test to verify formatters**

Run: `cd webapp && npx vitest run src/lib/formatters.test.ts`
Expected: PASS

- [ ] **Step 3: Update `globals.css` with Modern CAD Slate & Light tokens and component styles**

Write the updated `webapp/src/app/globals.css` with:
- Google Fonts import (`IBM Plex Sans`, `IBM Plex Mono`, `IBM Plex Sans Condensed`).
- Dark/Light root variables (`--bg-canvas`, `--bg-surface`, `--bg-elevated`, `--bg-hover`, `--border-subtle`, `--border-active`, etc.).
- Entity domain accents (`--storm: #10b981; --sanitary: #f59e0b; --water: #0284c7; --structures: #8b5cf6;`).
- CAD grid utilities, buttons, badges, table styling, cards, and animation keyframes.

- [ ] **Step 4: Commit Task 1**

```bash
git add webapp/src/lib/formatters.ts webapp/src/lib/formatters.test.ts webapp/src/app/globals.css
git commit -m "feat(ui): add precision CAD design tokens and formatters"
```

---

### Task 2: Core UI Primitives (`Icons`, `Badge`, `Button`, `Card`, `DataTable`)

**Files:**
- Create: `webapp/src/components/ui/Icons.tsx`
- Create: `webapp/src/components/ui/Badge.tsx`
- Create: `webapp/src/components/ui/Button.tsx`
- Create: `webapp/src/components/ui/Card.tsx`
- Create: `webapp/src/components/ui/DataTable.tsx`
- Test: `webapp/src/lib/table-sort.test.ts` (test client-side search & sorting helper)

**Interfaces:**
- Produces:
  - `<Icon name="..." className="..." />` (ruler, pipe, manhole, water, download, search, check, alert, chevron, refresh, settings, etc.)
  - `<Badge variant="storm" | "sanitary" | "water" | "structures" | "success" | "alarm" | "muted">`
  - `<Button variant="primary" | "secondary" | "outline" | "ghost" size="sm" | "md" | "lg" icon={<Icon />}>`
  - `<Card title="..." subtitle="..." action={...} headerBadge={...}>`
  - `<DataTable columns={...} data={...} searchPlaceholder="..." defaultSortField="..." />`

- [ ] **Step 1: Write table sorting and search filter utility + tests**

Create `webapp/src/lib/table-sort.ts` and `webapp/src/lib/table-sort.test.ts`:

```typescript
// webapp/src/lib/table-sort.ts
export type SortDirection = 'asc' | 'desc';

export function sortData<T>(
  data: T[],
  field: keyof T | ((item: T) => any),
  direction: SortDirection
): T[] {
  return [...data].sort((a, b) => {
    const valA = typeof field === 'function' ? field(a) : a[field];
    const valB = typeof field === 'function' ? field(b) : b[field];

    if (valA == null && valB == null) return 0;
    if (valA == null) return direction === 'asc' ? 1 : -1;
    if (valB == null) return direction === 'asc' ? -1 : 1;

    if (typeof valA === 'number' && typeof valB === 'number') {
      return direction === 'asc' ? valA - valB : valB - valA;
    }

    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();
    return direction === 'asc' ? strA.localeCompare(strB) : strB.localeCompare(strA);
  });
}

export function filterData<T>(data: T[], query: string, searchFields: (keyof T)[]): T[] {
  if (!query.trim()) return data;
  const q = query.toLowerCase().trim();
  return data.filter((item) =>
    searchFields.some((field) => {
      const val = item[field];
      if (val == null) return false;
      return String(val).toLowerCase().includes(q);
    })
  );
}
```

```typescript
// webapp/src/lib/table-sort.test.ts
import { describe, it, expect } from 'vitest';
import { sortData, filterData } from './table-sort';

describe('table-sort', () => {
  const items = [
    { id: 'MH 1', depth: 3.5, size: 1200 },
    { id: 'MH 10', depth: 2.1, size: 1500 },
    { id: 'CB 2', depth: 1.8, size: 600 },
  ];

  it('sorts numbers ascending and descending', () => {
    const asc = sortData(items, 'depth', 'asc');
    expect(asc[0].id).toBe('CB 2');
    expect(asc[2].id).toBe('MH 1');

    const desc = sortData(items, 'depth', 'desc');
    expect(desc[0].id).toBe('MH 1');
    expect(desc[2].id).toBe('CB 2');
  });

  it('filters by multiple search fields', () => {
    const res = filterData(items, 'cb', ['id']);
    expect(res.length).toBe(1);
    expect(res[0].id).toBe('CB 2');
  });
});
```

- [ ] **Step 2: Run test to verify table sorting**

Run: `cd webapp && npx vitest run src/lib/table-sort.test.ts`
Expected: PASS

- [ ] **Step 3: Implement `Icons.tsx`, `Badge.tsx`, `Button.tsx`, `Card.tsx`, and `DataTable.tsx`**

Create:
- `webapp/src/components/ui/Icons.tsx`: SVG paths for all icons with customizable `className` and `size`.
- `webapp/src/components/ui/Badge.tsx`: Tag pill with color tokens and dot indicator.
- `webapp/src/components/ui/Button.tsx`: Button with loading spinner, icon slot, and variants.
- `webapp/src/components/ui/Card.tsx`: Card container with technical header and border styling.
- `webapp/src/components/ui/DataTable.tsx`: Full generic table with search box, sortable `<th>`, empty state, and footer tally.

- [ ] **Step 4: Commit Task 2**

```bash
git add webapp/src/lib/table-sort.ts webapp/src/lib/table-sort.test.ts webapp/src/components/ui/
git commit -m "feat(ui): add core UI primitives and DataTable component"
```

---

### Task 3: Layout Components (`Navbar`, `Footer`) & Root Layout

**Files:**
- Create: `webapp/src/components/layout/Navbar.tsx`
- Create: `webapp/src/components/layout/Footer.tsx`
- Modify: `webapp/src/app/layout.tsx`

**Interfaces:**
- Produces: `<Navbar activeMode="..." onReset={...} />`, `<Footer />`

- [ ] **Step 1: Implement `Navbar.tsx` and `Footer.tsx`**

Create `webapp/src/components/layout/Navbar.tsx`:
- Brand logo: Technical CAD crosshair glyph with "AutoInfra" title and "Ontario Municipal Takeoff Engine" badge.
- Status indicator: Green live engine pill.
- Rates & Settings button linking to `/settings`.

Create `webapp/src/components/layout/Footer.tsx`:
- Engine version, extraction mode indicator, Ontario OPS standard link.

- [ ] **Step 2: Update `webapp/src/app/layout.tsx`**

Integrate `<Navbar />` and `<Footer />` cleanly into the root layout.

- [ ] **Step 3: Commit Task 3**

```bash
git add webapp/src/components/layout/ webapp/src/app/layout.tsx
git commit -m "feat(ui): add Navbar and Footer layout components"
```

---

### Task 4: Upload Flow Components (`DropZone`, `DrawingConfig`)

**Files:**
- Create: `webapp/src/components/upload/DrawingConfig.tsx`
- Create: `webapp/src/components/upload/DropZone.tsx`

**Interfaces:**
- Consumes: `<Button />`, `<Badge />`, `<Icon />`
- Produces: `<DropZone onFileSelected={(file, mode) => void} isUploading={boolean} error={string | null} />`

- [ ] **Step 1: Implement `DrawingConfig.tsx`**

Options to select extraction mode (`default`, `transcribe`, `hybrid`, `vector`) with concise technical descriptions.

- [ ] **Step 2: Implement `DropZone.tsx`**

Features:
- Drag-and-drop listener with active drag state styling.
- File selector button.
- PDF file validation (rejects non-PDFs with clean alert).
- Selected file preview card (filename, file size, remove button).
- "Process Drawing Set" CTA button with rocket/cog icon.
- Advanced settings toggle for `DrawingConfig`.

- [ ] **Step 3: Commit Task 4**

```bash
git add webapp/src/components/upload/
git commit -m "feat(ui): add DropZone and DrawingConfig upload components"
```

---

### Task 5: Processing Animation (`ProcessingStages`)

**Files:**
- Create: `webapp/src/components/processing/ProcessingStages.tsx`

**Interfaces:**
- Consumes: `<Card />`, `<Icon />`
- Produces: `<ProcessingStages fileName={string} extractionMode={string} />`

- [ ] **Step 1: Implement `ProcessingStages.tsx`**

Renders:
1. Stage 1: Page Location & Sheet Filtering
2. Stage 2: Physical Fact Extraction (Linework, Callouts, Elevations)
3. Stage 3: Municipal Cost Rules & Snapping
4. Stage 4: Excel Workbook & Quote PDF Compilation
- Animated timeline with pulsing active step and checkmark on previous steps.
- Live elapsed time counter.

- [ ] **Step 2: Commit Task 5**

```bash
git add webapp/src/components/processing/
git commit -m "feat(ui): add multi-step ProcessingStages animation component"
```

---

### Task 6: Benchmark & Accuracy Components (`BenchmarkDashboard`, `EntityMeters`, `ProjectScoreCard`)

**Files:**
- Create: `webapp/src/components/benchmark/EntityMeters.tsx`
- Create: `webapp/src/components/benchmark/ProjectScoreCard.tsx`
- Create: `webapp/src/components/benchmark/BenchmarkDashboard.tsx`

**Interfaces:**
- Consumes: `PerformanceSummary` from `webapp/src/lib/perf-summary.ts`, `<Card />`, `<Badge />`
- Produces: `<BenchmarkDashboard summary={PerformanceSummary} error={string | null} onRefresh={...} />`

- [ ] **Step 1: Implement `EntityMeters.tsx`**

Renders horizontal accuracy bars for Sewers, Structures, Catchbasins, and Watermain showing Recall, Precision, and detF1 with clean percentages.

- [ ] **Step 2: Implement `ProjectScoreCard.tsx`**

Renders an individual project card with name, detF1 score pill (Strong/Fair/Alarm), entity count badges, and failure warning if 0 entities.

- [ ] **Step 3: Implement `BenchmarkDashboard.tsx`**

Collapsible benchmark panel:
- Grand detF1 KPI figure with status badge.
- Overall metrics: Total test sets, Passing sets, Empty runs.
- Search filter for test projects.
- Grid of `ProjectScoreCard`s.

- [ ] **Step 4: Commit Task 6**

```bash
git add webapp/src/components/benchmark/
git commit -m "feat(ui): add BenchmarkDashboard and EntityMeters components"
```

---

### Task 7: Results View Components (Domain Data Tables)

**Files:**
- Create: `webapp/src/components/results/views/StormView.tsx`
- Create: `webapp/src/components/results/views/SanitaryView.tsx`
- Create: `webapp/src/components/results/views/StructuresView.tsx`
- Create: `webapp/src/components/results/views/WatermainView.tsx`
- Create: `webapp/src/components/results/views/CostLedgerView.tsx`
- Create: `webapp/src/components/results/views/TelemetryView.tsx`

**Interfaces:**
- Consumes: `ExtractionResult` from `webapp/src/lib/types.ts`, `<DataTable />`, formatters.
- Produces: Individual domain tab views.

- [ ] **Step 1: Implement `StormView.tsx` and `SanitaryView.tsx`**

Columns: Run ID, From Structure, To Structure, Size (mm), Material, Length (m), Slope (%), Avg Depth (m), Unit Price, Total Price.
Footer summary: Total linear meters and total sewer cost.

- [ ] **Step 2: Implement `StructuresView.tsx`**

Columns: ID, Type, Size/Dia (mm), Rim Elev (m), Invert Elev (m), Total Depth (m), Benching, Unit Cost, Total Cost.
Footer summary: Total structures count and total structure cost.

- [ ] **Step 3: Implement `WatermainView.tsx`**

Dual sub-tables:
- Table A: Watermain Pipe Runs (Size, Material, Length, Cost).
- Table B: Valves, Hydrants & Fittings (Item ID, Size, Quantity, Valve Cost, Box Cost, Anode Cost, Labor, Total Cost).

- [ ] **Step 4: Implement `CostLedgerView.tsx`**

Grand summary cards by trade (Storm, Sanitary, Structures, Watermain, Appurtenances) + detailed itemized line-item ledger.

- [ ] **Step 5: Implement `TelemetryView.tsx`**

Displays extraction runtime metrics (LLM calls, token count, tile count, cost $) + collapsible syntax-highlighted raw JSON facts viewer with "Copy JSON" button.

- [ ] **Step 6: Commit Task 7**

```bash
git add webapp/src/components/results/views/
git commit -m "feat(ui): add domain data table views for Storm, Sanitary, Structures, Watermain, Ledger, and Telemetry"
```

---

### Task 8: Master Takeoff Studio Container (`TakeoffStudio`, `TakeoffHeader`, `TakeoffSummaryBar`, `TakeoffTabs`)

**Files:**
- Create: `webapp/src/components/results/TakeoffHeader.tsx`
- Create: `webapp/src/components/results/TakeoffSummaryBar.tsx`
- Create: `webapp/src/components/results/TakeoffTabs.tsx`
- Create: `webapp/src/components/results/TakeoffStudio.tsx`

**Interfaces:**
- Consumes: `ExtractionResult`, `ProcessResponse`, and all view components from Task 7.
- Produces: `<TakeoffStudio result={ProcessResponse} onReset={...} />`

- [ ] **Step 1: Implement `TakeoffHeader.tsx` and `TakeoffSummaryBar.tsx`**

- `TakeoffHeader`: Project title block, sheet ID, timestamp, and action buttons ("Download Excel .xlsx", "Export Quote .pdf", "New Takeoff").
- `TakeoffSummaryBar`: 4 prominent KPI cards (Grand Total $, Total Pipe Meters, Total Structures, Total Appurtenances).

- [ ] **Step 2: Implement `TakeoffTabs.tsx`**

Tab bar with active underline indicator and count pills for each tab.

- [ ] **Step 3: Implement `TakeoffStudio.tsx`**

Coordinates active tab state, provides base64 download helpers for `.xlsx` and `.pdf`, and mounts the selected view.

- [ ] **Step 4: Commit Task 8**

```bash
git add webapp/src/components/results/
git commit -m "feat(ui): add TakeoffStudio master container with KPI bar and export actions"
```

---

### Task 9: Rewire `webapp/src/app/page.tsx` as Lean Controller

**Files:**
- Modify: `webapp/src/app/page.tsx`

**Interfaces:**
- Connects `DropZone`, `BenchmarkDashboard`, `ProcessingStages`, and `TakeoffStudio` into a clean state machine (~80-100 lines total).

- [ ] **Step 1: Refactor `page.tsx`**

Replace the 762-line monolithic component with a clean state orchestrator:
- Manages `appState`: `'upload' | 'processing' | 'results'`.
- Handles file upload to `/api/process`.
- Loads benchmark summary from `/api/performance`.
- Renders `DropZone` + `BenchmarkDashboard` when in `'upload'`, `ProcessingStages` when in `'processing'`, and `TakeoffStudio` when in `'results'`.

- [ ] **Step 2: Commit Task 9**

```bash
git add webapp/src/app/page.tsx
git commit -m "refactor(ui): streamline page.tsx into lean state machine controller"
```

---

### Task 10: Restyle Settings Page (`webapp/src/app/settings/page.tsx`)

**Files:**
- Modify: `webapp/src/app/settings/page.tsx`

- [ ] **Step 1: Update Settings Page styling**

Apply the new Card, Button, Badge, and input styling tokens to the rates parameter editor so it matches the CAD aesthetic.

- [ ] **Step 2: Commit Task 10**

```bash
git add webapp/src/app/settings/page.tsx
git commit -m "feat(ui): restyle settings rates editor with modern CAD tokens"
```

---

### Task 11: End-to-End Build & Verification

**Files:**
- All modified and created files.

- [ ] **Step 1: Run unit tests**

Run: `cd webapp && npm test`
Expected: All unit tests PASS with 0 failures.

- [ ] **Step 2: Run TypeScript & Next.js production build**

Run: `cd webapp && npm run build`
Expected: Zero TypeScript errors, successful Next.js compile.

- [ ] **Step 3: Final clean commit**

```bash
git add -A
git commit -m "chore(ui): complete frontend redesign build verification"
```
