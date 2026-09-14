"""
failure_modes.py
----------------
Single source of truth for dam failure modes.

Keeps failure-mode behaviour OUT of hardcoded strings scattered across the
codebase ("use enums/constants instead of hardcoded strings, keep modular"):

  - FailureMode          — str-Enum of the supported modes
  - FAILURE_MODE_INFO    — per-mode profile: UI label, description, and the
                           engineering multipliers applied to the Froehlich
                           (1995/2008) breach regressions inside breach.py

Breach-engine semantics per mode (applied to the base Froehlich estimates):

  mode          formation-time multiplier   breach-width multiplier
  overtopping   1.5  (slow, progressive)    1.3 (k0=1.3, wide trapezoidal)
  piping        1.0  (baseline)             1.0 (k0=1.0, narrow)
  structural    0.15 (near-instant)          2.0 (sudden large collapse)
  earthquake    0.3  (rapid)                1.8 (seismic slope/crest collapse)

Peak discharge is NOT scaled directly — the hydrograph keeps the same peak Qp
but concentrates it into a shorter rise time, which raises the advancing-wave
steepness and speeds flood propagation (see breach.build_breach_hydrograph).
"""

import json
from enum import Enum
from pathlib import Path


class FailureMode(str, Enum):
    """Supported dam failure modes (str-Enum: serializes as its value)."""

    OVERTOPPING = "overtopping"
    PIPING = "piping"
    STRUCTURAL = "structural"
    EARTHQUAKE = "earthquake"


# Per-mode profile consumed by both the backend engine and the frontend
# (the UI dropdown is generated from this via /failure-modes).
FAILURE_MODE_INFO: dict[str, dict] = {
    FailureMode.OVERTOPPING.value: {
        "label": "Overtopping",
        "description": "Water flows over the dam crest causing erosion.",
        # Multipliers applied to the base Froehlich (2008) estimates
        "time_multiplier": 1.5,    # slow breach formation
        "width_multiplier": 1.3,   # matches Froehlich k0=1.3 for overtopping
        "auto_breach_width": True, # let the regression compute width (req. 3)
    },
    FailureMode.PIPING.value: {
        "label": "Piping (Internal Erosion)",
        "description": "Internal seepage gradually erodes the dam.",
        "time_multiplier": 1.0,    # medium (baseline regression value)
        "width_multiplier": 1.0,   # medium (baseline regression value)
        "auto_breach_width": False, # UI prefills a medium breach width
    },
    FailureMode.STRUCTURAL.value: {
        "label": "Structural Failure",
        "description": "Sudden collapse of the dam structure.",
        "time_multiplier": 0.15,   # near-instant failure
        "width_multiplier": 2.0,   # large breach width
        "auto_breach_width": False, # UI prefills a large breach width
    },
    FailureMode.EARTHQUAKE.value: {
        "label": "Earthquake-Induced Failure",
        "description": "Dam failure triggered by seismic activity.",
        "time_multiplier": 0.3,    # rapid failure
        "width_multiplier": 1.8,   # large breach width
        "auto_breach_width": False, # UI prefills a large breach width
    },
}

# Fast validation without re-deriving from the Enum every call
_VALID_MODES = frozenset(m.value for m in FailureMode)


def normalize_failure_mode(value: str | None, default: FailureMode = FailureMode.PIPING) -> str:
    """Map legacy/unknown inputs onto a valid FailureMode value.

    Legacy aliases kept for backward compatibility with earlier API payloads
    and saved scenarios: 'seismic' -> 'earthquake', 'collapse' -> 'structural'.
    """
    if not value:
        return default.value
    v = str(value).strip().lower()
    if v in _VALID_MODES:
        return v
    aliases = {
        "seismic": FailureMode.EARTHQUAKE.value,
        "collapse": FailureMode.STRUCTURAL.value,
        "internal_erosion": FailureMode.PIPING.value,
    }
    return aliases.get(v, default.value)


def get_failure_mode_info(value: str | None) -> dict:
    """Return the full profile dict for a mode value (normalized)."""
    return FAILURE_MODE_INFO[normalize_failure_mode(value)]


def default_frontend_params(value: str) -> dict:
    """Frontend-facing defaults: which manual inputs to prefill per mode.

    Overtopping  -> slow formation, auto breach width
    Piping       -> medium formation, medium breach width
    Structural   -> instant formation, large breach width
    Earthquake   -> rapid formation, large breach width
    """
    info = get_failure_mode_info(value)
    # Base "medium" reference points for the UI prefill (breach engine applies
    # its own physics multipliers on top; these only prefill the form fields).
    base_tf_min, base_bw_m = 45, 60
    prefilled_width = (
        None if info["auto_breach_width"] else round(base_bw_m * info["width_multiplier"], 1)
    )
    return {
        "breach_formation_time_min": round(base_tf_min * info["time_multiplier"], 1),
        "breach_width_m": prefilled_width,
        # UI flag: leave the field empty (backend regression + mode multiplier
        # compute the width) — False when this mode prefills an explicit width.
        "auto_breach_width": prefilled_width is None,
    }


def export_for_frontend() -> str:
    """Serialize the mode list (value, label, description, defaults) as JSON
    for the frontend dropdown + description display."""
    payload = []
    for mode in FailureMode:
        info = FAILURE_MODE_INFO[mode.value]
        payload.append({
            "value": mode.value,
            "label": info["label"],
            "description": info["description"],
            "defaults": default_frontend_params(mode.value),
        })
    return json.dumps(payload)


# Legacy value sets formerly hardcoded in API Field(pattern=...) validators
LEGACY_PIPING_OVERTOPPING = ("piping", "overtopping")
