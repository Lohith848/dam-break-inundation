# REST API & SSE Endpoints Reference — SIH26161

The backend server is built with **FastAPI** and provides high-performance asynchronous endpoints for simulation execution, scenario comparison, live rainfall data, dam catalog queries, AI risk copilot, and PDF report export.

Base URL: `http://localhost:8000`

---

## Endpoints Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server health status check |
| `POST` | `/simulate` | Run dam breach hydrodynamic flood routing simulation |
| `POST` | `/simulate/start` | Start async SSE-backed simulation job; returns `job_id` |
| `GET` | `/simulate/stream/{job_id}` | Server-Sent Events (SSE) step progress + final result |
| `POST` | `/compare` | Multi-scenario breach comparative analysis |
| `GET` | `/weather/rainfall` | Fetch live Open-Meteo rainfall intensity (mm/hr) |
| `GET` | `/dams` | Search 6,644 national dams database |
| `GET` | `/rivers` | List rivers and associated dams |
| `GET` | `/failure-modes` | List supported failure mode constants |
| `POST` | `/ai/copilot` | Disaster risk assessment query via Groq LLM |
| `GET` | `/ai/status` | Check Groq AI key status |
| `POST` | `/export/pdf` | Generate downloadable disaster assessment PDF report |

---

## Endpoint Details

### 1. `POST /simulate`

Runs a single hydrodynamic dam breach simulation.

**Request Body** (`application/json`):
```json
{
  "dam_id": "NDSA_TN_001",
  "latitude": 11.8,
  "longitude": 77.8,
  "dam_name": "Mettur Dam",
  "reservoir_volume_m3": 2640000000,
  "dam_height_m": 65.23,
  "failure_mode": "overtopping",
  "manning_n": 0.045,
  "total_sim_hours": 3.0,
  "dem_type": "COP30"
}
```

**Response Body** (`200 OK`):
```json
{
  "status": "success",
  "simulation_id": "sim_20260914_001",
  "failure_mode": "overtopping",
  "breach": {
    "peak_outflow_cms": 31250.4,
    "breach_width_m": 185.2,
    "breach_formation_time_min": 42.5
  },
  "summary": {
    "max_inundated_area_km2": 84.5,
    "max_flood_depth_m": 14.8,
    "points_of_interest": [
      {
        "name": "Mettur Town",
        "arrival_time_min": 12.0,
        "max_depth_m": 8.5,
        "status": "Inundated"
      }
    ]
  },
  "depth_grids": [ [[ ... ]] ],
  "velocity_grids": [ [[ 0.0, 1.2, 3.5, ... ]] ],
  "timesteps_hours": [0.0, 0.25, 0.5, ...],
  "elevation_grid": [[ ... ]],
  "dam_geometry": { ... }
}
```

> **`velocity_grids`** — 3D array `[snapshot][row][col]` of flow speed (m/s) computed from edge unit discharges via `V = sqrt(qx²+qy²) / max(h, 0.05)`. Zero for dry cells. Used by the frontend `setColorMode("velocity")` heatmap and the dashboard `Max Velocity` metric.

---

### 2. `POST /simulate/start` + `GET /simulate/stream/{job_id}`

Start an async job and stream SSE progress events + final result.

**`POST /simulate/start`** — same request body as `/simulate`. Returns `{"job_id": "..."}`.

**`GET /simulate/stream/{job_id}`** — SSE stream:
```text
data: {"step": 0, "total_steps": 6, "label": "Fetching DEM", "done": false}
data: {"step": 3, "total_steps": 6, "label": "Routing flood wave", "done": false}
event: result
data: { ...full simulation JSON including velocity_grids... }
```

---

```json
{
  "status": "success",
  "breach": {
    "peak_outflow_cms": 31250.4,
    "breach_width_m": 185.2,
    "breach_formation_time_min": 42.5
  },
  "summary": {
    "max_inundated_area_km2": 84.5,
    "max_flood_depth_m": 14.8,
    "points_of_interest": [
      {
        "name": "Mettur Town",
        "arrival_time_min": 12.0,
        "max_depth_m": 8.5,
        "status": "Inundated"
      }
    ]
  },
  "snapshots": [ ... ]
}
```

---

### 2. `GET /simulate/progress`

Server-Sent Events (SSE) connection streaming real-time simulation computation percentage.

**Response Stream** (`text/event-stream`):
```text
data: {"progress": 15, "stage": "Fetching DEM terrain..."}
data: {"progress": 45, "stage": "Computing breach hydrograph..."}
data: {"progress": 90, "stage": "Routing 2D flood wave..."}
data: {"progress": 100, "stage": "Simulation complete"}
```

---

### 3. `POST /compare`

Runs multi-scenario simulations side-by-side to compute deltas in peak depth, inundated area, and settlement arrival times.

**Request Body**:
```json
{
  "scenarios": [
    {
      "latitude": 11.8,
      "longitude": 77.8,
      "dam_name": "Mettur Dam - Piping",
      "reservoir_volume_m3": 2640000000,
      "dam_height_m": 65.23,
      "failure_mode": "piping"
    },
    {
      "latitude": 11.8,
      "longitude": 77.8,
      "dam_name": "Mettur Dam - Overtopping",
      "reservoir_volume_m3": 2640000000,
      "dam_height_m": 65.23,
      "failure_mode": "overtopping"
    }
  ]
}
```

**Response Body**:
```json
{
  "scenarios": [ ... ],
  "delta": {
    "area_km2": 14.2,
    "peak_depth_m": 3.1
  },
  "elapsed_ms": 4820
}
```

---

### 4. `GET /weather/rainfall`

Retrieves live rainfall intensity from Open-Meteo API.

**Query Parameters**:
- `lat` (float): Latitude coordinate (e.g. `11.8`)
- `lon` (float): Longitude coordinate (e.g. `77.8`)

**Response**:
```json
{
  "latitude": 11.8,
  "longitude": 77.8,
  "current_mm_per_hr": 14.5,
  "source": "Open-Meteo",
  "timestamp": "2026-09-13T17:00:00"
}
```

---

### 5. `POST /export/pdf`

Generates an executive disaster risk report in PDF format.

**Request Body**: Standard simulation result dictionary.
**Response**: `application/pdf` binary download stream (`disaster_report_mettur.pdf`).
