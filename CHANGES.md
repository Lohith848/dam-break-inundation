# CHANGES.md — Development Session Log

**Project:** Dam Break Inundation Modelling Platform (SIH26161)
**Date:** September 13, 2026
**Scope:** Bug fixes, AI Copilot integration, 3D GLB dam model integration, security hardening, regression tests, and editor diagnostics.

---

## Table of Contents

1. [Summary of All Changes](#1-summary-of-all-changes)
2. [Fix 1 — `elevation_grid[row] is undefined` crash (3D viewport)](#2-fix-1--elevation_gridrow-is-undefined-crash-3d-viewport)
3. [Fix 2 — Dam 3D model not visible / not loading](#3-fix-2--dam-3d-model-not-visible--not-loading)
4. [Fix 3 — AI Copilot: three root-cause bugs in Groq client](#4-fix-3--ai-copilot-three-root-cause-bugs-in-groq-client)
5. [Fix 4 — Security: removed hardcoded API keys](#5-fix-4--security-removed-hardcoded-api-keys)
6. [Fix 5 — "Simulation not found: \<id\>" in AI Copilot](#6-fix-5--simulation-not-found-id-in-ai-copilot)
7. [Fix 6 — End-to-end GLB dam model integration (10 requirements)](#7-fix-6--end-to-end-glb-dam-model-integration-10-requirements)
8. [Fix 7 — Editor errors in `groq_client.py` (lazy imports / Pylance)](#8-fix-7--editor-errors-in-groq_clientpy-lazy-imports--pylance)
9. [New Files Created](#9-new-files-created)
10. [Test Coverage Added](#10-test-coverage-added)
11. [Verification Results](#11-verification-results)
12. [Files Changed — Quick Reference](#12-files-changed--quick-reference)
13. [How to Apply / Run](#13-how-to-apply--run)

---

## 1. Summary of All Changes

| # | Problem | Root Cause | Fix |
|---|---------|-----------|-----|
| 1 | `can't access property, this.data.elevation_grid[row] is undefined` | Backend synthetic-fallback response used a different data contract (`min_m` vs `min_elev`, missing `timesteps_hours`); one malformed field aborted the whole `loadSimulation()` | Grid sanitization + stats fallback + per-step error isolation in `three_viewer.js` |
| 2 | Dam 3D model not visible | Failed GLB attempt left both GLB and fallback box hidden; no materials in GLB → black render | Robust URL fallback chain, material assignment, IBL lighting, auto-orient/center/scale/place |
| 3a | AI endpoints crash with `NameError` | `_groq_client` referenced via `global` but never initialized | Module-level `_groq_client = None` |
| 3b | `.env` keys never loaded | Windows OS had **empty-string** `GROQ_API_KEY=` / `OPENTOPOGRAPHY_API_KEY=` env vars shadowing real values | Loaders now override empty values, never real ones |
| 3c | Groq 404 `model_not_found` | `llama-3.3-70b-versatile` retired from Groq | Auto model resolution from the key's catalog → `openai/gpt-oss-120b`; `GROQ_MODEL` override supported |
| 4 | API key committed in source | Hardcoded OpenTopography key in `dem_fetcher.py` | Moved to `.env`-only loading; added `.env.example` |
| 5 | `Analysis failed: Simulation not found: 9063f45970a5` | SSE pipeline (`/simulate/start`) generated a `simulation_id` but never cached the result | New shared `sim_cache.py`; both `/simulate` and `/simulate/start` register results |
| 6 | GLB model integration gaps | No orientation handling, no debug visibility, no auto-load on dam selection | Full 10-point implementation (orientation, scaling, lighting, debug helper, logs, auto-load) |
| 7 | Editor errors at `groq_client.py` lines 65/135/189/203 | Lazy/conditional imports inside functions unresolvable by Pylance | Single guarded module-level import site per package; real helper classes instead of `type()` hacks |

---

## 2. Fix 1 — `elevation_grid[row] is undefined` crash (3D viewport)

**File:** `frontend/three_viewer.js`

### Root cause
When the DEM download fails, `main.py::_build_synthetic_response()` returns a **different payload contract** than the real-terrain path:

| Field | Real path | Synthetic fallback |
|-------|-----------|--------------------|
| `elevation_stats` | `min_elev`, `max_elev` | `min_m`, `max_m` |
| `timesteps_hours` | present | **missing** |
| `village_impacts` | present | **missing** |

The missing stats produced `NaN` terrain colors/positions; the exception aborted `loadSimulation()` mid-way — which also killed dam construction (linking bug #1 → bug #2).

### Changes
1. **`_sanitizeElevationGrid(grid)`** — new method:
   - Returns a flat placeholder terrain if the grid is missing/not an array-of-arrays.
   - Replaces every non-finite cell (`NaN`, `undefined`, strings) with `0`.
2. **`_deriveTimesteps(data)`** — new method: derives `timesteps_hours` from `snapshot_times_s` (or a default 5-minute spacing) when missing.
3. **`buildTerrainMesh()`** hardened:
   - Accepts both `min_elev/max_elev` and legacy `min_m/max_m` stats keys.
   - Computes min/max from the grid itself when stats are missing/invalid.
   - Skips malformed rows instead of crashing; skips non-finite cells.
4. **`loadSimulation()`** — each build step (terrain, dam, water, villages) wrapped in its own `try/catch` with `console.error`, so one failure can no longer abort the rest.
5. **`setFrame()`** — guards against missing/empty `depth_grids` and missing `timesteps_hours`.

---

## 3. Fix 2 — Dam 3D model not visible / not loading

**Files:** `frontend/three_viewer.js`, `frontend/app.js`

### Root causes
1. `dam_structure.glb` exists and the backend serves `frontend/assets/` at `/assets`, but a failed GLB attempt left **both** the GLB and the procedural box dam hidden.
2. The GLB contains **zero materials** (trimesh export) — a `MeshStandardMaterial` model with no map and no environment lighting renders black.
3. `app.js` called `loadRealDamMesh("/assets/...")` with an absolute path that fails when the page is served by Live Server or `file://`.

### Changes
1. `loadRealDamMesh()`: URL candidate list reordered and deduplicated (absolute API → `/assets/...` → relative), explicit fallback re-showing the box dam, informative console logging.
2. `app.js`: added `apiBase` constant; the model URL is now `${apiBase}/assets/dam_structure.glb` so it resolves cross-origin too.
3. Initial material/visibility/lighting hardening (superseded and extended by Fix 6 below).

---

## 4. Fix 3 — AI Copilot: three root-cause bugs in Groq client

**File:** `backend/app/ai/groq_client.py`

### 3a. `NameError: _groq_client is not defined`
The code did `global _groq_client` inside `_get_client()` but the variable was never initialized at module level → every AI endpoint (`/ai/status`, `/ai/chat`, …) crashed before checking the key.
**Fix:** `_groq_client = None` at module level.

### 3b. Empty-string OS env placeholders shadowed `.env`
Diagnostics proved the OS environment contained:

```
GROQ_API_KEY=            (length 0)
OPENTOPOGRAPHY_API_KEY=  (length 0)
```

Every `.env` loader used `if k not in os.environ` — which treats an **empty existing value** as "already set" and skips loading the real key from `.env`.

**Fix (all three loaders):** `if k and v and not os.environ.get(k):` — overrides only when unset **or empty**, never a real non-empty value. Applied consistently in:
- `backend/app/ai/groq_client.py::_load_dotenv()`
- `backend/app/dem_fetcher.py::_load_env_fallback()`
- `backend/app/main.py::_load_env()`

### 3c. Dead model ID → 404 `model_not_found`
Live test against the Groq API: `llama-3.3-70b-versatile` no longer exists (Groq retired its Llama chat models for this key). Available catalog included `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`, `groq/compound`, whisper/guard models.

**Fix — automatic model resolution:**
- New `resolve_model()` queries `client.models.list()` and picks the first available model from a preference list:
  `openai/gpt-oss-120b → openai/gpt-oss-20b → qwen/qwen3.8-27b → qwen/qwen3.6-27b → groq/compound-mini → groq/compound`
- `GROQ_MODEL=<model_id>` in `.env` pins a specific model (override wins).
- Last-resort filter skips guard/audio models (`guard`, `whisper`, `orpheus`, `safeguard`).
- `/ai/status` and `/ai/analyze` now report the **resolved** model instead of the hardcoded dead one.
- Retry logic: `model_not_found` fails fast with a clear log; **empty content** (gpt-oss reasoning models consume budget with hidden reasoning) triggers a retry with doubled `max_tokens` (capped at 8192); 401/auth errors fail fast with a `.env` hint.
- `httpx` fallback client now also supports **streaming** (SSE line parsing via `_iter_sse`).

### Related: main.py health check
`/health` referenced the removed module-level constant `dem_fetcher.OPENTOPOGRAPHY_API_KEY`; updated to `dem_fetcher.get_opentopography_key()`.

---

## 5. Fix 4 — Security: removed hardcoded API keys

**Files:** `backend/app/dem_fetcher.py`, `.env.example` (new)

- **Removed** the OpenTopography API key hardcoded in source (`dem_fetcher.py` line 24).
- Added a lazy getter `get_opentopography_key()` that resolves from the environment (loading `.env` on demand), so import order no longer matters.
- `fetch_dem_for_dam()` uses the getter and raises a descriptive `ValueError` when the key is missing.
- **Created `.env.example`** documenting both required keys (git-ignored `.env` holds the real values; `.gitignore` already covers `.env`).

---

## 6. Fix 5 — "Simulation not found: \<id\>" in AI Copilot

**Files:** `backend/app/sim_cache.py` (new), `backend/app/progress.py`, `backend/app/main.py`

### Root cause
The SSE pipeline (`POST /simulate/start`, used by the UI) generated a `simulation_id` with `hashlib.md5(...)` but **never registered the result anywhere**. Only the direct `POST /simulate` endpoint cached results in `_simulation_cache`. Result: every AI Copilot call 404'd with `Simulation not found: <id>`.

### Changes
1. **New `backend/app/sim_cache.py`** — shared in-memory store:
   - `cache_simulation(sim_data) -> sim_id` (MD5-based ID, insertion-ordered dict, evicts oldest beyond 20 entries).
   - `get_simulation(sim_id)` lookup used by all AI endpoints.
2. **`progress.py`** — the SSE pipeline now calls `sim_cache.cache_simulation(response)` instead of only generating an ID.
3. **`main.py`** — imports `sim_cache`; all AI endpoints (`/ai/analyze`, `/ai/chat`, `/ai/report`, `/report/pdf`) look up via `sim_cache.get_simulation()`; backward-compatible aliases kept:
   ```python
   _simulation_cache = sim_cache.SIMULATION_CACHE
   _cache_simulation = sim_cache.cache_simulation
   ```

---

## 7. Fix 6 — End-to-end GLB dam model integration (10 requirements)

**Files:** `frontend/three_viewer.js`, `frontend/app.js`, `backend/tests/test_assets.py` (new), `scripts/inspect_glb.py` (new)

### Asset verification (done first)
- Both copies (`./dam_structure.glb` and `frontend/assets/dam_structure.glb`) are **byte-identical** (SHA-1 `315dcd6d…`).
- Binary inspection (`scripts/inspect_glb.py`): valid glTF 2.0 (magic `glTF`, version 2, declared length = actual 238,372 bytes), **no extensionsRequired** (no DRACO/KTX2 needed), 11 meshes (DAM_Cube, ELCTRICITY_*, BUILDING_Cube, NurbsPath×3, D*_Cube), **0 materials**, 0 animations, generator `trimesh` (Blender → trimesh export).
- Backend serves it: `GET /assets/dam_structure.glb` → 200 with `glTF` magic (now regression-tested).

### Implementation in `three_viewer.js`
1. **Loader with callbacks & logs** — 4 URL candidates, per-URL `console.info` on failure, success log `[DAM GLB] loaded successfully: <url>`; full failure output lists every candidate + last error.
2. **Inspection logs** — mesh count, native bounding box min/max, animation count.
3. **Auto-orientation** — detects Blender Z-up exports (up-extent < 35% of largest horizontal extent) and rotates −90° around X, then re-measures the bounding box.
4. **Center + scale + position** — wrapper group gets a bottom-center local origin; scale chosen so model height = `crest_height_m × exaggeration`; positioned at the simulation's dam column using the **raw pre-sanitization** elevation grid (`_rawElevationGrid`), i.e. real terrain elevation at the dam site; `updateMatrixWorld(true)` called before helpers/render.
5. **Materials fixed** — GLB has no materials: every mesh gets a cloned concrete `MeshStandardMaterial` (`color 0x9aa0a6`, roughness 0.85, metalness 0.05), `side: DoubleSide` (defensive against flipped windings), `frustumCulled = false` (stale bounding spheres can never hide it), `castShadow/receiveShadow = true`.
6. **Lighting** — `RoomEnvironment` IBL via `PMREMGenerator` (HDRI-style env map so untextured standard materials aren't black) + existing hemisphere + directional sun + ACES filmic tone mapping.
7. **Debug helper** — green `Box3Helper` wireframe around the model, **on by default**; `viewer3D.toggleDamDebugHelper(force?)` toggles it; disposed/refreshed on every rebuild and in `destroy()`.
8. **Auto-appear** — `loadSimulation()` auto-loads the GLB if not yet loaded (terrain-ready-before-model race) or repositions the existing model (model-ready-before-terrain race); `positionAndScaleDamMesh()` is idempotent and re-applies on exaggeration changes via `setExaggeration() → loadSimulation()`.
9. **Dam selection preload (`app.js`)** — `selectDam()` preloads the GLB from `${apiBase}/assets/dam_structure.glb` so the model appears instantly when terrain loads (requirement 9).
10. **No unrelated code rewritten** — routing, simulation, compare, weather modules untouched.

### Kept for reuse
`scripts/inspect_glb.py` — GLB sanity checker (header, extensions, meshes, bounds, binary chunk).

---

## 8. Fix 7 — Editor errors in `groq_client.py` (lazy imports / Pylance)

**File:** `backend/app/ai/groq_client.py`

### Diagnosis
Lines 65, 135, 189, 203 were the four **lazy/conditional imports** (`import httpx` ×2, `from dotenv import load_dotenv`, `from groq import Groq`) inside functions/try-blocks — Pylance reports these as unresolved even though `httpx`, `python-dotenv`, and `groq` are all installed (`C:\Python314`). A related hidden complaint: `_groq_client = None` later assigned a client object (type mismatch), and the dynamic `type("obj", (object,), {...})()` message objects defeat static analysis.

### Changes (behavior-preserving refactor)
1. **Single guarded import site per package** at module level:
   ```python
   try:
       import httpx
   except ImportError:
       httpx = None
   # same pattern for dotenv (as _dotenv_load) and groq (as Groq)
   ```
2. `_get_client()` restructured: `if Groq is not None:` / `if httpx is None:` checks replace try/except-around-import; identical fallback order (groq SDK → httpx fallback → error).
3. `_load_dotenv()` uses the module-level `_dotenv_load` handle; built-in fallback parser unchanged (empty-placeholder override semantics preserved).
4. Typing cleanup: `_groq_client: Any`, `last_error: Optional[Exception]`, `from __future__ import annotations`.
5. Real helper classes `_Delta`, `_StreamChoice`, `_Message`, `_Choice`, `_Response` replace the `type()` hacks (same attribute shapes as the groq SDK).

---

## 9. New Files Created

| File | Purpose |
|------|---------|
| `.env.example` | Template documenting `GROQ_API_KEY` and `OPENTOPOGRAPHY_API_KEY` (no secrets) |
| `backend/app/sim_cache.py` | Shared simulation cache (sim_id → result) used by `/simulate`, `/simulate/start`, and all AI endpoints |
| `backend/tests/test_sim_cache.py` | 7 regression tests for the cache + SSE pipeline + `/ai/analyze` contract |
| `backend/tests/test_assets.py` | 2 tests: GLB served by backend with valid magic; GLB file integrity |
| `scripts/inspect_glb.py` | GLB binary inspector (header, extensions, meshes, bounds) |
| `CHANGES.md` | This document |

---

## 10. Test Coverage Added

**`backend/tests/test_sim_cache.py`** (7 tests)
- `test_cache_roundtrip` — cache → get returns the same object.
- `test_get_simulation_unknown_returns_none` — unknown IDs return None.
- `test_cache_evicts_oldest_beyond_limit` — LRU-style eviction beyond 20.
- `test_progress_pipeline_registers_result_in_cache` — SSE pipeline output resolves via cache (the original bug).
- `test_main_endpoints_use_shared_cache` — `main._simulation_cache` is the shared store.
- `test_ai_analyze_resolves_cached_sse_simulation` — end-to-end: cached sim → `POST /ai/analyze` → 200 (AI mocked, hermetic).
- `test_ai_analyze_unknown_id_still_404s` — 404 path preserved.

**`backend/tests/test_assets.py`** (2 tests)
- `test_dam_glb_is_served_by_backend` — `GET /assets/dam_structure.glb` → 200, body starts with `glTF`.
- `test_dam_glb_exists_in_frontend_assets` — file present, valid header, declared length == actual size.

---

## 11. Verification Results

| Check | Result |
|-------|--------|
| `python -m pytest tests/ -q` (backend) | ✅ **16 passed** (7 original + 9 new) |
| Live Groq API call (`chat_completion`) | ✅ `OK → "ready"` via `openai/gpt-oss-120b` |
| Groq streaming (`chat_completion_stream`) | ✅ 11 chunks yielded |
| `/ai/status` via TestClient | ✅ `{"groq_available": true, "api_key_configured": true, "model": "openai/gpt-oss-120b"}` |
| `node --input-type=module --check` on `three_viewer.js` | ✅ syntax OK |
| `node --check` on `app.js` / `ai_panel.js` | ✅ syntax OK |
| `python -m py_compile backend/app/ai/groq_client.py` | ✅ OK |
| GLB integrity (header/length/magic) | ✅ valid, served by backend |
| Stale symbol search (`applyDamMaterials`, `prepareAndNormalizeDamMesh`) | ✅ 0 matches |

---

## 12. Files Changed — Quick Reference

**Frontend**
- `frontend/three_viewer.js` — sanitization, error isolation, GLB pipeline rewrite (orient/center/materials/scale/position), IBL lighting, debug helper, auto-load, destroy() cleanup.
- `frontend/app.js` — `apiBase`, cross-origin GLB URL, dam-selection preload, loadSimulation auto-load call site.
- `frontend/ai_panel.js` — `checkAIStatus()` on startup (✅ ready / ⚠️ missing key / backend unreachable).

**Backend**
- `backend/app/ai/groq_client.py` — NameError fix, empty-placeholder env override, model auto-resolution, adaptive max_tokens retry, streaming httpx fallback, module-level guarded imports, typed helpers.
- `backend/app/dem_fetcher.py` — hardcoded key removed → `get_opentopography_key()` + `_load_env_fallback()`.
- `backend/app/progress.py` — SSE pipeline registers results in shared cache.
- `backend/app/main.py` — env loader override semantics, `sim_cache` wiring (aliases kept), `/health` + `/ai/status` + `/ai/analyze` model reporting.

**New files:** see [Section 9](#9-new-files-created).

---

## 13. How to Apply / Run

```bash
# 1. Backend
cd backend
pip install -r requirements.txt        # groq, httpx, python-dotenv already listed
uvicorn app.main:app --reload --port 8000

# 2. Frontend (either)
#    a) served by the backend:  http://localhost:8000
#    b) Live Server: backend CORS already allows it; GLB uses absolute API URL

# 3. Optional: pin the Groq model in .env
#    GROQ_MODEL=openai/gpt-oss-120b
```

**Sanity checks in the browser console:**
- `[DAM GLB] loaded successfully: /assets/dam_structure.glb`
- `[DAM GLB] meshes: 11 | native bbox … | animations: 0`
- `[DAM GLB] placed: { scale, position, worldSize }`
- AI panel shows `✅ AI Copilot ready (model: openai/gpt-oss-120b)`
- Green wireframe around the dam = debug `Box3Helper` (toggle: `viewer3D.toggleDamDebugHelper(false)`)

**Notes**
- Old simulation IDs (e.g. `9063f45970a5`) remain unresolvable — they predate the cache fix and the in-memory store resets on backend restart. Run a fresh simulation.
- Recommended cleanup: delete the empty `GROQ_API_KEY=` / `OPENTOPOGRAPHY_API_KEY=` entries from Windows user environment variables (harmless now, but redundant).
- `.env` is git-ignored — never commit real keys.

---

## 11. Asset Pipeline Restructure — GLB Dam Removed, Standard `public/assets` Pipeline (later on Sep 13, 2026)

> **Supersedes Fix 6 and the `[DAM GLB]` console markers above** — the shipped GLB was removed
> by request; a new model will be dropped in later via a one-line config switch.

### What changed

**Removal (scene untouched)**
- Deleted `loadRealDamMesh`, `positionAndScaleDamMesh`, `_updateDamDebugHelper` and the
  `GLTFLoader` import from `three_viewer.js`; removed both `app.js` call sites and the
  `frontend/assets/` directory (`dam.mtl/obj/stl` clutter removed too).
- The old `dam_structure.glb` is preserved (not deleted) at `public/assets/models/dam/dam_structure.glb`,
  git-ignored, ready to be replaced by the new model.

**New standard assets layout (served by the backend at `/public/assets`)**

```
public/assets/
├── models/dam/       <- drop the new dam model here (+ README with instructions)
├── models/river/     <- reserved for river meshes / flood animation clips (+ README)
├── textures/         <- shared textures
└── env/              <- HDRI / environment maps
```

- `backend/app/main.py`: legacy `/assets` mount removed → new `/public/assets` mount
  (`main.py` is the only backend file touched).
- `.gitignore`: `public/assets/models/**` ignored (large binaries), READMEs still tracked.

**Central asset configuration — the one-line model switch**
- **New `frontend/config/assets.js`**: `ASSETS_BASE`, `DAM_MODEL` (`filename`, `dir`,
  `autoLoad`, `transform { rotationYDeg, scale, yOffset }`), `resolveAssetURL()`, `damModelURL()`.
- To activate a new model: copy the file into `public/assets/models/dam/` and set
  `filename: "<file>"` — no other code changes anywhere.

**Modular asset pipeline**
- **New `frontend/dam_model.js`** → `createDamModelPipeline(viewer)`: fetch (multi-candidate
  URLs), Blender Z-up auto-orient, center-to-bottom, material hardening, fit-to-crest scaling,
  terrain placement, green debug `Box3Helper` (opt-in, off by default now), animation-clip
  playback hook, full disposal. The viewer delegates via thin wrappers that still exist:
  `viewer3D.loadDamModel()`, `viewer3D.repositionDamModel()`, `viewer3D.toggleDamDebugHelper()`.
- Until a filename is configured, the procedural fallback dam box renders — scene stays intact.

**Failure-mode animation foundation (prepared, not auto-started)**
- **New `frontend/failure_mode_animations.js`** → `FAILURE_ANIMATION_PRESETS` (one preset per
  mode: overtopping / piping / structural / earthquake — river speed, turbulence, water tint,
  crest-overflow, piping jet, camera shake, surge intensity, phase profile) and
  `FloodFailureAnimator` (self-contained actor group: river streamers, crest overflow sheets,
  piping jet, decaying camera shake; `start(mode)`, `stop()`, `setPhase(0..1)`, `update(dt)`).
- Viewer wiring (no UI change): `viewer3D.startFailureModeAnimation("overtopping")`,
  `stopFailureModeAnimation()`, `setFailureModePhase(p)`; the animator ticks inside the
  existing `animate()` loop and `destroy()` cleans everything up.
- `setExaggeration()` and `loadSimulation()` re-place an already-loaded model via
  `repositionDamModel()` instead of the old inline code.

### Files
| Change | File |
|---|---|
| Removed GLB code | `frontend/three_viewer.js`, `frontend/app.js` |
| New | `frontend/config/assets.js`, `frontend/dam_model.js`, `frontend/failure_mode_animations.js` |
| New (assets) | `public/assets/models/{dam,river}/README.md`, `textures/`, `env/` |
| Mount swap | `backend/app/main.py` (`/assets` → `/public/assets`) |
| Tests rewritten | `backend/tests/test_assets.py` (mount alive, config↔file parity, legacy 404) |
| Moved (preserved) | `frontend/assets/dam_structure.glb` → `public/assets/models/dam/dam_structure.glb` |
| Deleted | `frontend/assets/dam/` (obj/mtl/stl), `scripts/inspect_glb.py` |

### Verification
- ✅ 32/32 backend tests pass (asset tests rewritten for the new pipeline)
- ✅ ES-module syntax checks pass on all 5 frontend modules
- ✅ No stale references to the old GLB implementation anywhere

### To activate the new dam model later
1. Copy it to `public/assets/models/dam/`
2. In `frontend/config/assets.js` set `DAM_MODEL.filename: "<your-file>.glb"` (and `autoLoad: true`)
3. Restart the backend → auto-oriented, centered, scaled to crest height, placed at the dam column
