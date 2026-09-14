/**
 * config/assets.js — Central Asset Configuration
 * =================================================================
 * SINGLE SOURCE OF TRUTH for every static asset the 3D viewer loads.
 *
 * Assets layout (served by the backend at `/public`):
 *
 *   public/assets/
 *   ├── models/
 *   │   ├── dam/            <-- drop your new dam model here
 *   │   └── river/          <-- future river meshes/animations
 *   ├── textures/           <-- shared textures (water, terrain, decals)
 *   └── env/                <-- HDRI / environment maps
 *
 * ---------------------------------------------------------------------------
 * HOW TO SWAP IN A NEW DAM MODEL — NO CODE CHANGES NEEDED:
 * ---------------------------------------------------------------------------
 *   1. Copy your model file into  public/assets/models/dam/
 *   2. Set  DAM_MODEL.filename  below to that exact file name.
 *
 * Example:  filename: "my_new_dam.glb"
 *
 * Any GLB / GLTF is supported (DRACO/KTX2 not wired yet). The loader
 * normalizes orientation (Blender Z-up), centers, fits and positions it on
 * the simulated terrain automatically.
 *
 * Set  filename: ""  (or null) to disable external model loading entirely —
 * the viewer then shows the procedural fallback dam box.
 * =================================================================
 */

// Root URL of the static assets tree, as mounted by the backend (main.py).
// `resolveAssetURL` turns relative paths into API-origin-absolute URLs so
// assets also load when the page is served by Live Server or file://.
export const ASSETS_BASE = "/public/assets";

// ---------------------------------------------------------------------------
// DAM MODEL — the ONLY line you edit to swap models.
// ---------------------------------------------------------------------------
export const DAM_MODEL = {
  // Exact file name inside `public/assets/dams/` (with extension).
  // Empty string = no external model; viewer scene remains empty.
  filename: "",

  // Sub-directory (inside ASSETS_BASE) where dam models live.
  dir: "dams",

  // Disabled until user imports models
  autoLoad: false,

  // Optional per-model tuning. `null` fields use the auto-detected defaults
  // (auto-orient, auto-center, fit-to-crest-height scaling).
  transform: {
    rotationYDeg: 0, // manual Y rotation in degrees if the export needs it
    scale: null,     // uniform scale override, e.g. 0.35
    yOffset: 0,      // vertical nudge in world units (applied after fit)
  },
};

/**
 * Resolve a relative asset path into an absolute URL against the API origin.
 * @param {string} relativePath e.g. "models/dam/dam.glb"
 * @param {string} [apiBase] API origin (defaults to window.location.origin)
 * @returns {string}
 */
export function resolveAssetURL(relativePath, apiBase) {
  const origin = apiBase || (typeof window !== "undefined" ? window.location.origin : "");
  const rel = String(relativePath || "").replace(/^\/+/, "");
  return `${origin}${ASSETS_BASE}/${rel}`.replace(/([^:])\/{2,}/g, "$1/");
}

/** Full URL of the configured dam model, or null when none is configured. */
export function damModelURL(apiBase) {
  const name = DAM_MODEL.filename && String(DAM_MODEL.filename).trim();
  if (!name) return null;
  return resolveAssetURL(`${DAM_MODEL.dir}/${name}`, apiBase);
}
