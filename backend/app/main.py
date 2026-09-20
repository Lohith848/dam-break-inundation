
"""
main.py
-------
FastAPI backend for the# Dam Break Inundation Modelling API (SIH26161)
# Production FastAPI Backend with full ReportLab PDF engine and hydrodynamic routing.

Endpoints
---------
GET  /health                 -> liveness check
GET  /rivers                 -> list rivers from dataset
GET  /dams                   -> list dams with metadata
GET  /dam/{id}               -> full metadata for one dam
GET  /dem/cache              -> list cached DEM tiles
POST /simulate               -> run flood simulation on real DEM
POST /fetch-dem              -> manually download a DEM tile
GET  /weather/rainfall       -> live rainfall from Open-Meteo
POST /compare                -> scenario comparison
POST /simulate/start         -> SSE-backed simulation with progress
GET  /simulate/stream/{id}   -> SSE progress stream
POST /report/pdf             -> Generate PDF report

Run locally:
    cd backend
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000
"""

import json
import html
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import breach as breach_mod
from . import dem as dem_utils
from . import dem_fetcher
from . import flood as flood_engine
from . import routing
from . import sim_cache
from . import validation
from .failure_modes import FailureMode, export_for_frontend, normalize_failure_mode
from .report_engine import build_pdf_report
from .ai import groq_client
from .ai import prompts as ai_prompts
from .weather import router as weather_router
from .compare import router as compare_router
from .progress import router as progress_router
from .assets_api import router as assets_router
from .progress import build_village_impacts as _build_village_impacts

# Request-size limit for chat payloads (chars) — prevents abuse of the
# conversation_history field as a memory/DoS vector.
MAX_CHAT_MESSAGE_CHARS = 4000
MAX_CHAT_HISTORY_MESSAGES = 40

# ---------------------------------------------------------------------------
# Logging Configuration
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("dam_sim.main")

# ---------------------------------------------------------------------------
# App Setup & Environment Loading
# ---------------------------------------------------------------------------
_project_root = Path(__file__).resolve().parent.parent.parent

def _load_env():
    """Find and load .env file from common search paths."""
    search_dirs = [
        Path.cwd(),
        _project_root,
        _project_root / "backend",
        Path(__file__).resolve().parent,
    ]
    for d in search_dirs:
        env_file = d / ".env"
        if env_file.is_file():
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'\"")
                            # Override empty-string placeholders (e.g. KEY= exported
                            # by the OS shell) but never a real, non-empty value.
                            if k and v and not os.environ.get(k):
                                os.environ[k] = v
                break
            except Exception:
                pass

_load_env()


app = FastAPI(
    title="Dam Break Inundation Modelling API",
    version="2.0.0",
    description="Real-terrain dam break flood simulation using OpenTopography DEM data",
)

app.add_middleware(
    CORSMiddleware,
    # CORS: configurable via ALLOWED_ORIGINS env var (comma-separated).
    # "*" keeps local/demo simple; set an explicit list for production.
    allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()] or ["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# GZip: simulation payloads carry full elevation/depth grids (hundreds of KB
# to several MB of JSON) — compressing them cuts transfer time drastically.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# ---------------------------------------------------------------------------
# Global exception handler — no uncaught exception reaches the client as a
# raw 500; every failure returns structured JSON and is fully logged.
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error. Check server logs for details."},
    )

# Register new feature routers
app.include_router(weather_router)
app.include_router(compare_router)
app.include_router(progress_router)
app.include_router(assets_router)  # digital-twin asset discovery (read-only)

# ---------------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------------

class SimulateRequest(BaseModel):
    """Request body for flood simulation."""
    dam_id: Optional[str] = Field(default=None, description="Dam PIC code from database")
    latitude: Optional[float] = Field(default=None, description="Dam latitude (decimal degrees)")
    longitude: Optional[float] = Field(default=None, description="Dam longitude (decimal degrees)")
    dam_name: str = Field(default="Dam", max_length=120)
    reservoir_volume_m3: float = Field(..., gt=0, description="Reservoir storage at failure (m^3)")
    dam_height_m: float = Field(..., gt=0, description="Height of water above breach invert (m)")
    # Validated against the FailureMode enum in failure_modes.py (normalized,
    # so legacy 'piping'/'overtopping' payloads and aliases keep working)
    failure_mode: str = Field(default=FailureMode.PIPING.value)
    manning_n: float = Field(default=0.045, gt=0, lt=0.2)
    total_sim_hours: float = Field(default=3.0, gt=0, le=24)
    dem_type: str = Field(default="COP30", description="DEM source: COP30, SRTMGL1, SRTMGL3, ASTGTMV3")
    # Optional user overrides — when provided they win over mode defaults
    breach_width_m: Optional[float] = Field(default=None, gt=0, description="Manual breach width (m)")
    breach_formation_time_min: Optional[float] = Field(default=None, gt=0, description="Manual breach formation time (min)")

    @field_validator("latitude")
    @classmethod
    def _check_lat(cls, v):
        validation.validate_coordinates(v, None)
        return v

    @field_validator("longitude")
    @classmethod
    def _check_lon(cls, v):
        validation.validate_coordinates(None, v)
        return v

    @field_validator("dam_id")
    @classmethod
    def _check_dam_id(cls, v):
        if v is not None:
            v = v.strip()
            if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", v):
                raise ValueError("dam_id must be 1-40 alphanumeric characters")
        return v


