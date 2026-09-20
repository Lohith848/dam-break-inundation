"""
dem.py
------
Digital Elevation Model (DEM) utilities.

Provides:
  - load_dem(): Load any GeoTIFF DEM with rasterio (Pillow fallback)
  - sample_elevation(): Query elevation at a specific lat/lon
  - crop_dem(): Crop DEM to a bounding box
  - get_dem_bounds(): Extract bounds and CRS info from a GeoTIFF
  - load_opentopography_dem(): Load + downsample for the hydrodynamic solver
  - make_synthetic_valley_dem(): Fallback synthetic V-shaped valley
"""

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger("dam_sim.dem")


@dataclass
class DEMInfo:
    """Structured return type for DEM metadata."""
    elevation: np.ndarray          # (ny, nx) float32 elevation array (m)
    dx: float                      # pixel width in metres
    dy: float                      # pixel height in metres
    bounds: Tuple[float, float, float, float]  # (west, south, east, north) in degrees
    crs: str                       # coordinate reference system string
    transform: object              # affine transform (rasterio.Affine or None)
    ny: int
    nx: int


# ---------------------------------------------------------------------------
# 1. Core DEM Loading
# ---------------------------------------------------------------------------

def load_dem(path: str) -> DEMInfo:
    """
    Load a DEM GeoTIFF using rasterio, with Pillow fallback.

    Extracts:
      - elevation matrix (float32)
      - pixel resolution (dx, dy in metres)
      - geographic bounds (west, south, east, north)
      - CRS string
      - affine transform

    Raises
    ------
    FileNotFoundError if path does not exist.
    ValueError if the DEM is empty or unreadable.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"DEM file not found: {path}")

    t0 = __import__("time").time()

    # Try rasterio first (handles CRS, transform, proper nodata)
    try:
        import rasterio
        with rasterio.open(path) as src:
            dem = src.read(1).astype(np.float32)

            # Handle nodata values
            if src.nodata is not None:
                dem[dem == src.nodata] = np.nan

            dx = abs(float(src.transform.a))
            dy = abs(float(src.transform.e))
            bounds = src.bounds  # BoundingBox(left, bottom, right, top)
            crs = str(src.crs) if src.crs else "EPSG:4326"
            transform = src.transform

            # If coordinates are in geographic degrees (EPSG:4326 or dx < 1.0),
            # convert dx & dy to metric units (meters) so the hydrodynamic solver operates properly.
            if dx < 1.0:
                mid_lat = (bounds.bottom + bounds.top) / 2.0
                mid_lon = (bounds.left + bounds.right) / 2.0
                src_dx_deg = abs(float(src.transform.a))  # raw degree step (before conversion)
                src_dy_deg = abs(float(src.transform.e))
                try:
                    from pyproj import Geod
                    geod = Geod(ellps="WGS84")
                    # Geodesic metre distance for one pixel in x and y directions
                    _, _, dx = geod.inv(bounds.left, mid_lat, bounds.left + src_dx_deg, mid_lat)
                    _, _, dy = geod.inv(mid_lon, bounds.bottom, mid_lon, bounds.bottom + src_dy_deg)
                    dx = abs(dx)
                    dy = abs(dy)
                    logger.debug("pyproj geodesic dx=%.2fm dy=%.2fm at lat=%.4f", dx, dy, mid_lat)
                except ImportError:
                    # Flat-Earth fallback (accurate to ~0.1% for India latitudes)
                    dx = src_dx_deg * 111320.0 * float(np.cos(np.radians(mid_lat)))
                    dy = src_dy_deg * 111320.0

            elapsed_ms = ( __import__("time").time() - t0) * 1000
            logger.info("Loaded DEM via rasterio: %s (%dx%d, dx=%.1fm, CRS=%s, %.0fms)",
                        p.name, src.width, src.height, dx, crs, elapsed_ms)

            return DEMInfo(
                elevation=dem,
                dx=dx, dy=dy,
                bounds=(bounds.left, bounds.bottom, bounds.right, bounds.top),
                crs=crs,
                transform=transform,
                ny=dem.shape[0], nx=dem.shape[1],
            )
    except ImportError:
        logger.warning("rasterio not installed, falling back to Pillow")
    except Exception as e:
        logger.warning("rasterio failed (%s), falling back to Pillow", e)

    # Fallback using PIL / numpy — assumes 30 m resolution, EPSG:4326
    try:
        from PIL import Image
        with Image.open(path) as img:
            dem = np.array(img, dtype=np.float32)

        dx = 30.0
        dy = 30.0
        # Approximate bounds for Indian dam regions
        bounds = (77.70, 11.55, 77.95, 11.85)

        elapsed_ms = (__import__("time").time() - t0) * 1000
        logger.info("Loaded DEM via Pillow fallback: %s (%dx%d, %.0fms)",
                    p.name, dem.shape[1], dem.shape[0], elapsed_ms)

        return DEMInfo(
            elevation=dem, dx=dx, dy=dy,
            bounds=bounds, crs="EPSG:4326", transform=None,
            ny=dem.shape[0], nx=dem.shape[1],
        )
    except (ImportError, ModuleNotFoundError):
        logger.warning("Neither rasterio nor Pillow available; generating synthetic DEM fallback")
        return generate_synthetic_dem(180, 100, 30.0)
    except Exception as e:
        logger.warning("Pillow load failed (%s); generating synthetic DEM fallback", e)
        return generate_synthetic_dem(180, 100, 30.0)


# ---------------------------------------------------------------------------
# 2. Elevation Sampling at a Point
# ---------------------------------------------------------------------------

def sample_elevation(dem_info: DEMInfo, lat: float, lon: float) -> Optional[float]:
    """
    Sample elevation at a specific lat/lon from a loaded DEM.

    Returns None if the point is outside the DEM bounds.
    """
    west, south, east, north = dem_info.bounds

    if lon < west or lon > east or lat < south or lat > north:
        logger.warning("Point (%.4f, %.4f) outside DEM bounds", lat, lon)
        return None

    # Convert geographic coordinates to pixel indices
    col_frac = (lon - west) / (east - west) * dem_info.nx
    row_frac = (north - lat) / (north - south) * dem_info.ny  # north is top

    col = int(col_frac)
    row = int(row_frac)

    col = max(0, min(col, dem_info.nx - 1))
    row = max(0, min(row, dem_info.ny - 1))

    val = float(dem_info.elevation[row, col])
    logger.debug("Elevation at (%.4f, %.4f) = %.2f m", lat, lon, val)
    return val


# ---------------------------------------------------------------------------
# 3. DEM Cropping to a Bounding Box
# ---------------------------------------------------------------------------

def crop_dem(
    dem_info: DEMInfo,
    west: float, south: float, east: float, north: float,
) -> DEMInfo:
    """
    Crop a DEM to a geographic bounding box.

    Returns a new DEMInfo with the cropped elevation and adjusted bounds.
    """
    dem_w, dem_s, dem_e, dem_n = dem_info.bounds

    # Compute pixel ranges
    col_start = max(0, int((west - dem_w) / (dem_e - dem_w) * dem_info.nx))
    col_end = min(dem_info.nx, int((east - dem_w) / (dem_e - dem_w) * dem_info.nx))
    row_start = max(0, int((dem_n - north) / (dem_n - dem_s) * dem_info.ny))
    row_end = min(dem_info.ny, int((dem_n - south) / (dem_n - dem_s) * dem_info.ny))

    if col_start >= col_end or row_start >= row_end:
        logger.warning("Crop box outside DEM extent, returning original")
        return dem_info

    cropped = dem_info.elevation[row_start:row_end, col_start:col_end].copy()

    new_w = dem_w + col_start * dem_info.dx / 111320  # approximate
    new_e = dem_w + col_end * dem_info.dx / 111320
    new_n = dem_n - row_start * dem_info.dy / 111320
    new_s = dem_n - row_end * dem_info.dy / 111320

    logger.info("Cropped DEM: %dx%d → %dx%d", dem_info.nx, dem_info.ny,
                cropped.shape[1], cropped.shape[0])

    return DEMInfo(
        elevation=cropped, dx=dem_info.dx, dy=dem_info.dy,
        bounds=(new_w, new_s, new_e, new_n),
        crs=dem_info.crs, transform=dem_info.transform,
        ny=cropped.shape[0], nx=cropped.shape[1],
    )


# ---------------------------------------------------------------------------
# 4. Get DEM Bounds (convenience)
# ---------------------------------------------------------------------------

def get_dem_bounds(path: str) -> dict:
    """
    Extract bounds, CRS, and resolution from a GeoTIFF without loading the full array.
    """
    try:
        import rasterio
        with rasterio.open(path) as src:
            return {
                "bounds": {
                    "west": src.bounds.left,
                    "south": src.bounds.bottom,
                    "east": src.bounds.right,
                    "north": src.bounds.top,
                },
                "crs": str(src.crs) if src.crs else "EPSG:4326",
                "resolution_m": abs(float(src.transform.a)),
                "width_px": src.width,
                "height_px": src.height,
            }
    except ImportError:
        return {"error": "rasterio not installed", "file": path}


# ---------------------------------------------------------------------------
# 5. Load + Downsample for Hydrodynamic Solver
# ---------------------------------------------------------------------------

def load_opentopography_dem(
    tif_path: str,
    target_rows: int = 80,
    target_cols: int = 120,
    dam_col_fraction: float = 0.10,
) -> Tuple[np.ndarray, float, int, Tuple[float, float, float, float]]:
    """
    Load a real GeoTIFF, downsample to solver-compatible grid.

    Returns
    -------
    dem     : (target_rows, target_cols) float32 elevation array (m)
    dx      : effective cell size in metres after downsampling
    dam_col : column index of the dam
    bounds  : (west, south, east, north) in decimal degrees
    """
    dem_info = load_dem(tif_path)

    ny_raw, nx_raw = dem_info.ny, dem_info.nx
    if ny_raw == 0 or nx_raw == 0:
        raise ValueError(f"Empty DEM loaded from {tif_path}")

    row_factor = max(1, ny_raw // target_rows)
    col_factor = max(1, nx_raw // target_cols)

    dem = dem_info.elevation[::row_factor, ::col_factor].astype(np.float32)
    dx = dem_info.dx * col_factor
    dy = dem_info.dy * row_factor

    # Replace NaN with local mean for solver stability
    nan_mask = np.isnan(dem)
    if nan_mask.any():
        mean_val = np.nanmean(dem)
        dem[nan_mask] = mean_val
        logger.warning("Filled %d NaN cells with mean elevation %.1f m",
                       nan_mask.sum(), mean_val)

    # Clamp to target size
    if dem.shape[0] > target_rows:
        dem = dem[:target_rows, :]
    if dem.shape[1] > target_cols:
        dem = dem[:, :target_cols]

    dam_col = max(1, int(dem.shape[1] * dam_col_fraction))

    logger.info("Downsampled DEM: %dx%d → %dx%d (dx=%.1fm, dam_col=%d)",
                nx_raw, ny_raw, dem.shape[1], dem.shape[0], dx, dam_col)

    return dem, dx, dam_col, dem_info.bounds


# ---------------------------------------------------------------------------
# 6. Synthetic Fallback DEM
# ---------------------------------------------------------------------------

def make_synthetic_valley_dem(
    nx: int = 180, ny: int = 100, dx: float = 30.0,
    dam_x_index: int = 15, longitudinal_slope: float = 0.0025,
    valley_half_width_cells: int = 22, bank_height: float = 40.0,
) -> np.ndarray:
    """
    Generate a synthetic V-shaped river valley DEM for demo/testing.
    """
    x = np.arange(nx)
    y = np.arange(ny)
    xx, yy = np.meshgrid(x, y)

    base_elev = 300.0 - longitudinal_slope * xx * dx
    centre = ny / 2.0
    cross_dist = np.abs(yy - centre) / valley_half_width_cells
    cross_dist = np.clip(cross_dist, 0, 1.6)
    cross_profile = bank_height * (cross_dist ** 1.6)

    dem = (base_elev + cross_profile).astype(np.float32)
    rng = np.random.default_rng(42)
    dem += rng.normal(0, 0.15, size=dem.shape).astype(np.float32)

    logger.info("Generated synthetic DEM: %dx%d (dx=%.1fm)", nx, ny, dx)
    return dem


def generate_synthetic_dem(nx: int = 180, ny: int = 100, dx: float = 30.0) -> DEMInfo:
    """Generate a synthetic DEM wrapped in DEMInfo for seamless fallback."""
    dem = make_synthetic_valley_dem(nx=nx, ny=ny, dx=dx)
    return DEMInfo(
        elevation=dem,
        dx=dx,
        dy=dx,
        bounds=(77.70, 11.55, 77.95, 11.85),
        crs="EPSG:4326",
        transform=None,
        ny=dem.shape[0],
        nx=dem.shape[1],
    )

