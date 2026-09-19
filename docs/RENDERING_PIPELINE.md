# Rendering Pipeline — 3D Digital Twin (Roadmap)

> **Implementation Status Note**: In the current production release, the platform utilizes **Map-Based 2D Hydrodynamic Simulation** (Leaflet 2D GIS). This document specifies the architecture for the upcoming **3D Digital Twin Viewer** scheduled for a post-SIH update. See [`docs/3D_IMPLEMENTATION_ROADMAP.md`](file:///c:/Users/Lohith%20G/Downloads/SIH_WINNING_PROJECT/dam-break-inundation/docs/3D_IMPLEMENTATION_ROADMAP.md) for full implementation details.

## 1. Pipeline Overview
The 3D visualization is built on Three.js (r160+) using a modular, decoupled architecture:

```
                  Backend Asset Config
                           │
                           ▼
                   AssetLoader.js
             (scene.glb + scene.json)
                           │
       ┌───────────────────┼───────────────────┐
       ▼                   ▼                   ▼
SceneManager.js     CameraManager.js    LightingManager.js
(ACES ToneMapping, (Constrained Orbit,  (Dynamic Sun &
 Fog, Helpers)      Bounds Presets)      Shadow Frustum)
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
                 SimulationRenderer.js
                 & FloodAnimator.js
       (Depth Grids, Interp, Failure Modes)
```

## 2. Master GLB Ingestion
1. **Load**: `AssetLoader._loadGLTF()` loads `scene.glb` with optional Draco decompression.
2. **Normalization**:
   - Auto-centering: Origin aligned to centroid of `(minX + maxX)/2` and `(minZ + maxZ)/2`.
   - Ground alignment: Minimum bounding box Y is translated to `Y = 0.0`.
   - Bounding volume computation: Computes tight `Box3` and `Sphere`.
3. **PBR Material Optimization**:
   - Clamps imported material roughness (`0.4` to `0.95`).
   - Clamps metalness (`<= 0.3`) to prevent unrealistic metallic reflections on terrain and dam concrete.
   - Enforces `depthWrite: true` and `castShadow = true`, `receiveShadow = true`.
   - Sets `frustumCulled = true` on every mesh to eliminate off-screen draw calls.

## 3. Water Surface Simulation Mesh
- **Grid Plane**: A `THREE.PlaneGeometry(width, depth, cols - 1, rows - 1)` is generated directly matching the simulation resolution (`cols × rows`).
- **Data Binding**:
  - `pos[idx + 1] = baseElevation + depth * exaggeration` for wet cells (`depth > 0.05m`).
  - Dry cells are submerged beneath terrain (`Y = -15m`) or given zero alpha to eliminate visual artifacts.
- **Color Palettes**:
  - **Realistic**: Soft water blue with depth-based darkening.
  - **Depth**: Multi-tier USGS/HEC-RAS heatmap ramp (0.5m → 8m+).
  - **Velocity**: Hydrodynamic velocity heatmap (0 → 6+ m/s) when `velocity_grids` are present.
  - **Arrival**: Chronological arrival heatmap based on timestep of first inundation.
  - **Risk**: Hydraulic danger index (`depth × velocity`).

## 4. Sub-frame Linear Interpolation
Between consecutive snapshot timesteps $t_k$ and $t_{k+1}$, vertex positions and velocities are linearly interpolated:
$$h(t) = (1 - \alpha) h_k + \alpha h_{k+1}, \quad \alpha = \frac{t - t_k}{t_{k+1} - t_k}$$
This produces fluid 60 FPS water movement from discrete 5-minute hydrodynamic output frames.
