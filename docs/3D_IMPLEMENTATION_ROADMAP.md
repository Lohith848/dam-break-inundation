# 3D Digital Twin Implementation Roadmap (Post-SIH Architecture)

**Dam Break Inundation Modeling Platform — Future 3D Digital Twin Specification**  
*Document Version: 2.0 (Post-SIH Integration Roadmap)*

---

## 1. Overview & Objective

During the Smart India Hackathon (SIH26161), the platform operates exclusively in a **Map-First 2D GIS** mode to maximize real-time stability, accessibility on mobile/low-spec devices, and deterministic hydraulic accuracy.

This document establishes the architecture for reactivating and upgrading the **3D Digital Twin Viewer** after SIH without altering the core 2D hydraulic solver or simulation engine pipelines.

---

## 2. Digital Twin Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        3D Digital Twin Subsystem                       │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Three.js Scene Graph & WebGL Renderer                         │   │
│   │ - Custom PBR Shaders & Dynamic Sun Lighting                    │   │
│   │ - Atmospheric Fog & Skybox (EXR / HDR)                         │   │
│   └───────────────▲───────────────────────────────▲────────────────┘   │
│                   │                               │                    │
│   ┌───────────────┴───────────────┐ ┌─────────────┴────────────────┐   │
│   │ Procedural Terrain Surface    │ │ Photorealistic Dam GLB       │   │
│   │ - 3D Mesh from DEM Array      │ │ - LOD0 (Crest, Sluice Gates) │   │
│   │ - Satellite Texture Mapping   │ │ - LOD1 (Far-field geometry)  │   │
│   │ - Displacement Shader         │ │ - Dynamic Breach Geometry    │   │
│   └───────────────▲───────────────┘ └─────────────▲────────────────┘   │
│                   │                               │                    │
│   ┌───────────────┴───────────────────────────────┴────────────────┐   │
│   │ Dynamic Water Surface Shader (GLSL)                           │   │
│   │ - Vertex displacement driven by simulation depth_grids        │   │
│   │ - Screen Space Reflections (SSR) & Foam wave front            │   │
│   │ - Normal mapped caustics and wave perturbation                │   │
│   └───────────────────────────────▲────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────┴────────────────────────────────┐   │
│   │ Animation & Camera Controller                                 │   │
│   │ - OrbitControls with ground collision detection               │   │
│   │ - Cinematic Fly-Through Keyframes (Dam -> Village 1 -> 2)      │   │
│   │ - Synchronized timeline playback (shared with 2D Leaflet map)  │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Asset Loading & GLB Pipeline

### 3.1 Model Hierarchy & Category Folders
Assets are stored under `public/assets/` and auto-discovered by the backend asset API:
- `public/assets/dams/`: High-resolution GLB models of concrete gravity, earthen, and arch dams.
- `public/assets/terrain/`: Pre-baked terrain GLB tiles or raw GeoTIFF elevation files.
- `public/assets/buildings/`: Instanced settlement models (houses, schools, hospitals).
- `public/assets/vegetation/`: GPU-instanced tree and shrub clusters.

### 3.2 GLTF/GLB Optimization Standards
- **DRACO Mesh Compression:** Apply Draco compression for 80% geometry size reduction.
- **KTX2 / Basis Universal Textures:** Texture compression for reduced GPU VRAM consumption.
- **Polycount Limits:**
  - Dam structure: $< 60,000$ triangles.
  - Surrounding terrain mesh: $120 \times 120$ vertices ($28,800$ triangles).

---

## 4. Terrain & Water Shader Implementation

### 4.1 DEM Terrain Generation
The terrain geometry is procedurally generated directly from `sim_data.dem_bounds` and the DEM elevation matrix $Z$:
```javascript
const geometry = new THREE.PlaneGeometry(widthMeters, heightMeters, cols - 1, rows - 1);
const pos = geometry.attributes.position;
for (let i = 0; i < pos.count; i++) {
  const r = Math.floor(i / cols);
  const c = i % cols;
  pos.setZ(i, demGrid[r][c]); // Elevation Z
}
geometry.computeVertexNormals();
```

### 4.2 Dynamic Water Surface Shader (GLSL)
The water surface is rendered as an animated elevation plane where elevation $Z_{\text{water}}(x, y) = Z_{\text{terrain}}(x, y) + h(x, y, t)$:
```glsl
// Vertex Shader (Snippet)
uniform sampler2D uDepthTexture;
uniform sampler2D uTerrainTexture;
varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vUv = uv;
  float terrainZ = texture2D(uTerrainTexture, uv).r;
  float waterDepth = texture2D(uDepthTexture, uv).r;
  
  vec3 displacedPosition = position;
  if (waterDepth > 0.05) {
    displacedPosition.z = terrainZ + waterDepth;
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displacedPosition, 1.0);
}
```

---

## 5. 3D Flood Animation & Timeline Synchronization

The 3D animation timeline links directly to the existing `mapPlayer` state:
- When the user drags `#playerTimeline` or presses Play in 2D mode, the 3D viewer interpolates between frame textures:
  $$\text{Depth}(t) = (1 - \alpha) \cdot \text{Depth}_k + \alpha \cdot \text{Depth}_{k+1}$$
- **Color Coding:** The fragment shader uses the exact same color ramps as 2D Leaflet:
  - Shallow: `#26c6da` (Cyan)
  - Moderate: `#2196f3` (Blue)
  - Deep: `#e65100` (Orange)
  - Critical: `#d50000` (Red)

---

## 6. Split-View (Dual 2D/3D Mode)

When reactivated:
1. The `#workspace` splits into two synchronized panels:
   - Left: Leaflet 2D GIS Map (Spatial context, POI markers, layer toggles).
   - Right: Three.js 3D Viewport (Photorealistic flood wave and structure visualization).
2. Camera synchronization:
   - Panning the 2D map translates the 3D target coordinates.
   - Tilting in 3D adjusts the 2D directional cone.

---

## 7. Performance Strategy & Target Benchmarks

- **Target Framerate:** Solid 60 FPS on mid-range GPUs (Intel Iris Xe / GTX 1650).
- **Draw Call Budget:** Under 65 draw calls per frame using GPU geometry instancing.
- **Adaptive Resolution:** Automatic dynamic scaling (0.75x to 1.0x) if framerate drops below 45 FPS.
- **Memory Footprint:** Under 180 MB GPU VRAM for the entire 3D scene.
