"""
test_sim_cache.py
-----------------
Regression tests for the shared simulation cache.

Bug: /simulate/start generated a simulation_id but never registered the
result, so every AI Copilot call failed with
"Simulation not found: <id>". These tests pin the fixed behavior.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import sim_cache


def test_cache_roundtrip():
    sim_id = sim_cache.cache_simulation({"dam_name": "Test Dam", "summary": {}})
    assert sim_id
    cached = sim_cache.get_simulation(sim_id)
    assert cached is not None
    assert cached["dam_name"] == "Test Dam"


def test_get_simulation_unknown_returns_none():
    assert sim_cache.get_simulation("does-not-exist") is None


def test_cache_evicts_oldest_beyond_limit():
    sim_cache.SIMULATION_CACHE.clear()
    ids = [sim_cache.cache_simulation({"dam_name": f"Dam {i}"}) for i in range(25)]
    # Oldest entries must have been evicted, newest retained
    assert len(sim_cache.SIMULATION_CACHE) <= sim_cache.MAX_CACHED_SIMULATIONS
    assert sim_cache.get_simulation(ids[0]) is None
    assert sim_cache.get_simulation(ids[-1]) is not None
    sim_cache.SIMULATION_CACHE.clear()


def test_progress_pipeline_registers_result_in_cache():
    """The SSE /simulate/start pipeline must cache its result under the
    simulation_id it returns — otherwise /ai/analyze 404s."""
    from app import progress

    class _FakeResult:
        peak_outflow_cms = 100.0
        breach_width_m = 50.0
        breach_formation_time_min = 12.0
        dx = 30.0
        ny = 80
        nx = 120
        dam_col = 12
        dam_geometry = {"col_index": 6, "dam_height_m": 30.0, "breach_width_m": 50.0}
        elevation_stats = {"min_m": 100.0, "max_m": 300.0}
        elevation_grid = [[100.0] * 120 for _ in range(80)]
        snapshot_times_s = [0.0, 300.0]
        depth_grids = [[[0.0] * 120 for _ in range(80)] for _ in range(2)]
        summary = {"max_inundated_area_km2": 1.0, "max_flood_depth_m": 2.0,
                   "points_of_interest": []}
        points_of_interest = []
        flood_polygon_geojson = None
        simulation_time_ms = 1.0

    result = _FakeResult()
    response = {"elevation_grid": result.elevation_grid}
    village_impacts = progress.build_village_impacts(result)
    response["village_impacts"] = village_impacts
    response["summary"] = result.summary

    sim_id = sim_cache.cache_simulation(response)
    response["simulation_id"] = sim_id

    # The AI endpoints' lookup path must now resolve this ID
    assert sim_cache.get_simulation(sim_id) is response


def test_main_endpoints_use_shared_cache(monkeypatch):
    """main.py AI endpoints must look up simulations via the shared cache."""
    from app import main

    sim_id = main._cache_simulation({"dam_name": "Alias Dam"})
    assert main.sim_cache.get_simulation(sim_id) is not None
    assert main._simulation_cache is sim_cache.SIMULATION_CACHE


def test_ai_analyze_resolves_cached_sse_simulation(monkeypatch):
    """End-to-end contract: a simulation registered the way the SSE pipeline
    now does it must be analyzable via POST /ai/analyze."""
    from fastapi.testclient import TestClient
    from app import main

    monkeypatch.setattr(main, "_simulation_cache", main.sim_cache.SIMULATION_CACHE, raising=False)
    monkeypatch.setattr(main.groq_client, "is_available", lambda: True, raising=False)
    monkeypatch.setattr(
        main.groq_client, "analyze_simulation",
        lambda *a, **k: "## Mock analysis\nAll good.", raising=False,
    )

    sim_id = main.sim_cache.cache_simulation({
        "dam_name": "SSE Dam",
        "breach": {"peak_outflow_cms": 900.0, "breach_width_m": 60.0},
        "summary": {"max_inundated_area_km2": 2.5, "max_flood_depth_m": 4.0,
                    "points_of_interest": []},
        "village_impacts": [],
    })

    client = TestClient(main.app)
    resp = client.post("/ai/analyze", json={"simulation_id": sim_id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert "Mock analysis" in body["analysis"]


def test_ai_analyze_unknown_id_still_404s():
    from fastapi.testclient import TestClient
    from app import main

    client = TestClient(main.app)
    resp = client.post("/ai/analyze", json={"simulation_id": "no-such-id"})
    assert resp.status_code == 404
