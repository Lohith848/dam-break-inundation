# Dam Models

Drop external dam model files here (`.glb` / `.gltf` supported).

## How to activate a model — one line, no code changes

1. Copy your model file into this folder, e.g. `my_dam.glb`.
2. Open `frontend/config/assets.js` and set:

   ```js
   export const DAM_MODEL = {
     filename: "my_dam.glb",   // <-- just this line
     dir: "models/dam",
     autoLoad: true,
     // ...
   };
   ```

3. Restart the backend (or hard-refresh the browser) — the model is fetched,
   auto-oriented (Blender Z-up detected), centered, scaled to the dam crest
   height, and positioned at the simulated dam column automatically.

## Notes

- `filename: ""` (current state) disables external loading; the procedural
  fallback dam box is shown instead.
- Optional tuning lives in `DAM_MODEL.transform` (`rotationYDeg`, `scale`,
  `yOffset`) in the same config file.
- Model files in this folder are git-ignored (large binaries) — only this
  README is tracked.
