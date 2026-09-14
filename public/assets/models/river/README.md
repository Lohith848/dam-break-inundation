# River / Flood Animation Assets

Reserved for river channel meshes, flow-line geometry, and clip-based flood
animations (`.glb` with embedded `AnimationClip`s).

The runtime side is already wired: `frontend/failure_mode_animations.js`
holds per-mode presets for the four failure modes (overtopping, piping,
structural, earthquake) and `FloodFailureAnimator` renders river flow,
crest overflow, piping jets, and camera shake. Drop meshes here and wire
them into the animator by loading them the same way as the dam model
(add a `RIVER_MODEL` entry in `frontend/config/assets.js` when ready).
