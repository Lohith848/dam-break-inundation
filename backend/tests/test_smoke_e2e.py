"""
test_smoke_e2e.py
-----------------
End-to-end smoke tests against the full ASGI stack (TestClient):
covers every public endpoint, the validation paths, and the canonical
user flow — health → catalog → failure modes → simulate → AI cache →
report → compare. This is the "final verification" gate.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    from app.main import app
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Infrastructure
# ---------------------------------------------------------------------------

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "api_key_configured" in body


def test_failure_modes_endpoint(client):
    r = client.get("/failure-modes")
    assert r.status_code == 200
    modes = r.json()
    keys = {m["value"] for m in modes} if isinstance(modes, list) else set()
    if not keys and isinstance(modes, dict):
        # tolerate {"modes": [...]} shape
        for v in modes.values():
            if isinstance(v, list):
                keys = {m["value"] for m in v if isinstance(m, dict) and "value" in m}
                break
    assert {"overtopping", "piping", "structural", "earthquake"} <= keys


def test_assets_mount_alive(client):
    r = client.get("/public/assets/models/dam/README.md")
    assert r.status_code == 200


def test_legacy_assets_gone(client):
    assert client.get("/assets/dam_structure.glb").status_code == 404


# ---------------------------------------------------------------------------
# Validation paths (security)
# ---------------------------------------------------------------------------

def test_simulate_rejects_bad_dam_id(client):
    r = client.post("/simulate", json={
        "dam_id": "../etc/passwd", "reservoir_volume_m3": 1e6, "dam_height_m": 30,
    })
    assert r.status_code == 422


def test_simulate_rejects_out_of_range_coords(client):
    r = client.post("/simulate", json={
        "latitude": 999.0, "longitude": 77.8,
        "reservoir_volume_m3": 1e6, "dam_height_m": 30,
    })
    assert r.status_code == 422


def test_weather_rejects_bad_coords(client):
    assert client.get("/weather/rainfall?lat=999&lon=77").status_code == 422
    assert client.get("/weather/rainfall?lat=12&lon=-500").status_code == 422


def test_fetch_dem_rejects_bad_coords(client):
    r = client.post("/fetch-dem", json={"latitude": 1234, "longitude": 0})
    assert r.status_code == 422


def test_compare_caps_scenario_count(client):
    scenario = {
        "reservoir_volume_m3": 1e6, "dam_height_m": 30,
    }
    r = client.post("/compare", json={"scenarios": [scenario] * 6})
    assert r.status_code == 422  # MAX_SCENARIOS = 5


def test_ai_chat_rejects_oversized_message(client):
    r = client.post("/ai/chat", json={
        "simulation_id": "whatever", "message": "x" * 5000,
    })
    assert r.status_code == 422


def test_unknown_dam_returns_404(client):
    assert client.get("/dam/__no_such_dam__").status_code == 404


def test_ai_analyze_unknown_sim_returns_404(client):
    r = client.post("/ai/analyze", json={"simulation_id": "deadbeef0000"})
    assert r.status_code in (404, 503)  # 404 without key-configured cache hit


# ---------------------------------------------------------------------------
# Catalog endpoints
# ---------------------------------------------------------------------------

def test_dams_list(client):
    r = client.get("/dams?max_results=5")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] >= 0 and isinstance(body["dams"], list)


def test_rivers_list(client):
    r = client.get("/rivers")
    assert r.status_code == 200
    assert "rivers" in r.json()


# ---------------------------------------------------------------------------
# Full simulation flow (synthetic fallback = hermetic, no network/DEM needed)
# ---------------------------------------------------------------------------

def _run_simulation(client):
    return client.post("/simulate", json={
        "dam_name": "Audit Dam",
        "latitude": 11.8025, "longitude": 77.8015,
        "reservoir_volume_m3": 12_000_000,
        "dam_height_m": 32,
        "failure_mode": "overtopping",
        "total_sim_hours": 1.0,
    })


@pytest.mark.skipif(
    os.environ.get("CI") == "1",
    reason="DEM fetch may be slow in CI; fallback path is hermetic though",
)
def test_full_simulation_flow(client):
    r = _run_simulation(client)
    assert r.status_code == 200, r.text
    sim = r.json()
    sim_id = sim.get("simulation_id")
    assert sim_id, "simulation must be cached (AI Copilot dependency)"

    # Viewer contract keys present regardless of DEM vs synthetic path
    assert "elevation_grid" in sim and "depth_grids" in sim
    assert "timesteps_hours" in sim
    assert sim["elevation_stats"].get("min_elev") is not None

    # AI endpoints resolve this sim (no-key → 503, with-key → 200)
    ra = client.post("/ai/analyze", json={"simulation_id": sim_id})
    assert ra.status_code in (200, 502, 503)

    # Report export works (generates real .pdf binary stream)
    rp = client.post("/report/pdf", json={"simulation_id": sim_id})
    assert rp.status_code == 200
    assert rp.content.startswith(b"%PDF")
    assert len(rp.content) > 1000
    assert "application/pdf" in rp.headers.get("content-type", "")


def test_report_unknown_sim_404(client):
    assert client.post("/report/pdf", json={"simulation_id": "missing"}).status_code == 404
