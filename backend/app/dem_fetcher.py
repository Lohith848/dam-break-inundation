"""
dem_fetcher.py
--------------
Fetch real-world Digital Elevation Model tiles from OpenTopography API.

- API key stored internally (not exposed to frontend)
- Deterministic local caching by AOI bounds
- Structured logging for every operation
"""

import json
import os
import re
import hashlib
import logging
import time
from pathlib import Path
from typing import Optional, Tuple, List, Dict

logger = logging.getLogger("dam_sim.dem_fetcher")

# ---------------------------------------------------------------------------
# API Key — loaded from environment / .env file, never hardcoded in source.
# Add OPENTOPOGRAPHY_API_KEY=<your key> to the project .env file.
# ---------------------------------------------------------------------------


def _load_env_fallback():
    """Minimal .env loader used when python-dotenv is unavailable.

    Searches cwd and directories upward from this file so it works whether
    uvicorn is started from the project root or from backend/.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv()
        if os.environ.get("OPENTOPOGRAPHY_API_KEY"):
            return
    except ImportError:
        pass

    here = Path(__file__).resolve()
    for d in [Path.cwd(), *here.parents[:4]]:
        env_file = d / ".env"
        if env_file.is_file():
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k, v = k.strip(), v.strip().strip("'\"")
                            # Override empty-string placeholders (e.g. KEY= exported
                            # by the OS shell) but never a real, non-empty value.
                            if k and v and not os.environ.get(k):
                                os.environ[k] = v
                if os.environ.get("OPENTOPOGRAPHY_API_KEY"):
                    return
            except Exception:
                pass


def get_opentopography_key() -> str:
    """Return the OpenTopography API key from the environment (.env file)."""
    key = os.environ.get("OPENTOPOGRAPHY_API_KEY", "")
    if key:
        return key
    _load_env_fallback()
    return os.environ.get("OPENTOPOGRAPHY_API_KEY", "")


def get_cache_dir() -> Path:
    """Public accessor for the DEM cache directory (used by /dem/cache)."""
    return _CACHE_DIR

# ---------------------------------------------------------------------------
# 1. Coordinate Parsing: DMS strings → decimal degrees
# ---------------------------------------------------------------------------

_DMS_PATTERN = re.compile(
    r"""
    ^\s*
    (?P<deg>\d{1,3})\s*[°]\s*
    (?P<min>\d{1,2})\s*['′]\s*
    (?P<sec>[\d.]+)\s*["″]?\s*
    (?P<dir>[NSEWnsew])
    \s*$
    """,
    re.VERBOSE,
)


def parse_dms(dms_str: str) -> float:
    """Convert DMS string (e.g. '11° 37' 28.000" N') to signed decimal degrees."""
    m = _DMS_PATTERN.match(dms_str)
    if not m:
        raise ValueError(f"Cannot parse DMS string: {dms_str!r}")

    deg = float(m.group("deg"))
    minutes = float(m.group("min"))
    seconds = float(m.group("sec"))
    direction = m.group("dir").upper()

    dd = deg + minutes / 60.0 + seconds / 3600.0
    if direction in ("S", "W"):
        dd = -dd
    return round(dd, 6)


# ---------------------------------------------------------------------------
# 2. AOI (Area of Interest) Bounding Box Generator
# ---------------------------------------------------------------------------

def generate_aoi(
    lat: float,
    lon: float,
    padding_lat: float = 0.18,
    padding_lon: float = 0.20,
) -> Tuple[float, float, float, float]:
    """Generate a bounding box around the dam. Returns (north, south, east, west)."""
    north = round(lat + padding_lat, 6)
    south = round(lat - padding_lat, 6)
    east = round(lon + padding_lon, 6)
    west = round(lon - padding_lon, 6)
    return north, south, east, west


# ---------------------------------------------------------------------------
# 3. Local Cache Manager
# ---------------------------------------------------------------------------

_CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "datasets" / "dem" / "cache"


def _cache_key(south: float, north: float, west: float, east: float, dem_type: str) -> str:
    """Deterministic cache filename from AOI bounds."""
    raw = f"{dem_type}_{south}_{north}_{west}_{east}"
    return hashlib.md5(raw.encode()).hexdigest()


def _cache_path(south: float, north: float, west: float, east: float, dem_type: str) -> Path:
    """Full path to cached GeoTIFF."""
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = _cache_key(south, north, west, east, dem_type)
    return _CACHE_DIR / f"{key}.tif"


def get_cached_dem(
    south: float, north: float, west: float, east: float, dem_type: str = "COP30"
) -> Optional[Path]:
    """Return path to cached GeoTIFF if it exists, else None."""
    p = _cache_path(south, north, west, east, dem_type)
    if p.exists() and p.stat().st_size > 0:
        logger.info("Cache hit: %s (%.1f MB)", p.name, p.stat().st_size / 1048576)
        return p

    # Fallback 1: Pre-packaged benchmark Mettur DEM (Stanley Reservoir)
    mid_lat = (south + north) / 2.0
    mid_lon = (west + east) / 2.0
    if abs(mid_lat - 11.8025) < 0.25 and abs(mid_lon - 77.8015) < 0.25:
        mettur = _CACHE_DIR.parent / "mettur_dem.tif"
        if mettur.exists() and mettur.stat().st_size > 0:
            logger.info("Cache hit (Mettur benchmark DEM): %s (%.1f MB)", mettur.name, mettur.stat().st_size / 1048576)
            return mettur

    # Fallback 2: Any cached tile overlapping the requested center
    if _CACHE_DIR.exists():
        for tif in _CACHE_DIR.glob("*.tif"):
            if tif.stat().st_size > 0:
                try:
                    import rasterio
                    with rasterio.open(tif) as src:
                        b = src.bounds
                        if b.left <= mid_lon <= b.right and b.bottom <= mid_lat <= b.top:
                            logger.info("Spatial cache hit: %s covers target (%.4f, %.4f)", tif.name, mid_lat, mid_lon)
                            return tif
                except Exception:
                    pass

    return None


# ---------------------------------------------------------------------------
# 4. OpenTopography API Client
# ---------------------------------------------------------------------------

def fetch_dem_tile(
    south: float,
    north: float,
    west: float,
    east: float,
    api_key: Optional[str] = None,
    dem_type: str = "COP30",
    output_format: str = "GTiff",
    force_download: bool = False,
) -> Path:
    """
    Download a DEM tile from OpenTopography and cache it locally.

    Parameters
    ----------
    south, north, west, east : bounding box in decimal degrees
    api_key : OpenTopography API key (defaults to internal key)
    dem_type : COP30 | SRTMGL1 | SRTMGL3 | ASTGTMV3
    force_download : ignore cache, re-download

    Returns
    -------
    Path to the local cached GeoTIFF file.

    Raises
    ------
    RuntimeError if the API call fails.
    ValueError if API key is missing.
    """
    # Check cache first
    if not force_download:
        cached = get_cached_dem(south, north, west, east, dem_type)
        if cached:
            return cached

    import requests

    key = api_key or get_opentopography_key()
    if not key:
        raise ValueError(
            "OpenTopography API key is required — "
            "add OPENTOPOGRAPHY_API_KEY=<your key> to the project .env file"
        )

    url = "https://portal.opentopography.org/API/globaldem"
    params = {
        "demtype": dem_type,
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "outputFormat": output_format,
        "API_Key": key,
    }

    logger.info("Fetching DEM tile: %s | AOI=(%.4f, %.4f, %.4f, %.4f)",
                dem_type, south, north, west, east)
    t0 = time.time()

    # Retry transient network failures (max 3 attempts, linear backoff).
    max_attempts = 3
    response = None
    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.get(url, params=params, timeout=120, stream=True)
            break
        except requests.exceptions.Timeout:
            logger.warning("OpenTopography timeout (attempt %d/%d)", attempt, max_attempts)
            if attempt == max_attempts:
                raise RuntimeError("OpenTopography API request timed out (120s)")
        except requests.exceptions.ConnectionError as e:
            logger.warning("OpenTopography connection error (attempt %d/%d): %s",
                           attempt, max_attempts, e)
            if attempt == max_attempts:
                raise RuntimeError(f"Network error connecting to OpenTopography: {e}")
        time.sleep(1.0 * attempt)

    if response is None:  # defensive; loop always sets or raises
        raise RuntimeError("OpenTopography request failed without a response")

    latency_ms = (time.time() - t0) * 1000
    logger.info("API response: HTTP %d in %.0f ms", response.status_code, latency_ms)

    if response.status_code != 200:
        raise RuntimeError(
            f"OpenTopography API returned HTTP {response.status_code}: "
            f"{response.text[:500]}"
        )

    content_type = response.headers.get("Content-Type", "")
    if "json" in content_type:
        error_data = response.json()
        raise RuntimeError(
            f"OpenTopography API error: {json.dumps(error_data, indent=2)}"
        )

    # Save to cache
    tif_path = _cache_path(south, north, west, east, dem_type)
    total_bytes = 0
    with open(tif_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
            total_bytes += len(chunk)

    file_size_mb = total_bytes / 1048576
    logger.info("Cached DEM tile: %s (%.1f MB, %d bytes)", tif_path.name, file_size_mb, total_bytes)

    return tif_path


# ---------------------------------------------------------------------------
# 5. Dam Database Loader (from dam.geojson)
# ---------------------------------------------------------------------------

_DAM_GEOJSON_PATH = Path(__file__).resolve().parent.parent.parent / "datasets" / "dam" / "dam.geojson"


def load_dam_list(max_dams: int = 500) -> List[Dict]:
    """
    Load dams from dam.geojson and return simplified list with parsed coordinates.
    """
    if not _DAM_GEOJSON_PATH.exists():
        logger.warning("Dam database not found: %s", _DAM_GEOJSON_PATH)
        return []

    t0 = time.time()
    with open(_DAM_GEOJSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    dams = []
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        lat_str = props.get("latitude", "")
        lon_str = props.get("longitude", "")

        if not lat_str or not lon_str:
            continue

        try:
            lat = parse_dms(lat_str)
            lon = parse_dms(lon_str)
        except (ValueError, TypeError):
            continue

        vol_mcm = props.get("gs_st_cap")
        try:
            vol_mcm = float(vol_mcm) if vol_mcm else 0
        except (ValueError, TypeError):
            vol_mcm = 0

        ht_found = props.get("ht_found")
        try:
            ht_found = float(ht_found) if ht_found else 0
        except (ValueError, TypeError):
            ht_found = 0

        dams.append({
            "id": props.get("PIC", ""),
            "name": props.get("dm_name", "Unknown Dam"),
            "state": props.get("state", ""),
            "district": props.get("district", ""),
            "river": props.get("river", ""),
            "latitude": lat,
            "longitude": lon,
            "dam_height_m": ht_found,
            "reservoir_volume_mcm": vol_mcm,
            "purpose": props.get("purpose", ""),
            "dam_type": (props.get("dm_type") or "").replace("·", "").replace("•\t", "").strip(),
            "year_completed": props.get("cmp_year", 0),
            "basin": props.get("basin", ""),
        })

        if len(dams) >= max_dams:
            break

    dams.sort(key=lambda d: (d["state"], d["name"]))
    elapsed_ms = (time.time() - t0) * 1000
    logger.info("Loaded %d dams from database in %.0f ms", len(dams), elapsed_ms)
    return dams


def get_dam_by_id(dam_id: str) -> Optional[Dict]:
    """Return a single dam's full metadata by PIC id."""
    dams = load_dam_list(max_dams=9999)
    for d in dams:
        if d["id"] == dam_id:
            return d
    return None


# ---------------------------------------------------------------------------
# 6. Convenience: fetch DEM for a specific dam
# ---------------------------------------------------------------------------

def fetch_dem_for_dam(
    lat: float,
    lon: float,
    api_key: Optional[str] = None,
    dem_type: str = "COP30",
    padding_lat: float = 0.18,
    padding_lon: float = 0.20,
) -> Path:
    """High-level function: given dam lat/lon, generate AOI and fetch DEM."""
    north, south, east, west = generate_aoi(lat, lon, padding_lat, padding_lon)
    return fetch_dem_tile(south, north, west, east, api_key, dem_type)
