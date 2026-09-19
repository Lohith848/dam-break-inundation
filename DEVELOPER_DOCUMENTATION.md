# Dam Break Inundation Modeling Platform — Developer Documentation

**Smart India Hackathon (SIH26161) — Map-First Production Release**  
*Central Water Commission (CWC) · National Disaster Management Authority (NDMA) · State Disaster Response Force (SDRF)*

---

## 1. System Architecture Overview

The **Dam Break Inundation Modeling Platform** is a high-performance, map-based hydrodynamic simulation system designed for dam safety engineers, hydrologists, district emergency planners, and disaster management authorities.

The architecture decouples the frontend visualization layer from the backend computational solver:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Web Browser                            │
│                                                                         │
│   ┌───────────────────────┐ ┌───────────────────────────────────────┐   │
│   │ Control Panel         │ │ Leaflet Map Viewport                  │   │
│   │ - River & Dam Search  │ │ - Satellite Base Map (Esri/Carto)     │   │
│   │ - 4 Failure Modes     │ │ - Real-Time Flood Wave Animation      │   │
│   │ - Hydrograph Param    │ │ - Vector Polygon Wavefront Overlay    │   │
│   │ - Simulation Controls │ │ - Multi-Layer Heatmap (D, V, Risk, T) │   │
│   └──────────┬────────────┘ └───────────────────▲───────────────────┘   │
│              │                                  │                       │
│              │ HTTP POST /progress/stream       │ Frame Sync & GeoJSON  │
└──────────────┼──────────────────────────────────┼───────────────────────┘
               │                                  │
┌──────────────▼──────────────────────────────────┴───────────────────────┐
│                      FastAPI Computational Backend                      │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ 1. DEM Acquisition Engine (OpenTopography 30m / COP30 / SRTM)    │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │                                     │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │ 2. Breach Hydrograph Generator (Froehlich 1995/2008 & MacDonald)│   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │ Q(t) Inflow                         │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │ 3. 2D Shallow Water Routing Engine (Diffusive-Wave Solver)      │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │ Grids: Depth, Velocity, Arrival     │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │ 4. Topological Polygon Generator (Rasterio & Shapely Union)     │   │
│   └────────────────────────────────┬────────────────────────────────┘   │
│                                    │                                     │
│   ┌────────────────────────────────▼────────────────────────────────┐   │
│   │ 5. Government PDF Engine (ReportLab & Matplotlib Hydrographs)   │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Directory Structure

```
dam-break-inundation/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI application, routing, and CORS
│   │   ├── flood.py             # Main simulation runner & smooth polygon extractor
│   │   ├── routing.py           # 2D Diffusive-wave Saint-Venant hydraulic solver
│   │   ├── breach.py            # Froehlich & MacDonald empirical breach regressions
│   │   ├── failure_modes.py     # Piping, Overtopping, Structural, Earthquake profiles
│   │   ├── report_engine.py     # Government 13-section PDF generator with charts
│   │   ├── dem.py               # GeoTIFF / DEM reading, slope, and clipping
│   │   ├── dem_fetcher.py       # OpenTopography REST API interface & fallback
│   │   ├── sim_cache.py         # LRU caching for simulation results
│   │   ├── progress.py          # SSE real-time step streaming
│   │   ├── validation.py        # Strict latitude/longitude coordinate bounds
│   │   └── ai/
│   │       ├── groq_client.py   # LLaMA 3.3 70B Versatile inference
│   │       └── prompts.py       # Hydraulic engineering system prompts
│   ├── tests/
│   │   ├── test_smoke_e2e.py    # End-to-end integration and smoke tests
│   │   ├── test_failure_modes.py# Failure mode regression tests
│   │   ├── test_breach.py       # Hydrograph calculation tests
│   │   ├── test_routing.py      # Hydraulic solver numerical stability tests
│   │   ├── test_sim_cache.py    # Cache expiration and concurrency tests
│   │   └── test_assets_api.py   # Asset discovery regression guards
│   └── requirements.txt
├── frontend/
│   ├── index.html               # Semantic HTML5 layout (Map viewport, Control sidebar)
│   │── style.css                # Dark engineering theme (Inter + JetBrains Mono)
│   ├── app.js                   # Application state, Leaflet GIS player, timeline
│   ├── ai_panel.js              # Asynchronous, non-blocking AI Copilot drawer
│   ├── dashboard.js             # Post-simulation quantitative metrics cards
│   ├── config/
│   │   └── api.js               # Auto-resolving backend URL configuration
│   └── viewer/                  # 3D Digital Twin code (paused for Map-First SIH)
├── public/assets/               # Pre-compiled GLB & DEM asset directory
├── DEVELOPER_DOCUMENTATION.md   # System technical reference (this document)
└── 3D_IMPLEMENTATION_ROADMAP.md # Post-SIH 3D Digital Twin implementation guide
```