class FetchDEMRequest(BaseModel):
    """Request body for manual DEM download."""
    latitude: float
    longitude: float
    dem_type: str = "COP30"
    padding_lat: float = Field(default=0.18, gt=0, le=1.0)
    padding_lon: float = Field(default=0.20, gt=0, le=1.0)

    @field_validator("latitude")
    @classmethod
    def _check_lat(cls, v):
        validation.validate_coordinates(v, None)
        return v

    @field_validator("longitude")
    @classmethod
    def _check_lon(cls, v):
        validation.validate_coordinates(None, v)
        return v


# ---------------------------------------------------------------------------
# Health & Info Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "version": "2.0.0", "api_key_configured": bool(dem_fetcher.get_opentopography_key())}


@app.get("/failure-modes")
def list_failure_modes():
    """Failure modes + descriptions + per-mode default parameters for the UI.

    Single source of truth: failure_modes.FAILURE_MODE_INFO. The frontend
    dropdown, description text, and parameter prefills are all generated
    from this payload (falls back to a bundled copy if the API is down).
    """
    return json.loads(export_for_frontend())


# ---------------------------------------------------------------------------
# Rivers Endpoint
# ---------------------------------------------------------------------------

@app.get("/rivers")
def list_rivers():
    """
    List all rivers available in the HydroRIVERS dataset.
    Returns river name, reach info, and associated dams.
    """
    t0 = time.time()

    # Load dam data to extract unique rivers
    dams = dem_fetcher.load_dam_list(max_dams=9999)

    # Group dams by river
    rivers_map = {}
    for dam in dams:
        river = (dam.get("river") or "").strip()
        if not river or "<" in river or ">" in river or river.lower() == "unknown":
            continue
        if river not in rivers_map:
            rivers_map[river] = {
                "name": river,
                "dams": [],
                "states": set(),
                "basins": set(),
            }
        rivers_map[river]["dams"].append(dam["id"])
        if dam.get("state"):
            rivers_map[river]["states"].add(dam["state"])
        if dam.get("basin"):
            rivers_map[river]["basins"].add(dam["basin"])

    # Convert sets to lists for JSON
    rivers = []
    for name, info in sorted(rivers_map.items()):
        rivers.append({
            "name": name,
            "dam_count": len(info["dams"]),
            "dam_ids": info["dams"],
            "states": sorted(info["states"]),
            "basins": sorted(info["basins"]),
        })

    elapsed_ms = (time.time() - t0) * 1000
    logger.info("Listed %d rivers in %.0f ms", len(rivers), elapsed_ms)
    return {"count": len(rivers), "rivers": rivers}


# ---------------------------------------------------------------------------
# Dams Endpoints
# ---------------------------------------------------------------------------

@app.get("/dams")
def list_dams(max_results: int = 200, state: Optional[str] = None, river: Optional[str] = None, q: Optional[str] = None):
    """
    List/search dams with metadata.
    Supports: ?q= fuzzy search, ?state=, ?river= filters.
    """
    t0 = time.time()
    dams = dem_fetcher.load_dam_list(max_dams=99999)

    if state:
        dams = [d for d in dams if state.lower() in (d.get("state") or "").lower()]
    if river:
        dams = [d for d in dams if river.lower() in (d.get("river") or "").lower()]

    # Fuzzy search
    if q and q.strip():
        scored = []
        for dam in dams:
            score = max(
                _fuzzy_score(q, dam.get("name", "")),
                _fuzzy_score(q, dam.get("river") or "") // 2,
                _fuzzy_score(q, dam.get("state") or "") // 3,
                _fuzzy_score(q, dam.get("district") or "") // 4,
            )
            if score > 0:
                scored.append((score, dam))
        scored.sort(key=lambda x: -x[0])
        dams = [d for _, d in scored]

    elapsed_ms = (time.time() - t0) * 1000
    logger.info("Dams search (q='%s', river='%s'): %d results in %.0f ms",
                q or '', river or '', len(dams[:max_results]), elapsed_ms)

    return {"count": len(dams), "dams": dams[:max_results]}


