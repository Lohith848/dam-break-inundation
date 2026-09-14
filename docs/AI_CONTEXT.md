# Dam Break Inundation Modelling (SIH26161) — Project Context & Changelog for AI

> **Purpose**: This document serves as a complete, authoritative context file for AI assistants and engineers. It details what has been built, all codebase modifications, bugs and errors encountered along with their fixes, technical contracts, directory structure, and operational instructions.

---

## 1. Project Overview & Problem Statement

* **Challenge ID**: SIH26161
* **Objective**: Rapid, physics-informed dam break flood wave inundation modeling to determine breach outflow hydrographs, downstream arrival times, maximum flood water depths, and population risk evacuation priorities.
* **Core Technology Stack**:
  * **Backend**: Python 3, FastAPI, NumPy, SciPy, Pillow / Rasterio.
  * **Hydraulics & Solvers**:
    * Empirical Dam Breach Equations (Froehlich 1995 / 2008 regressions for breach width $B$, failure formation time $T_f$, and peak discharge $Q_p$).
    * 2D Diffusive-Wave Hydrodynamic Routing Solver with adaptive Courant-Friedrichs-Lewy (CFL) time-stepping and mass-conserving limiters.
  * **Frontend**: Vanilla JavaScript (ES6+), Three.js (WebGL 3D terrain rendering), Leaflet (2D GIS geospatial mapping), Modular CSS design system (Enterprise Neutral Slate).
  * **Design Standard**: Clean, minimal, enterprise-grade interface inspired by Linear, Stripe Dashboard, and Vercel. **Strictly 0 emojis, 0 decorative gradients, and 0 visual clutter**.

---

## 2. Directory Structure & Path Conventions

> **CRITICAL PATH NOTICE**:
> The workspace root is `c:\Users\Lohith G\Downloads\SIH26161\`.
> The project codebase is located inside the subfolder: `dam-break-inundation\`.
> Attempting to run `cd backend` directly from the workspace root will fail with `Cannot find path 'backend'`. You must first navigate into `dam-break-inundation`.

### Complete Tree:
```
c:\Users\Lohith G\Downloads\SIH26161\
├── AI_CONTEXT.md                           <-- Root AI context document
├── PROBLEMSTATEMENTS.pdf                   <-- Official SIH problem statements
├── SIH2025-IDEA-Presentation-Format.pdf    <-- Presentation deck template
├── .agents\                                <-- Agent workflows & rules
│   ├── rules\graphify.md
│   └── workflows\graphify.md
├── graphify-out\                           <-- Graphify knowledge graph
│   ├── graph.json                          <-- Full AST & dependency graph
│   ├── graph.html                          <-- Interactive visual knowledge graph
│   └── GRAPH_REPORT.md                     <-- Architecture summary report
├── datasets\                               <-- Root mirror of clean GIS data
└── dam-break-inundation\                   <-- MAIN PROJECT REPOSITORY
    ├── AI_CONTEXT.md                       <-- Project AI context document
    ├── PRODUCT.md                          <-- Product requirements & user personas
    ├── DESIGN.md                           <-- Design system tokens & typography
    ├── README.md                           <-- Project quickstart guide
    ├── backend\
    │   ├── requirements.txt
    │   ├── app\
    │   │   ├── __init__.py
    │   │   ├── main.py                     <-- FastAPI endpoints & static hosting
    │   │   ├── breach.py                   <-- Froehlich breach regressions
    │   │   ├── routing.py                  <-- 2D diffusive wave hydrodynamic solver
    │   │   ├── dem.py                      <-- DEM generation & GeoTIFF loaders
    │   │   ├── risk.py                     <-- Village impact & risk assessment
    │   │   └── test_simulation.py          <-- Unit & regression tests
    │   └── tests\
    │       ├── test_breach.py              <-- Breach equation unit tests
    │       └── test_routing.py             <-- 2D routing solver tests
    ├── frontend\
    │   ├── index.html                      <-- Enterprise UI layout
    │   ├── style.css                       <-- Neutral Slate CSS design system
    │   ├── three_viewer.js                 <-- Three.js 3D WebGL flood engine
    │   ├── app.js                          <-- Frontend controller & API orchestrator
    │   ├── package.json                    <-- Frontend npm & Vite scripts
    │   └── package-lock.json
    ├── sample_data\
    │   └── sample_result.json              <-- Calibrated offline demo payload
    ├── datasets\                           <-- Mettur Dam calibrated GIS data (clean)
    │   ├── README.md
    │   ├── dem\mettur_dem.tif              <-- Float32 elevation raster (EPSG:4326)
    │   ├── river\mettur_river.geojson      <-- Cauvery river centerline LineString
    │   ├── villages\villages.geojson       <-- 10 downstream settlement POIs
    │   ├── dam\mettur_parameters.csv       <-- Stanley Reservoir hydraulic parameters
    │   ├── satellite\sentinel.tif          <-- 3-band RGB visual basemap
    │   └── population\worldpop.tif         <-- Population density raster
    ├── docs\
    │   ├── DATASETS.md                     <-- Dataset sources & specifications
    │   ├── SYSTEM_DESIGN.md                <-- Architecture diagrams & flowcharts
    │   └── references\                     <-- Literature & technical reference documents
    │       ├── NRLD 2023-1_final.pdf       <-- National Register of Large Dams
    │       └── Pankaj Sharma_...pdf        <-- South India dams reference paper
    └── scripts\
        ├── run_local.ps1                   <-- Native Windows PowerShell server runner
        └── run_local.sh                    <-- Linux/macOS server runner
