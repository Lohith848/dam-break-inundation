"""
weather.py
----------
Live rainfall for the dam's catchment, via Open-Meteo — free, no API key,
no signup. This is the one number in your whole pipeline that can be
genuinely real-time rather than stored/precomputed; say so explicitly in
the UI and in your pitch.
"""

import logging
from datetime import datetime, timezone

import requests
from fastapi import APIRouter, HTTPException

from .validation import validate_coordinates

logger = logging.getLogger("dam_sim.weather")
router = APIRouter(prefix="/weather", tags=["weather"])

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


@router.get("/rainfall")
def get_live_rainfall(lat: float, lon: float):
    """
    Get live rainfall data for a location.

    Returns:
        current_mm_per_hr: current rainfall intensity
        next_24h_total_mm: cumulative next-24h forecast
        hourly_times: ISO timestamps for the next 24 hours
        hourly_mm: precipitation values per hour
        fetched_at: when this data was fetched
        source: data source attribution
    """
    # Validate up front — a bad coordinate is a client error (422), not a 502.
    try:
        validate_coordinates(lat, lon)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    try:
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": "precipitation",
            "forecast_days": 2,
            "timezone": "auto",
        }
        resp = requests.get(
            OPEN_METEO_URL, params=params, timeout=8.0,
            headers={"User-Agent": "SIH26161-DamBreakPlatform/2.0"},
        )
        resp.raise_for_status()
        data = resp.json()

        times = data["hourly"]["time"]
        mm = data["hourly"]["precipitation"]

        # "current" = the most recent hourly bucket at/before now
        now = datetime.now(timezone.utc)
        current_idx = 0
        for i, t in enumerate(times):
            t_parsed = datetime.fromisoformat(t)
            if t_parsed.tzinfo is None:
                # Open-Meteo returns local time when timezone=auto
                current_idx = i
                continue
            if t_parsed <= now:
                current_idx = i

        next_24h = mm[current_idx: current_idx + 24]

        return {
            "current_mm_per_hr": float(mm[current_idx]) if mm else 0.0,
            "next_24h_total_mm": round(sum(next_24h), 1),
            "hourly_times": times[current_idx: current_idx + 24],
            "hourly_mm": next_24h,
            "fetched_at": now.isoformat(),
            "source": "open-meteo.com",
        }
    except requests.RequestException as e:
        logger.warning("Open-Meteo request failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Weather data unavailable: {e}")
    except (KeyError, IndexError) as e:
        logger.warning("Unexpected Open-Meteo response format: %s", e)
        raise HTTPException(status_code=502, detail=f"Weather data parse error: {e}")
