"""
breach.py
---------
Physically-based EMPIRICAL breach parameter equations used by dam-safety
engineers when a full physically-based breach-erosion model is not available.

References (equations only reproduced — standard published regressions,
widely cited in USBR / FEMA dam-safety guidance):
  - Froehlich (1995) "Peak outflow from breached embankment dam"
  - Froehlich (2008) "Embankment dam breach parameters and their uncertainties"

These give an ENGINEERING-GRADE FIRST ESTIMATE of:
  * peak breach outflow (Qp)
  * average breach width (B)
  * breach formation time (tf)

which are then used to build a breach outflow hydrograph that becomes the
upstream boundary condition for the 2D flood-routing model (routing.py).

Failure-mode awareness: the four modes (see failure_modes.py) modify the
formation time and breach width through documented multipliers, and shape the
hydrograph rise time — which concentrates or spreads the discharge and thus
influences flood propagation speed downstream.
"""

import math

import numpy as np

from .failure_modes import (
    FailureMode,
    get_failure_mode_info,
    normalize_failure_mode,
)

# ---------------------------------------------------------------------------
# Froehlich regressions
# ---------------------------------------------------------------------------


# Per-mode parameter profiles extending Froehlich's regressions (Froehlich 1995/2008),
# consistent with USBR / FEMA dam safety screening guidance for seismic and structural failure.
FAILURE_MODE_PARAMS = {
    FailureMode.PIPING.value:      {"k0": 1.0, "formation_time_factor": 1.0},
    FailureMode.OVERTOPPING.value: {"k0": 1.3, "formation_time_factor": 1.5},
    FailureMode.STRUCTURAL.value:  {"k0": 2.0, "formation_time_factor": 0.15},  # sudden collapse, wide breach
    FailureMode.EARTHQUAKE.value:  {"k0": 1.8, "formation_time_factor": 0.30},  # rapid seismic crest collapse
}


def froehlich_peak_outflow(volume_m3: float, height_m: float) -> float:
    """
    Froehlich (1995) peak breach outflow regression.

    Qp = 0.607 * Vw^0.295 * Hw^1.24   (SI units)

    Parameters
    ----------
    volume_m3 : reservoir storage at time of failure (m^3)
    height_m  : height of water above final breach invert (m)

    Returns
    -------
    Peak outflow discharge (m^3/s)
    """
    return 0.607 * (volume_m3 ** 0.295) * (height_m ** 1.24)


def froehlich_breach_width(volume_m3: float, height_m: float,
                           failure_mode: str = FailureMode.PIPING.value) -> float:
    """
    Froehlich (2008) average breach width regression.

    B = 0.27 * k0 * Vw^0.32 * Hb^0.04

    k0 = 1.3 for overtopping failure, 1.0 for piping (base regression).
    Other modes reuse k0=1.0 and are scaled afterwards by the mode's
    width_multiplier (see build_breach_hydrograph).
    """
    k0 = 1.3 if normalize_failure_mode(failure_mode) == FailureMode.OVERTOPPING.value else 1.0
    return 0.27 * k0 * (volume_m3 ** 0.32) * (height_m ** 0.04)


def froehlich_breach_width_v2(volume_m3: float, height_m: float,
                              failure_mode: str = FailureMode.PIPING.value) -> float:
    """Froehlich breach width with unified per-mode coefficients (breach v2)."""
    mode = normalize_failure_mode(failure_mode)
    params = FAILURE_MODE_PARAMS.get(mode, FAILURE_MODE_PARAMS[FailureMode.PIPING.value])
    return 0.27 * params["k0"] * (volume_m3 ** 0.32) * (height_m ** 0.04)


def breach_formation_time(volume_m3: float, height_m: float, g: float = 9.81) -> float:
    """
    Froehlich (2008) breach formation time regression.

    tf = 63.2 * sqrt(Vw / (g * Hb^2))   [seconds]
    """
    return 63.2 * math.sqrt(volume_m3 / (g * height_m ** 2))