```

---

## 3. Chronological Changes Completed Till Now

### Phase 1: Knowledge Graph Setup (`graphify`)
* Installed `graphifyy` CLI tool via `uv tool install graphifyy[all]`.
* Generated knowledge graph for the entire project workspace into `graphify-out/` (178 nodes, 226 edges, 19 communities).
* Configured persistent agent rules at `.agents/rules/graphify.md` requiring AST graph synchronization (`graphify update .`) after modifying code files.

### Phase 2: Calibrated Geographic Datasets
* Created `dam-break-inundation/scripts/generate_datasets.py` to synthesize calibrated geospatial datasets for **Mettur Dam (Stanley Reservoir, Cauvery River Basin, Tamil Nadu, India)**:
  * `dem/mettur_dem.tif`: $460 \times 240$ digital elevation model with downstream gradient (elevations 210m to 140m).
  * `river/mettur_river.geojson`: Downstream Cauvery river reach coordinates.
  * `villages/villages.geojson`: 10 key settlements with names, coordinates, and populations (Mettur, Thangamapuripattinam, Raman Nagar, Kolathur, Veerakkalpudur, Bhavani, Komarapalayam, Pallipalayam, Erode, Karur).
  * `dam/mettur_parameters.csv`: Full reservoir capacity ($2,640 \times 10^6 \text{ m}^3$), dam height (65m), crest length (1615m), full reservoir level (242.6m).
  * `satellite/sentinel.tif`: RGB satellite simulation.
  * `population/worldpop.tif`: High-resolution population density grid.
  * `docs/DATASETS.md`: Source attribution and specification catalog.

### Phase 3: FastAPI Hydrodynamic Simulation Backend
* **Enhanced Backend Models (`backend/app/main.py` & `routing.py`)**:
  * Added `elevation_grid`: Downsampled $50 \times 90$ grid from DEM to match simulation depth grid dimensions for direct 3D vertex height construction.
  * Added `elevation_stats`: Calculated minimum and maximum terrain elevations for automatic normalizations.
  * Added `dam_geometry`: Provides dam column index, crest height, breach width, and notch elevation.
  * Added `cell_3d`: Computes $(X, Y)$ grid cell indices for each downstream village to position 3D hazard beacons accurately.
* **Unified Static Hosting**: Mounted `frontend/` at `/` and `sample_data/` at `/sample_data/` using `fastapi.staticfiles.StaticFiles`. Both the REST API and the web application run simultaneously on port 8000.
* **Offline Demo Cache**: Updated `sample_data/sample_result.json` with 3D elevation fields so the full 3D simulation works out-of-the-box without waiting for the hydrodynamic solver.

### Phase 4: Three.js Interactive 3D WebGL Engine (`frontend/three_viewer.js`)
* Built `Flood3DViewer` class with modern WebGL capabilities:
  * **Textured 3D Terrain Mesh**: Dynamic `BufferGeometry` applying elevation data with multi-zone vertex coloring (canyon base, river channel, shrubland valley, ridges).
  * **3D Concrete Dam Barrier**: Extruded geometric wall structure with crest walkway, central breach notch gap, and upstream reservoir water plane.
  * **Dynamic Flood Wave Surface**: Real-time vertex z-height updating ($Z_{water} = Z_{terrain} + \text{depth}$) with translucent water shader, depth absorption color gradient (cyan to deep navy), and animated surface wave ripples.
  * **Downstream Village Hazard Beacons**: 3D glowing markers with ground rings that dynamically shift status based on current flood depth:
    * **Safe** (< 0.5m): Emerald Green (`#10b981`)
    * **Warning** (0.5m – 2.0m): Amber (`#f59e0b`)
    * **Critical / Inundated** (> 2.0m): Pulsing Coral Red (`#ef4444`)
  * **Raycaster Probe**: Mouse cursor hover inspects local coordinates, ground elevation (m), water depth (m), and water surface elevation (m).
  * **Camera Director Presets**: Smooth interpolated camera movements between:
    1. *Dam View* (close-up of breach)
    2. *Valley Track* (following the canyon downstream)
    3. *Top-Down Tactical* (overhead orthogonal map perspective)
    4. *Scenic Orbit* (45° cinematic diagonal angle)

