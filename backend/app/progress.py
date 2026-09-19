"""
progress.py
-----------
Replaces a client-side fake timer with REAL backend progress for the
documented 6-step progress UI:
  1. Download DEM  2. Load Terrain  3. Generate Mesh
  4. Run Simulation  5. Generate Flood Map  6. AI Analysis

Uses Server-Sent Events (SSE) — no extra dependency beyond FastAPI/Starlette.
"""

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from . import breach as breach_mod
from . import dem as dem_utils
from . import dem_fetcher
from . import flood as flood_engine
from . import sim_cache
from . import validation
from .failure_modes import FailureMode, normalize_failure_mode
from .ai import groq_client
from .ai import prompts as ai_prompts

logger = logging.getLogger("dam_sim.progress")
router = APIRouter(tags=["progress"])

STEPS = [
    "Download DEM",
    "Load Terrain",
    "Generate Mesh",
    "Run Simulation",
    "Generate Flood Map",
    "AI Analysis",
]

# In-memory job store — bounded so a long-running server can never leak
# memory: finished jobs are evicted oldest-first beyond MAX_JOBS.
MAX_JOBS = 100
_JOBS: dict[str, dict] = {}


def _register_job(job_id: str, job: dict) -> None:
    """Insert a job and evict oldest finished jobs over the cap."""
    _JOBS[job_id] = job
    if len(_JOBS) > MAX_JOBS:
        finished = [k for k, j in _JOBS.items() if j.get("done")]
        # Prefer evicting finished jobs; fall back to oldest inserts.
        victims = finished[: len(_JOBS) - MAX_JOBS] or list(_JOBS)[: len(_JOBS) - MAX_JOBS]
        for k in victims:
            _JOBS.pop(k, None)


class SimulateStartRequest(BaseModel):
    """Request body for starting a simulation with progress tracking."""
    dam_id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    dam_name: str = Field(default="Demo Dam", max_length=120)
    reservoir_volume_m3: float = Field(..., gt=0)
    dam_height_m: float = Field(..., gt=0)
    failure_mode: str = Field(default=FailureMode.PIPING.value)  # normalized before simulation
    breach_width_m: Optional[float] = Field(default=None, gt=0)
    breach_formation_time_min: Optional[float] = Field(default=None, gt=0)
    manning_n: float = Field(default=0.045, gt=0, lt=0.2)
    total_sim_hours: float = Field(default=3.0, gt=0, le=24)
    dem_type: str = "COP30"

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


@router.post("/simulate/start")
async def simulate_start(req: SimulateStartRequest):
    """Start a simulation with real-time progress tracking via SSE."""
    job_id = uuid.uuid4().hex[:12]
    _register_job(job_id, {
        "step": 0,
        "label": STEPS[0],
        "done": False,
        "error": None,
        "result": None,
        "start_time": time.time(),
    })
    asyncio.create_task(_run_pipeline(job_id, req))
    return {"job_id": job_id}


