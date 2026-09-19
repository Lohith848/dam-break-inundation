"""
test_assets_api.py
------------------
Verifies the digital-twin asset discovery endpoints:

1. GET  /api/assets/config returns the documented envelope and categories.
2. POST /api/assets/reload returns reloaded=true with the same envelope.
3. Simulated dam entries (dams/ containing a model file) are discovered.
4. config.json pinning overrides directory auto-discovery.
5. Solver/flood/routing modules are untouched (regression guard).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

PUBLIC_ASSETS = os.path.join(
    os.path.dirname(__file__), "..", "..", "public", "assets"
)


def _client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def test_assets_config_envelope():
    client = _client()
    resp = client.get("/api/assets/config")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data["categories"]) == {"master", "terrain", "dam", "river", "buildings", "vegetation"}
    assert "glb" in data["supported_formats"]
    assert "geotiff" in data["supported_formats"]
    for cat in data["categories"]:
        assert "assets" in data and cat in data["assets"]


def test_assets_reload_roundtrip():
    client = _client()
    resp = client.post("/api/assets/reload")
    assert resp.status_code == 200
    data = resp.json()
    assert data["reloaded"] is True
    assert set(data["assets"].keys()) == {"master", "terrain", "dam", "river", "buildings", "vegetation"}


def test_discovery_finds_placed_model(tmp_path):
    """Drop a GLB into public/assets/dams/ -> discovered under 'dam'."""
    from app import assets_api

    dam_dir = os.path.join(PUBLIC_ASSETS, "dams")
    os.makedirs(dam_dir, exist_ok=True)
    probe = os.path.join(dam_dir, "test_probe_model.glb")
    with open(probe, "wb") as f:
        f.write(b"probe")

    try:
        result = assets_api.discover_assets()
        assert result["dam"] is not None
        assert result["dam"]["file"].endswith("test_probe_model.glb")
        assert result["dam"]["format"] == "glb"
        assert result["dam"]["url"].startswith("/assets/")
    finally:
        os.remove(probe)


def test_config_json_pinning(tmp_path, monkeypatch):
    """A config.json pin must take precedence over auto-discovery."""
    from app import assets_api

    dam_dir = os.path.join(PUBLIC_ASSETS, "dams")
    os.makedirs(dam_dir, exist_ok=True)
    auto = os.path.join(dam_dir, "aaa_auto.glb")
    pinned = os.path.join(dam_dir, "zzz_pinned.glb")
    for p in (auto, pinned):
        with open(p, "wb") as f:
            f.write(b"probe")

    cfg = os.path.join(PUBLIC_ASSETS, "config.json")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write('{"dam": "dams/zzz_pinned.glb"}')

    try:
        result = assets_api.discover_assets()
        assert result["dam"]["file"] == "dams/zzz_pinned.glb"
    finally:
        for p in (auto, pinned, cfg):
            if os.path.exists(p):
                os.remove(p)


def test_simulation_modules_untouched():
    """Regression guard: solver sources carry no assets_api references."""
    backend_app = os.path.join(os.path.dirname(__file__), "..", "app")
    for fname in ("routing.py", "flood.py", "breach.py", "dem.py"):
        with open(os.path.join(backend_app, fname), "r", encoding="utf-8") as f:
            src = f.read()
        assert "assets_api" not in src, f"{fname} must not depend on assets_api"
