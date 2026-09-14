# Asset Pipeline — Digital Twin Ingestion & Metadata Architecture

## 1. Directory Architecture
Assets are structured cleanly inside `public/assets/`:
```
public/assets/
  ├── master/
  │   └── scene.glb             # Master digital twin GLB model (~1.94 MB)
  ├── metadata/
  │   └── scene.json            # Spatial anchors, camera presets, breach origin
  ├── dams/                     # Dam-specific models (for per-dam switching)
  ├── terrain/                  # Terrain tiles / DEMs
  ├── textures/                 # Normal maps, ripple textures
  ├── shaders/                  # GLSL vertex & fragment sources
  └── draco/                    # WebAssembly Draco decoders
```

## 2. Metadata Schema (`metadata/scene.json`)
The metadata file eliminates hardcoded coordinates in JavaScript:
```json
{
  "name": "Master Digital Twin Scene",
  "version": "1.0.0",
  "model_url": "/public/assets/master/scene.glb",
  "auto_compute_bounds": true,
  "camera_presets": {
    "overview": {
      "relative_position": { "x": 1.2, "y": 1.0, "z": 1.4 },
      "relative_target": { "x": 0.0, "y": 0.1, "z": 0.0 }
    },
    "dam": {
      "relative_position": { "x": 0.0, "y": 0.5, "z": 0.6 },
      "relative_target": { "x": 0.0, "y": 0.25, "z": 0.0 }
    }
  },
  "spatial_anchors": {
    "dam_position": { "x": 0.0, "y": 0.2, "z": 0.0 },
    "reservoir_position": { "x": 0.0, "y": 0.25, "z": -0.6 },
    "river_direction": { "x": 0.0, "y": -0.05, "z": 1.0 },
    "breach_origin": { "x": 0.0, "y": 0.18, "z": 0.05 }
  }
}
```

## 3. Dynamic Dam Switching
When a new dam is selected:
1. `Flood3DViewer.loadNewScene(url, metadata)` is invoked.
2. The current scene hierarchy is recursively disposed (`disposeHierarchy`), releasing geometries, materials, and WebGL buffers.
3. The new model is loaded, centered, ground-aligned, and framed automatically.
4. Camera constraints adapt instantly to the new model's bounding radius.