---

## 3. Backend Hydraulic Simulation Pipeline

### 3.1 DEM Acquisition & Valley Slope Detection
- Coordinates $(\phi, \lambda)$ are checked against physical bounds $(\phi \in [-90, 90], \lambda \in [-180, 180])$.
- 30-meter Copernicus DEM (`COP30`) is fetched via OpenTopography or generated from synthetic elevation gradients with real river channel depressions.
- Downstream valley direction is determined using the elevation gradient tensor:
  $$\nabla z = \left( \frac{\partial z}{\partial x}, \frac{\partial z}{\partial y} \right)$$

### 3.2 Failure Mode Breach Mechanics
Four distinct dam breach failure modes are physically modeled:

1. **Piping (Internal Erosion):**
   - Progressive internal erosion forming a pipe through the embankment.
   - Base Froehlich (1995/2008) parameters: $k_0 = 1.0$, formation time factor $1.0\times$.
2. **Overtopping:**
   - Water exceeds crest level, eroding downstream face upwards.
   - Froehlich parameters: $k_0 = 1.3$, formation time factor $1.5\times$ (extended erosion duration).
3. **Structural Failure:**
   - Instantaneous or catastrophic monolithic collapse under hydrostatic load.
   - Formation time factor $0.15\times$ (rapid peak release, $Q_p$ surge wave).
4. **Earthquake-Induced Breach:**
   - Seismic crest shaking, liquefaction, and rapid longitudinal slumping.
   - Formation time factor $0.30\times$.

**Governing Breach Equations:**
- **Peak Breach Discharge (Froehlich 1995):**
  $$Q_p = 0.607 \cdot V_w^{0.295} \cdot H_w^{1.24}$$
- **Average Breach Width (Froehlich 2008):**
  $$B = 0.27 \cdot k_0 \cdot V_w^{0.32} \cdot H_b^{0.04}$$
- **Breach Formation Time (Froehlich 2008):**
  $$t_f = 63.2 \cdot \sqrt{\frac{V_w}{g \cdot H_b^2}}$$
- **Embankment Erosion Volume (MacDonald & Langridge-Monopolis 1984):**
  $$V_{\text{eroded}} = 0.0261 \cdot (V_w \cdot H_w)^{0.77}$$

### 3.3 2D Diffusive-Wave Hydrodynamic Routing
The flood wave propagates downstream over the 2D topography governed by the Saint-Venant shallow water equations in diffusive-wave approximation:

$$\frac{\partial h}{\partial t} + \frac{\partial (u h)}{\partial x} + \frac{\partial (v h)}{\partial y} = q_{\text{source}}$$

Flow velocity in each direction is computed via the Manning formula:
$$u = \frac{1}{n} R^{2/3} S_f^{1/2}$$
where $S_f = -\nabla (z + h)$ is the water surface slope, $n$ is Manning's roughness coefficient ($0.045\text{ s/m}^{1/3}$), and $h$ is local water depth.

---

## 4. Smooth Polygon Extraction & Animation Pipeline

To eliminate self-intersecting "bowtie" or "star" polygon artifacts caused by centroid polar angle sorting, the platform uses raster contour extraction and topological union:

1. **Cell Masking:** Each time-step depth grid $h(x, y)$ is thresholded at $h > 0.08\text{ m}$.
2. **Vector Extraction:** `rasterio.features.shapes` extracts closed boundary polygons with affine georeferencing.
3. **Topological Union:** `shapely.ops.unary_union` merges adjacent inundated cells into clean Single or MultiPolygons.
4. **Curvature Smoothing:** A micro-buffer dilation followed by erosion (`buffer(0.0001).buffer(-0.00005)`) smooths pixel steps.
5. **Douglas-Peucker Simplification:** `simplify(0.0004, preserve_topology=True)` optimizes vertex count for 60 FPS client rendering.
6. **Frontend Synchronization:**
   - Vector boundary rendered via `L.geoJSON` with dynamic hazard stroke/fill styling.
   - Cell texture rendered via high-density HTML5 `<canvas>` and updated onto `L.imageOverlay`.
   - Play/pause timeline controller animates frames at $0.5\times$, $1\times$, $2\times$, or $5\times$ speed.