### Phase 5: Dual Viewport & Master Controller (`frontend/app.js`)
* Unified coordination between **Three.js 3D WebGL** and **Leaflet 2D Geospatial Map**.
* Added view switching modes:
  * `3D Only`: Maximized WebGL spatial view.
  * `2D Only`: Leaflet satellite basemap with GeoJSON overlays.
  * `Split View`: Synchronized side-by-side viewports.
* Built full transport timeline: Play/Pause, Step Backward, Step Forward, Scrubber Slider, 1x/2x/5x speed selectors.
* Connected live FastAPI `/simulate` endpoint: reads form inputs, triggers simulation, dynamically updates metrics, hazard table, and both viewports.

### Phase 6: Enterprise UI/UX Redesign (`impeccable` Compliant)
* Performed complete UI/UX audit and refactor adhering to high-end enterprise SaaS standards (Linear, Stripe Dashboard, Vercel):
  * **Removed 100% of emojis** across buttons, headers, HUDs, risk badges, camera presets, and logs. Replaced with precision SVG marks and clean typographic hierarchy.
  * **Removed all multi-color neon gradients and fuzzy glassmorphism blur**. Replaced with an **Enterprise Neutral Slate** color palette.
  * **Typography Scale**: `Inter` for clean readability; `JetBrains Mono` for tabular coordinates, depth metrics, and telemetry data.
  * Created `PRODUCT.md` and `DESIGN.md` establishing durable product context and design tokens.

---

## 4. Errors & Bugs Encountered & How They Were Resolved

### Error 1: Python 3.14 Lacking Prebuilt Rasterio Binary Wheels
* **Symptom**: Running `pip install rasterio` failed on Windows Python 3.14 because C/C++ compilation tools (GDAL/PROJ dependencies) were missing and no prebuilt wheels existed for Python 3.14.
* **Root Cause**: Python 3.14 was installed on the host machine, for which complex C-extension GIS packages (like rasterio) did not have published precompiled wheels on PyPI.
* **Resolution**: Updated `scripts/generate_datasets.py` with an automated fallback to standard `Pillow` (`PIL.TiffImagePlugin`). Injected standard GeoTIFF TIFF tags directly:
  * Tag `33550` (`ModelPixelScaleTag`)
  * Tag `33922` (`ModelTiepointTag`)
  * Tag `34735` (`GeoKeyDirectoryTag` configured for EPSG:4326 WGS84)
  This allowed valid GeoTIFF files (`mettur_dem.tif`, `sentinel.tif`, `worldpop.tif`) to be generated natively on any Python version without requiring C-compilers.

