# Folder Architecture — Repository Structure

```
dam-break-inundation/
├── backend/                        # FastAPI Hydrodynamic Simulation Service
│   ├── app/
│   │   ├── main.py                 # Core API endpoints & SSE simulation stream
│   │   ├── flood.py                # 2D Diffusive wave routing solver & smooth polygon extractor
│   │   ├── routing.py              # Hydraulic routing algorithms & Saint-Venant solver
│   │   ├── breach.py               # Froehlich & MacDonald empirical breach kinetics
│   │   ├── failure_modes.py        # Piping, Overtopping, Structural, Earthquake profiles
│   │   ├── report_engine.py        # CWC 13-section official government PDF report generator
│   │   ├── dem.py                  # GeoTIFF raster operations & elevation slicing
│   │   ├── dem_fetcher.py          # OpenTopography Copernicus 30m DEM loader & cache
│   │   ├── compare.py              # Multi-scenario breach comparative analysis
│   │   ├── weather.py              # Live Open-Meteo rainfall telemetry
│   │   ├── progress.py             # SSE job queue & step-by-step progress streamer
│   │   ├── sim_cache.py            # Result caching & fast hash-based lookup
│   │   ├── validation.py           # Strict spatial bounds & numeric parameter validation
│   │   └── ai/
│   │       ├── groq_client.py      # Groq LPU API client with retry & streaming
│   │       └── prompts.py          # Civil/hydraulic engineering system prompts
│   ├── tests/                      # Pytest automated test suite (54 test cases)
│   └── requirements.txt            # Python backend dependencies
│
├── frontend/                       # Vite + Leaflet 2D GIS Client
│   ├── index.html                  # Main application layout, sidebar, and GIS map stage
│   ├── app.js                      # Application state controller, Leaflet player, time scrubber
│   ├── ai_panel.js                 # Floating bottom-corner Groq AI Copilot drawer & chat
│   ├── style.css                   # Enterprise dark-theme GIS design system
│   ├── vite.config.js              # Vite bundler & reverse proxy configuration
│   ├── package.json                # Frontend npm configuration
│   └── viewer/                     # 3D Digital Twin Engine (Post-SIH update)
│
├── datasets/                       # Hydrological & Geospatial Datasets
│   ├── dam/                        # 6,644 National Dams GeoJSON & Mettur calibration data
│   ├── dem/                        # Copernicus 30m / SRTM elevation rasters
│   ├── river/                      # River reach vectors
│   └── villages/                   # Downstream settlement population points
│
├── DEVELOPER_DOCUMENTATION.md      # Comprehensive technical developer documentation
│
└── docs/                           # Technical Documentation Suite
    ├── 3D_IMPLEMENTATION_ROADMAP.md# Post-SIH 3D Digital Twin upgrade roadmap
    ├── ARCHITECTURE.md             # Subsystem design & data pipeline
    ├── DEVELOPER_GUIDE.md          # Architecture, workflows, and developer conventions
    ├── SIMULATION_PIPELINE.md      # 2D diffusive wave solver and breach mechanics
    ├── HYDRODYNAMICS.md            # Equations & mathematical proofs
    ├── API_REFERENCE.md            # REST API & SSE specification
    ├── DATASETS.md                 # Geospatial dataset details
    ├── FOLDER_ARCHITECTURE.md      # Full repository directory breakdown
    ├── RENDERING_PIPELINE.md       # Master GLB ingestion & water shaders (Roadmap)
    ├── CAMERA_SYSTEM.md            # Constrained orbit geometry & bounds presets (Roadmap)
    ├── ASSET_PIPELINE.md           # Digital-twin asset discovery & scene schema (Roadmap)
    ├── PERFORMANCE_GUIDE.md        # 60 FPS desktop / 30 FPS integrated GPU optimizations
    ├── BACKEND_INTEGRATION.md      # REST API endpoints and SSE stream contracts
    ├── DEPLOYMENT_GUIDE.md         # Local staging and Docker containerization
    └── CONTRIBUTION_GUIDE.md       # Scientific integrity standards and PR workflows
```
