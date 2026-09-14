/**
 * viewer/AssetLoader.js
 * =============================================================================
 * Digital-twin asset pipeline.
 *
 * Flow: GET /api/assets/config -> category dispatch -> loader -> normalize
 *       (auto-center on origin, ground-align, compute bounds) -> register in
 *       ViewerState -> camera framing data ready.
 *
 * Supported formats: GLB, GLTF, OBJ, FBX, GeoTIFF (stub), DEM (stub).
 * No hardcoded filenames: discovery comes from the backend endpoint, with an
 * optional public/assets/config.json used to pin exact files per category.
 * =============================================================================
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

// ---------------------------------------------------------------------------
// Category -> pipeline stage
// ---------------------------------------------------------------------------
const CATEGORY_KEYS = ["master", "terrain", "dam", "river", "buildings", "vegetation"];

const CATEGORY_STAGE = {
  master: "master",
  terrain: "terrain",
  dam: "dam",
  river: "river",
  buildings: "buildings",
  vegetation: "vegetation",
};

export class AssetLoader {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ViewerState.js').ViewerState} viewerState
   * @param {{apiBase?: string}} [options]
   */
  constructor(scene, viewerState, options = {}) {
    this.scene = scene;
    this.state = viewerState;
    this.apiBase = options.apiBase || "";

    this.loadedAssets = {
      master: null, terrain: null, dam: null, river: null, buildings: null, vegetation: null,
    };

    // Loader registry
    this._draco = new DRACOLoader();
    this._draco.setDecoderPath("/assets/draco/gltf/");
    this._gltf = new GLTFLoader();
    this._gltf.setDRACOLoader(this._draco);
    this._obj = new OBJLoader();
    this._fbx = new FBXLoader();

    this._managers = {}; // stage -> manager (Terrain/Dam/Camera/Lighting set by facade)
  }

  /** Attach downstream managers that receive the normalized assets. */
  setManagers({ terrainManager, damManager, riverManager, cameraManager, lightingManager } = {}) {
    this._managers = { terrainManager, damManager, riverManager, cameraManager, lightingManager };
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------
  async autoLoadFromServer() {
    let manifest = null;
    try {
      const res = await fetch(`${this.apiBase}/api/assets/config`);
      if (res.ok) manifest = await res.json();
    } catch {
      /* offline / backend down — fall through to local config */
    }

    const assets = manifest?.assets || null;
    if (!assets) return this._summary("manifest-unavailable");

    // Store scene metadata if provided
    if (manifest.metadata) {
      this.state.set("sceneMetadata", manifest.metadata);
    }

    // Master digital-twin GLB takes precedence when present
    if (assets.master?.url) {
      try {
        const masterObj = await this.loadMasterScene(assets.master.url, manifest.metadata);
        if (masterObj) {
          return this._summary("master-scene");
        }
      } catch (err) {
        console.warn("AssetLoader: master scene load failed, falling back to modular categories:", err?.message || err);
      }
    }

    // Fallback: modular category loading (terrain first, then others)
    const order = ["terrain", "dam", "river", "buildings", "vegetation"];
    for (const key of order) {
      const entry = assets[key];
      if (entry?.url) {
        try {
          await this.loadCategory(entry);
        } catch (err) {
          console.warn(`AssetLoader: failed to load ${key} (${entry.url}):`, err?.message || err);
        }
      }
    }
    return this._summary("manifest");
  }

  /** Load a single discovered asset entry {category, url, format}. */
  async loadCategory(entry) {
    const category = CATEGORY_STAGE[entry.category] || entry.category;
    switch (category) {
      case "master":   return this.loadMasterScene(entry.url);
      case "terrain":  return this.loadTerrain(entry.url, entry.format);
      case "dam":      return this.loadDam(entry.url, entry.format);
      case "river":    return this.loadRiver(entry.url, entry.format);
      case "buildings":return this.loadBuildings(entry.url, entry.format);
      case "vegetation":return this.loadVegetation(entry.url, entry.format);
      default:
        console.warn(`AssetLoader: unknown category "${entry.category}"`);
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------
  async loadMasterScene(url, metadata = null) {
    const object = await this._loadByFormat(url, "glb");
    if (!object) return null;

    // Center on origin (x, z) and align base to y=0 (ground alignment)
    this._normalize(object, { align: "center-ground" });

    // Compute bounding box and bounding sphere without manual offsets
    const bounds = this._computeBounds(object);
    if (!bounds) return null;

    // Shadow casting/receiving, frustum culling, and material optimization
    object.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        child.frustumCulled = true;

        if (child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach((mat) => {
            if (mat) {
              mat.roughness = Math.min(Math.max(mat.roughness ?? 0.7, 0.4), 0.95);
              mat.metalness = Math.min(mat.metalness ?? 0.1, 0.3);
              mat.depthWrite = true;
              mat.needsUpdate = true;
            }
          });
        }
      }
    });

    this.state.set("terrainBounds", bounds);
    this.state.set("masterBounds", bounds);
    if (metadata) {
      this.state.set("sceneMetadata", metadata);
    }

    const group = this._register("master", object, url);
    // Also register under terrain slot so downstream queries treat master scene as primary ground
    this.loadedAssets["terrain"] = group;

    this._managers.terrainManager?.register(group, bounds);
    this._managers.cameraManager?.applyTerrainConstraints(bounds);
    this._managers.cameraManager?.fitObject(group);
    this._managers.lightingManager?.adjustToSceneBounds(bounds);
    if (metadata?.default_lighting) {
      this._managers.lightingManager?.applyMetadataLighting(metadata.default_lighting);
    }

    return group;
  }

  async loadTerrain(url, format) {
    const object = await this._loadByFormat(url, format);
    if (!object) return null;
    this._normalize(object, { align: "center-ground" });

    // Terrain defines the world bounds everything else aligns to.
    const bounds = this._computeBounds(object);
    this.state.set("terrainBounds", bounds);

    const group = this._register("terrain", object, url);
    this._managers.terrainManager?.register(group, bounds);
    return group;
  }

  async loadDam(url, format) {
    const object = await this._loadByFormat(url, format);
    if (!object) return null;
    // Dam aligns to terrain origin (center of terrain footprint).
    this._normalize(object, { align: "center-ground" });
    const group = this._register("dam", object, url);
    this._managers.damManager?.register(group);
    return group;
  }

  async loadRiver(url, format) {
    const object = await _loadByFormatShared(this, url, format);
    if (!object) return null;
    this._normalize(object, { align: "center-ground" });
    const group = this._register("river", object, url);
    this._managers.riverManager?.register(group);
    return group;
  }

  async loadBuildings(url, format) {
    const object = await _loadByFormatShared(this, url, format);
    if (!object) return null;
    this._normalize(object, { align: "center-ground" });
    return this._register("buildings", object, url);
  }

  async loadVegetation(url, format) {
    const object = await _loadByFormatShared(this, url, this._inferFormat(url, format));
    if (!object) return null;
    this._normalize(object, { align: "center-ground" });
    return this._register("vegetation", object, url);
  }

  // -------------------------------------------------------------------------
  // Normalization & bounds
  // -------------------------------------------------------------------------
  _normalize(object, { align = "center-ground" } = {}) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return object;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    object.position.x -= center.x;
    object.position.z -= center.z;
    if (align === "center-ground") {
      object.position.y -= box.min.y; // ground-align: minY -> y=0
    }
    object.updateMatrixWorld(true);
    return object;
  }

  _computeBounds(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
      size: { x: size.x, y: size.y, z: size.z },
      center: { x: center.x, y: center.y, z: center.z },
      radius: sphere.radius,
    };
  }

  _register(stage, object, url) {
    this._disposeStage(stage);
    this.scene.add(object);
    this.loadedAssets[stage] = object;
    const bounds = this._computeBounds(object);
    const loaded = { ...this.state.get("loadedAssets"), [stage]: url };
    this.state.set("loadedAssets", loaded);
    return object;
  }

  _disposeStage(stage) {
    const prev = this.loadedAssets[stage];
    if (!prev) return;
    this.scene.remove(prev);
    prev.traverse?.((child) => {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.loadedAssets[stage] = null;
  }

  // -------------------------------------------------------------------------
  // Format dispatch
  // -------------------------------------------------------------------------
  _loadByFormat(url, format) {
    const fmt = (format || this._inferFormat(url)).toLowerCase();
    switch (fmt) {
      case "glb":
      case "gltf":
        return this._loadGLTF(url);
      case "obj":
        return this._loadOBJ(url);
      case "fbx":
        return this._loadFBX(url);
      case "geotiff":
      case "dem":
        // GeoTIFF/DEM → mesh pipeline is a future stage; skip gracefully.
        console.info(`AssetLoader: ${fmt.toUpperCase()} raster pipeline not wired yet — skipped ${url}`);
        return Promise.resolve(null);
      default:
        console.warn(`AssetLoader: unsupported format "${fmt}" for ${url}`);
        return Promise.resolve(null);
    }
  }

  _inferFormat(url) {
    const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(url || "");
    return m ? m[1].toLowerCase() : "";
  }

  _promise(loader, url) {
    return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
  }

  async _loadGLTF(url) {
    const gltf = await this._promise(this._gltf, url);
    return gltf.scene || gltf.scenes?.[0] || null;
  }

  _loadOBJ(url) {
    return this._promise(this._obj, url);
  }

  _loadFBX(url) {
    return this._promise(this._fbx, url);
  }

  _summary(source) {
    return {
      source,
      loaded: Object.fromEntries(Object.entries(this.loadedAssets).map(([k, v]) => [k, Boolean(v)])),
      bounds: this.state.get("terrainBounds"),
    };
  }

  dispose() {
    for (const stage of Object.keys(this.loadedAssets)) this._disposeStage(stage);
    this._draco.dispose?.();
  }
}

// Shared dispatch used by secondary categories (kept module-private).
function _loadByFormatShared(loader, url, format) {
  return loader._loadByFormat(url, format);
}