### Error 2: JavaScript Syntax Error in `three_viewer.js`
* **Symptom**: 3D viewer failed to render; console showed `SyntaxError: Unexpected token` or mesh geometry vertex positions were corrupted.
* **Root Cause**: Python-style floor division (`// 2`) was written inside JavaScript code when calculating grid center offsets (`col - cols // 2`). In JavaScript, `//` starts a line comment, causing the rest of the line to be commented out and breaking syntax.
* **Resolution**: Replaced all occurrences with standard JavaScript `Math.floor(x / 2)`.

### Error 3: Directory Navigation Failures in PowerShell
* **Symptom**: User commands like `cd backend\` failed with `Cannot find path '...\backend\' because it does not exist`.
* **Root Cause**: Workspace root is `c:\Users\Lohith G\Downloads\SIH26161`, while all application code is inside `dam-break-inundation\`.
* **Resolution**: Clarified working directories in all instructions and documentation. To access backend, run:
  ```powershell
  cd "c:\Users\Lohith G\Downloads\SIH26161\dam-break-inundation\backend"
  ```

### Error 4: Interactive CLI Hangs During Agent Tool Execution
* **Symptom**: Running `npx impeccable install` caused background tasks to hang indefinitely.
* **Root Cause**: The CLI tool detected multiple development harnesses (Antigravity, Cursor, Claude Code, etc.) and paused waiting for interactive user arrow-key selection in standard input (stdin).
* **Resolution**: Terminated the hanging background process via `manage_task` (`Action: kill`). Noted that the `impeccable` skill was already pre-installed at `C:\Users\Lohith G\.gemini\config\skills\impeccable\SKILL.md` and used it directly.

### Error 5: Dual Server CORS & Static Asset Path Mismatch
* **Symptom**: Running frontend on Vite (`http://localhost:5173`) and backend on Uvicorn (`http://localhost:8000`) caused CORS preflight errors and relative path resolution issues for `/sample_data/sample_result.json`.
* **Root Cause**: Separate ports without explicit origin headers and cross-origin resource requests.
* **Resolution**: Configured FastAPI (`backend/app/main.py`) with `CORSMiddleware` allowing `*` origins, and mounted `frontend/` directly as static files on the FastAPI server (`http://localhost:8000/`). This allows running the entire application from a single, unified server command.

### Error 6: Artifact Markdown Image Path Validation on Windows
* **Symptom**: Antigravity artifact markdown linter rejected image embeds with warnings like `invalid image path ... must start with /` or `must be within artifact directory`.
* **Root Cause**: URI schemes (`file:///`) and URL encoded spaces (`%20` for `Lohith G`) are rejected by the artifact viewer validator on Windows.
* **Resolution**: Formatted all artifact images as clean unencoded Windows paths without leading slash:
  `![Caption](C:/Users/Lohith G/.../image.png)`.

---

## 5. Technical Specifications & Contracts

### API Endpoints (`backend/app/main.py`)

#### 1. `GET /health`
* **Response**: `{"status": "ok", "app": "Dam Break Inundation Modelling API", "version": "1.0.0"}`

#### 2. `GET /sample-result`
* **Response**: Precomputed simulation JSON payload including:
  * `summary`: `{ peak_discharge_m3s, time_to_peak_hr, breach_width_m, formation_time_hr, total_inundated_area_km2, max_depth_overall_m }`
  * `elevation_grid`: $50 \times 90$ nested float array (downsampled terrain elevations).
  * `elevation_stats`: `{ min_elev, max_elev }`
  * `dam_geometry`: `{ dam_col_index, crest_height_m, breach_width_m, breach_level_m }`
  * `timesteps_hours`: Array of float simulation hours `[0.0, 0.5, 1.0, ...]`.
  * `depth_grids`: 3D array of depth matrices $[T, 50, 90]$.
  * `village_impacts`: Array of `{ name, arrival_time_hr, peak_depth_m, status, cell_3d: [col, row] }`.

