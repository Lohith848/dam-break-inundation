# Technical Requirements Document (TRD)
## Dam Break Inundation Modelling Platform — SIH26161

---

### 1. Architecture Overview

```
┌──────────────┐      ┌───────────────────┐      ┌────────────────────────┐
│   Frontend   │◄────►│   Backend API      │◄────►│  Simulation Engine      │
│ (Leaflet map │ REST │ (FastAPI, Python)  │ calls│ breach.py + routing.py │
│  + controls) │      │                    │      │ (NumPy, vectorised)    │
└──────────────┘      └─────────┬──────────┘      └───────────┬────────────┘
                                 │                              │
                        ┌────────▼─────────┐          ┌─────────▼──────────┐
                        │  Data layer       │          │  DEM / GIS layer   │
                        │ (dam registry,    │          │ (SRTM/Copernicus   │
                        │  scenario cache)  │          │  DEM, river vectors)│
                        └───────────────────┘          └────────────────────┘
```

This repo ships a **monolithic** version of the above (one FastAPI process,
DEM generated in-process) because that's the fastest path to a working demo.
The module boundaries (`breach.py`, `dem.py`, `routing.py`, `main.py`) are
kept clean so each box above can be pulled out into its own service later
(e.g., DEM/GIS layer → PostGIS + a tile server; simulation engine → a Celery
worker queue so long runs don't block the API).

### 2. Component Details

#### 2.1 Frontend
- Plain HTML/CSS/JS + Leaflet (no build step — works by opening `index.html`
  or serving with any static file server).
- Renders the depth grid client-side as a canvas → data-URL image, overlaid
  on OpenStreetMap tiles via `L.imageOverlay`.
- Time slider scrubs through precomputed snapshots.
- Talks to the backend via `fetch()`; falls back to a bundled sample JSON
  when the backend isn't reachable (useful for offline demos).
- **Swap-in for production:** replace the canvas overlay with real
  georeferenced raster tiles (e.g., served via `titiler`/`GeoServer`) once
  you're working with real DEM-derived GeoTIFFs, and swap OSM tiles for
  Bhuvan/other India-specific basemaps if required.

#### 2.2 Backend API (FastAPI)
- `POST /simulate` — synchronous for the demo (small grid, few seconds).
  For production/larger DEMs, move this to an async job:
  `POST /simulate` returns a `job_id`, `GET /jobs/{id}` polls status, and a
  worker (Celery/RQ) executes `routing.run_flood_routing` off the request
  thread.
- `GET /sample-result` — canned response for demos/tests.
- Input validation via Pydantic (`DamParams`).
- CORS open for the hackathon demo — lock down `allow_origins` before any
  real deployment.

#### 2.3 Simulation Engine
- `breach.py` — Froehlich (1995/2008) empirical breach-parameter equations →
  triangular breach outflow hydrograph. This is the same class of equation
  used in FEMA/USBR dam-safety guidance as a rapid first estimate when a
  full physically-based breach-erosion model (e.g., HEC-RAS's embedded
  breach module, or NWS BREACH) isn't run.
- `routing.py` — explicit, adaptive-timestep 2D **diffusive-wave**
  approximation of the shallow water equations (same physics family as
  LISFLOOD-FP's simplified mode; see Bates, Horritt & Fenton (2010) and
  Hunter et al. (2005) for the Courant-type adaptive timestep logic). Volume
  is conserved between adjacent cells at every step; a mass-conservation
  flux limiter prevents cells from being over-drained across multiple
  edges in a single timestep (the classic instability failure mode of
  first-order explicit CA/diffusive-wave flood models).
- `dem.py` — DEM access layer; ships a synthetic valley generator for the
  zero-dependency demo, plus a `load_real_dem()` stub (rasterio) to switch
  to a real GeoTIFF DEM.

#### 2.4 Data Layer (production target — not needed for the demo)
- Dam registry: name, location, height, storage-elevation curve, spillway
  capacity — sourced from India-WRIS / National Register of Large Dams
  (CWC) where available, or entered manually.
- Scenario cache: store completed simulation runs (Postgres/SQLite) so
  repeated queries for the same dam+scenario don't re-run the model.
- GIS layer: PostGIS for river centrelines/cross-sections (HydroSHEDS/GRWL),
  administrative boundaries (village/ward) for impact reporting.

### 3. Physics / Numerics Reference (what's actually implemented)

| Step | Method | Where |
|---|---|---|
| Breach peak outflow | Froehlich (1995): `Qp = 0.607·Vw^0.295·Hw^1.24` | `breach.py` |
| Breach width | Froehlich (2008): `B = 0.27·k0·Vw^0.32·Hb^0.04` | `breach.py` |
| Breach formation time | `tf = 63.2·sqrt(Vw/(g·Hb²))` | `breach.py` |
| Breach hydrograph shape | Triangular (rise over tf, recede over 2·tf) | `breach.py` |
| 2D flood routing | Explicit diffusive-wave (simplified shallow water), Manning-based inter-cell flux | `routing.py` |
| Numerical stability | Adaptive timestep (Courant-type) + per-cell mass-conservation flux limiter | `routing.py` |

**Known simplifications (documented on purpose, not hidden):**
- No inertial/momentum terms → flow direction/timing is good, but peak
  velocities in very steep or highly dynamic reaches will be less accurate
  than a full dynamic-wave model. Acceptable for rapid screening; **not**
  a substitute for a certified EAP study.
- Single Manning's n for the whole domain (real deployments should vary n
  by land cover, from Sentinel-2/land-use classification).
