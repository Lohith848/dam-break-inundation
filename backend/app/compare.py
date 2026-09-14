"""
compare.py
----------
Scenario comparison — explicitly required by the SIH26161 brief, and the
biggest functional gap versus the documented current build.

Calls the EXISTING simulate() function — does not reimplement any physics —
so it stays consistent with whatever /simulate already does.
"""

import logging
import re
import time
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from . import breach as breach_mod
from . import dem as dem_utils
from . import dem_fetcher
from . import flood as flood_engine
from . import validation
from .failure_modes import FailureMode, normalize_failure_mode

logger = logging.getLogger("dam_sim.compare")
router = APIRouter(tags=["compare"])


class ScenarioParams(BaseModel):
    """Parameters for a single scenario."""
    dam_id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    dam_name: str = Field(default="Demo Dam", max_length=120)
    reservoir_volume_m3: float = Field(..., gt=0)
    dam_height_m: float = Field(..., gt=0)
    failure_mode: str = Field(default=FailureMode.PIPING.value)  # validated via FailureMode enum
    manning_n: float = Field(default=0.045, gt=0, lt=0.2)
    total_sim_hours: float = Field(default=3.0, gt=0, le=12)
    dem_type: str = "COP30"
    # Optional user overrides honored per scenario
    breach_width_m: Optional[float] = Field(default=None, gt=0)
    breach_formation_time_min: Optional[float] = Field(default=None, gt=0)

    @field_validator("latitude", "longitude")
    @classmethod
    def _check_coords(cls, v):
        validation.validate_coordinates(v, None)
        return v

    @field_validator("dam_id")
    @classmethod
    def _check_dam_id(cls, v):
        if v is not None:
            v = v.strip()
            if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", v):
                raise ValueError("dam_id must be 1-40 alphanumeric characters")
        return v


# Cap: each scenario runs a full DEM fetch + simulation; an unbounded list
# would let one request hog the server for minutes.
MAX_SCENARIOS = 5


class CompareRequest(BaseModel):
    """Request body for scenario comparison."""
    scenarios: List[ScenarioParams] = Field(..., max_length=MAX_SCENARIOS)
    labels: Optional[List[str]] = None


def _run_single_scenario(params: ScenarioParams) -> dict:
    """Run a single simulation scenario and return a summary dict."""
    dam_lat = params.latitude
    dam_lon = params.longitude
    params.failure_mode = normalize_failure_mode(params.failure_mode)

    # Resolve dam coordinates from DB if dam_id provided
    if params.dam_id:
        dam = dem_fetcher.get_dam_by_id(params.dam_id)
        if dam:
            dam_lat = dam["latitude"]
            dam_lon = dam["longitude"]
            if params.dam_name == "Demo Dam":
                params.dam_name = dam["name"]

    if dam_lat is None or dam_lon is None:
        return {"error": "No coordinates available"}

    try:
        tif_path = dem_fetcher.fetch_dem_for_dam(
            lat=dam_lat, lon=dam_lon, dem_type=params.dem_type,
        )
        dem, dx, dam_col, dem_bounds = dem_utils.load_opentopography_dem(
            str(tif_path), target_rows=80, target_cols=120,
        )
    except Exception as e:
        logger.warning("DEM fetch/load failed for scenario: %s", e)
        return {"error": str(e)}

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
        dem=dem, dx=dx, dam_col=dam_col, config=config,
        dam_name=params.dam_name,
        bounds=dem_bounds or (0, 0, 0, 0),
        latitude=dam_lat, longitude=dam_lon,
    )

    return {
        "dam_name": params.dam_name,
        "failure_mode": params.failure_mode,
        "breach": {
            "peak_outflow_cms": result.peak_outflow_cms,
            "breach_width_m": result.breach_width_m,
            "breach_formation_time_min": result.breach_formation_time_min,
        },
        "summary": result.summary,
    }


@router.post("/compare")
def compare_scenarios(req: CompareRequest):
    """
    Compare multiple dam break scenarios side by side.

    Returns per-scenario breach and summary data, plus a delta
    between the first two scenarios (area, peak depth, arrival times).
    """
    if len(req.scenarios) < 2:
        raise HTTPException(status_code=400, detail="Provide at least two scenarios to compare.")

    t0 = time.time()
    results = [_run_single_scenario(p) for p in req.scenarios]
    elapsed_ms = (time.time() - t0) * 1000

    # Check for errors
    for i, r in enumerate(results):
        if "error" in r:
            raise HTTPException(
                status_code=400,
                detail=f"Scenario {i+1} failed: {r['error']}"
            )

    labels = req.labels or [r.get("dam_name", f"Scenario {i+1}") for i, r in enumerate(results)]

    scenarios_out = [
        {
            "label": labels[i] if i < len(labels) else f"Scenario {i+1}",
            "failure_mode": req.scenarios[i].failure_mode,
            "breach": r["breach"],
            "summary": r["summary"],
        }
        for i, r in enumerate(results)
    ]

    # Pairwise delta between first two scenarios
    a, b = results[0]["summary"], results[1]["summary"]
    delta = {
        "area_km2": round(b["max_inundated_area_km2"] - a["max_inundated_area_km2"], 3),
        "peak_depth_m": round(b["max_flood_depth_m"] - a["max_flood_depth_m"], 2),
    }

    # Per-village arrival-time delta
    village_delta = []
    a_villages = {v["name"]: v for v in a.get("points_of_interest", [])}
    b_villages = {v["name"]: v for v in b.get("points_of_interest", [])}
    for name in a_villages:
        if name in b_villages:
            av = a_villages[name].get("arrival_time_min")
            bv = b_villages[name].get("arrival_time_min")
            village_delta.append({
                "name": name,
                "arrival_a_min": av,
                "arrival_b_min": bv,
                "delta_min": None if (av is None or bv is None) else round(bv - av, 1),
            })

    logger.info("Comparison of %d scenarios completed in %.0f ms", len(results), elapsed_ms)

    return {
        "scenarios": scenarios_out,
        "delta": delta,
        "village_delta": village_delta,
        "elapsed_ms": round(elapsed_ms, 0),
    }