#### 3. `POST /simulate`
* **Request Body**:
  ```json
  {
    "dam_name": "Stanley Reservoir (Mettur)",
    "volume_mcm": 2640.0,
    "dam_height_m": 65.0,
    "failure_mode": "piping",
    "simulation_hours": 6.0
  }
  ```
* **Response**: Computed simulation result matching the schema described above.

### UI Design Tokens (`frontend/style.css` & `DESIGN.md`)

```css
/* Neutral Slate Palette */
--color-bg-canvas: #090d13;
--color-bg-surface: #0f141c;
--color-bg-subtle: #161d27;
--color-border-subtle: #1e2633;
--color-border-default: #2d3748;

/* Typography */
--color-text-primary: #f0f4f8;
--color-text-secondary: #94a3b8;
--color-text-muted: #64748b;
--font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

/* Functional Action & Hazards */
--color-primary: #2563eb;
--color-primary-hover: #1d4ed8;
--color-status-safe: #10b981;
--color-status-warning: #f59e0b;
--color-status-critical: #ef4444;
```

---

## 6. How to Run & Verify the Application

### Step 1: Start the FastAPI Backend
Open PowerShell in the backend directory:
```powershell
cd "c:\Users\Lohith G\Downloads\SIH26161\dam-break-inundation\backend"
python -m uvicorn app.main:app --reload --port 8000
```

### Step 2: Open in Browser
Navigate to:
```
http://localhost:8000/
```

### Step 3: Interactive Features to Test
* **3D Simulation Canvas**: Left-click and drag to rotate the canyon; right-click and drag to pan; scroll to zoom.
* **Camera Director Presets**: Click `Dam`, `Valley`, `Top-Down`, or `Scenic` in the floating HUD.
* **Surface Probe**: Hover the mouse over any point in the 3D terrain to read local elevation and flood depth.
* **Playback Timeline**: Click `Play` to animate the flood surge; drag the scrubber slider; switch between `1x`, `2x`, and `5x` playback speeds.
* **View Switcher**: Click `3D View`, `2D Map`, or `Split View` in the top navigation bar.
* **Live Hydrodynamic Simulation**: Adjust reservoir volume or dam height in the left panel and click `Run Simulation`.

---

## 7. OpenTopography Real DEM Integration (Implemented)

### New Backend Module: `backend/app/dem_fetcher.py`
* **DMS Coordinate Parser**: Converts dam latitude/longitude strings (e.g. `"11° 37' 28.000\" N"`) to decimal degrees.
* **AOI Generator**: Creates a bounding box (~0.35 degrees padding) around dam coordinates for targeted DEM download.
* **OpenTopography API Client**: Downloads COP30 / SRTM GL1 / ASTER GDEM tiles from `https://portal.opentopography.org/API/globaldem`.
* **Local Cache Manager**: Caches downloaded GeoTIFFs in `datasets/dem/cache/` with MD5-based filenames derived from AOI bounds.
* **Dam Database Loader**: Parses `datasets/dam/dam.geojson` (National Register of Large Dams) to provide ~500 dams with parsed decimal-degree coordinates.

### Updated Backend: `backend/app/dem.py`
* Added `load_opentopography_dem()`: Loads a real GeoTIFF, downsamples to 80x120 grid for the hydrodynamic solver, and determines dam column position.
* Improved `load_real_dem()`: Now returns proper `(west, south, east, north)` bounds tuple.

### Updated Backend: `backend/app/main.py`
* **`GET /dams`**: Lists available dams with metadata (name, state, coordinates, height, volume).
* **`GET /dem/cache`**: Shows cached DEM tiles and their sizes.
* **`POST /fetch-dem`**: Manually download a DEM tile for a dam location.
* **Enhanced `POST /simulate`**: Accepts `terrain_type=opentopography` with `latitude`, `longitude`, `api_key`, `dem_type` fields. Automatically fetches real DEM, runs simulation on real terrain, and returns `dem_bounds` + `dam_location` for accurate 2D map overlay.

