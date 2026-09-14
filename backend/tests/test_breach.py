import math
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import breach


def test_peak_outflow_matches_hand_calculation():
    # Froehlich (1995): Qp = 0.607 * Vw^0.295 * Hw^1.24
    vw, hw = 10_000_000, 30
    expected = 0.607 * (vw ** 0.295) * (hw ** 1.24)
    assert math.isclose(breach.froehlich_peak_outflow(vw, hw), expected, rel_tol=1e-9)


def test_peak_outflow_increases_with_height_and_volume():
    base = breach.froehlich_peak_outflow(10_000_000, 30)
    bigger_volume = breach.froehlich_peak_outflow(20_000_000, 30)
    taller_dam = breach.froehlich_peak_outflow(10_000_000, 50)
    assert bigger_volume > base
    assert taller_dam > base


def test_breach_width_overtopping_wider_than_piping():
    piping = breach.froehlich_breach_width(10_000_000, 30, "piping")
    overtopping = breach.froehlich_breach_width(10_000_000, 30, "overtopping")
    assert overtopping > piping


def test_hydrograph_shape_is_triangular_and_returns_to_zero():
    result = breach.build_breach_hydrograph(10_000_000, 30, "piping", dt=5.0)
    q = result["discharge_cms"]
    assert q[0] == 0
    assert q[-1] == 0
    assert max(q) == result["discharge_cms"].max()
    # peak should be close to the Froehlich peak outflow value (within one
    # discretisation step's worth of the triangular ramp, since the exact
    # peak time may fall between two sampled timesteps)
    assert abs(max(q) - result["peak_outflow_cms"]) < 0.01 * result["peak_outflow_cms"]
