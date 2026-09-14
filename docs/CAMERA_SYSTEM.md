# Camera System — Constrained Engineering Camera

## 1. Design Philosophy
The 3D viewer is an engineering decision-support tool, **not** a free-flight arcade camera. Unconstrained orbit cameras cause catastrophic presentation failures:
- Users inadvertently rotating below the terrain plane and seeing hollow back-faces.
- Users clipping through the dam crest or mountains.
- Users getting disoriented in infinite black void.

The `CameraManager.js` enforces deterministic, bounds-aware constraints at all times.

## 2. Polar Angle Clamping
The camera orbit uses strict spherical coordinate constraints:
$$\theta_{\min} \approx 20^\circ \ (0.349\text{ rad}), \quad \theta_{\max} \approx 75^\circ \ (1.309\text{ rad})$$

- **$\theta_{\max} \le 75^\circ$**: Prevents the camera from sinking below ground or viewing the underside of the digital twin.
- **$\theta_{\min} \ge 20^\circ$**: Prevents looking straight down into the mathematical singularity / gimbal flip.

## 3. Dynamic Distance Bounds
Zoom extents are derived dynamically from the master model bounding sphere radius $R$:
$$\text{minDistance} = \max(12\text{m}, 0.28 \cdot R)$$
$$\text{maxDistance} = \max(120\text{m}, 3.6 \cdot R)$$

- **`minDistance`**: Guarantees users cannot zoom inside the dam mesh or clip through surfaces.
- **`maxDistance`**: Prevents drifting into the infinite void while keeping the catchment visible.

## 4. Bounds-Driven Camera Presets
Every preset is calculated programmatically from model extents $(S_x, S_y, S_z)$ and centroid $(C_x, C_y, C_z)$:

| Preset | Target | Camera Position | Perspective Purpose |
|---|---|---|---|
| **Overview** | Catchment Centroid | $[C_x + 0.68S, C_y + 0.58S, C_z + 0.72S]$ | Standard 45° isometric engineering view of the entire valley |
| **Dam** | Dam Crest Invert | $[C_x + 0.02S, C_y + 0.32S, C_z + 0.48S]$ | Upstream reservoir and spillway inspection view |
| **Valley** | Downstream Channel | $[C_x + 0.36S, C_y + 0.42S, C_z + 0.88S]$ | Downstream flood wave propagation vantage point |
| **Top** | Centroid | $[C_x + 0.01, C_y + 1.25S, C_z + 0.35S]$ | Plan-view GIS orientation (tilted safely within 20° polar bound) |

Transitions between presets execute via cubic easing (`easeInOutCubic`) over 900ms, ensuring smooth motion without abrupt snapping.
