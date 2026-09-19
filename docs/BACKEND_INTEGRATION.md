# Backend Integration — REST API & Hydrodynamic Contracts

## 1. REST Endpoints Overview

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/dams` | Search and list indexed dams with metadata |
| `GET` | `/dam/{dam_id}` | Retrieve specific dam parameters, geometry, and reservoir volume |
| `GET` | `/rivers` | List river networks and associated dam counts |
| `POST` | `/simulate` | Synchronous hydrodynamic simulation run |
| `POST` | `/simulate/start` | Launch asynchronous simulation job returning `job_id` |
| `GET` | `/simulate/stream/{job_id}` | SSE stream emitting step-by-step progress and final payload |
| `POST` | `/report/pdf` | Generate official 13-section CWC/NDMA government PDF report |
| `POST` | `/ai/chat` | Query civil/hydraulic engineering AI copilot via Groq LPU |
| `GET` | `/weather/rainfall` | Fetch live precipitation and 24h forecast from Open-Meteo |
| `POST` | `/compare` | Multi-scenario comparative flood wave analysis |

## 2. Asynchronous Simulation Flow (Server-Sent Events)

```
Client                             Backend FastAPI
  │                                       │
  ├────── POST /simulate/start ──────────►│ (Spawns background task)
  │◄───── { job_id: "..." } ──────────────┤
  │                                       │
  ├────── GET /simulate/stream/{job_id} ──►│
  │◄───── "step 1: downloading DEM" ──────┤
  │◄───── "step 2: computing breach" ─────┤
  │◄───── "step 3: 2D diffusive wave" ────┤
  │◄───── "result": { full JSON payload }─┤
```

## 3. Hydrodynamic Simulation Payload Schema
```json
{
  "simulation_id": "sim_2026_mettur_001",
  "dam_name": "Mettur Dam",
  "failure_mode": "piping",
  "breach": {
    "peak_outflow_cms": 14250.0,
    "breach_width_m": 84.5,
    "breach_formation_time_min": 42.0
  },
  "summary": {
    "max_inundated_area_km2": 142.8,
    "max_flood_depth_m": 8.4,
    "velocity_estimate_ms": 3.8,
    "points_of_interest": [
      { "name": "Settlement Alpha", "arrival_time_min": 35.0, "peak_depth_m": 4.2 }
    ]
  },
  "snapshot_times_s": [0, 300, 600, 900, 1200],
  "depth_grids": [[[0.0, ...], ...]],
  "velocity_grids": [[[0.0, ...], ...]],
  "simulation_time_ms": 1450.0
}
```
The frontend consumes this schema directly without fabricating or altering values.
