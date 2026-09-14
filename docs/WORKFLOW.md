# Build Workflow — From Zero to Demo

This is the order to actually do the work in, whether you have 2 days
(hackathon) or 2 weeks (pre-hackathon prep before SIH's internal round).

## Phase 0 — Setup (½ day)
- [ ] Clone/unzip this starter repo.
- [ ] `cd backend && pip install -r requirements.txt` (use
      `pip install --break-system-packages -r requirements.txt` on
      externally-managed environments/Linux distros if needed).
- [ ] Run `uvicorn app.main:app --reload --port 8000` → confirm
      `http://localhost:8000/health` returns `{"status": "ok"}`.
- [ ] Open `frontend/index.html` in a browser (or `python -m http.server`
      inside `frontend/`) → click **Run Simulation** → confirm you see a
      flood animate down the synthetic valley.
- [ ] Set up GitHub repo + basic README so the team can collaborate.

## Phase 1 — Understand the physics (½–1 day)
- [ ] Read `docs/TRD.md` section 3 (physics reference) end to end.
- [ ] Read the Froehlich (1995/2008) equations in `backend/app/breach.py`
      and manually check one calculation by hand — make sure the team
      actually understands what "breach width", "peak outflow" and
      "breach formation time" mean before presenting them to judges.
- [ ] Read `backend/app/routing.py` and understand the diffusive-wave
      formula and why the adaptive timestep + flux limiter exist (this is
      exactly the kind of question judges from NTRO/a technical panel will
      ask).

## Phase 2 — Swap in a real dam + real DEM (1 day)
- [ ] Pick ONE real Indian dam (ideally one with documented height/storage
      and a river with a few well-known downstream towns — makes the demo
      much more convincing). See `docs/DATASETS.md` §7 for the minimal path.
- [ ] Download & clip a real DEM (SRTM/Bhuvan, 30 m) around it.
- [ ] Wire `dem.load_real_dem()` into `main.py` in place of
      `make_synthetic_valley_dem()`. Reproject/resample to a consistent
      square cell size if the DEM is in geographic (lat/lon) degrees rather
      than metres (use `gdalwarp -tr <dx> <dx> -t_srs EPSG:32644` or similar
      UTM zone for India).
- [ ] Update `frontend/app.js` ORIGIN_LAT/ORIGIN_LON (or, better, carry the
      DEM's real geotransform through the API response and use it directly
      instead of the illustrative anchor point).
- [ ] Manually mark 3–6 real downstream villages as points of interest
      (lat/lon → row/col in the DEM).

## Phase 3 — Improve the model realism (as time allows)
- [ ] Vary Manning's `n` spatially using a land-cover raster (ESA
      WorldCover / Sentinel-2 classification) instead of one constant value.
- [ ] Add a second breach-parameter method (e.g., MacDonald &
      Langridge-Monopolis 1984) and show a sensitivity range instead of a
      single number — this is a genuinely good talking point for judges
      ("uncertainty-aware", which real dam-safety guidance emphasises).
- [ ] Add population-weighted impact (WorldPop raster × flood extent) to
      report "estimated population affected", not just area.
- [ ] Stretch: swap the routing engine for ANUGA (pip-installable, full 2D
      shallow water) for at least one showcase scenario, and show a
      side-by-side comparison with the simplified engine to demonstrate you
      understand the trade-off you made.

## Phase 4 — Turn results into decision-support output (½ day)
- [ ] Auto-generate an evacuation-zone polygon (max flood extent, buffered).
- [ ] Add a "time-to-safety" readout per village (arrival time minus a
      configurable evacuation lead time).
- [ ] Export a PDF/CSV situation report (this is the kind of artifact an
      actual District Disaster Management Authority would want).

## Phase 5 — Package the SIH submission
- [ ] Fill in the official AICTE PPT template (max 6 slides, per the SIH
      submission rules) — structure suggestion:
      1. Problem understanding + why it matters
      2. Proposed solution (architecture diagram from `SYSTEM_DESIGN.md`)
      3. Technology stack (from `TRD.md` §5)
      4. What makes it novel/feasible (uncertainty-aware breach modelling,
         "any river" parameterisation, free/open data & tools only)
      5. Impact & scalability (any dam in India, decision-support for EAPs)
      6. Live demo screenshot / QR code to a hosted demo
- [ ] Rehearse a **live** run (not just a video) — a working demo is much
      more convincing for a modelling problem statement like this one.
- [ ] Prepare answers for the two questions judges will almost certainly
      ask: *"Why not just use HEC-RAS?"* (answer: we do recommend it for
      production — see `TRD.md` §4 — but built our own lightweight engine
      to keep the whole pipeline scriptable, free, and web-deployable
      end-to-end) and *"How do you validate this against a real dam-break
      event?"* (answer: compare against a documented historical case, e.g.
      Machhu Dam-II (1979, India) or Teton Dam (1979, US), which have
      published peak-discharge estimates you can sanity-check your breach
      equations against).
