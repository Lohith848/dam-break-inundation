# Performance Guide — 60 FPS Desktop / 30 FPS Integrated GPU (Roadmap)

> **Implementation Status Note**: In the current production release, the platform operates in a **Map-Based 2D Hydrodynamic Simulation** mode, rendering smooth topological vector polygons at a locked 60 FPS via Leaflet canvas/vector rendering. This document specifies GPU optimizations for the upcoming **3D Digital Twin Viewer** scheduled for a post-SIH update. See [`docs/3D_IMPLEMENTATION_ROADMAP.md`](file:///c:/Users/Lohith%20G/Downloads/SIH_WINNING_PROJECT/dam-break-inundation/docs/3D_IMPLEMENTATION_ROADMAP.md) for full implementation details.

## 1. Performance Targets
- **Desktop (Dedicated GPU)**: Stable 60 FPS under full simulation playback.
- **Laptop / Integrated GPU (Intel Iris / AMD Radeon Vega)**: Stable 30+ FPS without thermal throttling.
- **Initial Load Time**: Under 2.0 seconds over standard broadband.

## 2. Implemented Optimizations

### Renderer Pixel Ratio Clamp
High-DPI retina displays (e.g. 3x or 4x) cripple GPU fill-rate. The renderer clamps pixel ratio to a maximum of 2:
```javascript
this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
```

### Frustum Culling
Frustum culling is enabled on all meshes loaded by `AssetLoader`:
```javascript
child.frustumCulled = true;
```
Objects outside the camera viewing pyramid are culled on the CPU before GPU draw calls are issued.

### Shadow Camera Bounds Adaptation
Instead of a massive shadow frustum (which wastes shadow map resolution), `LightingManager.adjustToSceneBounds(bounds)` adapts shadow camera extents tightly to the bounding radius of the model, maximizing shadow sharpness while avoiding wasted draw calls.

### Recursive Resource Disposal
Three.js does not automatically garbage-collect GPU buffers when JavaScript references are removed. `SceneManager.disposeHierarchy(root)` traverses the tree and explicitly calls:
- `geometry.dispose()`
- `material.dispose()`
- `material.map.dispose()`, `normalMap.dispose()`, `roughnessMap.dispose()`

### Sub-frame Interpolation Efficiency
`SimulationRenderer.updateFrame(frameIndex, fraction)` modifies existing typed buffer arrays (`Float32Array`) in-place rather than allocating new geometries, avoiding GC pauses during animation playback.