- The reservoir itself isn't simulated (no storage-elevation drawdown
  during breach) — the breach hydrograph is treated as a prescribed
  upstream boundary condition, which is standard practice for a rapid
  screening tool.

### 4. Upgrade Path to a Fully-Validated Hydrodynamic Model
Replace `routing.py`'s engine with one of (all free):
1. **HEC-RAS 2D (free, USACE)** — industry-standard, has a built-in dam
   breach module (matches this PS's "hydrodynamic modelling" language most
   directly). Automate via its scripting/controller interface or by
   generating `.g01`/`.u01`/plan files programmatically.
2. **ANUGA (free, open-source Python, Geoscience Australia/ANU)** — solves
   the full 2D shallow water equations via finite volume; installable via
   `pip`/`conda`; scriptable end-to-end from Python, so it's the easiest
   "drop-in" upgrade for this codebase.
3. **LISFLOOD-FP (free for research use)** — the same diffusive/inertial
   physics family this repo approximates, but production-grade and GPU
   accelerated.

### 5. Tech Stack Summary (all free)
| Layer | Choice | License |
|---|---|---|
| Backend | Python 3.11+, FastAPI, Uvicorn | MIT/BSD |
| Numerics | NumPy | BSD |
| GIS (production) | rasterio, GDAL, PostGIS, QGIS | Open source |
| Hydrodynamic engine (production) | HEC-RAS 2D / ANUGA / LISFLOOD-FP | Free (USACE/GPL/research) |
| Frontend | Leaflet.js + vanilla JS | BSD-2 |
| Basemap tiles | OpenStreetMap | ODbL (free) |
| Version control / CI | GitHub + GitHub Actions | Free tier |
| Hosting (optional) | Render/Railway/Fly.io free tier, or on-prem | Free tier |

### 6. Testing Strategy
- Unit tests (`backend/tests/`) on `breach.py` (regression values against
  hand-calculated Froehlich outputs) and `routing.py` (mass conservation:
  total injected volume ≈ total volume in the domain at any snapshot, to
  within the flux-limiter's tolerance).
- Sanity/physical tests: monotonic non-increasing peak depth with distance
  downstream; non-decreasing arrival time with distance.
- API contract tests via `TestClient` (see `backend/tests/test_api.py`).