### Updated Frontend: `frontend/index.html` + `frontend/app.js`
* **Dam Selector Dropdown**: Populated from `/dams` endpoint, grouped by state. Auto-fills name, volume, height on selection.
* **OpenTopography API Key Input**: Password field with link to key request page.
* **DEM Source Selector**: COP30, SRTMGL1, SRTMGL3, ASTGTMV3 options.
* **Terrain Mode Selector**: Synthetic / Mettur / Real DEM (OpenTopography).
* **2D Map Overlay**: Uses real DEM bounds when available for accurate Leaflet geospatial rendering.

### New Frontend: `frontend/style.css`
* Added `.form-hint` styling for helper text below form fields.

### Updated: `backend/requirements.txt`
* Added `requests>=2.31.0` for OpenTopography API calls.

### Data Flow
```
User selects dam from dropdown
        ↓
Frontend sends lat/lon + API key to /simulate
        ↓
Backend generates AOI bounding box (~0.35 deg padding)
        ↓
Backend calls OpenTopography COP30 API
        ↓
GeoTIFF downloaded → cached in datasets/dem/cache/
        ↓
GeoTIFF loaded → downsampled to 80x120 grid
        ↓
Hydrodynamic solver runs on real terrain
        ↓
Results include dem_bounds for accurate 2D map overlay
```

### Phase: Professional Engineering UI Redesign & 3D Calibration
* **Design Language Overhaul**: Transformed UI from futuristic/gaming dark theme to an engineering-grade workstation interface inspired by Bentley OpenFlows, HEC-RAS Mapper, Cesium, and ArcGIS Pro.
* **Design Tokens (`style.css`)**:
  * Primary Accent: Shifted from teal (`#00d4aa`) to industry-standard CAD/GIS Engineering Blue (`#4a9eff`, with translucent tints).
  * Surface Spectrum: Replaced stark void-black surfaces with warmer, eye-comfort charcoals (`--surface-0: #0f1318`, `--surface-1: #161b22`, `--surface-2: #1c2128`).
  * Typography: Adopted `Inter` as the primary UI typography with `JetBrains Mono` for hydrological metrics and telemetry.
  * Layout Refinements: Sidebar narrowed from 360px to 320px for optimal screen real estate; simulation metrics dock narrowed to 680px and configured to start minimized by default so the 3D hydrodynamic visualization remains dominant.
* **3D Viewport & Lighting Calibration (`three_viewer.js`)**:
  * Tone Mapping Exposure: Calibrated from 0.82 down to 0.70 to prevent washed-out overexposed highlights on concrete dam faces and water.
  * Post-Processing: Reduced UnrealBloomPass intensity to 0.04 with higher threshold 0.95 (eliminating blinding glows while preserving realistic specular glints).
  * Environmental Lighting: Softened hemisphere light (0.45), warm directional sun (0.90), and environment reflections (0.18) for balanced outdoor daylight realism.
  * Atmospheric Depth: Calibrated exponential fog density to 0.0018 with muted sky hemisphere colors (`#2c4f75` to `#b8c8d8`).
  * Streamlined Camera Presets: Focused to three core operational presets (`Dam`, `Valley`, `Top`) with wider default panoramic framing of reservoir, dam wall, and downstream floodplain.
* **Toolbar Simplification (`index.html`)**: Removed redundant VFX test trigger button from the live view header, leaving only essential operational presets, layer toggles, and simulation timeline controls.

---

## 8. Recommended Next Steps for Future AI Agents

1. **Export Capabilities**:
   * Add a GeoJSON export button for the maximum flood inundation boundary.
   * Add a PDF summary report generator for disaster response agencies (NDMA/SDMA).
2. **Population Vulnerability Modeling**: Overlay `datasets/population/worldpop.tif` onto the maximum depth grid to calculate affected headcounts by village.
3. **AST Graph Maintenance**: Whenever modifying Python or JavaScript source files, remember to execute:
   ```powershell
   $env:PATH += ";$env:USERPROFILE\.local\bin"; graphify update .
   ```

