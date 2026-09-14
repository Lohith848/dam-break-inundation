"""
routing.py
----------
2D flood-routing engine using the SIMPLIFIED / DIFFUSIVE-WAVE approximation
of the shallow water equations — the same class of simplification used by
established rapid-flood-inundation models such as LISFLOOD-FP (Bates et al.,
2010) when the full dynamic (inertial) terms are dropped for speed/stability.

Governing idea (per cell-edge, explicit finite-difference in time):

    hflow = max(H_a, H_b) - max(z_a, z_b)          (flow depth at the edge)
    q     = (1/n) * hflow^(5/3) * sqrt(|dH|/dx)    (Manning-type unit discharge)
    dV    = q * edge_width * dt                    (volume moved this step)

where H = water-surface elevation (z + h), n = Manning's roughness, dx = cell
size. Flow moves from the higher water-surface cell to the lower one; volume
is conserved between adjacent cells every step.

This is intentionally the SAME physics family used by real inundation tools,
simplified enough to run in pure NumPy for a hackathon prototype. Swap this
module out for ANUGA / HEC-RAS 2D / LISFLOOD-FP for a validated, defensible
result before presenting flood-hazard numbers to any real authority.
"""

import numpy as np
from math import sqrt as math_sqrt

G = 9.81


def _edge_flux(H_a, H_b, z_a, z_b, manning_n, edge_width, dx, dt):
    """Volume flux (m^3) moved from cell a -> cell b this timestep (can be negative)."""
    dH = H_a - H_b
    hflow = np.maximum(H_a, H_b) - np.maximum(z_a, z_b)
    hflow = np.clip(hflow, 0.0, None)

    with np.errstate(invalid="ignore", divide="ignore"):
        q = np.sign(dH) * (1.0 / manning_n) * (hflow ** (5.0 / 3.0)) * np.sqrt(np.abs(dH) / dx)
    q = np.nan_to_num(q)

    return q * edge_width * dt


def _limit_fluxes_to_available_volume(flux_h, flux_v, h, cell_area, safety=0.9):
    """
    Mass-conservation limiter.

    A cell can have up to 4 edges trying to drain it in the same step; capping
    each edge independently (against 90% of that cell's volume) is NOT enough
    because the caps don't know about each other and can jointly still drain
    more than the cell holds -> negative depth -> blow-up. Here we sum every
    outgoing request per cell and, if the total exceeds the safety fraction of
    that cell's stored volume, scale ALL of that cell's outgoing edges down
    proportionally (a standard limiter in explicit flood-routing schemes).
    """
    ny, nx = h.shape
    outgoing = np.zeros_like(h)
    outgoing[:, :-1] += np.clip(flux_h, 0, None)   # a=(i,j) sending to the right
    outgoing[:, 1:] += np.clip(-flux_h, 0, None)   # b=(i,j+1) sending to the left
    outgoing[:-1, :] += np.clip(flux_v, 0, None)   # c=(i,j) sending downward
    outgoing[1:, :] += np.clip(-flux_v, 0, None)   # d=(i+1,j) sending upward

    available = h * cell_area
    scale = np.ones_like(h)
    mask = outgoing > 1e-9
    scale[mask] = np.minimum(1.0, (safety * available[mask]) / outgoing[mask])

    flux_h_scaled = np.where(flux_h >= 0, flux_h * scale[:, :-1], flux_h * scale[:, 1:])
    flux_v_scaled = np.where(flux_v >= 0, flux_v * scale[:-1, :], flux_v * scale[1:, :])
    return flux_h_scaled, flux_v_scaled


