# Free Asset Sources — for the "populate empty areas" requirement

I can't hand-model a village's worth of houses, bridges, and forests in a code sandbox — but you don't need custom-modeled assets for any of this. These are real, verified, genuinely free (CC0 = public domain, no attribution required, commercial use fine) libraries used throughout the game-dev and archviz industry. Verified via web search on 2026-09-13, not from memory:

## Kenney.nl
**Confirmed CC0** — "all game assets on the asset pages are public domain licensed (CC0). You're free to use them, even in commercial projects." Thousands of ready-made low-poly packs, several directly relevant:
- Search their asset library for city/road/nature-themed packs — low-poly buildings, roads, bridges, fences, and vegetation kits are exactly the "fill empty space" pieces this project needs, pre-optimized for real-time use.
- Direct `.glb`/`.gltf` or `.obj` downloads, ready to load with the same `GLTFLoader` pipeline already in `three_viewer.js`.

## Poly Haven (polyhaven.com)
**Confirmed CC0**, no login required. Three catalogs, all useful here:
- **HDRIs** — hundreds of real environment lighting maps (mountains, fields, desert, coast). This is the *actual* HDR environment lighting option beyond the procedural `RoomEnvironment` I wired into v5 — swap in a real Poly Haven HDRI via `RGBELoader` + `PMREMGenerator` for a specific real-world lighting look (e.g. a mountain-valley HDRI for your dam scene).
- **Textures** — free 8K+ PBR material sets (rock, ground, concrete, wood) to texture your terrain/dam instead of flat vertex colors, if you want that extra fidelity.
- **Models** — includes real photoscanned rocks and desert vegetation (their Namaqualand collection specifically), useful for scattering realistic rock/plant detail around the valley instead of only my procedural cone-trees.

## Sketchfab (sketchfab.com)
Filter search results by license = "CC0" or "Downloadable." Good source for one-off specific models (a bridge, a specific house style, a pylon) when Kenney/Poly Haven don't have exactly what you need — just double-check the license badge on each individual model page before use, since Sketchfab hosts many licenses, not only CC0.

## Integration workflow
1. Download the `.glb`/`.gltf` (or `.blend`, export via Blender if needed — same pipeline as `docs/BLENDER_TO_WEB.md`).
2. Run it through `gltf-transform draco input.glb output.glb` (verified working, see the conversation — 8x size reduction, all materials/meshes intact). **Do not use the `optimize` preset** on low-poly multi-material assets like these — its default `simplify`/`join` steps are tuned for high-poly single-material scans and will silently merge/destroy distinct parts, exactly as it did to your dam model when I first tried it.
3. Load via `GLTFLoader` and scatter with `THREE.InstancedMesh` (same pattern as `buildVegetation()` in `three_viewer.js`) for anything repeated (trees, houses, fence posts) — this is what actually keeps frame rate smooth with many instances, real GPU instancing, not a trick.

## What I built procedurally instead (no download needed)
Trees, sky, foam, mist, and debris in `three_viewer.js` are simple primitive geometry (cones, cylinders, Points) — genuinely fine for "fill the empty space" at the counts used (100-150 instances), and zero licensing/download friction. Use the sources above when you want higher visual fidelity than primitives allow (actual house/bridge/rock models), not as a requirement to make the scene functional.
