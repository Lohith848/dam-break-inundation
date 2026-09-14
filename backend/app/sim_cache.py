"""
sim_cache.py
------------
Shared in-memory cache of simulation results, keyed by simulation ID.

Both the direct /simulate endpoint (main.py) and the SSE-backed pipeline
(progress.py) register their results here, so the AI Copilot endpoints
(/ai/analyze, /ai/chat, /ai/report, /report/pdf) can resolve any
simulation_id the frontend sends — regardless of which code path
produced it.

Bug fix: /simulate/start previously generated a simulation_id but never
registered the result, so AI analysis always failed with
"Simulation not found: <id>".
"""

import hashlib
import logging
import time

logger = logging.getLogger("dam_sim.sim_cache")

SIMULATION_CACHE: dict = {}  # sim_id -> sim_data (insertion-ordered)
MAX_CACHED_SIMULATIONS = 20


def cache_simulation(sim_data: dict) -> str:
    """Register simulation results in the cache and return the new sim_id."""
    sim_id = hashlib.md5(
        f"{sim_data.get('dam_name', '')}_{time.time()}".encode()
    ).hexdigest()[:12]
    SIMULATION_CACHE[sim_id] = sim_data

    # Keep only the most recent simulations in memory
    while len(SIMULATION_CACHE) > MAX_CACHED_SIMULATIONS:
        oldest = next(iter(SIMULATION_CACHE))
        del SIMULATION_CACHE[oldest]

    logger.info("Cached simulation %s (%d in cache)", sim_id, len(SIMULATION_CACHE))
    return sim_id


def get_simulation(sim_id: str):
    """Return cached simulation data for sim_id, or None if unknown/expired."""
    return SIMULATION_CACHE.get(sim_id)
