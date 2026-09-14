"""
validation.py
-------------
Shared input-validation helpers. Every request model that accepts
coordinates validates them here — no duplicate logic per endpoint.
"""

from typing import Optional

# Inclusive bounds used for every coordinate in the API.
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0


def validate_coordinates(lat: Optional[float], lon: Optional[float]) -> None:
    """Raise ValueError when a provided coordinate is out of physical range.

    None values are allowed (fields are optional; presence is enforced
    separately by endpoint logic).
    """
    if lat is not None and not (LAT_MIN <= lat <= LAT_MAX):
        raise ValueError(f"latitude must be within [{LAT_MIN}, {LAT_MAX}], got {lat}")
    if lon is not None and not (LON_MIN <= lon <= LON_MAX):
        raise ValueError(f"longitude must be within [{LON_MIN}, {LON_MAX}], got {lon}")
