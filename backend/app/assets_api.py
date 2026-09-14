"""
assets_api.py
-------------
Digital-twin asset pipeline endpoints.

GET  /api/assets/config   -> discovered assets (terrain, dam, river, buildings, vegetation)
POST /api/assets/reload   -> rescan the assets tree without restarting the server

Design notes
------------
* Read-only: this module NEVER touches the hydrodynamic solver, DEM
  processing, flood calculations, or any simulation state. It only scans
  the public/assets directory tree.
* Future users drop model files into public/assets/<category>/ and the
  frontend discovers them through this endpoint — no code changes needed.
* An optional public/assets/config.json can pin exact files per category
  (see ASSETS_CONFIG_EXAMPLE). When absent, directory auto-discovery is
  used and the first supported file in each category is selected.
"""

import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter

router = APIRouter(prefix="/api/assets", tags=["assets"])

# Project layout: backend/app/assets_api.py -> project root is three parents up.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASSETS_ROOT = _PROJECT_ROOT / "public" / "assets"

# Logical category -> directory inside public/assets/
CATEGORY_DIRS = {
    "master": "master",
    "terrain": "terrain",
    "dam": "dams",
    "river": "rivers",
    "buildings": "buildings",
    "vegetation": "vegetation",
}

# Model formats the frontend AssetLoader can ingest.
SUPPORTED_EXTENSIONS = {
    ".glb": "glb",
    ".gltf": "gltf",
    ".obj": "obj",
    ".fbx": "fbx",
    ".tif": "geotiff",
    ".tiff": "geotiff",
    ".dem": "dem",
}

# Documented shape of the optional manual pinning file.
ASSETS_CONFIG_EXAMPLE = {
    "terrain": "terrain/valley.glb",
    "dam": "dams/dam.glb",
    "river": "rivers/river.glb",
    "buildings": "buildings/village.glb",
    "vegetation": "vegetation/trees.glb",
}


def _format_of(path: Path) -> Optional[str]:
    return SUPPORTED_EXTENSIONS.get(path.suffix.lower())


def _to_url(relative: str) -> str:
    return f"/public/assets/{relative.replace(chr(92), '/')}"


def _scan_category(category: str) -> Optional[dict]:
    """Return the first supported asset file for a category, or None."""
    sub = CATEGORY_DIRS[category]
    base = ASSETS_ROOT / sub
    if not base.is_dir():
        return None

    candidates = sorted(
        (p for p in base.rglob("*") if p.is_file() and _format_of(p)),
        key=lambda p: (len(p.relative_to(base).parts), p.name.lower()),
    )
    if not candidates:
        return None

    best = candidates[0]
    rel = best.relative_to(ASSETS_ROOT)
    return {
        "category": category,
        "file": str(rel).replace("\\", "/"),
        "url": _to_url(str(rel)),
        "format": _format_of(best),
    }


def _read_config_overrides() -> dict:
    """Read optional public/assets/config.json pinning exact files."""
    cfg = ASSETS_ROOT / "config.json"
    if not cfg.is_file():
        return {}
    try:
        import json

        data = json.loads(cfg.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def discover_assets() -> dict:
    """Scan the assets tree (or config.json overrides) and build the payload."""
    overrides = _read_config_overrides()
    assets = {}
    for category in CATEGORY_DIRS:
        entry = None
        pinned = overrides.get(category)
        if isinstance(pinned, str) and pinned.strip():
            candidate = ASSETS_ROOT / pinned.strip()
            if candidate.is_file() and _format_of(candidate):
                entry = {
                    "category": category,
                    "file": pinned.strip().replace("\\", "/"),
                    "url": _to_url(pinned.strip()),
                    "format": _format_of(candidate),
                }
        if entry is None:
            entry = _scan_category(category)
        assets[category] = entry
    return assets


def _read_scene_metadata() -> Optional[dict]:
    """Read public/assets/metadata/scene.json if present."""
    meta_file = ASSETS_ROOT / "metadata" / "scene.json"
    if not meta_file.is_file():
        return None
    try:
        import json
        data = json.loads(meta_file.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


@router.get("/config")
def get_assets_config():
    """Discovered digital-twin assets for the frontend viewer."""
    return {
        "assets": discover_assets(),
        "metadata": _read_scene_metadata(),
        "supported_formats": sorted(set(SUPPORTED_EXTENSIONS.values())),
        "categories": list(CATEGORY_DIRS.keys()),
        "generated_at": time.time(),
    }


@router.post("/reload")
def reload_assets():
    """Rescan the assets tree without restarting the server."""
    return {
        "reloaded": True,
        "assets": discover_assets(),
        "metadata": _read_scene_metadata(),
        "generated_at": time.time(),
    }
