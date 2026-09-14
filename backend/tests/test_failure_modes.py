"""
test_failure_modes.py
---------------------
Tests for the failure-mode system: constants module, mode-aware breach
physics, user overrides, and the /failure-modes API contract.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.failure_modes import (
    FAILURE_MODE_INFO,
    FailureMode,
    default_frontend_params,
    get_failure_mode_info,
    normalize_failure_mode,
)

VW, HW = 10_000_000, 30  # standard test reservoir: 10 Mm³, 30 m head


# ---------------------------------------------------------------------------
# Constants module
# ---------------------------------------------------------------------------

def test_enum_contains_exactly_four_modes():
    assert {m.value for m in FailureMode} == {"overtopping", "piping", "structural", "earthquake"}


def test_every_mode_has_label_description_and_multipliers():
    for mode in FailureMode:
        info = FAILURE_MODE_INFO[mode.value]
        assert info["label"], mode
        assert info["description"], mode
        assert info["time_multiplier"] > 0
        assert info["width_multiplier"] > 0


def test_normalize_accepts_all_modes_and_legacy_aliases():
    assert normalize_failure_mode("overtopping") == "overtopping"
    assert normalize_failure_mode("PIPING") == "piping"
    assert normalize_failure_mode("seismic") == "earthquake"
    assert normalize_failure_mode("collapse") == "structural"
    assert normalize_failure_mode("nonsense") == "piping"  # default
    assert normalize_failure_mode(None) == "piping"
    assert normalize_failure_mode("") == "piping"


def test_frontend_defaults_match_requirements():
    # Overtopping -> slow formation, auto width
    ov = default_frontend_params("overtopping")
    assert ov["breach_formation_time_min"] > default_frontend_params("piping")["breach_formation_time_min"]
    assert ov["auto_breach_width"] is True
    # Structural -> near-instant, large explicit width
    st = default_frontend_params("structural")
    assert st["breach_formation_time_min"] <= 10
    assert st["breach_width_m"] >= 100 and st["auto_breach_width"] is False
    # Earthquake -> rapid, large explicit width
    eq = default_frontend_params("earthquake")
    assert 10 < eq["breach_formation_time_min"] < 30
    assert eq["breach_width_m"] >= 100 and eq["auto_breach_width"] is False


# ---------------------------------------------------------------------------
# Breach physics per mode
# ---------------------------------------------------------------------------

def _hydro(mode, **kw):
    from app.breach import build_breach_hydrograph
    return build_breach_hydrograph(VW, HW, failure_mode=mode, **kw)


def test_structural_forms_much_faster_than_piping():
    assert _hydro("structural")["breach_formation_time_s"] < 0.2 * _hydro("piping")["breach_formation_time_s"]


def test_earthquake_faster_than_piping_but_slower_than_structural():
    t_pipe = _hydro("piping")["breach_formation_time_s"]
    t_eq = _hydro("earthquake")["breach_formation_time_s"]
    t_st = _hydro("structural")["breach_formation_time_s"]
    assert t_st < t_eq < t_pipe


def test_overtopping_forms_slower_than_piping():
    assert _hydro("overtopping")["breach_formation_time_s"] > _hydro("piping")["breach_formation_time_s"]


def test_structural_and_earthquake_have_larger_breach_width_than_piping():
    b_pipe = _hydro("piping")["breach_width_m"]
    assert _hydro("structural")["breach_width_m"] > 1.5 * b_pipe
    assert _hydro("earthquake")["breach_width_m"] > 1.5 * b_pipe


def test_all_modes_share_the_same_peak_discharge_regression():
    qps = {_hydro(m)["peak_outflow_cms"] for m in ("overtopping", "piping", "structural", "earthquake")}
    assert len(qps) == 1  # Qp depends on volume/height only


def test_shorter_rise_time_concentrates_discharge():
    """Structural failure reaches 90% of peak much sooner in wall-clock time
    than piping — the mechanism that speeds flood propagation."""
    from app.breach import build_breach_hydrograph
    import numpy as np
    h_st = build_breach_hydrograph(VW, HW, "structural", dt=1.0)
    h_pipe = build_breach_hydrograph(VW, HW, "piping", dt=1.0)
    qp = h_st["peak_outflow_cms"]
    # The hydrograph is triangular (rises then falls) — NOT monotonic — so use
    # a boolean mask, not np.searchsorted (binary search needs sorted input).
    t90_st = h_st["times_s"][int(np.argmax(h_st["discharge_cms"] >= 0.9 * qp))]
    t90_pipe = h_pipe["times_s"][int(np.argmax(h_pipe["discharge_cms"] >= 0.9 * qp))]
    assert t90_st < 0.2 * t90_pipe


def test_user_overrides_win_over_mode_defaults():
    h = _hydro("structural", breach_width_override=88.0, formation_time_override_min=25.0)
    assert h["breach_width_m"] == 88.0
    assert h["breach_formation_time_s"] == 25.0 * 60.0


def test_overrides_survive_gentle_mode_and_hydrograph_stays_valid():
    h = _hydro("overtopping", breach_width_override=50.0, formation_time_override_min=10.0)
    assert (h["discharge_cms"] >= 0).all()
    assert h["discharge_cms"][0] == 0
    assert h["discharge_cms"][-1] == 0
    assert h["breach_width_m"] == 50.0


def test_mode_is_echoed_normalized():
    assert _hydro("SEISMIC")["failure_mode"] == "earthquake"  # legacy alias


# ---------------------------------------------------------------------------
# API contract
# ---------------------------------------------------------------------------

def test_failure_modes_endpoint_payload():
    from fastapi.testclient import TestClient
    from app.main import app

    resp = TestClient(app).get("/failure-modes")
    assert resp.status_code == 200
    modes = resp.json()
    assert [m["value"] for m in modes] == ["overtopping", "piping", "structural", "earthquake"]
    for m in modes:
        assert m["label"] and m["description"]
        assert "breach_formation_time_min" in m["defaults"]


def test_simulate_accepts_structural_mode_payload():
    """Regression guard: the old pattern validator rejected structural/earthquake."""
    from app.main import SimulateRequest

    req = SimulateRequest(
        reservoir_volume_m3=1e7, dam_height_m=30,
        failure_mode="structural",
        breach_width_m=90.0, breach_formation_time_min=5.0,
    )
    assert req.failure_mode == "structural"
    assert req.breach_width_m == 90.0
