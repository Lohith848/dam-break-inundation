"""
test_assets.py
--------------
Verifies the standardized public asset pipeline:

1. GET /public/assets/models/dam/README.md must be served (mount alive).
2. A configured model referenced by frontend/config/assets.js must exist
   on disk at public/assets/models/dam/<filename> (config <-> file parity).
3. The legacy /assets mount is gone (serves 404) after the restructure.
"""

import sys
import os
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

PUBLIC_ASSETS = os.path.join(
    os.path.dirname(__file__), "..", "..", "public", "assets"
)
ASSETS_CONFIG = os.path.join(
    os.path.dirname(__file__), "..", "..", "frontend", "config", "assets.js"
)


def test_public_assets_mount_serves_files():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    resp = client.get("/public/assets/models/dam/README.md")
    assert resp.status_code == 200, f"public assets mount broken: HTTP {resp.status_code}"
    assert b"Dam Models" in resp.content, "Unexpected payload from assets mount"


def test_configured_dam_model_exists_on_disk():
    """If config/assets.js names a model file, that file must exist."""
    with open(ASSETS_CONFIG, "r", encoding="utf-8") as f:
        config = f.read()

    match = re.search(r'export const DAM_MODEL\s*=\s*\{(.*?)\n\};', config, re.S)
    assert match, "DAM_MODEL block missing from frontend/config/assets.js"
    filename = re.search(r'filename:\s*""\s*,|filename:\s*"([^"]+)"', match.group(1))
    assert filename, "filename field missing in DAM_MODEL"
    configured = (filename.group(1) or "").strip()
    if not configured:
        return  # external loading disabled — nothing to verify

    model = os.path.join(PUBLIC_ASSETS, "models", "dam", configured)
    assert os.path.isfile(model), f"Configured model not found: {model}"


def test_legacy_assets_mount_removed():
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    resp = client.get("/assets/dam_structure.glb")
    assert resp.status_code == 404, "Legacy /assets mount should no longer serve files"