async def _run_pipeline(job_id: str, req: SimulateStartRequest):
    """Run the full simulation pipeline with real progress updates."""
    job = _JOBS[job_id]
    try:
        dam_lat = req.latitude
        dam_lon = req.longitude

        # Resolve dam coordinates
        dam_name = req.dam_name
        dam_river = None
        dam_state = None
        dam_district = None
        if req.dam_id:
            dam = await run_in_threadpool(dem_fetcher.get_dam_by_id, req.dam_id)
            if dam:
                dam_lat = dam["latitude"]
                dam_lon = dam["longitude"]
                if not req.dam_name or req.dam_name == "Demo Dam" or req.dam_name == "Dam":
                    dam_name = dam["name"]
                else:
                    dam_name = req.dam_name
                dam_river = dam.get("river")
                dam_state = dam.get("state")
                dam_district = dam.get("district")

        if dam_lat is None or dam_lon is None:
            job.update({"done": True, "error": "No coordinates available"})
            return

        # Step 1 — Download DEM
        job.update({"step": 0, "label": STEPS[0]})
        terrain_type = "opentopography"
        try:
            tif_path = await run_in_threadpool(
                dem_fetcher.fetch_dem_for_dam,
                dam_lat, dam_lon, req.dem_type,
            )

            # Step 2 — Load Terrain
            job.update({"step": 1, "label": STEPS[1]})
            dem, dx, dam_col, dem_bounds = await run_in_threadpool(
                dem_utils.load_opentopography_dem,
                str(tif_path), 80, 120,
            )
        except Exception as dem_err:
            logger.warning("DEM acquisition failed (%s) — falling back to synthetic terrain", dem_err)
            job.update({"step": 1, "label": "Using Terrain Fallback Model"})
            terrain_type = "synthetic"
            dx = 30.0
            dam_col = 15
            dem = dem_utils.make_synthetic_valley_dem(dam_x_index=dam_col)
            dem_bounds = (
                dam_lon - 0.20,
                dam_lat - 0.18,
                dam_lon + 0.20,
                dam_lat + 0.18,
            )

        # Step 3 — Generate Mesh
        job.update({"step": 2, "label": STEPS[2]})
        config = flood_engine.SimulationConfig(
            volume_m3=req.reservoir_volume_m3,
            height_m=req.dam_height_m,
            failure_mode=normalize_failure_mode(req.failure_mode),
            manning_n=req.manning_n,
            total_sim_hours=req.total_sim_hours,
            breach_width_override_m=req.breach_width_m,
            formation_time_override_min=req.breach_formation_time_min,
        )

        # Step 4 — Run Simulation
        job.update({"step": 3, "label": STEPS[3]})
        result = await run_in_threadpool(
            flood_engine.run_simulation,
            dem, dx, dam_col, config,
            req.dam_name,
            dem_bounds or (0, 0, 0, 0),
            dam_lat, dam_lon,
        )

        # Step 5 — Generate Flood Map
        job.update({"step": 4, "label": STEPS[4]})
        # Build response payload (same shape as /simulate)
        import numpy as np
        village_impacts = build_village_impacts(result)

        response = {
            "dam_name": dam_name,
            "dam_id": req.dam_id,
            "river": dam_river,
            "state": dam_state,
            "district": dam_district,
            "manning_n": req.manning_n,
            "total_sim_hours": req.total_sim_hours,
            "terrain_type": terrain_type,
            "dem_type": req.dem_type if terrain_type == "opentopography" else "synthetic",
            "failure_mode": req.failure_mode,
            "breach": {
                "peak_outflow_cms": result.peak_outflow_cms,
                "breach_width_m": result.breach_width_m,
                "breach_formation_time_min": result.breach_formation_time_min,
            },
            "grid": {
                "dx_m": result.dx, "ny": result.ny, "nx": result.nx,
                "dam_col": result.dam_col,
            },
            "dam_geometry": {
                "dam_col_index": result.dam_geometry.get("col_index", result.dam_col // 2),
                "crest_height_m": result.dam_geometry.get("dam_height_m", req.dam_height_m),
                "breach_width_m": result.dam_geometry.get("breach_width_m", result.breach_width_m),
                "breach_level_m": result.dam_geometry.get("dam_height_m", req.dam_height_m) * 0.6,
            },
            "elevation_stats": {
                "min_elev": result.elevation_stats.get("min_m", 0),
                "max_elev": result.elevation_stats.get("max_m", 100),
            },
            "elevation_grid": result.elevation_grid,
            "summary": result.summary,
            "snapshot_times_s": result.snapshot_times_s,
            "timesteps_hours": [t / 3600.0 for t in result.snapshot_times_s],
            "timesteps_formatted": getattr(result, "timesteps_formatted", []),
            "depth_grids": result.depth_grids,
            "velocity_grids": result.velocity_grids,
            "risk_grids": getattr(result, "risk_grids", None),
            "arrival_grid": getattr(result, "arrival_grid", None),
            "hydraulic_parameters": getattr(result, "hydraulic_parameters", None),
            "village_impacts": village_impacts,
            "flood_polygon": result.flood_polygon_geojson,
            "frame_polygons": getattr(result, "frame_polygons", None),
            "simulation_timing_ms": result.simulation_time_ms,
            "dem_bounds": {
                "west": dem_bounds[0], "south": dem_bounds[1],
                "east": dem_bounds[2], "north": dem_bounds[3],
            } if dem_bounds else None,
            "dam_location": {"latitude": dam_lat, "longitude": dam_lon},
        }

        # Step 6 — AI Analysis
        job.update({"step": 5, "label": STEPS[5]})
        # Register the result in the shared simulation cache so the AI
        # Copilot endpoints (/ai/analyze, /ai/chat, ...) can resolve this
        # simulation_id. Previously this step only generated an ID without
        # caching anything, causing "Simulation not found" errors.
        sim_id = sim_cache.cache_simulation(response)
        response["simulation_id"] = sim_id

        job.update({"done": True, "result": response})

    except Exception as e:
        logger.exception("Pipeline error for job %s", job_id)
        job.update({"done": True, "error": str(e)})


def build_village_impacts(result) -> list:
    """Build village_impacts with status field for the 3D viewer.

    Single shared implementation — main.py's /simulate uses this too,
    so the status thresholds never drift between endpoints.
    """
    impacts = []
    for poi in result.points_of_interest:
        depth = poi.get("peak_depth_m", 0)
        if depth > 2.0:
            status = "critical"
        elif depth >= 0.5:
            status = "warning"
        else:
            status = "safe"

        cell = poi.get("cell", [0, 0])
        impacts.append({
            "name": poi["name"],
            "arrival_time_hr": (poi["arrival_time_min"] / 60.0) if poi.get("arrival_time_min") else None,
            "arrival_time_min": poi.get("arrival_time_min"),
            "peak_depth_m": poi.get("peak_depth_m", 0),
            "status": status,
            "cell_3d": poi.get("cell_3d", [cell[0] // 2, cell[1] // 2]),
        })
    return impacts


@router.get("/simulate/stream/{job_id}")
async def simulate_stream(job_id: str):
    """Stream simulation progress via Server-Sent Events."""
    async def event_generator():
        last_step = -1
        while True:
            job = _JOBS.get(job_id)
            if job is None:
                yield f"data: {json.dumps({'error': 'unknown job_id'})}\n\n"
                return
            if job["step"] != last_step or job["done"]:
                last_step = job["step"]
                payload = {
                    "step": job["step"],
                    "label": job["label"],
                    "total_steps": len(STEPS),
                    "done": job["done"],
                    "error": job["error"],
                }
                yield f"data: {json.dumps(payload)}\n\n"
            if job["done"]:
                yield f"event: result\ndata: {json.dumps(job['result'] or {})}\n\n"
                return
            await asyncio.sleep(0.25)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