def run_flood_routing(dem: np.ndarray, dx: float, source_cells: list,
                       hydrograph_times: np.ndarray, hydrograph_q: np.ndarray,
                       manning_n: float = 0.045, dt_max: float = 2.0,
                       total_time_s: float = 3 * 3600, snapshot_interval_s: float = 300.0,
                       courant_alpha: float = 0.4, dt_min: float = 0.05,
                       return_velocities: bool = False):
    """
    Run the explicit 2D diffusive-wave flood routing simulation with an
    ADAPTIVE timestep (Courant-type control, as used in LISFLOOD-FP /
    Hunter et al. 2005): dt is shrunk automatically when depths/velocities
    are high, and relaxed back up to dt_max when the flow has calmed down.
    This is what keeps an explicit scheme like this numerically stable
    without the user having to hand-tune dt for every dam/DEM.

    Parameters
    ----------
    dem : (ny, nx) elevation array (m)
    dx  : square cell size (m)
    source_cells : list of (row, col) indices — the breach hydrograph's total
                   discharge is split evenly across these cells, representing
                   the physical breach width rather than a single grid point
    hydrograph_times, hydrograph_q : breach hydrograph (s, m3/s) from breach.py
    manning_n : channel/floodplain roughness coefficient (typical 0.03-0.06)
    dt_max, dt_min : timestep bounds (s)
    total_time_s : total simulated time (s)
    snapshot_interval_s : how often to save a depth-grid snapshot (s)
    return_velocities : if True, also returns list of (ny, nx) velocity arrays (m/s)

    Returns
    -------
    snap_times : list of snapshot times (s)
    snapshots  : list of (ny, nx) depth arrays (m) at each snapshot time
    (optional) velocity_snapshots : list of (ny, nx) velocity arrays (m/s)
    """
    ny, nx = dem.shape
    z = dem
    h = np.zeros_like(dem)
    cell_area = dx * dx
    n_source = len(source_cells)

    t = 0.0
    next_snap = 0.0
    snap_times = []
    snapshots = []
    velocity_snapshots = []

    while t < total_time_s:
        # --- adaptive timestep: shrink when depths are large (fast waves) ---
        h_max = float(h.max())
        if h_max > 1e-6:
            dt = min(dt_max, max(dt_min, courant_alpha * dx / math_sqrt(G * h_max)))
        else:
            dt = dt_max

        # --- inject breach inflow, split across the breach-width source cells ---
        q_in = float(np.interp(t, hydrograph_times, hydrograph_q, left=0.0, right=0.0))
        q_per_cell = q_in / n_source
        for (sy, sx) in source_cells:
            h[sy, sx] += (q_per_cell * dt) / cell_area

        H = z + h

        # --- horizontal (east-west) edges ---
        flux_h = _edge_flux(H[:, :-1], H[:, 1:], z[:, :-1], z[:, 1:], manning_n, edge_width=dx, dx=dx, dt=dt)
        # --- vertical (north-south) edges ---
        flux_v = _edge_flux(H[:-1, :], H[1:, :], z[:-1, :], z[1:, :], manning_n, edge_width=dx, dx=dx, dt=dt)

        flux_h, flux_v = _limit_fluxes_to_available_volume(flux_h, flux_v, h, cell_area)

        # --- apply updates (volume conserving) ---
        dvol = np.zeros_like(h)
        dvol[:, :-1] -= flux_h
        dvol[:, 1:] += flux_h
        dvol[:-1, :] -= flux_v
        dvol[1:, :] += flux_v

        h += dvol / cell_area
        h = np.clip(h, 0.0, None)  # numerical safety net

        t += dt
        if t >= next_snap:
            snapshots.append(h.copy())
            snap_times.append(t)
            if return_velocities:
                dt_safe = max(dt, 1e-6)
                qx = np.zeros_like(h)
                qy = np.zeros_like(h)
                qx[:, :-1] += 0.5 * np.abs(flux_h) / (dx * dt_safe)
                qx[:, 1:] += 0.5 * np.abs(flux_h) / (dx * dt_safe)
                qy[:-1, :] += 0.5 * np.abs(flux_v) / (dx * dt_safe)
                qy[1:, :] += 0.5 * np.abs(flux_v) / (dx * dt_safe)
                h_wet = np.maximum(h, 0.05)
                vel = np.where(h > 0.05, np.sqrt(qx**2 + qy**2) / h_wet, 0.0)
                vel = np.clip(vel, 0.0, 25.0)
                velocity_snapshots.append(vel.copy())
            next_snap += snapshot_interval_s

    if return_velocities:
        return snap_times, snapshots, velocity_snapshots
    return snap_times, snapshots


def summarize_results(snap_times, snapshots, dx, points_of_interest=None, arrival_threshold_m=0.3):
    """
    Compute headline disaster-management metrics from the simulation output:
      - maximum inundated area (km^2)
      - maximum flood depth anywhere in the domain (m)
      - arrival time & peak depth at each named point of interest (e.g. villages)
    """
    cell_area_km2 = (dx * dx) / 1e6
    max_depth_grid = np.maximum.reduce(snapshots)
    max_area_km2 = float(np.sum(max_depth_grid > 0.1) * cell_area_km2)
    max_depth_m = float(np.max(max_depth_grid))

    poi_results = []
    if points_of_interest:
        for poi in points_of_interest:
            name, (r, c) = poi["name"], poi["cell"]
            depths_over_time = [snap[r, c] for snap in snapshots]
            arrival_t = None
            for t, d in zip(snap_times, depths_over_time):
                if d >= arrival_threshold_m:
                    arrival_t = t
                    break
            poi_results.append({
                "name": name,
                "cell": [int(r), int(c)],
                "cell_3d": [int(r // 2), int(c // 2)],
                "arrival_time_min": None if arrival_t is None else round(arrival_t / 60.0, 1),
                "peak_depth_m": round(float(max(depths_over_time)), 2),
            })

    return {
        "max_inundated_area_km2": round(max_area_km2, 3),
        "max_flood_depth_m": round(max_depth_m, 2),
        "points_of_interest": poi_results,
    }
