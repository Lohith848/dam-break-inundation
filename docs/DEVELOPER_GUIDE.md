# Developer Guide — Dam Break Inundation Modeling Platform

## 1. System Overview
The Dam Break Inundation Modeling Platform (SIH26161) is an end-to-end, scientifically grounded hydrodynamic modeling and visualization suite for flood risk analysis. In the current production release, the platform operates in a **Map-First 2D GIS Architecture** coupling 2D shallow-water numerical routing with an interactive Leaflet spatial viewport, Groq AI copilot, and CWC 13-section PDF generator.

> **Roadmap Note**: The 3D Digital Twin Viewer (Three.js WebGL terrain, dynamic water shaders, and structural GLB dam models) is documented for post-SIH deployment in [`docs/3D_IMPLEMENTATION_ROADMAP.md`](file:///c:/Users/Lohith%20G/Downloads/SIH_WINNING_PROJECT/dam-break-inundation/docs/3D_IMPLEMENTATION_ROADMAP.md).

```
┌─────────────────────────────────────────────────────────────┐
│                       Frontend (Vite)                       │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │     Leaflet 2D GIS    │       │   Floating AI Drawer  │  │
│  │  (Satellite Imagery,  │       │  (Groq LPU Inference, │  │
│  │   Smooth Contours)    │       │   Engineering Q&A)    │  │
│  └───────────▲───────────┘       └───────────▲───────────┘  │
│              │                               │              │
│              └───────────────┬───────────────┘              │
│                              │                              │
│              ┌───────────────▼───────────────┐              │
│              │     Multi-Layer GIS Engine    │              │
│              │  (Depth, Velocity, Risk, ETA) │              │
│              └───────────────▲───────────────┘              │
└──────────────────────────────┼──────────────────────────────┘
                               │ HTTP / SSE Stream
┌──────────────────────────────▼──────────────────────────────┐
│                    FastAPI Hydrodynamic Engine              │
│  ┌─────────────────┐ ┌───────────────────┐ ┌─────────────┐  │
│  │ Froehlich Breach│ │ 2D Diffusive Wave │ │ DEM Fetcher │  │
│  │ Regressions     │ │ Routing Solver    │ │ & Cache     │  │
│  └─────────────────┘ └───────────────────┘ └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 2. Core Architectural Principles
1. **Zero Data Fabrication**: All water surfaces, depths, velocities, arrival times, and summary metrics originate strictly from the backend hydrodynamic solver. No artificial wave paths or procedural flood extents are created.
2. **Deterministic Hydraulic Physics**: Breach outflows are derived using Froehlich (1995/2008) and MacDonald empirical equations. Flood wave propagation adheres to the 2D diffusive wave Saint-Venant shallow water equations with adaptive CFL stability.
3. **Smooth Vector Topological Contours**: Contours are extracted from raw depth rasters via `rasterio.features.shapes` and unified using `shapely.ops.unary_union` to prevent bowtie or star polygon visual artifacts.
4. **Failure Mode Specialization**: Overtopping, Piping, Structural, and Earthquake modes employ the same underlying hydrodynamic conservation laws while driving mode-specific breach formation kinetics.
5. **Future 3D Extensibility**: The API returns full 3D matrix arrays (`depth_grids`, `velocity_grids`) allowing direct integration with the future Three.js 3D Digital Twin without backend modification.

## 3. Development Environment Setup

### Prerequisites
- Node.js >= 18.x
- Python >= 3.10
- Git

### Quick Setup
```bash
# 1. Clone repository
git clone https://github.com/Lohith848/dam-break-inundation.git
cd dam-break-inundation

# 2. Setup and run Backend
cd backend
python -m venv venv
# Windows:
.\venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 3. In another terminal, setup and run Frontend
cd ../frontend
npm install
npm run dev
```
Open your browser at `http://localhost:5173`.

## 4. Coding Conventions & Best Practices
- **ES Modules**: Pure ES modules throughout frontend code (`import / export`).
- **Clean Architecture**: Decoupled state management in `frontend/app.js` with isolated AI Copilot drawer in `frontend/ai_panel.js`.
- **API Contracts**: Backend contracts in `backend/app/main.py` and `backend/app/flood.py` are strictly versioned, tested via Pytest, and backward-compatible.
