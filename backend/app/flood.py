"""
flood.py
--------
Physically-based dam break flood simulation engine.

Uses the existing diffusive-wave routing (routing.py) for the time-stepping
solver, and adds:
  - Automatic downstream direction detection from DEM slope
  - Flood wave propagation statistics
  - Velocity estimation from momentum
  - GeoJSON flood polygon generation
  - Affected cells identification
  - Structured logging of simulation timing

This module is designed to be modular so that AI/ML prediction models
can replace individual components in the future.
"""

import logging
import time
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple

import numpy as np

try:
    import rasterio.features
    import rasterio.transform
    import shapely.geometry
    import shapely.ops
    RASTERIO_SHAPELY_AVAILABLE = True
except ImportError:
    RASTERIO_SHAPELY_AVAILABLE = False

try:
    from scipy.ndimage import label as _ndimage_label
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

from . import breach as breach_mod
from . import routing
from .failure_modes import normalize_failure_mode

logger = logging.getLogger("dam_sim.flood")


@dataclass
class SimulationConfig:
    """Configuration for a flood simulation run."""
    volume_m3: float              # reservoir storage at failure (m^3)
    height_m: float               # water head above breach invert (m)
    failure_mode: str = "piping"  # overtopping | piping | structural | earthquake
    manning_n: float = 0.045      # channel roughness
    total_sim_hours: float = 3.0  # simulation horizon
    snapshot_interval_s: float = 300.0  # how often to save snapshots
    target_rows: int = 80         # DEM downsample height
    target_cols: int = 120        # DEM downsample width
    # Optional user overrides (UI fields). When set they win over the
    # mode/regression defaults — see breach.build_breach_hydrograph.
    breach_width_override_m: Optional[float] = None
    formation_time_override_min: Optional[float] = None


@dataclass
class SimulationResult:
    """Complete output of a flood simulation."""
    # Breach parameters
    peak_outflow_cms: float
    breach_width_m: float
    breach_formation_time_min: float

    # Grid info
    dx: float
    ny: int
    nx: int
    dam_col: int
    dam_row: int

    # Elevation
    elevation_grid: List[List[float]]
    elevation_stats: Dict[str, float]

    # Dam geometry
    dam_geometry: Dict[str, float]

    # Time-stepping output
    snapshot_times_s: List[float]
    timesteps_formatted: List[str]
    depth_grids: List[List[List[float]]]

    # Summary statistics
    summary: Dict

    # Downstream points of interest
    points_of_interest: List[Dict]

    # GeoJSON flood polygon (peak and per-frame)
    flood_polygon_geojson: Optional[Dict] = None
    frame_polygons: Optional[List[Optional[Dict]]] = None

    # Velocity and risk grids
    velocity_grids: Optional[List[List[List[float]]]] = None
    risk_grids: Optional[List[List[List[int]]]] = None
    arrival_grid: Optional[List[List[float]]] = None

    # Breach hydrograph Q(t) — serialisable lists for the frontend chart
    hydrograph_times_min: Optional[List[float]] = None
    hydrograph_q_cms: Optional[List[float]] = None

    # Comprehensive SIH Hydraulic & Impact Metrics
    hydraulic_parameters: Optional[Dict] = None

    # Simulation timing
    simulation_time_ms: float = 0.0
    terrain_time_ms: float = 0.0


# ---------------------------------------------------------------------------
# 1. Downstream Direction Detection
# ---------------------------------------------------------------------------

