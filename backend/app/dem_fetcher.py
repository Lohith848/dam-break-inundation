"""DEM and dam dataset loading utilities for the FastAPI application."""

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger("dam_sim.dem_fetcher")

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CACHE_DIR = _PROJECT_ROOT / "datasets" / "dem" / "cache"


def _load_env_fallback() -> None:
    """Load a local .env without overwriting an existing environment value."""
    for directory in [Path.cwd(), _PROJECT_ROOT, _PROJECT_ROOT / "backend", Path(__file__).resolve().parent]:
        env_file = directory / ".env"
        if not env_file.is_file():
            continue
        try:
            for raw in env_file.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    if key.strip() and value.strip() and not os.environ.get(key.strip()):
                        os.environ[key.strip()] = value.strip().strip("'\"")
        except OSError:
            logger.exception("Could not read %s", env_file)


def get_opentopography_key() -> str:
    key = os.environ.get("OPENTOPOGRAPHY_API_KEY", "")
    if not key:
        _load_env_fallback()
    return os.environ.get("OPENTOPOGRAPHY_API_KEY", "")


def get_cache_dir() -> Path:
    return _CACHE_DIR


def parse_dms(value) -> float:
    """Parse decimal or common DMS coordinate strings."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if not text:
        raise ValueError("empty coordinate")
    try:
        return float(text)
    except ValueError:
        pass
    match = re.match(
        r"^\s*(\d+(?:\.\d+)?)\s*[°º]?\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?"
        r"(?:(\d+(?:\.\d+)?)\s*[\"″])?\s*([NSEW])\s*$",
        text,
        re.IGNORECASE,
    )
    if not match:
        raise ValueError(f"Cannot parse coordinate: {value!r}")
    degrees, minutes, seconds, direction = match.groups()
    result = float(degrees) + float(minutes or 0) / 60 + float(seconds or 0) / 3600
    return -result if direction.upper() in ("S", "W") else result


def generate_aoi(lat: float, lon: float, padding_lat: float = 0.18, padding_lon: float = 0.20) -> Tuple[float, float, float, float]:
    return round(lat + padding_lat, 6), round(lat - padding_lat, 6), round(lon + padding_lon, 6), round(lon - padding_lon, 6)


def _cache_key(south, north, west, east, dem_type):
    return hashlib.md5(f"{dem_type}_{south}_{north}_{west}_{east}".encode()).hexdigest()


def _cache_path(south, north, west, east, dem_type):
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR / f"{_cache_key(south, north, west, east, dem_type)}.tif"


def get_cached_dem(south, north, west, east, dem_type="COP30") -> Optional[Path]:
    path = _cache_path(south, north, west, east, dem_type)
    if path.is_file() and path.stat().st_size:
        return path
    return None


def fetch_dem_tile(south, north, west, east, api_key=None, dem_type="COP30", output_format="GTiff", force_download=False) -> Path:
    if not force_download:
        cached = get_cached_dem(south, north, west, east, dem_type)
        if cached:
            return cached
    key = api_key or get_opentopography_key()
    if not key:
        raise ValueError("OpenTopography API key is required — add OPENTOPOGRAPHY_API_KEY to .env")
    import requests
    response = requests.get(
        "https://portal.opentopography.org/API/globaldem",
        params={"demtype": dem_type, "south": south, "north": north, "west": west, "east": east, "outputFormat": output_format, "API_Key": key},
        timeout=30,
    )
    if response.status_code != 200:
        raise RuntimeError(f"OpenTopography API returned HTTP {response.status_code}: {response.text[:500]}")
    if "json" in response.headers.get("Content-Type", "").lower():
        raise RuntimeError(f"OpenTopography API error: {response.text[:500]}")
    path = _cache_path(south, north, west, east, dem_type)
    path.write_bytes(response.content)
    return path


def _resolve_dam_geojson_path() -> Path:
    candidates = [
        _PROJECT_ROOT / "datasets" / "dam" / "dam.geojson",
        Path.cwd() / "datasets" / "dam" / "dam.geojson",
        Path.cwd() / "backend" / "datasets" / "dam" / "dam.geojson",
    ]
    for candidate in candidates:
        if candidate.is_file() and candidate.stat().st_size > 1000:
            return candidate
    return candidates[0]


def _coordinate(props: dict, geometry: dict, key: str, index: int) -> float:
    raw = props.get(key)
    if raw not in (None, ""):
        return parse_dms(raw)
    coordinates = (geometry or {}).get("coordinates") or []
    if len(coordinates) > index:
        return float(coordinates[index])
    raise ValueError(f"missing {key}")


def load_dam_list(max_dams: int = 500) -> List[Dict]:
    """Load and normalize dams from the repository dataset.

    Resolve the path on every request and open that resolved path.  The old
    implementation opened a module-level path, which could be stale when the
    app was started before a mounted dataset became available.
    """
    path = _resolve_dam_geojson_path()
    if not path.is_file():
        logger.warning("Dam database not found: %s", path)
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("Unable to load dam database: %s", path)
        return []

    dams = []
    for feature in data.get("features", []):
        props = feature.get("properties") or {}
        try:
            lat = _coordinate(props, feature.get("geometry"), "latitude", 1)
            lon = _coordinate(props, feature.get("geometry"), "longitude", 0)
        except (ValueError, TypeError, IndexError):
            continue
        def number(name):
            try:
                return float(props.get(name) or 0)
            except (TypeError, ValueError):
                return 0.0
        dam_id = str(props.get("PIC") or props.get("pic") or props.get("id") or "").strip()
        name = str(props.get("dm_name") or props.get("name") or "Unknown Dam").strip()
        dams.append({
            "id": dam_id, "name": name,
            "state": str(props.get("state") or "").strip(),
            "district": str(props.get("district") or "").strip(),
            "river": str(props.get("river") or props.get("river_name") or "").strip(),
            "latitude": lat, "longitude": lon,
            "dam_height_m": number("ht_found"),
            "reservoir_volume_mcm": number("gs_st_cap"),
            "purpose": props.get("purpose") or "",
            "dam_type": str(props.get("dm_type") or "").replace("·", "").replace("•\t", "").strip(),
            "year_completed": props.get("cmp_year", 0),
            "basin": str(props.get("basin") or "").strip(),
        })
        if len(dams) >= max_dams:
            break
    dams.sort(key=lambda dam: (dam["state"], dam["name"]))
    logger.info("Loaded %d dams from %s", len(dams), path)
    return dams


def get_dam_by_id(dam_id: str) -> Optional[Dict]:
    return next((dam for dam in load_dam_list(99999) if dam["id"] == dam_id), None)


def fetch_dem_for_dam(lat, lon, api_key=None, dem_type="COP30", padding_lat=0.18, padding_lon=0.20):
    north, south, east, west = generate_aoi(lat, lon, padding_lat, padding_lon)
    return fetch_dem_tile(south, north, west, east, api_key, dem_type)
