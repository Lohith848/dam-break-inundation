/**
 * dam_model.js — Dam Model Asset Pipeline
 * =================================================================
 * Reusable loading + normalization pipeline for external dam models.
 *
 * Extracted from Flood3DViewer so the pipeline stays modular: the viewer
 * only owns the scene, this module owns everything about asset files
 * (fetching, orienting, centering, scaling, positioning, debugging).
 *
 * Public API:
 *   const pipeline = createDamModelPipeline(viewer);
 *   await pipeline.load(urlOrConfig, damGeometry);  // fetch + place
 *   pipeline.place(damGeometry);                    // re-place (e.g. new sim)
 *   pipeline.clear();                               // remove from scene
 *   pipeline.setDebugHelper(boolean);               // green bbox wireframe
 *   pipeline.isLoaded / pipeline.root
 * =================================================================
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Shared loader instance — reuses caches across loads.
const _gltfLoader = new GLTFLoader();

/**
 * @param {import("../three_viewer.js").Flood3DViewer} viewer  host viewer
 *        (must expose .scene, .data, ._nx, ._ny, .cellSize, .exaggeration)
 */
export function createDamModelPipeline(viewer) {
  let root = null;          // wrapper Group added to the scene
  let rawSize = null;       // THREE.Vector3, model size after orientation
  let rawClips = [];        // THREE.AnimationClip[] (future failure animations)
  let rawMixer = null;      // THREE.AnimationMixer
  let debugHelper = null;
  let debugEnabled = false;

  // ---------------------------------------------------------------
  // URL resolution: try the exact URL first, then the same path
  // relative to the document (works under Live Server / file://).
  function candidateURLs(url) {
    const list = [url];
    try {
      const u = new URL(url, window.location.href);
      const rel = `${u.pathname}${u.search}`;
      if (!list.includes(rel)) list.push(rel);
      const fname = rel.split("/").pop();
      if (fname && !list.includes(fname)) list.push(fname);
    } catch { /* ignore malformed URLs */ }
    return list;
  }

  async function fetchGLTF(url) {
    let lastError = null;
    for (const candidate of candidateURLs(url)) {
      try {
        const gltf = await _gltfLoader.loadAsync(candidate);
        if (gltf && gltf.scene) {
          console.info(`[DAM MODEL] loaded: ${candidate}`);
          return gltf;
        }
      } catch (err) {
        lastError = err;
        console.info(`[DAM MODEL] not at "${candidate}" (${err?.message || err})`);
      }
    }
    throw lastError || new Error(`DAM MODEL: could not load ${url}`);
  }

  // ---------------------------------------------------------------
  // Orientation: Blender exports are Z-up, three.js is Y-up. Detect a
  // flat up-axis and rotate -90° X, then re-measure.
  function orient(sceneRoot) {
    sceneRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(sceneRoot);
    const size = box.getSize(new THREE.Vector3());
    const maxExtent = Math.max(size.x, size.y, size.z);
    if (size.y < 0.35 * maxExtent) {
      sceneRoot.rotation.x = -Math.PI / 2;
      sceneRoot.updateMatrixWorld(true);
      console.info("[DAM MODEL] auto-rotated -90° X (Blender Z-up export detected).");
    }
  }

  // ---------------------------------------------------------------
  // Center to bottom-center origin so scaling/positioning is trivial.
  function center(sceneRoot) {
    const box = new THREE.Box3().setFromObject(sceneRoot);
    const centerV = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    sceneRoot.position.sub(centerV);
    sceneRoot.position.y += size.y / 2;
    sceneRoot.updateMatrixWorld(true);
    return size;
  }

  // ---------------------------------------------------------------
  // Material hardening: many exports ship without materials (renders
  // black without an env map) or with flipped windings.
  function fixMaterials(sceneRoot) {
    sceneRoot.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = false; // never hide it via stale bounds
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const fixed = mats.map((m) => {
        const mat = (m && m.isMaterial) ? m.clone() : new THREE.MeshStandardMaterial();
        if (!mat.map) {
          mat.color = new THREE.Color(0x9aa0a6); // concrete grey
          mat.roughness = 0.85;
          mat.metalness = 0.05;
        }
        mat.side = THREE.DoubleSide;
        return mat;
      });
      child.material = Array.isArray(child.material) ? fixed : fixed[0];
    });
  }

  // ---------------------------------------------------------------
  function disposeRoot() {
    if (!root) return;
    viewer.scene.remove(root);
    root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m?.dispose?.());
      }
    });
    root = null;
    rawSize = null;
  }

  function disposeHelper() {
    if (debugHelper) {
      viewer.scene.remove(debugHelper);
      debugHelper.geometry?.dispose?.();
      debugHelper = null;
    }
  }

  function refreshHelper() {
    disposeHelper();
    if (!root || !debugEnabled) return;
    root.updateMatrixWorld(true);
    debugHelper = new THREE.Box3Helper(new THREE.Box3().setFromObject(root), 0x00ff88);
    debugHelper.name = "damDebugBox";
    viewer.scene.add(debugHelper);
  }

  // ---------------------------------------------------------------
  // Scene anchor: where the dam sits on the simulated terrain grid.
  function sceneAnchor(damGeometry) {
    const nx = viewer._nx || 1, ny = viewer._ny || 1;
    const colIndex = damGeometry?.dam_col_index ?? damGeometry?.col_index ?? Math.floor(nx / 4);
    const clampedCol = Math.max(0, Math.min(nx - 1, Math.round(colIndex)));
    const clampedRow = Math.max(0, Math.min(ny - 1, Math.floor(ny / 2)));
    // Raw (pre-sanitization) grid preferred — sanitization may replace values.
    const grid = viewer.data?._rawElevationGrid;
    const baseElev = (Array.isArray(grid) && Array.isArray(grid[clampedRow])
      ? Number(grid[clampedRow][clampedCol]) : NaN);
    return {
      x: (clampedCol - (nx - 1) / 2) * viewer.cellSize,
      y: (Number.isFinite(baseElev) ? baseElev : 0) * viewer.exaggeration,
    };
  }

  // ---------------------------------------------------------------
  // Scale + place on the terrain (crest height fit by default).
  function place(damGeometry, cfg = {}) {
    if (!root) return false;
    const t = { ...(cfg.transform || {}) };
    const anchor = sceneAnchor(damGeometry);

    // Scale: fixed override, else fit model height to the dam crest height.
    let scale;
    if (Number.isFinite(Number(t.scale)) && Number(t.scale) > 0) {
      scale = Number(t.scale);
    } else {
      const crestRaw = Number(damGeometry?.crest_height_m ?? damGeometry?.dam_height_m ?? 30);
      const crestHeight = Number.isFinite(crestRaw) && crestRaw > 0 ? crestRaw : 30;
      const targetHeight = Math.max(2, crestHeight * viewer.exaggeration);
      scale = targetHeight / Math.max(1e-3, rawSize ? rawSize.y : 1);
    }
    root.scale.setScalar(scale);

    root.rotation.y = (Number(t.rotationYDeg) || 0) * (Math.PI / 180);
    root.position.set(anchor.x, anchor.y + (Number(t.yOffset) || 0), 0);
    root.updateMatrixWorld(true);
    viewer._damWorldX = anchor.x;
    refreshHelper();

    if (rawSize) {
      console.info("[DAM MODEL] placed:", {
        scale: +scale.toFixed(4),
        position: root.position.toArray().map((v) => +v.toFixed(2)),
        worldSize: {
          x: +(rawSize.x * scale).toFixed(1),
          y: +(rawSize.y * scale).toFixed(1),
          z: +(rawSize.z * scale).toFixed(1),
        },
      });
    }
    return true;
  }

  // ---------------------------------------------------------------
  async function load(urlOrConfig, damGeometry) {
    const cfg = typeof urlOrConfig === "string"
      ? { filename: urlOrConfig, transform: {} }
      : (urlOrConfig || {});
    const url = cfg.filename || cfg.url;
    if (!url) return false;

    try {
      const gltf = await fetchGLTF(url);
      const sceneRoot = gltf.scene;

      orient(sceneRoot);
      rawSize = center(sceneRoot);
      fixMaterials(sceneRoot);

      let meshCount = 0;
      sceneRoot.traverse((o) => { if (o.isMesh) meshCount++; });
      console.info(`[DAM MODEL] meshes: ${meshCount} | native size:`,
        rawSize.toArray().map((v) => +v.toFixed(2)),
        "| animations:", (gltf.animations || []).length);

      disposeRoot();
      disposeHelper();

      root = new THREE.Group();
      root.name = "damModelRoot";
      root.add(sceneRoot);
      viewer.scene.add(root);

      // Animation clips (e.g. collapse/breach animations) — the future
      // failure-mode animation system can play them by name.
      rawClips = gltf.animations || [];
      rawMixer = rawClips.length ? new THREE.AnimationMixer(sceneRoot) : null;

      place(damGeometry, cfg);

      if (viewer.damFallbackGroup) viewer.damFallbackGroup.visible = false;
      return true;
    } catch (err) {
      console.error("[DAM MODEL] load failed:", err);
      if (viewer.damFallbackGroup) viewer.damFallbackGroup.visible = true;
      return false;
    }
  }

  return {
    load,
    place: (geom, cfg) => place(geom, cfg),
    clear: () => { disposeHelper(); disposeRoot(); },
    setDebugHelper(v) {
      debugEnabled = !!v;
      refreshHelper();
      return debugEnabled;
    },
    playClip(name, { loop = false } = {}) {
      if (!rawMixer || !rawClips.length) return false;
      const clip = THREE.AnimationClip.findByName(rawClips, name);
      if (!clip) return false;
      rawMixer.stopAllAction();
      const action = rawMixer.clipAction(clip);
      action.reset();
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !loop;
      action.play();
      return true;
    },
    update(dt) { if (rawMixer) rawMixer.update(dt); },
    dispose() { disposeHelper(); disposeRoot(); rawMixer = null; rawClips = []; },
    get isLoaded() { return !!root; },
    get root() { return root; },
    get clips() { return rawClips; },
  };
}