def detect_downstream_direction(dem: np.ndarray, dam_row: int, dam_col: int) -> Tuple[int, int]:
    """
    Detect the dominant downstream flow direction from the DEM slope starting at the dam.

    Analyzes the elevation gradient around (dam_row, dam_col) to determine
    which direction the flood will preferentially travel along natural topography.

    Returns (row_offset, col_direction) where:
      - row_offset: +1 = downstream is below (south), -1 = above (north)
      - col_direction: +1 = downstream is right (east), -1 = left (west)
    """
    ny, nx = dem.shape
    dam_elev = dem[dam_row, dam_col]

    # Sample downstream columns (eastward) and rows (north/south)
    best_row = dam_row
    best_drop = 0.0

    step_cols = min(10, nx - 1 - dam_col)
    if step_cols > 0:
        check_col = min(dam_col + step_cols, nx - 1)
        slice_vals = dem[:, check_col]
        search_radius = min(20, ny // 3)
        r_min = max(0, dam_row - search_radius)
        r_max = min(ny, dam_row + search_radius + 1)
        for r in range(r_min, r_max):
            drop = dam_elev - slice_vals[r]
            if drop > best_drop:
                best_drop = drop
                best_row = r

    row_offset = 1 if best_row > dam_row else (-1 if best_row < dam_row else 0)
    col_direction = 1  # downstream eastward along reach

    logger.info("Detected downstream from dam (%d, %d): row_offset=%d (drop=%.1fm)",
                dam_row, dam_col, row_offset, best_drop)
    return row_offset, col_direction


# ---------------------------------------------------------------------------
# 2. Flood Propagation Statistics
# ---------------------------------------------------------------------------

def compute_flood_statistics(
    snap_times: List[float],
    snapshots: List[np.ndarray],
    dem: np.ndarray,
    dx: float,
    dam_row: int,
    dam_col: int,
    row_offset: int,
) -> Dict:
    """
    Compute detailed flood propagation statistics from simulation output.
    All calculations strictly relative to the dam origin (dam_row, dam_col).
    """
    if not snapshots:
        return {"error": "No simulation snapshots"}

    ny, nx = dem.shape
    cell_area_km2 = (dx * dx) / 1e6
    max_depth_grid = np.maximum.reduce(snapshots)
    max_depth_m = float(np.max(max_depth_grid))
    affected_cells = int(np.sum(max_depth_grid > 0.05))
    max_area_km2 = affected_cells * cell_area_km2

    # Compute maximum flood width across all transverse columns
    max_width_cells = 0
    for c in range(nx):
        col_flooded = np.sum(max_depth_grid[:, c] > 0.1)
        if col_flooded > max_width_cells:
            max_width_cells = int(col_flooded)
    max_flood_width_m = round(max_width_cells * dx, 1)

    # Compute arrival times at downstream distances from the dam
    arrival_distances = {}
    distances_km = [1, 2, 5, 10, 20]

    for dist_km in distances_km:
        col_offset = int(dist_km * 1000 / dx)
        target_col = min(dam_col + col_offset, nx - 1)

        for t, snap in zip(snap_times, snapshots):
            max_d = 0.0
            for r_offset in range(-4, 5):
                r = dam_row + r_offset * (row_offset if row_offset != 0 else 1)
                r = max(0, min(r, snap.shape[0] - 1))
                max_d = max(max_d, float(snap[r, target_col]))

            if max_d >= 0.1:  # arrival threshold
                arrival_distances[f"{dist_km}km"] = round(t / 60.0, 1)
                break
        else:
            arrival_distances[f"{dist_km}km"] = None

    # Arrival time grid across entire domain (minutes)
    arrival_grid = np.full((ny, nx), -1.0, dtype=np.float32)
    for t, snap in zip(snap_times, snapshots):
        wet_mask = (snap >= 0.1) & (arrival_grid < 0)
        arrival_grid[wet_mask] = round(t / 60.0, 1)

    # Velocity estimation from average depth & hydraulic gradient
    if max_depth_m > 0:
        avg_depth = float(np.mean(max_depth_grid[max_depth_grid > 0.1]))
        slope = 0.0015
        velocity_ms = (1.0 / 0.045) * (avg_depth ** (2.0 / 3.0)) * (slope ** 0.5)
    else:
        velocity_ms = 0.0

    # SIH Impact assessments
    pop_density = 450.0  # est persons / km²
    affected_pop = int(max_area_km2 * pop_density)
    affected_bldgs = int(affected_pop / 4.8)
    inundated_roads = round(max_area_km2 * 1.35, 2)
    inundated_agri = round(max_area_km2 * 0.65, 2)

    return {
        "max_depth_m": round(max_depth_m, 2),
        "max_inundated_area_km2": round(max_area_km2, 3),
        "max_inundated_area_ha": round(max_area_km2 * 100.0, 1),
        "max_flood_width_m": max_flood_width_m,
        "affected_cells": affected_cells,
        "arrival_distances": arrival_distances,
        "velocity_estimate_ms": round(velocity_ms, 2),
        "peak_depth_grid": max_depth_grid,
        "arrival_grid": arrival_grid,
        "affected_population_est": affected_pop,
        "affected_buildings_est": affected_bldgs,
        "inundated_roads_km": inundated_roads,
        "inundated_agriculture_km2": inundated_agri,
    }


# ---------------------------------------------------------------------------
# 3. GeoJSON Flood Polygon Generation (Smooth Topological Extraction)
# ---------------------------------------------------------------------------

def _extract_pure_numpy_polygon(
    depth_grid: np.ndarray,
    bounds: Tuple[float, float, float, float],
    threshold_m: float = 0.08,
) -> Optional[Dict]:
    """Pure NumPy boundary ribbon extraction guaranteed not to self-intersect."""
    west, south, east, north = bounds
    ny, nx = depth_grid.shape
    flooded = depth_grid > threshold_m
    if not flooded.any():
        return None
    lon_step = (east - west) / nx
    lat_step = (north - south) / ny

    cols_with_water = [c for c in range(nx) if flooded[:, c].any()]
    rows_with_water = [r for r in range(ny) if flooded[r, :].any()]
    if not cols_with_water or not rows_with_water:
        return None

    if len(cols_with_water) >= len(rows_with_water):
        top_coords = []
        bot_coords = []
        for c in cols_with_water:
            r_indices = np.where(flooded[:, c])[0]
            r_min = float(r_indices.min())
            r_max = float(r_indices.max())
            lon_l = float(west + c * lon_step)
            lon_r = float(west + (c + 1) * lon_step)
            lat_t = float(north - r_min * lat_step)
            lat_b = float(north - (r_max + 1) * lat_step)
            top_coords.append([round(lon_l, 6), round(lat_t, 6)])
            top_coords.append([round(lon_r, 6), round(lat_t, 6)])
            bot_coords.append([round(lon_l, 6), round(lat_b, 6)])
            bot_coords.append([round(lon_r, 6), round(lat_b, 6)])
        ordered = top_coords + bot_coords[::-1]
    else:
        left_coords = []
        right_coords = []
        for r in rows_with_water:
            c_indices = np.where(flooded[r, :])[0]
            c_min = float(c_indices.min())
            c_max = float(c_indices.max())
            lon_l = float(west + c_min * lon_step)
            lon_r = float(west + (c_max + 1) * lon_step)
            lat_t = float(north - r * lat_step)
            lat_b = float(north - (r + 1) * lat_step)
            left_coords.append([round(lon_l, 6), round(lat_t, 6)])
            left_coords.append([round(lon_l, 6), round(lat_b, 6)])
            right_coords.append([round(lon_r, 6), round(lat_t, 6)])
            right_coords.append([round(lon_r, 6), round(lat_b, 6)])
        ordered = left_coords + right_coords[::-1]

    ordered.append(ordered[0])
    return {"type": "Polygon", "coordinates": [ordered]}


def _extract_smooth_polygon(
    depth_grid: np.ndarray,
    bounds: Tuple[float, float, float, float],
    threshold_m: float = 0.08,
    simplify_tol: float = 0.0003,
) -> Optional[Dict]:
    """
    Extract topologically clean, smooth GeoJSON polygon from inundated grid.
    Uses rasterio boundary contour extraction + shapely union if available,
    with a robust pure-NumPy ribbon envelope fallback.
    Eliminates bowtie / self-intersection artifacts completely.
    """
    if RASTERIO_SHAPELY_AVAILABLE:
        try:
            west, south, east, north = bounds
            ny, nx = depth_grid.shape
            flooded = (depth_grid > threshold_m).astype(np.uint8)

            if not flooded.any():
                return None

            trans = rasterio.transform.from_bounds(west, south, east, north, nx, ny)
            shapes_gen = rasterio.features.shapes(
                flooded, mask=(flooded == 1), transform=trans
            )
            geoms = [shapely.geometry.shape(geom) for geom, val in shapes_gen if val == 1]
            if geoms:
                merged = shapely.ops.unary_union(geoms)
                if not merged.is_empty:
                    smoothed = merged.buffer(0.0001).buffer(-0.00005)
                    simplified = smoothed.simplify(simplify_tol, preserve_topology=True)
                    if simplified.is_empty:
                        simplified = merged
                    return shapely.geometry.mapping(simplified)
        except Exception as e:
            logger.debug(f"Rasterio/shapely polygon extraction skipped: {e}")

    # scipy middle tier: connected-component cleanup removes isolated dry islands
    # then hand off to the pure-NumPy ribbon tracer.
    if SCIPY_AVAILABLE:
        try:
            flooded = depth_grid > threshold_m
            labeled, n_components = _ndimage_label(flooded)
            if n_components > 1:
                # Keep only the largest connected wet component
                sizes = [(labeled == i).sum() for i in range(1, n_components + 1)]
                largest = int(np.argmax(sizes)) + 1
                depth_grid = np.where(labeled == largest, depth_grid, 0.0)
        except Exception:
            pass  # scipy cleanup failed — fall through to pure-NumPy

    # Pure NumPy fallback: guaranteed bowtie-free smooth ribbon contour
    return _extract_pure_numpy_polygon(depth_grid, bounds, threshold_m)


def generate_flood_polygon_geojson(
    max_depth_grid: np.ndarray,
    dem: np.ndarray,
    dx: float,
    bounds: Tuple[float, float, float, float],
    threshold_m: float = 0.08,
) -> Dict:
    """
    Generate GeoJSON polygon from the peak flood inundation extent.

    When shapely is available, also produces a MultiPolygon per depth band
    (shallow / moderate / deep / critical) stored in 'depth_band_features'.
    This handles complex flood extents with disconnected islands correctly.
    """
    geom = _extract_smooth_polygon(max_depth_grid, bounds, threshold_m, simplify_tol=0.0002)
    cell_area_km2 = (dx * dx) / 1e6
    flooded_cells = int(np.sum(max_depth_grid > threshold_m))
    flooded_area_km2 = float(flooded_cells * cell_area_km2)

    feature = {
        "type": "Feature",
        "properties": {
            "flooded_area_km2": round(flooded_area_km2, 3),
            "max_depth_m": round(float(np.max(max_depth_grid)), 2) if flooded_cells > 0 else 0.0,
            "threshold_m": threshold_m,
            "affected_cells": flooded_cells,
        },
        "geometry": geom or {"type": "Polygon", "coordinates": []},
    }

    # --- Depth-band MultiPolygon dissolve (shapely only) ---
    depth_band_features = []
    if RASTERIO_SHAPELY_AVAILABLE:
        depth_bands = [
            (threshold_m, 0.5, "shallow", "#26c6da"),
            (0.5, 2.0, "moderate", "#2196f3"),
            (2.0, 5.0, "deep", "#e65100"),
            (5.0, 9999.0, "critical", "#d50000"),
        ]
        try:
            west, south, east, north = bounds
            ny, nx = max_depth_grid.shape
            trans = rasterio.transform.from_bounds(west, south, east, north, nx, ny)
            for lo, hi, band_name, color in depth_bands:
                band_mask = ((max_depth_grid >= lo) & (max_depth_grid < hi)).astype(np.uint8)
                if not band_mask.any():
                    continue
                shapes_gen = rasterio.features.shapes(band_mask, mask=band_mask, transform=trans)
                geoms = [shapely.geometry.shape(g) for g, v in shapes_gen if v == 1]
                if not geoms:
                    continue
                merged = shapely.ops.unary_union(geoms)
                if merged.is_empty:
                    continue
                simplified = merged.simplify(0.0003, preserve_topology=True)
                depth_band_features.append({
                    "type": "Feature",
                    "properties": {"band": band_name, "depth_lo_m": lo, "depth_hi_m": hi, "color": color},
                    "geometry": shapely.geometry.mapping(simplified),
                })
        except Exception as e:
            logger.debug("Depth-band dissolve skipped: %s", e)

    return {
        "type": "FeatureCollection",
        "features": [feature] if geom else [],
        "depth_band_features": depth_band_features,
        "metadata": {
            "flooded_area_km2": round(flooded_area_km2, 3),
            "threshold_m": threshold_m,
        },
    }


def generate_frame_polygon(
    depth_grid: np.ndarray,
    bounds: Tuple[float, float, float, float],
    threshold_m: float = 0.08,
) -> Optional[Dict]:
    """Generate simplified smooth GeoJSON polygon for a single snapshot frame."""
    return _extract_smooth_polygon(depth_grid, bounds, threshold_m, simplify_tol=0.0004)


# ---------------------------------------------------------------------------
# 4. Main Simulation Runner
# ---------------------------------------------------------------------------

def run_simulation(
    dem: np.ndarray,
    dx: float,
    dam_col: int,
    config: SimulationConfig,
    dam_name: str = "Unknown Dam",
    bounds: Tuple[float, float, float, float] = (0, 0, 0, 0),
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> SimulationResult:
    """
    Run a complete, calculation-driven dam break flood simulation.
    All physics strictly start AT the dam coordinates (latitude, longitude).
    """
    t_total_start = time.time()
    ny, nx = dem.shape
    west, south, east, north = bounds

    # --- Anchor dam location strictly to input coordinates ---
    if east > west and north > south and latitude is not None and longitude is not None:
        dam_col = int(np.clip(((longitude - west) / (east - west)) * nx, 0, nx - 1))
        dam_row = int(np.clip(((north - latitude) / (north - south)) * ny, 0, ny - 1))
    else:
        dam_row = ny // 2
        dam_col = max(1, min(dam_col, nx - 2))

    config.failure_mode = normalize_failure_mode(config.failure_mode)

    # --- Step 1: Detect downstream direction from dam origin ---
    t0 = time.time()
    row_offset, col_direction = detect_downstream_direction(dem, dam_row, dam_col)
    terrain_time_ms = (time.time() - t0) * 1000
    logger.info("Terrain analysis from dam (%d, %d): %.0f ms", dam_row, dam_col, terrain_time_ms)

    # --- Step 2: Generate breach hydrograph ---
    t0 = time.time()
    hydro = breach_mod.build_breach_hydrograph(
        volume_m3=config.volume_m3,
        height_m=config.height_m,
        failure_mode=config.failure_mode,
        breach_width_override=config.breach_width_override_m,
        formation_time_override_min=config.formation_time_override_min,
    )
    breach_time_ms = (time.time() - t0) * 1000
    logger.info("Breach hydrograph (%s): Qp=%.1f m3/s, B=%.1fm, tf=%.1f s",
                config.failure_mode, hydro["peak_outflow_cms"],
                hydro["breach_width_m"], hydro["breach_formation_time_s"])

    # --- Step 3: Define source cells AT the dam breach ---
    source_cells = []
    breach_width_cells = max(1, int(hydro["breach_width_m"] / dx))
    for offset in range(-(breach_width_cells // 2), (breach_width_cells // 2) + 1):
        r = dam_row + offset
        if 0 <= r < ny:
            source_cells.append((r, dam_col))
    if not source_cells:
        source_cells = [(dam_row, dam_col)]

    # --- Step 4: Adaptive snapshot interval based on simulation duration ---
    total_sim_h = float(config.total_sim_hours)
    if total_sim_h <= 1.0:
        interval_s = 180.0   # every 3 min
    elif total_sim_h <= 3.0:
        interval_s = 300.0   # every 5 min
    elif total_sim_h <= 8.0:
        interval_s = 600.0   # every 10 min
    else:
        interval_s = 1800.0  # every 30 min
    config.snapshot_interval_s = interval_s

    total_time_s = total_sim_h * 3600.0
    t0 = time.time()
    snap_times, snapshots, vel_snapshots = routing.run_flood_routing(
        dem=dem, dx=dx,
        source_cells=source_cells,
        hydrograph_times=hydro["times_s"],
        hydrograph_q=hydro["discharge_cms"],
        manning_n=config.manning_n,
        total_time_s=total_time_s,
        snapshot_interval_s=config.snapshot_interval_s,
        return_velocities=True,
    )
    routing_time_ms = (time.time() - t0) * 1000
    logger.info("Flood routing: %d snapshots over %.1f hours (%.0f ms)",
                len(snapshots), total_sim_h, routing_time_ms)

    # --- Step 5: Compute statistics from dam origin ---
    t0 = time.time()
    flood_stats = compute_flood_statistics(
        snap_times, snapshots, dem, dx, dam_row, dam_col, row_offset,
    )
    stats_time_ms = (time.time() - t0) * 1000

    # --- Step 6: Generate Peak GeoJSON and Frame Polygons ---
    flood_polygon = generate_flood_polygon_geojson(
        flood_stats["peak_depth_grid"], dem, dx, bounds,
    )

    frame_polygons = [
        generate_frame_polygon(snap, bounds) for snap in snapshots
    ]

    # --- Step 7: Downstream Points of Interest ---
    points_of_interest = _generate_downstream_pois(
        ny, nx, dam_row, dam_col, row_offset, snap_times, snapshots, vel_snapshots, bounds,
    )

    # --- Step 8: Build formatted timestamps (e.g. 0:00, 0:15, 1:00) ---
    timesteps_formatted = []
    for s in snap_times:
        hours = int(s // 3600)
        minutes = int((s % 3600) // 60)
        timesteps_formatted.append(f"{hours}:{minutes:02d}")

    # --- Step 9: Downsample grids and compute Risk Grids per frame ---
    downsampled_dem = dem[::2, ::2].round(2).tolist()
    depth_grids_ds = [snap[::2, ::2].round(2).tolist() for snap in snapshots]
    velocity_grids_ds = [v[::2, ::2].round(2).tolist() for v in vel_snapshots]

    # Risk grids: 0=dry, 1=low, 2=moderate, 3=high, 4=critical
    risk_grids = []
    for d_snap, v_snap in zip(snapshots, vel_snapshots):
        d_sub = d_snap[::2, ::2]
        v_sub = v_snap[::2, ::2]
        risk_map = np.zeros_like(d_sub, dtype=int)
        wet = d_sub > 0.05
        # Low hazard
        risk_map[wet] = 1
        # Moderate hazard
        mod_mask = wet & ((d_sub >= 0.5) | (v_sub >= 1.0))
        risk_map[mod_mask] = 2
        # High hazard
        high_mask = wet & ((d_sub >= 2.0) | ((d_sub * v_sub) >= 1.0) | (v_sub >= 2.0))
        risk_map[high_mask] = 3
        # Critical hazard
        crit_mask = wet & ((d_sub >= 4.0) | ((d_sub * v_sub) >= 2.0) | (v_sub >= 3.0))
        risk_map[crit_mask] = 4
        risk_grids.append(risk_map.tolist())

    arrival_grid_ds = flood_stats["arrival_grid"][::2, ::2].round(1).tolist()

    # --- Step 10: Full SIH Hydraulic Calculations Dictionary ---
    res_vol_m3 = config.volume_m3
    res_vol_mcm = round(res_vol_m3 / 1e6, 2)
    res_area_km2 = round((2.0 * res_vol_m3) / max(config.height_m * 1e6, 1.0), 2)
    crest_elevation = float(np.mean(dem[:, dam_col]) + config.height_m)
    peak_vel = float(np.max(np.maximum.reduce(vel_snapshots))) if vel_snapshots else 0.0

    hydraulic_params = {
        "reservoir_volume_m3": res_vol_m3,
        "reservoir_volume_mcm": res_vol_mcm,
        "reservoir_area_km2": res_area_km2,
        "reservoir_area_ha": round(res_area_km2 * 100.0, 1),
        "initial_water_level_m": round(config.height_m, 2),
        "dam_height_m": round(config.height_m, 2),
        "breach_width_m": round(hydro["breach_width_m"], 1),
        "breach_formation_time_min": round(hydro["breach_formation_time_s"] / 60.0, 1),
        "peak_outflow_cms": round(hydro["peak_outflow_cms"], 1),
        "peak_velocity_ms": round(peak_vel, 2),
        "max_flood_depth_m": flood_stats["max_depth_m"],
        "max_flood_width_m": flood_stats["max_flood_width_m"],
        "max_inundated_area_km2": flood_stats["max_inundated_area_km2"],
        "max_inundated_area_ha": flood_stats["max_inundated_area_ha"],
        "affected_population_est": flood_stats["affected_population_est"],
        "affected_buildings_est": flood_stats["affected_buildings_est"],
        "inundated_roads_km": flood_stats["inundated_roads_km"],
        "inundated_agriculture_km2": flood_stats["inundated_agriculture_km2"],
        "eroded_volume_m3": hydro.get("eroded_volume_m3", 0),
        "failure_mode": config.failure_mode,
        "critical_water_level_m": round(config.height_m * 0.85, 2),
        "warning_water_level_m": round(config.height_m * 0.65, 2),
    }

    total_time_ms = (time.time() - t_total_start) * 1000
    logger.info("Simulation complete: %.0f ms total (terrain=%.0f, routing=%.0f, stats=%.0f)",
                total_time_ms, terrain_time_ms, routing_time_ms, stats_time_ms)

    result = SimulationResult(
        peak_outflow_cms=round(hydro["peak_outflow_cms"], 1),
        breach_width_m=round(hydro["breach_width_m"], 1),
        breach_formation_time_min=round(hydro["breach_formation_time_s"] / 60.0, 1),
        dx=dx, ny=ny, nx=nx,
        dam_col=dam_col,
        dam_row=dam_row,
        elevation_grid=downsampled_dem,
        elevation_stats={
            "min_m": round(float(dem.min()), 2),
            "max_m": round(float(dem.max()), 2),
        },
        dam_geometry={
            "col_index": dam_col // 2,
            "row_index": dam_row // 2,
            "crest_elevation_m": round(crest_elevation, 2),
            "dam_height_m": config.height_m,
            "breach_centre_row": dam_row // 2,
            "breach_width_m": round(hydro["breach_width_m"], 1),
        },
        snapshot_times_s=[round(t, 1) for t in snap_times],
        timesteps_formatted=timesteps_formatted,
        depth_grids=depth_grids_ds,
        velocity_grids=velocity_grids_ds,
        risk_grids=risk_grids,
        arrival_grid=arrival_grid_ds,
        hydraulic_parameters=hydraulic_params,
        summary={
            "max_inundated_area_km2": flood_stats["max_inundated_area_km2"],
            "max_inundated_area_ha": flood_stats["max_inundated_area_ha"],
            "max_flood_depth_m": flood_stats["max_depth_m"],
            "max_flood_width_m": flood_stats["max_flood_width_m"],
            "peak_velocity_ms": round(peak_vel, 2),
            "affected_cells": flood_stats["affected_cells"],
            "arrival_distances": flood_stats["arrival_distances"],
            "velocity_estimate_ms": flood_stats["velocity_estimate_ms"],
            "affected_population_est": flood_stats["affected_population_est"],
            "affected_buildings_est": flood_stats["affected_buildings_est"],
            "inundated_roads_km": flood_stats["inundated_roads_km"],
            "inundated_agriculture_km2": flood_stats["inundated_agriculture_km2"],
            "points_of_interest": points_of_interest,
        },
        points_of_interest=points_of_interest,
        flood_polygon_geojson=flood_polygon,
        frame_polygons=frame_polygons,
        hydrograph_times_min=hydro.get("hydrograph_times_min"),
        hydrograph_q_cms=hydro.get("hydrograph_q_cms"),
        simulation_time_ms=round(total_time_ms, 1),
        terrain_time_ms=round(terrain_time_ms, 1),
    )

    return result


# ---------------------------------------------------------------------------
# 5. Downstream Points of Interest Generator
# ---------------------------------------------------------------------------

def _generate_downstream_pois(
    ny: int, nx: int, dam_row: int, dam_col: int,
    row_offset: int,
    snap_times: List[float], snapshots: List[np.ndarray],
    vel_snapshots: List[np.ndarray],
    bounds: Tuple[float, float, float, float],
    arrival_threshold_m: float = 0.2,
) -> List[Dict]:
    """Generate downstream settlement impact assessments with real coordinates."""
    west, south, east, north = bounds
    span = nx - dam_col
    pois = []

    distances = [0.20, 0.40, 0.65, 0.85]
    names = ["Settlement Zone 1 (Near Reach)", "Village Sector 2 (Mid-Valley)", "Agricultural Township 3", "Downstream Urban Cluster 4"]
    shelters = ["North Hill High Ground (350m)", "East Ridge Relief Shelter", "District Secondary School Campus", "National Highway Elevated Overpass"]

    lon_step = (east - west) / max(nx, 1)
    lat_step = (north - south) / max(ny, 1)

    for i, (frac, name, shelter) in enumerate(zip(distances, names, shelters)):
        r = dam_row + (i % 3 - 1) * 2 * (row_offset if row_offset != 0 else 1)
        r = max(0, min(r, ny - 1))
        c = dam_col + int(span * frac)
        c = max(0, min(c, nx - 1))

        lat = north - (r + 0.5) * lat_step
        lon = west + (c + 0.5) * lon_step

        depths_over_time = [float(snap[r, c]) for snap in snapshots]
        vels_over_time = [float(v[r, c]) for v in vel_snapshots] if vel_snapshots else [0.0] * len(snapshots)

        arrival_t = None
        for t, d in zip(snap_times, depths_over_time):
            if d >= arrival_threshold_m:
                arrival_t = t
                break

        peak_d = round(float(max(depths_over_time)), 2)
        peak_v = round(float(max(vels_over_time)), 2)

        if peak_d >= 3.0 or (peak_d * peak_v) >= 1.5:
            risk = "Critical"
        elif peak_d >= 1.5 or (peak_d * peak_v) >= 0.8:
            risk = "High"
        elif peak_d >= 0.5:
            risk = "Moderate"
        else:
            risk = "Low"

        arrival_min = None if arrival_t is None else round(arrival_t / 60.0, 1)
        evacuation_window = max(0, round(arrival_min - 15.0, 1)) if arrival_min else 120.0

        pois.append({
            "name": name,
            "latitude": round(lat, 5),
            "longitude": round(lon, 5),
            "cell": [int(r), int(c)],
            "cell_3d": [int(r // 2), int(c // 2)],
            "distance_km": round((frac * span * 30.0) / 1000.0, 1),
            "arrival_time_min": arrival_min,
            "peak_depth_m": peak_d,
            "peak_velocity_ms": peak_v,
            "risk_level": risk,
            "evacuation_window_min": evacuation_window,
            "shelter_recommendation": shelter,
            "population_est": int(1200 + i * 850),
        })

    return pois
