import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from app import breach, dem as dem_utils, routing


def _small_scenario():
    dem = dem_utils.make_synthetic_valley_dem(nx=60, ny=40, dam_x_index=8)
    hydro = breach.build_breach_hydrograph(5_000_000, 20, "piping")
    centre = dem.shape[0] // 2
    source_cells = [(centre, 8)]
    snap_times, snapshots = routing.run_flood_routing(
        dem=dem, dx=30.0, source_cells=source_cells,
        hydrograph_times=hydro["times_s"], hydrograph_q=hydro["discharge_cms"],
        manning_n=0.045, total_time_s=3600, snapshot_interval_s=300,
    )
    return dem, hydro, snap_times, snapshots


def test_no_nan_or_negative_depths():
    _, _, _, snapshots = _small_scenario()
    for snap in snapshots:
        assert not np.isnan(snap).any()
        assert (snap >= 0).all()


def test_flood_extent_grows_then_the_domain_holds_water():
    _, _, _, snapshots = _small_scenario()
    wetted_cells = [np.sum(s > 0.05) for s in snapshots]
    # flood extent should generally not shrink to zero once water has entered
    assert wetted_cells[-1] > 0
    assert max(wetted_cells) >= wetted_cells[0]


def test_summary_arrival_times_are_monotonic_with_distance():
    dem, hydro, snap_times, snapshots = _small_scenario()
    centre = dem.shape[0] // 2
    pois = [
        {"name": "near", "cell": (centre, 8 + 10)},
        {"name": "mid", "cell": (centre, 8 + 25)},
        {"name": "far", "cell": (centre, 8 + 45)},
    ]
    summary = routing.summarize_results(snap_times, snapshots, dx=30.0, points_of_interest=pois)
    arrivals = [p["arrival_time_min"] for p in summary["points_of_interest"]]
    reached = [a for a in arrivals if a is not None]
    # whichever points were reached, arrival time must increase with distance
    assert reached == sorted(reached)


def test_velocity_snapshots_computed_and_physical():
    dem = dem_utils.make_synthetic_valley_dem(nx=60, ny=40, dam_x_index=8)
    hydro = breach.build_breach_hydrograph(5_000_000, 20, "piping")
    centre = dem.shape[0] // 2
    source_cells = [(centre, 8)]
    snap_times, snapshots, vel_snapshots = routing.run_flood_routing(
        dem=dem, dx=30.0, source_cells=source_cells,
        hydrograph_times=hydro["times_s"], hydrograph_q=hydro["discharge_cms"],
        manning_n=0.045, total_time_s=3600, snapshot_interval_s=300,
        return_velocities=True,
    )
    assert len(vel_snapshots) == len(snapshots)
    for v in vel_snapshots:
        assert not np.isnan(v).any()
        assert (v >= 0.0).all()
        # Physical check: diffusive flow velocity bounded within reasonable engineering range
        assert float(np.max(v)) <= 25.0
    # Peak flow velocity near breach should be greater than zero
    max_overall_v = max(float(np.max(v)) for v in vel_snapshots)
    assert max_overall_v > 0.1