---

## 5. Multi-Layer GIS Analysis System

The floating GIS toolbar provides instant layer toggles without re-running simulation:

| Layer ID | Name | Color Ramp | Engineering Metric |
| :--- | :--- | :--- | :--- |
| `depth` | Flood Depth | Cyan $\rightarrow$ Blue $\rightarrow$ Orange $\rightarrow$ Red | Water depth above ground: $0.1\text{m}$ to $>5.0\text{m}$ |
| `velocity` | Flow Velocity | Green $\rightarrow$ Yellow $\rightarrow$ Orange $\rightarrow$ Dark Red | Momentum velocity: $0.2\text{ m/s}$ to $>4.5\text{ m/s}$ |
| `arrival` | Arrival Time | Magenta $\rightarrow$ Orange $\rightarrow$ Yellow $\rightarrow$ Cyan | Wavefront arrival: $0\text{ min}$ to $>120\text{ min}$ |
| `risk` | Hazard Zones | Green $\rightarrow$ Blue $\rightarrow$ Amber $\rightarrow$ Red | USBR Hazard Matrix ($D \times V$): Low to Critical |

---

## 6. PDF Report Generator

The PDF engine (`backend/app/report_engine.py`) builds an official multi-page document using ReportLab and Matplotlib:

### 13 Mandatory Sections:
1. **Executive Summary:** Overview of breach scenario, peak discharge, and affected assets.
2. **Dam Information & Specifications:** River basin, jurisdiction, capacity, structural height.
3. **Simulation Inputs:** DEM source, resolution, Manning's $n$, simulation duration.
4. **Failure Mode Mechanics:** Physical trigger, breach widening rate, erosion volume.
5. **Hydraulic Calculations:** Peak breach outflow $Q_p$, exit velocity, continuity checks.
6. **Flood Statistics:** Flooded area ($\text{km}^2$ and Hectares), affected population and buildings.
7. **Risk Assessment:** Depth-Velocity ($D \times V$) classification criteria and breakdown.
8. **Evacuation Analysis:** Downstream settlement directory with arrival times and safe shelters.
9. **Spatial Overview:** Geographic bounding coordinates $(\text{North, South, East, West})$.
10. **Hydrograph Charts:** High-resolution vector discharge hydrograph curve ($Q$ vs. Time).
11. **Inundation Progression Timeline:** Tabular frame-by-frame status and operational directives.
12. **Emergency Action Recommendations:** Phase 1 (0–2h), Phase 2 (2–12h), Phase 3 (12–72h).
13. **Technical Appendix:** Governing Saint-Venant shallow water equations and empirical formulations.

---

## 7. API Reference

### `POST /simulate`
Executes synchronous 2D hydrodynamic dam break simulation.
- **Request Body:**
  ```json
  {
    "dam_id": "dam_123",
    "dam_name": "Mettur Dam",
    "latitude": 11.8000,
    "longitude": 77.8000,
    "reservoir_volume_m3": 2640000000.0,
    "dam_height_m": 65.0,
    "failure_mode": "piping",
    "manning_n": 0.045,
    "total_sim_hours": 3.0,
    "dem_type": "COP30"
  }
  ```
- **Response:** JSON containing `simulation_id`, `summary`, `breach`, `depth_grids`, `velocity_grids`, `risk_grids`, `arrival_grid`, `frame_polygons`, `flood_polygon`, and `timesteps_formatted`.

### `POST /simulate/start` & `GET /simulate/stream/{job_id}`
Asynchronous SSE streaming endpoint returning progress percentages and live step logs.

### `POST /report/pdf`
Generates binary PDF report from cached simulation result.
- **Request Body:** `{"simulation_id": "abc123"}`
- **Response:** `application/pdf` binary stream with filename header.

### `POST /ai/chat`
Context-bounded AI Q&A endpoint utilizing the current simulation result (depth, velocity, settlement arrival times).

---

## 8. Deployment & Production Setup

### Backend (Python 3.11+)
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### Frontend (Static or Vite)
```bash
cd frontend
npm install
npm run build   # Production bundle in dist/
npm run dev     # Local development server at http://localhost:5173
```

### Environment Variables (`.env`)
```ini
OPENTOPOGRAPHY_API_KEY=your_opentopography_key
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
SIMULATION_CACHE_SIZE=50
CORS_ORIGINS=*
```
