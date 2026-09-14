# Product Requirements Document (PRD)
## Dam Break Inundation Modelling Using Hydrodynamic Modelling of Any River
**SIH26161 · Sponsoring Organisation: National Technical Research Organisation (NTRO) · Theme: Disaster Management**

---

### 1. Problem Statement (summary)
Dam failure (breach) can send a large, fast-moving flood wave downstream with
little warning. Authorities need a tool that, given a dam and its downstream
river, can simulate a breach scenario and produce **inundation extent, depth,
arrival time, and flood severity** for downstream villages/infrastructure —
usable for both **emergency planning (Emergency Action Plans)** and
**real-time early warning** during an actual dam-safety incident.

### 2. Goals
1. Let a user select/define a dam (location, height, storage, breach mode).
2. Automatically pull terrain (DEM) and river network data for the downstream
   reach.
3. Run a **hydrodynamic** flood-routing simulation (not just a static
   bathtub-fill) to get realistic timing and depth of flooding.
4. Visualise results on a map: flood extent over time, depth, velocity,
   arrival time at settlements.
5. Output actionable numbers: peak discharge, breach width/time, area
   flooded, time-to-arrival at each downstream point of interest.
6. Be usable by a non-GIS-expert district disaster-management officer.

### 3. Non-Goals (for the hackathon build)
- Real-time sensor integration / IoT telemetry (future work).
- Structural / geotechnical breach-initiation prediction (we take dam
  parameters as *given inputs*, we don't predict *whether* it will fail).
- Certified, litigation-grade hydraulic modelling (that requires calibrated
  HEC-RAS/MIKE 21 studies with surveyed cross-sections — out of scope for a
  36-hour prototype; the deliverable is a decision-support prototype).

### 4. Users & Use Cases
| User | Use case |
|---|---|
| District Disaster Management Authority | Pre-plan evacuation zones & timing for a specific dam |
| State Dam Safety Organisation | Screen multiple dams for downstream risk (EAP prep) |
| Emergency responder (during event) | Get fast estimate of arrival time / depth at a named village |
| NTRO / research analyst | Batch-run scenarios across different rivers |

### 5. Functional Requirements
- FR1: Accept dam parameters — height, reservoir storage/volume, failure mode
  (piping/overtopping), location (lat/lon or river+dam name).
- FR2: Fetch/attach a DEM for the downstream valley (from free sources, see
  `DATASETS.md`) at ≤30 m resolution.
- FR3: Compute breach hydrograph (peak outflow, breach width, formation time)
  using published empirical dam-breach equations.
- FR4: Route the flood hydrograph through the valley using a 2D
  hydrodynamic (or simplified hydrodynamic / diffusive-wave) model.
- FR5: Produce, per time step: water depth grid, flood extent polygon.
- FR6: Compute per-settlement: arrival time (depth > threshold), peak depth,
  peak velocity (stretch goal).
- FR7: Visualise as an animated/scrubbable map layer (Leaflet/Mapbox/QGIS).
- FR8: Export results (GeoTIFF/GeoJSON/CSV) for downstream GIS use.
- FR9: Support "any river" — i.e., the pipeline must be parameterised on
  DEM + dam location, not hard-coded to one basin.

### 6. Non-Functional Requirements
- Simulation for a demo-scale reach (≤ 15 km × 10 km at 30 m) should return
  in **under 2 minutes** on a laptop CPU (no GPU dependency for the MVP).
- Must run entirely on **free/open-source software and free data** (no paid
  licenses required to reproduce or judge the solution).
- Should degrade gracefully: if the full hydrodynamic run is too slow for a
  huge domain, offer a fast rapid-screening mode (HAND-based) as fallback.
- Codebase should be swappable: the "physics engine" (breach + routing) is a
  separate module so it can later be replaced by HEC-RAS/ANUGA/LISFLOOD-FP
  without changing the API/frontend contract.

### 7. Success Metrics (for judging / demo)
- Runs live, end-to-end, on stage in under a couple of minutes.
- Produces a map that visibly matches physical intuition (flood follows the
  valley, deeper near the dam, arrives later further downstream).
- Gives at least 3 concrete, quotable numbers per scenario: peak discharge,
  area flooded, time-to-arrival at a named point.
- Clearly documents the upgrade path to a validated hydrodynamic solver
  (HEC-RAS 2D / ANUGA / LISFLOOD-FP) for real deployment.

### 8. Milestones (36–48 hr hackathon timeline)
See `WORKFLOW.md` for the hour-by-hour plan.