def breach_formation_time_v2(volume_m3: float, height_m: float,
                             failure_mode: str = FailureMode.PIPING.value,
                             g: float = 9.81) -> float:
    """Froehlich breach formation time with mode factor (breach v2)."""
    base_tf = 63.2 * math.sqrt(volume_m3 / (g * height_m ** 2))
    mode = normalize_failure_mode(failure_mode)
    params = FAILURE_MODE_PARAMS.get(mode, FAILURE_MODE_PARAMS[FailureMode.PIPING.value])
    return base_tf * params["formation_time_factor"]


def build_breach_hydrograph(
    volume_m3: float,
    height_m: float,
    failure_mode: str = FailureMode.PIPING.value,
    dt: float = 10.0,
    breach_width_override: float | None = None,
    formation_time_override_min: float | None = None,
):
    """
    Build a triangular/trapezoidal breach outflow hydrograph:
      - discharge rises from 0 to Qp over the (mode-adjusted) breach
        formation time tf
      - discharge recedes from Qp to 0 over 2*tf (reservoir drawdown)

    Failure-mode influence
    ----------------------
    tf        *= mode time_multiplier   (slow/medium/instant/rapid)
    B         *= mode width_multiplier  (auto / medium / large)
    rise time  = tf — a shorter rise concentrates the same peak discharge
    into a steeper advancing wave, which the routing engine propagates faster
    (structural/earthquake floods arrive sooner; overtopping floods are slower
    but last longer).

    Parameters
    ----------
    volume_m3                  : reservoir storage at failure (m^3)
    height_m                   : water head above breach invert (m)
    failure_mode               : one of failure_modes.FailureMode values
    dt                         : hydrograph timestep (s)
    breach_width_override      : user-entered breach width (m) — wins over mode auto value
    formation_time_override_min: user-entered formation time (min) — wins over mode auto value

    Returns
    -------
    dict with breach parameters + (times, discharges) arrays (seconds, m3/s)
    """
    mode = normalize_failure_mode(failure_mode)
    info = get_failure_mode_info(mode)

    qp = froehlich_peak_outflow(volume_m3, height_m)

    # --- Breach width: user override > mode-scaled regression ---
    b = froehlich_breach_width(volume_m3, height_m, mode)
    if breach_width_override and breach_width_override > 0:
        b = float(breach_width_override)
    else:
        b *= info["width_multiplier"]

    # --- Formation time: user override > mode-scaled regression ---
    tf = breach_formation_time(volume_m3, height_m)
    if formation_time_override_min and formation_time_override_min > 0:
        tf = float(formation_time_override_min) * 60.0
    else:
        tf *= info["time_multiplier"]
    tf = max(tf, 1.0)  # guard: instant failure still needs >= 1 s of physics

    # MacDonald & Langridge-Monopolis (1984) comparative embankment erosion volume
    v_eroded_m3 = 0.0261 * ((volume_m3 * height_m) ** 0.77)

    # Theoretical maximum Torricelli breach exit velocity v = sqrt(2 * g * H)
    v_breach_ms = math.sqrt(2.0 * 9.81 * height_m)

    t_rise = tf
    t_fall = 2 * tf
    t_total = t_rise + t_fall

    times = np.arange(0, t_total + dt, dt)
    discharge = np.where(
        times <= t_rise,
        qp * times / max(t_rise, 1e-6),
        qp * np.clip((t_total - times) / max(t_fall, 1e-6), 0, None),
    )

    return {
        "failure_mode": mode,
        "peak_outflow_cms": qp,
        "breach_width_m": b,
        "breach_formation_time_s": tf,
        "breach_formation_time_min": round(tf / 60.0, 1),
        "eroded_volume_m3": round(v_eroded_m3, 1),
        "breach_velocity_ms": round(v_breach_ms, 2),
        "unit_discharge_m2s": round(qp / max(b, 1.0), 2),
        "times_s": times,
        "discharge_cms": discharge,
        # Serializable Q(t) time series for the frontend hydrograph chart.
        # Sampled at every 60 s to keep payload small (max ~200 points).
        "hydrograph_times_min": [round(t / 60.0, 2) for t in times[::6].tolist()],
        "hydrograph_q_cms": [round(float(q), 2) for q in discharge[::6].tolist()],
    }
