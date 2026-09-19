# Simulation Pipeline — Hydrodynamic Solver & Failure Physics

## 1. Mathematical Formulation
The backend calculates dam-break outflow hydrographs and 2D flood wave routing using empirical breach mechanics coupled with the 2D diffusive wave shallow-water equations.

### Breach Formation Mechanics
Peak outflow $Q_p$ and breach geometry are computed using peer-reviewed formulations:
- **Froehlich (2008)**:
  $$Q_p = 0.607 V_w^{0.295} h_w^{1.24}$$
  $$B_{avg} = 0.27 K_o V_w^{0.32} h_b^{0.04}, \quad t_f = 63.2 \sqrt{\frac{V_w}{g h_b^2}}$$
- **Von Thun & Gillette (1990)**:
  $$B_{avg} = 2.5 h_w + C_b, \quad t_f = \frac{B_{avg}}{4 h_w} \text{ or } \frac{B_{avg}}{2 h_w + 10}$$

### Hydrodynamic Wave Routing
Flood wave propagation over digital elevation models (DEM) is solved via the 2D Diffusive Wave equation:
$$\frac{\partial h}{\partial t} + \frac{\partial (uh)}{\partial x} + \frac{\partial (vh)}{\partial y} = q$$
where flow velocities $u$ and $v$ satisfy Manning's friction law:
$$u = \frac{1}{n} R^{2/3} S_{fx}^{1/2}, \quad v = \frac{1}{n} R^{2/3} S_{fy}^{1/2}$$

## 2. The Four Failure Modes
Every failure mode uses the identical hydrodynamic conservation solver while modeling distinct initiation kinetics:

| Failure Mode | Physical Mechanism | Outflow Characteristics | Inundation & Wavefront Characteristics |
|---|---|---|---|
| **Overtopping** | Extreme inflow exceeds crest; headcut erosion advances from downstream toe upward. | Prolonged hydrograph with delayed peak; slower formation time. | Gradual, wide downstream water advance with prolonged inundation duration. *(3D: Overtopping sheet spilling over crest)* |
| **Piping (Internal Erosion)** | High hydraulic gradient causes backward conduit erosion through embankment core. | Moderate formation time; sediment-laden early seepage. | Concentrated flood wave issuing from base, accelerating rapidly into main river reach. *(3D: Bottom jet at dam toe)* |
| **Structural Collapse** | Concrete monolith sliding, overturn, or sudden shear wall rupture. | Immediate, violent peak outflow discharge. | Sudden, high-energy surge wave traveling with steep wavefront gradient downstream. *(3D: Monolith displacement and shockwave)* |
| **Earthquake / Seismic** | Ground motion causes foundation liquefaction, crest settlement, or transverse cracking. | Rapid breach formation following seismic shaking. | Rapid multidirectional inundation pulse overwhelming proximate settlements. *(3D: Seismic ground motion tremors)* |

## 3. Zero-Fabrication Rule
- Inundation contours and depths are derived cell-by-cell from `depth_grids[t][r][c]`.
- Arrival times represent the exact numerical timestep where water depth $h > 0.05\text{ m}$.
- Velocity grids are computed directly from unit-discharge conservation equations ($V = \sqrt{q_x^2 + q_y^2} / h$), never from procedural approximations.
- Smooth GIS vector contours are topologically unified from raster shapes (`rasterio` + `shapely`) without polar angle sorting artifacts.

