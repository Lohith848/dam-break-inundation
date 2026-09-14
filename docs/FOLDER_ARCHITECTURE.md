# Folder Architecture — Repository Structure

```
dam-break-inundation/
├── backend/                        # FastAPI Hydrodynamic Simulation Service
│   ├── app/
│   │   ├── main.py                 # Core API endpoints & SSE simulation stream
│   │   ├── flood.py                # 2D Diffusive wave numerical routing solver
│   │   ├── breach.py               # Froehlich & Von Thun breach models
│   │   ├── failure_modes.py        # Mode kinetics (Overtopping, Piping, etc.)
│   │   ├── assets_api.py           # Digital-twin asset discovery & reload
│   │   ├── sim_cache.py            # Result caching & lookup
│   │   ├── ai_copilot.py           # Groq LLM integration
│   │   └── routing.py              # Hydraulic routing algorithms
│   ├── tests/                      # Pytest suite (54 test cases)
│   └── requirements.txt            # Python dependencies
│
├── frontend/                       # Vite + Three.js + Leaflet Client
│   ├── index.html                  # Main application DOM & toolbars
│   ├── app.js                      # Application controller & state coordination
│   ├── style.css                   # Responsive dark-theme engineering styling
│   ├── dashboard.js                # 8 zero-fabrication metrics drawer
│   ├── failure_mode_animations.js  # Mode-specific visual failure progression
│   ├── three_viewer.js             # 3D Digital Twin facade
│   ├── viewer/                     # Modular Three.js subsystems
│   │   ├── SceneManager.js         # Scene lifecycle, fog, and render loop
│   │   ├── CameraManager.js        # Constrained polar engineering camera
│   │   ├── AssetLoader.js          # Master GLB loader & normalization
│   │   ├── LightingManager.js      # Dynamic sun & bounds-adapted shadows
│   │   ├── SimulationRenderer.js   # Dynamic water surface mesh & heatmaps
│   │   ├── FloodAnimator.js        # Timeline failure effect coordinator
│   │   ├── TerrainManager.js       # Ground mesh owner & raycaster
│   │   ├── DamManager.js           # Dam structure management
│   │   ├── RiverManager.js         # River flow management
│   │   ├── AnimationManager.js     # Timestep playback controller
│   │   ├── UIController.js         # Viewport overlays & drawer toggles
│   │   └── ViewerState.js          # Reactive observable viewer state
│   ├── vite.config.js              # Vite bundler & reverse proxy config
│   └── package.json                # Frontend npm configuration
│
├── public/                         # Static Assets Root
│   └── assets/
│       ├── master/                 # Unified digital twin GLB models
│       │   └── scene.glb
│       ├── metadata/               # Spatial anchors & lighting configs
│       │   └── scene.json
│       ├── draco/                  # WebAssembly Draco decoders
│       └── shaders/                # GLSL shader modules
│
└── docs/                           # Technical Documentation Suite
    ├── DEVELOPER_GUIDE.md
    ├── RENDERING_PIPELINE.md
    ├── SIMULATION_PIPELINE.md
    ├── CAMERA_SYSTEM.md
    ├── ASSET_PIPELINE.md
    ├── FOLDER_ARCHITECTURE.md
    ├── PERFORMANCE_GUIDE.md
    ├── BACKEND_INTEGRATION.md
    ├── DEPLOYMENT_GUIDE.md
    └── CONTRIBUTION_GUIDE.md
```
