# Hydrodynamic Physics & Breach Mathematics — SIH26161

## 1. Dam Breach Empirical Regressions (Froehlich 1995/2008)

The initial breach hydrograph parameters are computed using empirical regression equations published by Dr. David C. Froehlich based on historical dam failure observations.

### Peak Outflow Discharge ($Q_p$)

For **Piping Failure**:
$$Q_p = 0.607 \cdot V_{w}^{0.295} \cdot H_{w}^{1.24}$$

For **Overtopping Failure**:
$$Q_p = 0.705 \cdot V_{w}^{0.295} \cdot H_{w}^{1.24}$$

Where:
- $Q_p$: Peak breach outflow discharge ($\text{m}^3/\text{s}$)
- $V_w$: Reservoir volume at failure ($\text{m}^3$)
- $H_w$: Height of water above breach invert ($\text{m}$)

### Average Breach Width ($B_{avg}$)

$$B_{avg} = 0.27 \cdot K_o \cdot V_{w}^{0.32} \cdot H_{b}^{0.19}$$

Where:
- $B_{avg}$: Average breach width ($\text{m}$)
- $K_o$: Failure mode factor ($1.0$ for piping, $1.3$ for overtopping)
- $H_b$: Height of breach ($\text{m}$)

### Breach Formation Time ($t_f$)

$$t_f = 63.2 \cdot \sqrt{\frac{V_w}{g \cdot H_{b}^2}}$$

Where:
- $t_f$: Time of breach formation ($\text{seconds}$)
- $g$: Acceleration due to gravity ($9.81 \text{ m/s}^2$)

---

## 2. 2D Diffusive-Wave Hydrodynamic Flood Routing

Downstream inundation propagation is governed by the 2D Shallow Water Equations under the **diffusive wave approximation**, neglecting inertia terms for stability and rapid convergence across complex DEM terrain grids.

### Continuity Equation (Conservation of Mass)

$$\frac{\partial h}{\partial t} + \frac{\partial (h u)}{\partial x} + \frac{\partial (h v)}{\partial y} = q_{in}$$

Where:
- $h$: Water depth ($\text{m}$)
- $u, v$: Flow velocities in $x$ and $y$ directions ($\text{m/s}$)
- $q_{in}$: External inflow / lateral inflow ($\text{m/s}$)

### Momentum Equation (Diffusive Wave Approximation)

Neglecting local and convective acceleration:
$$S_{fx} = S_{ox} - \frac{\partial h}{\partial x}$$
$$S_{fy} = S_{oy} - \frac{\partial h}{\partial y}$$

Where:
- $S_{fx}, S_{fy}$: Friction slopes in $x, y$ directions
- $S_{ox}, S_{oy}$: Bed slopes ($\partial z / \partial x, \partial z / \partial y$)

### Flow Velocity (Manning Equation)

$$u = \frac{1}{n} R_h^{2/3} S_{fx}^{1/2} \cdot \text{sgn}\left(-\frac{\partial Z}{\partial x}\right)$$
$$v = \frac{1}{n} R_h^{2/3} S_{fy}^{1/2} \cdot \text{sgn}\left(-\frac{\partial Z}{\partial y}\right)$$

Where:
- $n$: Manning's roughness coefficient ($\text{s/m}^{1/3}$, typically $0.035$ to $0.050$)
- $R_h$: Hydraulic radius ($\approx h$ for wide unconfined shallow flow)
- $Z = z + h$: Water surface elevation above datum ($\text{m}$)

### Numerical Stability & Courant Condition (CFL)

To prevent numerical dispersion and instabilities, the adaptive time-step $\Delta t$ is bounded by:

$$\Delta t \le C_{FL} \cdot \frac{\Delta x}{\sqrt{g \cdot h_{max}} + \max(|u|, |v|)}$$

With Courant number $C_{FL} \le 0.5$.