@app.get("/dam/{dam_id}")
def get_dam(dam_id: str):
    """Return full metadata for a single dam by PIC code."""
    dam = dem_fetcher.get_dam_by_id(dam_id)
    if not dam:
        raise HTTPException(status_code=404, detail=f"Dam not found: {dam_id}")
    return dam


# ---------------------------------------------------------------------------
# River-specific Dams Endpoint with Server-Side Search
# ---------------------------------------------------------------------------

def _fuzzy_score(query: str, text: str) -> int:
    """
    Fuzzy match score. Higher = better match.
    Returns 0 if no match.

    Priority:
      1. Exact match = 100
      2. Starts with = 80
      3. Contains = 60
      4. Fuzzy character sequence = 40
      5. No match = 0
    """
    if not text:
        return 0
    q = query.lower().strip()
    t = str(text).lower().strip()

    if not q:
        return 50  # empty query matches everything

    if q == t:
        return 100
    if t.startswith(q):
        return 80
    if q in t:
        return 60

    # Fuzzy: all characters of query appear in order in text
    qi = 0
    for ti in range(len(t)):
        if qi < len(q) and t[ti] == q[qi]:
            qi += 1
    if qi == len(q):
        return 40

    return 0


@app.get("/rivers/{river_name}/dams")
def list_dams_for_river(river_name: str, q: Optional[str] = None, max_results: int = 500):
    """
    List dams belonging to a specific river, with optional server-side search.

    GET /rivers/Krishna/dams        -> all Krishna dams
    GET /rivers/Krishna/dams?q=m    -> Krishna dams matching 'm'
    """
    t0 = time.time()
    all_dams = dem_fetcher.load_dam_list(max_dams=99999)

    # Filter to river (case-insensitive partial match)
    river_lower = river_name.lower()
    river_dams = [d for d in all_dams if river_lower in (d.get("river") or "").lower()]

    if not river_dams:
        # Try exact match as fallback
        river_dams = [d for d in all_dams if (d.get("river") or "").lower() == river_lower]

    # Apply search query with fuzzy scoring
    if q and q.strip():
        scored = []
        for dam in river_dams:
            score = max(
                _fuzzy_score(q, dam.get("name", "")),
                _fuzzy_score(q, dam.get("state", "")) // 2,
                _fuzzy_score(q, dam.get("district", "")) // 3,
            )
            if score > 0:
                scored.append((score, dam))
        scored.sort(key=lambda x: -x[0])
        river_dams = [d for _, d in scored]

    elapsed_ms = (time.time() - t0) * 1000
    logger.info("Dams for river '%s' (q='%s'): %d results in %.0f ms",
                river_name, q or '', len(river_dams[:max_results]), elapsed_ms)

    return {
        "river": river_name,
        "count": len(river_dams),
        "dams": river_dams[:max_results],
    }


# ---------------------------------------------------------------------------
# DEM Cache Endpoint
# ---------------------------------------------------------------------------

@app.get("/dem/cache")
def dem_cache_info():
    """Return list of cached DEM tiles."""
    cache_dir = dem_fetcher.get_cache_dir()
    if not cache_dir.exists():
        return {"cached_tiles": 0, "total_size_mb": 0, "files": []}
    files = sorted(cache_dir.glob("*.tif"))
    total_size = sum(f.stat().st_size for f in files)
    return {
        "cached_tiles": len(files),
        "total_size_mb": round(total_size / 1048576, 2),
        "files": [
            {"name": f.name, "size_mb": round(f.stat().st_size / 1048576, 2)}
            for f in files
        ],
    }


# ---------------------------------------------------------------------------
# Manual DEM Fetch Endpoint
# ---------------------------------------------------------------------------

