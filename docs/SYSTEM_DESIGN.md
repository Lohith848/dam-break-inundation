# System Design — Dam Break Inundation Modelling

### Data Flow Diagram

```
 [User: dam params]
        │
        ▼
 ┌─────────────────┐
 │ Frontend (map +  │
 │ input form)      │
 └────────┬─────────┘
          │ POST /simulate {dam_name, volume, height, failure_mode, hours}
          ▼
 ┌───────────────────────────┐
 │ FastAPI: /simulate         │
 └────────┬───────────────────┘
          │
          ▼
 ┌───────────────────────────┐        ┌───────────────────────────┐
 │ breach.py                  │──────► │ routing.py                 │
 │ - Froehlich equations      │ hydro- │ - 2D diffusive-wave solver │
 │ - triangular hydrograph    │ graph  │ - adaptive dt              │
 └───────────────────────────┘        │ - mass-conserving limiter  │
          ▲                            └────────┬───────────────────┘
          │                                     │
 ┌───────────────────────────┐                 ▼
 │ dem.py                     │        ┌───────────────────────────┐
 │ - synthetic valley (demo)   │───────►│ depth grids over time      │
 │ - real DEM loader (prod)    │        │ + summary metrics          │
 └───────────────────────────┘        └────────┬───────────────────┘
                                                 │ JSON response
                                                 ▼
                                       ┌───────────────────────────┐
                                       │ Frontend: render overlay,   │
                                       │ slider, summary table       │
                                       └───────────────────────────┘
```

### Production Target Architecture (post-hackathon)

```
                 ┌────────────────────────┐
                 │   Web Frontend (React)  │
                 │   Leaflet/Mapbox GL      │
                 └───────────┬─────────────┘
                             │ HTTPS/REST
                 ┌───────────▼─────────────┐
                 │   API Gateway (FastAPI)  │
                 └───────────┬─────────────┘
             ┌───────────────┼────────────────────┐
             ▼                ▼                    ▼
    ┌────────────────┐ ┌─────────────┐   ┌───────────────────┐
    │ Dam registry /   │ │ Job queue    │   │ Alerting service    │
    │ scenario DB      │ │ (Celery/RQ)  │   │ (SMS/app push)      │
    │ (Postgres)       │ └──────┬──────┘   └───────────────────┘
    └────────────────┘         │
                                ▼
                     ┌─────────────────────┐
                     │ Simulation workers    │
                     │ HEC-RAS 2D / ANUGA /  │
                     │ LISFLOOD-FP           │
                     └──────────┬────────────┘
                                ▼
                     ┌─────────────────────┐
                     │ Geospatial data store │
                     │ PostGIS + object      │
                     │ storage (GeoTIFFs)    │
                     └─────────────────────┘
```

### Sequence: "Run a scenario"
1. User selects/enters dam parameters in the frontend.
2. Frontend POSTs to `/simulate`.
3. API builds/loads DEM for the reach.
4. `breach.py` computes the breach hydrograph from dam parameters.
5. `routing.py` propagates that hydrograph across the DEM, snapshotting
   depth grids at fixed intervals.
6. API summarises: max area flooded, max depth, arrival time & depth at each
   point of interest (village/asset).
7. API returns everything as one JSON payload.
8. Frontend renders the depth grids as a scrubbable map overlay + shows the
   summary table.

### Key Design Decisions & Rationale
- **Why diffusive-wave instead of full shallow water for the base?**
  Full 2D shallow water (with inertial terms) needs a much smaller,
  velocity-dependent timestep and more careful boundary handling — harder to
  get right, live, in a hackathon in pure NumPy. Diffusive-wave is the same
  simplification real tools (LISFLOOD-FP) use for exactly this
  speed/robustness trade-off, and it's honestly documented as a
  simplification, not misrepresented as a full dynamic model.
- **Why synthetic DEM by default?** So the whole repo runs with zero
  external downloads or API keys — anyone can `git clone` and see a working
  simulation in under a minute. Swapping in a real DEM is one function call
  (`dem.load_real_dem`).
- **Why keep breach/routing as separate pure functions (not classes)?**
  Easy to unit test, easy to swap for a different breach model or routing
  engine independently, easy to run in a batch/notebook context outside the
  API for calibration work.
