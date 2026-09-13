# Frontend Redesign Specification: Modern Precision CAD Takeoff Studio

**Date:** 2026-09-13  
**Status:** Approved  
**Scope:** Frontend Architecture, UX/UI, Component Decomposition, Design Tokens  

---

## 1. Overview & Objectives

AutoInfra converts civil-engineering municipal servicing drawing PDFs (Ontario standards) into populated cost-estimating spreadsheets (`.xlsx`) and quote documents (`.pdf`).

The existing frontend in `webapp/src/app/page.tsx` was a monolithic ~762-line file containing the upload flow, benchmark metrics, and all table renders. This redesign accomplishes three core goals:
1. **Visual Refresh:** Transition from the legacy warm drafting-film theme to a high-precision **Modern CAD / Technical Engineering** interface with slate surfaces, hairline borders, domain-colored entity badges (Storm Emerald, Sanitary Amber, Watermain Cyan, Structures Violet), and tabular monospace numerals (`IBM Plex Mono`).
2. **Usability Overhaul:** Replace the flat document output with an interactive **Takeoff Studio** featuring top-level KPI metrics ($ Total, Total Linear Meters, Structure Count), responsive tabbed navigation with live badge tallies, client-side table search/sorting, a multi-step animated pipeline progress indicator, and an interactive telemetry inspector.
3. **Component Architecture:** Decompose the monolithic page into modular, single-responsibility UI primitives and views under `webapp/src/components/`.

---

## 2. Design Tokens & Styling Architecture

The styling is implemented using zero-dependency modern CSS custom properties (`webapp/src/app/globals.css`) supporting both dark and light modes.

### 2.1 Surfaces & Geometry
- **Dark Mode (Default/Technical):**
  - Background Canvas: `#0a0d12`
  - Card/Panel Surface: `#121720`
  - Elevated Surface / Table Header: `#1a2230`
  - Hover Surface: `#212c3d`
  - Hairline Border: `rgba(255, 255, 255, 0.08)`
  - Active Border: `rgba(255, 255, 255, 0.18)`
- **Light Mode:**
  - Background Canvas: `#f4f6f9`
  - Card/Panel Surface: `#ffffff`
  - Elevated Surface: `#f8fafc`
  - Hover Surface: `#edf2f7`
  - Hairline Border: `rgba(0, 0, 0, 0.08)`
  - Active Border: `rgba(0, 0, 0, 0.18)`

### 2.2 Domain Linework & Status Colors
- **Storm Sewers:** `#10b981` (Emerald)
- **Sanitary Sewers:** `#f59e0b` (Amber)
- **Watermain & Appurtenances:** `#0284c7` (Cyan Blue)
- **Maintenance Holes & Structures:** `#8b5cf6` (Violet)
- **Alarm / Error:** `#ef4444` (Red)
- **Success / Validated:** `#22c55e` (Green)
- **Neutral / Muted:** `#64748b` (Slate)

### 2.3 Typography
- **UI Base & Headings:** `IBM Plex Sans` (400, 500, 600)
- **Tabular Figures & Engineering Numbers:** `IBM Plex Mono` (400, 500) with `font-variant-numeric: tabular-nums`
- **Technical Title Blocks & Pills:** `IBM Plex Sans Condensed` (500, 600, 700)

---

## 3. Component Architecture & Directory Structure

```
webapp/src/
├── app/
│   ├── globals.css                # Precision CAD design tokens & styling utilities
│   ├── layout.tsx                 # Root layout with top Navigation Bar
│   ├── page.tsx                   # Main state machine orchestrator (~80 lines)
│   └── settings/page.tsx          # Unit costing rate-table parameters editor
├── components/
│   ├── ui/
│   │   ├── Icons.tsx              # Clean SVG icons (Ruler, Pipe, Manhole, Download, Search, Settings, etc.)
│   │   ├── Badge.tsx              # Domain badges & status chips
│   │   ├── Button.tsx             # Precision technical buttons
│   │   ├── Card.tsx               # Hairline bordered card surfaces
│   │   └── DataTable.tsx          # Generic sortable, searchable data table component
│   ├── layout/
│   │   ├── Navbar.tsx             # Brand header with status indicators & settings link
│   │   └── Footer.tsx             # System status footer
│   ├── upload/
│   │   ├── DropZone.tsx           # Interactive drag & drop zone with file metadata preview
│   │   └── DrawingConfig.tsx      # Extraction mode selector (Default, Transcribe, Hybrid, Vector)
│   ├── benchmark/
│   │   ├── BenchmarkDashboard.tsx # Collapsible golden-set benchmark panel
│   │   ├── EntityMeters.tsx       # Accuracy metric bars (Recall / Precision / detF1)
│   │   └── ProjectScoreCard.tsx   # Individual project test scorecards
│   ├── processing/
│   │   └── ProcessingStages.tsx   # 4-stage pipeline progress animation
│   └── results/
│       ├── TakeoffStudio.tsx      # Master container for results
│       ├── TakeoffHeader.tsx      # Title block, timestamp, and primary export CTAs (XLSX, PDF)
│       ├── TakeoffSummaryBar.tsx  # 4 KPI cards ($ Total, Total Meters, Structures, Valves)
│       ├── TakeoffTabs.tsx        # Tab navigation with entity count badges
│       └── views/
│           ├── StormView.tsx      # Storm sewer runs table
│           ├── SanitaryView.tsx   # Sanitary sewer runs table
│           ├── StructuresView.tsx # Manholes & catchbasins table
│           ├── WatermainView.tsx  # Watermain pipes, fittings & valves tables
│           ├── CostLedgerView.tsx # Detailed cost summary by trade
│           └── TelemetryView.tsx  # LLM token usage, cost, tile budgets & JSON inspector
```

