# Developer Guide — Dam Break Inundation Digital Twin

## 1. System Overview
The Dam Break Inundation Digital Twin (SIH26161) is an end-to-end, scientifically grounded hydrodynamic modeling and visualization platform for flood risk analysis. It bridges 2D shallow-water numerical routing with an interactive, engineering-grade 3D digital twin and GIS satellite interface.

```
┌─────────────────────────────────────────────────────────────┐
│                       Frontend (Vite)                       │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │   Three.js 3D Twin    │       │     Leaflet GIS       │  │
│  │ (Constrained Camera,  │       │  (Satellite Imagery,  │  │
│  │  Master GLB, Shaders) │       │   Depth Overlays)     │  │
│  └───────────▲───────────┘       └───────────▲───────────┘  │
│              │                               │              │
│              └───────────────┬───────────────┘              │
│                              │                              │
│              ┌───────────────▼───────────────┐              │
│              │   Reactive Dashboard Engine   │              │
│              │ (8 Zero-Fabrication Metrics)  │              │
│              └───────────────▲───────────────┘              │
└──────────────────────────────┼──────────────────────────────┘
                               │ HTTP / SSE Stream
┌──────────────────────────────▼──────────────────────────────┐
│                    FastAPI Hydrodynamic Engine              │
│  ┌─────────────────┐ ┌───────────────────┐ ┌─────────────┐  │
│  │ Froehlich/Von   │ │ 2D Diffusive Wave │ │ Asset & DEM │  │
│  │ Thun Breach     │ │ Routing Solver    │ │ Pipeline    │  │
│  └─────────────────┘ └───────────────────┘ └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 2. Core Architectural Principles
1. **Zero Data Fabrication**: All water surfaces, depths, velocities, arrival times, and summary metrics originate strictly from the backend hydrodynamic solver. No artificial wave paths or procedural flood extents are created.
2. **Master GLB Pipeline**: The digital twin is anchored to a unified master model (`public/assets/master/scene.glb`) accompanied by metadata (`public/assets/metadata/scene.json`), removing hardcoded spatial coordinates.
3. **Constrained Camera Architecture**: The camera operates as an analytical engineering inspection tool. Free-flying below ground, clipping into geometry, and inverted views are prevented mathematically via polar limits (20°–75°) and spherical distance clamps.
4. **Failure Mode Specialization**: Overtopping, Piping, Structural, and Earthquake modes employ the same underlying hydrodynamic conservation laws while driving mode-specific visual failure progression.

## 3. Development Environment Setup

### Prerequisites
- Node.js >= 18.x
- Python >= 3.10
- Git

### Quick Setup
```bash
# 1. Clone repository
git clone https://github.com/your-org/dam-break-inundation.git
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
- **Memory Management**: Three.js geometries, materials, and textures must be disposed via `SceneManager.disposeHierarchy(node)` when switching models or destroying views.
- **API Contracts**: Backend contracts in `backend/app/main.py` and `backend/app/flood.py` are strictly versioned and backward-compatible.
