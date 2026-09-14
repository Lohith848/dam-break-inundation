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

    # Elevation
    elevation_grid: List[List[float]]
    elevation_stats: Dict[str, float]

    # Dam geometry for 3D rendering
    dam_geometry: Dict[str, float]

    # Time-stepping output
    snapshot_times_s: List[float]
    depth_grids: List[List[List[float]]]

    # Summary statistics
    summary: Dict

    # Downstream points of interest
    points_of_interest: List[Dict]

    # GeoJSON flood polygon (if generated)
    flood_polygon_geojson: Optional[Dict] = None

    # Velocity grids (time-stepping flow velocity magnitude in m/s)
    velocity_grids: Optional[List[List[List[float]]]] = None

    # Simulation timing
    simulation_time_ms: float = 0.0
    terrain_time_ms: float = 0.0


# ---------------------------------------------------------------------------
# 1. Downstream Direction Detection
# ---------------------------------------------------------------------------

def detect_downstream_direction(dem: np.ndarray, dam_col: int) -> Tuple[int, int]:
    """
    Detect the dominant downstream flow direction from the DEM slope.

    Analyzes the elevation gradient downstream of the dam to determine
    which direction (row offset) the flood will preferentially travel.

    Returns (row_offset, col_direction) where:
      - row_offset: +1 = downstream is below (south), -1 = above (north)
      - col_direction: +1 = downstream is right (east), -1 = left (west)
    """
    ny, nx = dem.shape
    centre = ny // 2

    # Analyze elevation profile downstream of dam
    if dam_col + 5 < nx:
        downstream_slice = dem[:, dam_col + 5]
    else:
        downstream_slice = dem[:, dam_col]

    # Find steepest descent from center
    centre_elev = dem[centre, dam_col]
    best_row = centre
    best_drop = 0.0

    search_range = min(15, ny // 4)
    for r in range(max(0, centre - search_range), min(ny, centre + search_range)):
        drop = centre_elev - downstream_slice[r]
        if drop > best_drop:
            best_drop = drop
            best_row = r

    row_offset = 1 if best_row > centre else (-1 if best_row < centre else 0)
    col_direction = 1  # always downstream = increasing column index

    logger.info("Detected downstream: row_offset=%d (drop=%.1fm over %d cells)",
                row_offset, best_drop, 5)
    return row_offset, col_direction


# ---------------------------------------------------------------------------
# 2. Flood Propagation Statistics
# ---------------------------------------------------------------------------

def compute_flood_statistics(
    snap_times: List[float],
    snapshots: List[np.ndarray],
    dem: np.ndarray,
    dx: float,
    dam_col: int,
    row_offset: int,
) -> Dict:
    """
    Compute detailed flood propagation statistics from simulation output.

    Returns dict with:
      - max_depth_m: peak flood depth anywhere
      - max_inundated_area_km2: total flooded area
      - arrival_times: time when flood reaches downstream distances
      - velocity_estimates: estimated flow velocities
      - affected_cells: count of cells with depth > 0.1m
      - peak_depth_grid: maximum depth at each cell across all timesteps
    """
    if not snapshots:
        return {"error": "No simulation snapshots"}

    cell_area_km2 = (dx * dx) / 1e6
    max_depth_grid = np.maximum.reduce(snapshots)
    max_depth_m = float(np.max(max_depth_grid))
    affected_cells = int(np.sum(max_depth_grid > 0.1))
    max_area_km2 = affected_cells * cell_area_km2

    # Compute arrival times at various downstream distances
    centre = dem.shape[0] // 2
    arrival_distances = {}
    distances_km = [1, 2, 5, 10, 20]

    for dist_km in distances_km:
        # Convert km to column offset
        col_offset = int(dist_km * 1000 / dx)
        target_col = min(dam_col + col_offset, dem.shape[1] - 1)

        # Check along the downstream row path
        for t, snap in zip(snap_times, snapshots):
            # Sample depth at multiple rows around centre
            max_d = 0.0
            for r_offset in range(-3, 4):
                r = centre + r_offset * row_offset
                r = max(0, min(r, snap.shape[0] - 1))
                max_d = max(max_d, float(snap[r, target_col]))

            if max_d >= 0.1:  # arrival threshold
                arrival_distances[f"{dist_km}km"] = round(t / 60.0, 1)  # minutes
                break
        else:
            arrival_distances[f"{dist_km}km"] = None  # not reached

    # Velocity estimation: v ≈ (1/n) * h^(2/3) * sqrt(S)
    # Use average depth and typical slope for estimation
    if max_depth_m > 0:
        avg_depth = float(np.mean(max_depth_grid[max_depth_grid > 0.1]))
        slope = 0.001  # typical floodplain slope
        velocity_ms = (1.0 / 0.045) * (avg_depth ** (2.0/3.0)) * (slope ** 0.5)
    else:
        velocity_ms = 0.0

    return {
        "max_depth_m": round(max_depth_m, 2),
        "max_inundated_area_km2": round(max_area_km2, 3),
        "affected_cells": affected_cells,
        "arrival_distances": arrival_distances,
        "velocity_estimate_ms": round(velocity_ms, 2),
        "peak_depth_grid": max_depth_grid,
    }


# ---------------------------------------------------------------------------
# 3. GeoJSON Flood Polygon Generation
# ---------------------------------------------------------------------------

def generate_flood_polygon_geojson(
    max_depth_grid: np.ndarray,
    dem: np.ndarray,
    dx: float,
    bounds: Tuple[float, float, float, float],
    threshold_m: float = 0.1,
) -> Dict:
    """
    Generate a GeoJSON polygon from the flood inundation extent.

    Uses a simple contour-following approach to create the flood boundary.

    Parameters
    ----------
    max_depth_grid : (ny, nx) array of maximum depths
    dem : original DEM
    dx : cell size in metres
    bounds : (west, south, east, north) in degrees
    threshold_m : minimum depth to include in polygon

    Returns
    -------
    GeoJSON FeatureCollection with flood polygon and metadata.
    """
    west, south, east, north = bounds
    ny, nx = max_depth_grid.shape

    # Convert depth grid to binary flooded mask
    flooded = max_depth_grid > threshold_m

    if not flooded.any():
        return {
            "type": "FeatureCollection",
            "features": [],
            "metadata": {"flooded_area_km2": 0, "threshold_m": threshold_m},
        }

    # Create grid of coordinates
    lon_step = (east - west) / nx
    lat_step = (north - south) / ny

    # Find boundary cells (flooded cells adjacent to non-flooded cells)
    boundary_cells = []
    for r in range(ny):
        for c in range(nx):
            if not flooded[r, c]:
                continue
            # Check 4 neighbors
            is_boundary = False
            for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nr, nc = r + dr, c + dc
                if nr < 0 or nr >= ny or nc < 0 or nc >= nx:
                    is_boundary = True
                    break
                if not flooded[nr, nc]:
                    is_boundary = True
                    break
            if is_boundary:
                lon = west + (c + 0.5) * lon_step
                lat = north - (r + 0.5) * lat_step
                boundary_cells.append([round(lon, 6), round(lat, 6)])

    # Create a simplified polygon from boundary cells
    # Sort by angle from centroid for a proper polygon
    if boundary_cells:
        coords = np.array(boundary_cells)
        centroid = coords.mean(axis=0)
        angles = np.arctan2(coords[:, 1] - centroid[1], coords[:, 0] - centroid[0])
        sorted_idx = np.argsort(angles)
        ordered_boundary = [boundary_cells[i] for i in sorted_idx]
        # Close the polygon
        ordered_boundary.append(ordered_boundary[0])
    else:
        ordered_boundary = []

    # Max depth at each cell for properties
    cell_area_km2 = (dx * dx) / 1e6
    flooded_area_km2 = float(np.sum(flooded) * cell_area_km2)

    feature = {
        "type": "Feature",
        "properties": {
            "flooded_area_km2": round(flooded_area_km2, 3),
            "max_depth_m": round(float(np.max(max_depth_grid)), 2),
            "threshold_m": threshold_m,
            "affected_cells": int(np.sum(flooded)),
        },
        "geometry": {
            "type": "Polygon",
            "coordinates": [ordered_boundary] if ordered_boundary else [[]],
        },
    }

    return {
        "type": "FeatureCollection",
        "features": [feature],
        "metadata": {
            "flooded_area_km2": round(flooded_area_km2, 3),
            "threshold_m": threshold_m,
        },
    }


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
    Run a complete dam break flood simulation.

    This is the main entry point that orchestrates:
      1. Breach hydrograph generation
      2. Downstream direction detection
      3. 2D diffusive-wave flood routing
      4. Statistics computation
      5. GeoJSON polygon generation

    Designed to be modular — individual steps can be replaced by AI/ML models.
    """
    t_total_start = time.time()
    ny, nx = dem.shape
    centre = ny // 2

    # Normalize the mode so legacy/unknown strings map onto a valid mode
    config.failure_mode = normalize_failure_mode(config.failure_mode)

    # --- Step 1: Detect downstream direction ---
    t0 = time.time()
    row_offset, col_direction = detect_downstream_direction(dem, dam_col)
    terrain_time_ms = (time.time() - t0) * 1000
    logger.info("Terrain analysis: %.0f ms", terrain_time_ms)

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
    logger.info("Breach hydrograph: Qp=%.1f m3/s, B=%.1fm, tf=%.1f s (%.0f ms)",
                hydro["peak_outflow_cms"], hydro["breach_width_m"],
                hydro["breach_formation_time_s"], breach_time_ms)

    # --- Step 3: Define source cells (breach width spans multiple cells) ---
    source_cells = []
    breach_width_cells = max(1, int(hydro["breach_width_m"] / dx))
    for offset in range(-(breach_width_cells // 2), (breach_width_cells // 2) + 1):
        r = centre + offset
        if 0 <= r < ny:
            source_cells.append((r, dam_col))
    if not source_cells:
        source_cells = [(centre, dam_col)]

    # --- Step 4: Run 2D flood routing ---
    t0 = time.time()
    total_time_s = config.total_sim_hours * 3600
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
                len(snapshots), config.total_sim_hours, routing_time_ms)

    # --- Step 5: Compute statistics ---
    t0 = time.time()
    flood_stats = compute_flood_statistics(
        snap_times, snapshots, dem, dx, dam_col, row_offset,
    )
    stats_time_ms = (time.time() - t0) * 1000

    # --- Step 6: Generate GeoJSON flood polygon ---
    flood_polygon = generate_flood_polygon_geojson(
        flood_stats["peak_depth_grid"], dem, dx, bounds,
    )

    # --- Step 7: Downstream points of interest ---
    points_of_interest = _generate_downstream_pois(
        ny, nx, dam_col, centre, row_offset, snap_times, snapshots,
    )

    # --- Step 8: Build output ---
    downsampled_dem = dem[::2, ::2].round(2).tolist()
    crest_elevation = float(np.mean(dem[:, dam_col]) + config.height_m)

    # Downsample depth and velocity grids for frontend
    depth_grids_ds = [snap[::2, ::2].round(2).tolist() for snap in snapshots]
    velocity_grids_ds = [v[::2, ::2].round(2).tolist() for v in vel_snapshots]

    for poi in points_of_interest:
        cell = poi.get("cell", (0, 0))
        poi["cell_3d"] = [cell[0] // 2, cell[1] // 2]

    total_time_ms = (time.time() - t_total_start) * 1000
    logger.info("Simulation complete: %.0f ms total (terrain=%.0f, routing=%.0f, stats=%.0f)",
                total_time_ms, terrain_time_ms, routing_time_ms, stats_time_ms)

    result = SimulationResult(
        peak_outflow_cms=round(hydro["peak_outflow_cms"], 1),
        breach_width_m=round(hydro["breach_width_m"], 1),
        breach_formation_time_min=round(hydro["breach_formation_time_s"] / 60.0, 1),
        dx=dx, ny=ny, nx=nx, dam_col=dam_col,
        elevation_grid=downsampled_dem,
        elevation_stats={
            "min_m": round(float(dem.min()), 2),
            "max_m": round(float(dem.max()), 2),
        },
        dam_geometry={
            "col_index": dam_col // 2,
            "crest_elevation_m": round(crest_elevation, 2),
            "dam_height_m": config.height_m,
            "breach_centre_row": centre // 2,
            "breach_width_m": round(hydro["breach_width_m"], 1),
        },
        snapshot_times_s=[round(t, 1) for t in snap_times],
        depth_grids=depth_grids_ds,
        velocity_grids=velocity_grids_ds,
        summary={
            "max_inundated_area_km2": flood_stats["max_inundated_area_km2"],
            "max_flood_depth_m": flood_stats["max_depth_m"],
            "affected_cells": flood_stats["affected_cells"],
            "arrival_distances": flood_stats["arrival_distances"],
            "velocity_estimate_ms": flood_stats["velocity_estimate_ms"],
            "points_of_interest": points_of_interest,
        },
        points_of_interest=points_of_interest,
        flood_polygon_geojson=flood_polygon,
        simulation_time_ms=round(total_time_ms, 1),
        terrain_time_ms=round(terrain_time_ms, 1),
    )

    return result


# ---------------------------------------------------------------------------
# 5. Downstream Points of Interest Generator
# ---------------------------------------------------------------------------

def _generate_downstream_pois(
    ny: int, nx: int, dam_col: int, centre: int,
    row_offset: int,
    snap_times: List[float], snapshots: List[np.ndarray],
    arrival_threshold_m: float = 0.3,
) -> List[Dict]:
    """Generate downstream points of interest at increasing distances."""
    span = nx - dam_col
    pois = []

    distances = [0.25, 0.45, 0.65, 0.85]
    names = ["Settlement A (near)", "Settlement B (mid-near)", "Settlement C (mid-far)", "Settlement D (far)"]

    for i, (frac, name) in enumerate(zip(distances, names)):
        r = centre + (i % 3 - 1) * 2 * row_offset
        r = max(0, min(r, ny - 1))
        c = dam_col + int(span * frac)
        c = max(0, min(c, nx - 1))

        depths_over_time = [float(snap[r, c]) for snap in snapshots]
        arrival_t = None
        for t, d in zip(snap_times, depths_over_time):
            if d >= arrival_threshold_m:
                arrival_t = t
                break

        pois.append({
            "name": name,
            "cell": [int(r), int(c)],
            "arrival_time_min": None if arrival_t is None else round(arrival_t / 60.0, 1),
            "peak_depth_m": round(float(max(depths_over_time)), 2),
        })

    return pois