@app.post("/fetch-dem")
def fetch_dem_endpoint(req: FetchDEMRequest):
    """Download a DEM tile from OpenTopography for a specific location."""
    try:
        t0 = time.time()
        tif_path = dem_fetcher.fetch_dem_for_dam(
            lat=req.latitude, lon=req.longitude,
            dem_type=req.dem_type,
            padding_lat=req.padding_lat, padding_lon=req.padding_lon,
        )
        elapsed_ms = (time.time() - t0) * 1000
        return {
            "status": "ok",
            "dem_type": req.dem_type,
            "file_path": str(tif_path),
            "file_size_mb": round(tif_path.stat().st_size / 1048576, 2),
            "download_time_ms": round(elapsed_ms, 0),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error fetching DEM")
        raise HTTPException(status_code=500, detail=f"Internal error: {e}")


# ---------------------------------------------------------------------------
# Main Simulation Endpoint
# ---------------------------------------------------------------------------

@app.post("/simulate")
async def simulate(params: SimulateRequest):
    """
    Run a dam break flood simulation.

    Workflow:
      1. Resolve dam coordinates (from database or direct lat/lon)
      2. Fetch DEM from OpenTopography (or use cache)
      3. Load and downsample DEM
      4. Run physically-based flood routing
      5. Return results with GeoJSON polygon
    """
    t_start = time.time()
    dem_bounds = None
    dam_lat = params.latitude
    dam_lon = params.longitude
    params.failure_mode = normalize_failure_mode(params.failure_mode)

    # --- Step 1: Resolve dam coordinates ---
    dam_name = params.dam_name
    dam_river = None
    dam_state = None
    dam_district = None
    if params.dam_id:
        dam = dem_fetcher.get_dam_by_id(params.dam_id)
        if not dam:
            raise HTTPException(status_code=404, detail=f"Dam not found: {params.dam_id}")
        dam_lat = dam["latitude"]
        dam_lon = dam["longitude"]
        if not params.dam_name or params.dam_name == "Demo Dam" or params.dam_name == "Dam":
            params.dam_name = dam["name"]
        dam_name = params.dam_name
        dam_river = dam.get("river")
        dam_state = dam.get("state")
        dam_district = dam.get("district")
        logger.info("Resolved dam: %s at (%.4f, %.4f)", dam_name, dam_lat, dam_lon)

    if dam_lat is None or dam_lon is None:
        raise HTTPException(
            status_code=400,
            detail="Either dam_id or latitude/longitude must be provided"
        )

    # --- Step 2: Fetch DEM from OpenTopography ---
    try:
        t0 = time.time()
        tif_path = dem_fetcher.fetch_dem_for_dam(
            lat=dam_lat, lon=dam_lon,
            dem_type=params.dem_type,
        )
        fetch_ms = (time.time() - t0) * 1000
        logger.info("DEM fetched/cached in %.0f ms", fetch_ms)
    except Exception as e:
        logger.error("DEM fetch failed: %s — falling back to synthetic", e)
        # Fall back to synthetic DEM (also cached so the AI Copilot works)
        dem, dx, dam_col = _fallback_synthetic()
        response = _build_synthetic_response(params, dem, dx, dam_col)
        response["simulation_id"] = _cache_simulation(response)
        return response

    # --- Step 3: Load and downsample DEM ---
    try:
        t0 = time.time()
        dem, dx, dam_col, dem_bounds = dem_utils.load_opentopography_dem(
            str(tif_path),
            target_rows=80,
            target_cols=120,
        )
        load_ms = (time.time() - t0) * 1000
        logger.info("DEM loaded + downsampled in %.0f ms", load_ms)
    except Exception as e:
        logger.error("DEM load failed: %s — falling back to synthetic", e)
        dem, dx, dam_col = _fallback_synthetic()
        response = _build_synthetic_response(params, dem, dx, dam_col)
        response["simulation_id"] = _cache_simulation(response)
        return response

    # --- Step 4: Run flood simulation ---
    config = flood_engine.SimulationConfig(
        volume_m3=params.reservoir_volume_m3,
        height_m=params.dam_height_m,
        failure_mode=normalize_failure_mode(params.failure_mode),
        manning_n=params.manning_n,
        total_sim_hours=params.total_sim_hours,
        breach_width_override_m=params.breach_width_m,
        formation_time_override_min=params.breach_formation_time_min,
    )

    result = flood_engine.run_simulation(
        dem=dem, dx=dx, dam_col=dam_col,
        config=config,
        dam_name=params.dam_name,
        bounds=dem_bounds or (0, 0, 0, 0),
        latitude=dam_lat, longitude=dam_lon,
    )

    # --- Step 5: Build response ---
    # Shared builder (same thresholds/logic as the SSE pipeline — no drift)
    village_impacts = _build_village_impacts(result)

    response = {
        "dam_name": params.dam_name,
        "terrain_type": "opentopography",
        "dem_type": params.dem_type,
        "failure_mode": params.failure_mode,
        "breach": {
            "peak_outflow_cms": result.peak_outflow_cms,
            "breach_width_m": result.breach_width_m,
            "breach_formation_time_min": result.breach_formation_time_min,
        },
        "grid": {
            "dx_m": result.dx,
            "ny": result.ny,
            "nx": result.nx,
            "dam_col": result.dam_col,
            "grid_3d": {
                "rows": len(result.elevation_grid),
                "cols": len(result.elevation_grid[0]),
            },
        },
        # 3D viewer contract: dam_col_index, crest_height_m, breach_width_m, breach_level_m
        "dam_geometry": {
            "dam_col_index": result.dam_geometry.get("col_index", result.dam_col // 2),
            "crest_height_m": result.dam_geometry.get("dam_height_m", params.dam_height_m),
            "breach_width_m": result.dam_geometry.get("breach_width_m", result.breach_width_m),
            "breach_level_m": result.dam_geometry.get("dam_height_m", params.dam_height_m) * 0.6,
        },
        # 3D viewer contract: min_elev, max_elev (not min_m, max_m)
        "elevation_stats": {
            "min_elev": result.elevation_stats.get("min_m", 0),
            "max_elev": result.elevation_stats.get("max_m", 100),
        },
        "elevation_grid": result.elevation_grid,
        "summary": result.summary,
        "snapshot_times_s": result.snapshot_times_s,
        # 3D viewer needs timesteps_hours
        "timesteps_hours": [t / 3600.0 for t in result.snapshot_times_s],
        "timesteps_formatted": result.timesteps_formatted,
        "depth_grids": result.depth_grids,
        "velocity_grids": result.velocity_grids,
        "risk_grids": result.risk_grids,
        "arrival_grid": result.arrival_grid,
        "hydraulic_parameters": result.hydraulic_parameters,
        # 3D viewer needs village_impacts with status
        "village_impacts": village_impacts,
        "flood_polygon": result.flood_polygon_geojson,
        "frame_polygons": result.frame_polygons,
        # Breach hydrograph Q(t) for live Chart.js chart
        "hydrograph_times_min": getattr(result, "hydrograph_times_min", None),
        "hydrograph_q_cms": getattr(result, "hydrograph_q_cms", None),
        "simulation_timing_ms": result.simulation_time_ms,
        "dem_bounds": {
            "west": dem_bounds[0],
            "south": dem_bounds[1],
            "east": dem_bounds[2],
            "north": dem_bounds[3],
        } if dem_bounds else None,
        "dam_location": {
            "latitude": dam_lat,
            "longitude": dam_lon,
        },
    }

    total_ms = (time.time() - t_start) * 1000
    logger.info("Total request time: %.0f ms", total_ms)

    # Cache simulation for AI analysis
    sim_id = _cache_simulation(response)
    response["simulation_id"] = sim_id

    return response


# ---------------------------------------------------------------------------
# Fallback Helpers
# ---------------------------------------------------------------------------

def _fallback_synthetic():
    """Generate synthetic DEM as fallback."""
    dx = 30.0
    dam_col = 15
    dem = dem_utils.make_synthetic_valley_dem(dam_x_index=dam_col)
    return dem, dx, dam_col


def _build_synthetic_response(params, dem, dx, dam_col):
    """Build a response using synthetic DEM."""
    ny, nx = dem.shape
    centre = ny // 2
    source_cells = [(centre - 1, dam_col), (centre, dam_col), (centre + 1, dam_col)]

    hydro = breach_mod.build_breach_hydrograph(
        volume_m3=params.reservoir_volume_m3,
        height_m=params.dam_height_m,
        failure_mode=normalize_failure_mode(params.failure_mode),
        breach_width_override=params.breach_width_m,
        formation_time_override_min=params.breach_formation_time_min,
    )

    snap_times, snapshots, vel_snapshots = routing.run_flood_routing(
        dem=dem, dx=dx, source_cells=source_cells,
        hydrograph_times=hydro["times_s"],
        hydrograph_q=hydro["discharge_cms"],
        manning_n=params.manning_n,
        total_time_s=params.total_sim_hours * 3600,
        return_velocities=True,
    )

    cell_area_km2 = (dx * dx) / 1e6
    max_depth_grid = np.maximum.reduce(snapshots) if snapshots else np.zeros_like(dem)
    max_area_km2 = float(np.sum(max_depth_grid > 0.1) * cell_area_km2)

    downsampled_dem = dem[::2, ::2].round(2).tolist()
    depth_grids_ds = [snap[::2, ::2].round(2).tolist() for snap in snapshots]
    velocity_grids_ds = [v[::2, ::2].round(2).tolist() for v in vel_snapshots]

    return {
        "dam_name": dam_name,
        "dam_id": params.dam_id,
        "river": dam_river,
        "state": dam_state,
        "district": dam_district,
        "manning_n": params.manning_n,
        "total_sim_hours": params.total_sim_hours,
        "terrain_type": "synthetic",
        "dem_type": params.dem_type,
        "failure_mode": params.failure_mode,
        "breach": {
            "peak_outflow_cms": round(hydro["peak_outflow_cms"], 1),
            "breach_width_m": round(hydro["breach_width_m"], 1),
            "breach_formation_time_min": round(hydro["breach_formation_time_s"] / 60.0, 1),
        },
        "grid": {
            "dx_m": dx, "ny": ny, "nx": nx, "dam_col": dam_col,
            "grid_3d": {"rows": len(downsampled_dem), "cols": len(downsampled_dem[0])},
        },
        "dam_geometry": {
            # Canonical viewer contract (dam_col_index/crest_height_m/…), with
            # legacy aliases kept for older clients.
            "dam_col_index": dam_col // 2,
            "col_index": dam_col // 2,
            "crest_height_m": params.dam_height_m,
            "dam_height_m": params.dam_height_m,
            "breach_width_m": round(hydro["breach_width_m"], 1),
            "breach_level_m": round(params.dam_height_m * 0.6, 2),
            "crest_elevation_m": round(float(np.mean(dem[:, dam_col]) + params.dam_height_m), 2),
            "breach_centre_row": centre // 2,
        },
        "elevation_stats": {
            # Canonical keys first (viewer contract), legacy aliases retained.
            "min_elev": round(float(dem.min()), 2),
            "max_elev": round(float(dem.max()), 2),
            "min_m": round(float(dem.min()), 2),
            "max_m": round(float(dem.max()), 2),
        },
        "elevation_grid": downsampled_dem,
        "summary": {
            "max_inundated_area_km2": round(max_area_km2, 3),
            "max_flood_depth_m": round(float(np.max(max_depth_grid)), 2),
            "points_of_interest": [],
        },
        "snapshot_times_s": [round(t, 1) for t in snap_times],
        "timesteps_hours": [round(t / 3600.0, 4) for t in snap_times],
        "timesteps_formatted": [f"{int(t//3600)}:{int((t%3600)//60):02d}" for t in snap_times],
        "depth_grids": depth_grids_ds,
        "velocity_grids": velocity_grids_ds,
        "risk_grids": [[[1 if val > 0.05 else 0 for val in row] for row in snap] for snap in depth_grids_ds],
        "arrival_grid": [[0.0 for _ in row] for row in downsampled_dem],
        "hydraulic_parameters": {
            "reservoir_volume_m3": params.reservoir_volume_m3,
            "reservoir_volume_mcm": round(params.reservoir_volume_m3 / 1e6, 2),
            "reservoir_area_km2": 5.0,
            "reservoir_area_ha": 500.0,
            "initial_water_level_m": params.dam_height_m,
            "dam_height_m": params.dam_height_m,
            "breach_width_m": round(hydro["breach_width_m"], 1),
            "breach_formation_time_min": round(hydro["breach_formation_time_s"] / 60.0, 1),
            "peak_outflow_cms": round(hydro["peak_outflow_cms"], 1),
            "peak_velocity_ms": 3.5,
            "max_flood_depth_m": round(float(np.max(max_depth_grid)), 2),
            "max_flood_width_m": 450.0,
            "max_inundated_area_km2": round(max_area_km2, 3),
            "max_inundated_area_ha": round(max_area_km2 * 100.0, 1),
            "affected_population_est": int(max_area_km2 * 450),
            "affected_buildings_est": int(max_area_km2 * 450 / 4.8),
            "inundated_roads_km": round(max_area_km2 * 1.35, 2),
            "inundated_agriculture_km2": round(max_area_km2 * 0.65, 2),
            "eroded_volume_m3": 25000.0,
            "failure_mode": params.failure_mode,
            "critical_water_level_m": round(params.dam_height_m * 0.85, 2),
            "warning_water_level_m": round(params.dam_height_m * 0.65, 2),
        },
        "village_impacts": [],
        "flood_polygon": None,
        "frame_polygons": [None for _ in snap_times],
        "simulation_timing_ms": 0,
        "dem_bounds": None,
        "dam_location": {"latitude": params.latitude or 20.5937, "longitude": params.longitude or 78.9629},
    }


# ---------------------------------------------------------------------------
# In-Memory Simulation Cache (for AI analysis)
# ---------------------------------------------------------------------------
# The cache now lives in sim_cache.py and is shared with the SSE pipeline
# (progress.py) so simulations started via /simulate/start are visible to
# the AI endpoints too. Aliases below preserve backward compatibility.

_simulation_cache = sim_cache.SIMULATION_CACHE
_cache_simulation = sim_cache.cache_simulation


# ---------------------------------------------------------------------------
# AI Copilot Endpoints
# ---------------------------------------------------------------------------

class AIAnalyzeRequest(BaseModel):
    """Request for AI simulation analysis."""
    simulation_id: str = Field(..., description="Cached simulation ID")
    language: str = Field(default="en", description="Response language")


class AIChatRequest(BaseModel):
    """Request for AI chat interaction."""
    simulation_id: Optional[str] = Field(default=None, description="Cached simulation ID if available")
    message: str = Field(..., min_length=1, max_length=MAX_CHAT_MESSAGE_CHARS, description="User message")
    conversation_history: list = Field(default_factory=list, description="Previous messages")
    dam_context: Optional[dict] = Field(default=None, description="Active selected dam data")
    simulation_context: Optional[dict] = Field(default=None, description="Active simulation parameters or results")

    @field_validator("conversation_history")
    @classmethod
    def _check_history(cls, v):
        if len(v) > MAX_CHAT_HISTORY_MESSAGES:
            raise ValueError(f"conversation_history limited to {MAX_CHAT_HISTORY_MESSAGES} messages")
        for msg in v:
            if not isinstance(msg, dict) or not isinstance(msg.get("content"), str):
                raise ValueError("history entries must be objects with a 'content' string")
            if len(msg["content"]) > MAX_CHAT_MESSAGE_CHARS:
                raise ValueError(f"history message exceeds {MAX_CHAT_MESSAGE_CHARS} chars")
        return v


class AIReportRequest(BaseModel):
    """Request for AI report generation."""
    simulation_id: str = Field(..., description="Cached simulation ID")
    language: str = Field(default="en", description="Report language")


@app.get("/ai/status")
def ai_status():
    """Check AI copilot availability."""
    available = groq_client.is_available()
    return {
        "groq_available": available,
        "api_key_configured": bool(os.environ.get("GROQ_API_KEY")),
        "model": groq_client.resolve_model() if available else None,
    }


@app.post("/ai/analyze")
async def ai_analyze(req: AIAnalyzeRequest):
    """
    Analyze simulation results using Groq AI.

    Returns structured analysis with:
      - Executive summary
      - Breach analysis
      - Flood propagation assessment
      - Village impact analysis
      - Key observations
    """
    # Retrieve cached simulation
    sim_data = sim_cache.get_simulation(req.simulation_id)
    if not sim_data:
        raise HTTPException(
            status_code=404,
            detail=f"Simulation not found: {req.simulation_id}. Run a simulation first."
        )

    if not groq_client.is_available():
        raise HTTPException(
            status_code=503,
            detail="AI service unavailable. Set GROQ_API_KEY environment variable."
        )

    t0 = time.time()
    system_prompt, user_prompt = ai_prompts.build_analysis_prompt(sim_data)
    response = groq_client.analyze_simulation(sim_data, system_prompt, user_prompt)
    latency_ms = (time.time() - t0) * 1000

    if response is None:
        raise HTTPException(status_code=502, detail="AI analysis failed")

    return {
        "status": "ok",
        "simulation_id": req.simulation_id,
        "analysis": response,
        "latency_ms": round(latency_ms, 0),
        "model": groq_client.resolve_model(),
    }


@app.post("/ai/recommendations")
async def ai_recommendations(req: AIAnalyzeRequest):
    """
    Generate emergency recommendations from simulation results.

    Returns:
      - Evacuation priorities
      - Early warning suggestions
      - Road closures
      - Shelter recommendations
      - Emergency response priorities
    """
    sim_data = sim_cache.get_simulation(req.simulation_id)
    if not sim_data:
        raise HTTPException(status_code=404, detail=f"Simulation not found: {req.simulation_id}")

    if not groq_client.is_available():
        raise HTTPException(status_code=503, detail="AI service unavailable")

    t0 = time.time()
    system_prompt, user_prompt = ai_prompts.build_recommendations_prompt(sim_data)
    response = groq_client.analyze_simulation(sim_data, system_prompt, user_prompt)
    latency_ms = (time.time() - t0) * 1000

    if response is None:
        raise HTTPException(status_code=502, detail="AI recommendation generation failed")

    return {
        "status": "ok",
        "simulation_id": req.simulation_id,
        "recommendations": response,
        "latency_ms": round(latency_ms, 0),
    }


@app.post("/ai/chat")
async def ai_chat(req: AIChatRequest):
    """
    Interactive chat about simulation results and dam safety.
    Powered by Groq high-speed LPU inference with full engineering context.
    """
    sim_data = None
    if req.simulation_id:
        sim_data = sim_cache.get_simulation(req.simulation_id)

    if not sim_data:
        # Build contextual data from payload
        sim_data = {}
        if req.dam_context and isinstance(req.dam_context, dict):
            sim_data.update(req.dam_context)
            sim_data["dam_name"] = req.dam_context.get("name") or sim_data.get("dam_name", "Selected Dam")
        if req.simulation_context and isinstance(req.simulation_context, dict):
            sim_data.update(req.simulation_context)

    if not groq_client.is_available():
        raise HTTPException(status_code=503, detail="AI service unavailable. Ensure GROQ_API_KEY is set in .env")

    # Build conversation with history
    conversation = req.conversation_history.copy()
    conversation.append({"role": "user", "content": req.message})

    system_prompt = ai_prompts.build_chat_system_prompt(sim_data)
    t0 = time.time()
    response = groq_client.chat_with_context(conversation, system_prompt)
    latency_ms = (time.time() - t0) * 1000

    if response is None:
        raise HTTPException(status_code=502, detail="Groq AI chat failed to generate response")

    return {
        "status": "ok",
        "simulation_id": req.simulation_id,
        "response": response,
        "model": groq_client.resolve_model(),
        "latency_ms": round(latency_ms, 0),
        "updated_history": conversation + [{"role": "assistant", "content": response}],
    }


@app.post("/ai/report")
async def ai_report(req: AIReportRequest):
    """
    Generate a comprehensive simulation report in Markdown.

    Returns structured report with:
      - Executive Summary
      - Key Risks
      - Technical Analysis
      - Emergency Actions
      - Limitations
      - Confidence Statement
    """
    sim_data = sim_cache.get_simulation(req.simulation_id)
    if not sim_data:
        raise HTTPException(status_code=404, detail=f"Simulation not found: {req.simulation_id}")

    if not groq_client.is_available():
        raise HTTPException(status_code=503, detail="AI service unavailable")

    t0 = time.time()
    system_prompt, user_prompt = ai_prompts.build_report_prompt(sim_data)
    response = groq_client.generate_report(sim_data, system_prompt, user_prompt)
    latency_ms = (time.time() - t0) * 1000

    if response is None:
        raise HTTPException(status_code=502, detail="AI report generation failed")

    return {
        "status": "ok",
        "simulation_id": req.simulation_id,
        "report": response,
        "latency_ms": round(latency_ms, 0),
    }


@app.get("/ai/suggested-questions")
def ai_suggested_questions():
    """Return suggested questions for the AI chat."""
    return {"questions": ai_prompts.SUGGESTED_QUESTIONS}


# ---------------------------------------------------------------------------
# PDF Report Export
# ---------------------------------------------------------------------------

class PDFReportRequest(BaseModel):
    simulation_id: str
    language: str = "en"


@app.post("/report/pdf")
async def generate_pdf_report(req: PDFReportRequest):
    """Generate a high-grade SIH government PDF report from simulation results."""
    from fastapi.responses import Response

    sim_data = sim_cache.get_simulation(req.simulation_id)
    if not sim_data:
        raise HTTPException(status_code=404, detail=f"Simulation not found: {req.simulation_id}")

    try:
        from . import report_engine
        if not getattr(report_engine, "REPORTLAB_AVAILABLE", False):
            import importlib
            importlib.reload(report_engine)
        pdf_bytes = report_engine.build_pdf_report(sim_data)
        dam_name = sim_data.get("dam_name") or "Dam"
        safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', dam_name)
        filename = f"{safe_name}_Dam_Break_Report.pdf"
        logger.info("Generated PDF report (%d bytes) for %s (%s)", len(pdf_bytes), dam_name, req.simulation_id)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Dam-Name": safe_name,
            },
        )
    except Exception as e:
        logger.exception("Failed to generate PDF report: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to generate PDF report: {e}")


# ---------------------------------------------------------------------------
# Static File Mounting
# ---------------------------------------------------------------------------

_frontend_path = _project_root / "frontend"
_sample_data_path = _project_root / "sample_data"
_public_assets_path = _project_root / "public" / "assets"

if _sample_data_path.exists():
    app.mount("/sample_data", StaticFiles(directory=str(_sample_data_path)), name="sample_data")

# Serve the standard assets tree (public/assets/{models,textures,env}).
# Mounted at /public/assets — paths are defined in frontend/config/assets.js.
# Place a dam model in public/assets/models/dam/ and set its filename there.
if _public_assets_path.exists():
    app.mount(
        "/public/assets",
        StaticFiles(directory=str(_public_assets_path)),
        name="public_assets",
    )
    app.mount(
        "/assets",
        StaticFiles(directory=str(_public_assets_path)),
        name="assets",
    )

if _frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_path), html=True), name="frontend")