---

## 4. State Management & Data Flow

### 4.1 Page State Machine (`src/app/page.tsx`)
```typescript
type AppState = 'upload' | 'processing' | 'results';
```
- **Upload State:** Renders `DropZone` + `BenchmarkDashboard` (loaded asynchronously via `/api/performance`).
- **Processing State:** Renders `ProcessingStages` tracking pipeline phases while waiting for `/api/process`.
- **Results State:** Receives `ProcessResponse` (`ExtractionResult`, `xlsxBase64`, `quoteBase64`, `facts.cost`) and passes down to `TakeoffStudio`.

### 4.2 Takeoff Studio Internal State (`src/components/results/TakeoffStudio.tsx`)
```typescript
type TakeoffTab = 'summary' | 'storm' | 'sanitary' | 'structures' | 'watermain' | 'telemetry';
```
- Tracks active tab and global search query.
- Manages downloads for `.xlsx` workbook, `.pdf` quote, and raw `.json` takeoff facts.

---

## 5. View Details & Interactive Data Tables

### 5.1 Generic `DataTable` Features
- **Client-Side Search:** Instant filter across all row properties (pipe size, label, material, slope, rim, invert).
- **Column Sorting:** Clickable headers toggle ascending/descending with visual sort arrows.
- **Precision Numeric Alignment:** All monetary, length, slope, and elevation values align right in monospace font.
- **Empty States:** Clear technical indicator when search matches 0 records.

### 5.2 Specific Views
1. **Storm Sewer View (`StormView.tsx`):**
   - Columns: Run ID, Upstream MH, Downstream MH, Size (mm), Material, Length (m), Slope (%), Avg Depth (m), Unit Cost, Total Cost.
2. **Sanitary Sewer View (`SanitaryView.tsx`):**
   - Same format as Storm, tinted with Sanitary Ochre tokens.
3. **Structures View (`StructuresView.tsx`):**
   - Columns: Structure ID, Type (MH / CB / DCB / CBMH), Diameter (mm), Rim Elevation (m), Invert Elevation (m), Depth (m), Benching, Unit Cost, Total Cost.
4. **Watermain View (`WatermainView.tsx`):**
   - Sub-table A: Watermain Pipe Runs (Size, Material, Length, Cost).
   - Sub-table B: Valves, Hydrants & Fittings (Item, Size, Quantity, Valve Cost, Box Cost, Anode Cost, Labor, Total).
5. **Cost Ledger View (`CostLedgerView.tsx`):**
   - Summary breakdown cards + ledger list for Storm, Sanitary, Structures, Watermain, and Grand Total.
6. **Telemetry & Raw Facts (`TelemetryView.tsx`):**
   - Displays extraction mode used, tile count, LLM call count, token usage, cost ($), and formatted syntax-highlighted JSON viewer.

---

## 6. Verification & Quality Plan

1. **Unit & Build Tests:**
   - Execute `npm test` to ensure existing domain unit tests (costing rules, facts matching, spreadsheet generator) remain 100% passing.
   - Run `npm run build` (`tsc --noEmit` and Next.js compiler check) to verify zero TypeScript errors and successful Next.js server-side rendering.
2. **Interactive UI Verification:**
   - Test PDF upload flow with mock/real drawings.
   - Verify all tabs render correct data with working search, sort, and count badges.
   - Verify `.xlsx` and `.pdf` download buttons correctly convert base64 strings to downloadable files.
   - Check responsive layouts across mobile (375px), tablet (768px), and desktop (1280px+).
   - Verify dark and light mode color contrast and typography consistency.
