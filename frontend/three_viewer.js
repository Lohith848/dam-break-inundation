/**
 * three_viewer.js — Flood3DViewer Facade (Digital Twin)
 * =============================================================================
 * Modular digital-twin viewer for dam-break inundation.
 * Coordinates SceneManager, CameraManager (constrained), LightingManager,
 * AssetLoader (auto-discovery), TerrainManager, DamManager, RiverManager,
 * AnimationManager, FloodAnimator interfaces, SimulationRenderer, UIController,
 * and the shared ViewerState.
 *
 * The camera exists to explain the simulation — not to inspect the underside
 * of the terrain. All orbiting is constrained; presets are animated (900ms).
 * =============================================================================
 */

import { SceneManager } from "./viewer/SceneManager.js";
import { CameraManager } from "./viewer/CameraManager.js";
import { AssetLoader } from "./viewer/AssetLoader.js";
import { LightingManager } from "./viewer/LightingManager.js";
import { AnimationManager } from "./viewer/AnimationManager.js";
import { SimulationRenderer } from "./viewer/SimulationRenderer.js";
import { UIController } from "./viewer/UIController.js";
import { ViewerState } from "./viewer/ViewerState.js";
import { TerrainManager } from "./viewer/TerrainManager.js";
import { DamManager } from "./viewer/DamManager.js";
import { RiverManager } from "./viewer/RiverManager.js";
import { FloodAnimator, WaterRenderer, ParticleRenderer, BreachAnimator } from "./viewer/FloodAnimator.js";

export class Flood3DViewer {
  constructor(container) {
    if (!container) throw new Error("Flood3DViewer requires a valid container element.");
    this.container = container;

    // 0. Shared observable state
    this.state = new ViewerState();

    // 1. Core Scene & WebGL Renderer (ACES filmic, sRGB, shadows)
    this.sceneManager = new SceneManager(container);
    this.scene = this.sceneManager.scene;
    this.renderer = this.sceneManager.renderer;

    // 2. Constrained Engineering Camera (never below terrain, ±25° orbit)
    this.cameraManager = new CameraManager(container, this.sceneManager.renderer.domElement, this.state);
    this.camera = this.cameraManager.camera;
    this.controls = this.cameraManager.controls;

    // 3. Lighting Rig (Hemisphere + Directional sun + Ambient fill)
    this.lightingManager = new LightingManager(this.scene);

    // 4. Asset ownership: terrain / dam / river
    this.terrainManager = new TerrainManager(this.scene, this.state, this.cameraManager);
    this.damManager = new DamManager(   this.scene, this.state);
    this.riverManager = new RiverManager(this.scene, this.state);

    // TerrainManager owns the empty-scene helpers (hidden when terrain loads)
    this.terrainManager.setHelpers(this.sceneManager.gridHelper, this.sceneManager.axesHelper);

    // 5. Timeline & Animation Controller
    this.animationManager = new AnimationManager();

    // 6. Simulation state controller (layer modes)
    this.simulationRenderer = new SimulationRenderer(this.scene, this.state);

    // 7. Digital-twin asset pipeline (auto-discovery via /api/assets/config)
    const apiBase = (typeof window !== "undefined" && window.__API_BASE__) || "";
    this.assetLoader = new AssetLoader(this.scene, this.state, { apiBase });
    this.assetLoader.setManagers({
      terrainManager: this.terrainManager,
      damManager: this.damManager,
      riverManager: this.riverManager,
      cameraManager: this.cameraManager,
      lightingManager: this.lightingManager,
    });

    // 8. Animation interfaces (future flood/water/particle/breach systems plug in here)
    this.floodAnimator = new FloodAnimator({
      viewerState: this.state,
      scene: this.scene,
      camera: this.camera,
      viewer: this,
    });
    this.waterRenderer = new WaterRenderer({ scene: this.scene });
    this.particleRenderer = new ParticleRenderer({ scene: this.scene });
    this.breachAnimator = new BreachAnimator({ scene: this.scene });

    // Internal frame listener dispatch
    this._externalOnFrameChange = null;
    this.animationManager.onFrameChange = (frameIndex, currentHour) => {
      this.simulationRenderer.updateFrame(frameIndex);
      this.floodAnimator.updateFrame(frameIndex, 0.016);
      if (typeof this._externalOnFrameChange === "function") {
        this._externalOnFrameChange(frameIndex, currentHour);
      }
    };

    // 9. Viewport UI (empty-scene placeholder & metrics drawer)
    this.uiController = new UIController(container);

    // ---- Render loop --------------------------------------------------------
    this.sceneManager.addUpdateCallback((delta, timestamp) => {
      this.cameraManager.update(delta, timestamp);
      this.animationManager.update(delta, timestamp);
    });

    this.sceneManager.start(this.camera);

    // ---- Boot the asset pipeline --------------------------------------------
    this.autoLoadAssets();
  }

  /**
   * Auto-discover and load assets from public/assets (backend manifest).
   * The scene starts as a clean engineering grid — no placeholder UI. When
   * the master model or terrain arrives it occupies the scene and the camera frames it.
   */
  async autoLoadAssets() {
    try {
      const summary = await this.assetLoader.autoLoadFromServer();
      if (summary.loaded?.master || summary.loaded?.terrain) {
        this.uiController.setTwinReady(true);
        // Frame the digital twin with the default engineering camera.
        this.cameraManager.setPreset("overview", 900);
      }
    } catch (err) {
      console.warn("Flood3DViewer: asset auto-load skipped:", err?.message || err);
    }
  }

  /** Unload existing scene meshes and reset viewer state for dam switching. */
  unloadScene() {
    this.pause();
    this.simulationRenderer.dispose();
    this.floodAnimator.dispose();
    this.assetLoader.dispose();
    this.uiController.setTwinReady(false);
  }

  /** Dynamically load a new dam model and metadata without page reload. */
  async loadNewScene(url, metadata = null) {
    this.unloadScene();
    const obj = await this.assetLoader.loadMasterScene(url, metadata);
    if (obj) {
      this.uiController.setTwinReady(true);
      this.cameraManager.setPreset("overview", 900);
    }
    return obj;
  }

  // --- Constrained Camera API ------------------------------------------------
  setCameraPreset(name, duration = 900) {
    this.cameraManager.setPreset(name, duration);
  }

  setCameraLocked(locked) {
    this.cameraManager.setLocked(locked);
    this.state.set("cameraLocked", Boolean(locked));
  }

  fitCameraToObject(obj) {
    this.cameraManager.fitObject(obj);
  }

  get playing() {
    return this.animationManager.playing;
  }

  play() {
    this.animationManager.play();
  }

  pause() {
    this.animationManager.pause();
  }

  step(delta = 1) {
    this.animationManager.step(delta);
  }

  setSpeed(multiplier) {
    this.animationManager.setSpeed(multiplier);
  }

  get onFrameChange() {
    return this._externalOnFrameChange;
  }

  set onFrameChange(fn) {
    this._externalOnFrameChange = fn;
  }

  // --- Simulation Ingestion --------------------------------------------------
  loadSimulation(data) {
    this.simulationRenderer.loadSimulation(data);
    this.animationManager.setSimulationData(data);
    this.floodAnimator.loadSimulation(data);
  }

  // --- Layer Visualization Modes (Water, Depth, Velocity) --------------------
  setColorMode(mode) {
    this.floodAnimator.setColorMode(mode);
    return this.simulationRenderer.setColorMode(mode);
  }

  getColorMode() {
    return this.simulationRenderer.getColorMode();
  }

  hasVelocityData() {
    return this.simulationRenderer.hasVelocityData();
  }

  setExaggeration(factor) {
    this.simulationRenderer.setExaggeration(factor);
  }

  toggleWireframe() {
    return this.simulationRenderer.toggleWireframe();
  }

  // --- Resizing & Lifecycle --------------------------------------------------
  onResize() {
    this.sceneManager.handleResize();
  }

  dispose() {
    this.sceneManager.dispose();
    this.cameraManager.dispose();
    this.lightingManager.dispose();
    this.assetLoader.dispose();
    this.terrainManager.dispose();
    this.damManager.dispose();
    this.riverManager.dispose();
    this.animationManager.dispose();
    this.simulationRenderer.dispose();
    this.floodAnimator.dispose();
    this.waterRenderer.dispose();
    this.particleRenderer.dispose();
    this.breachAnimator.dispose();
    this.state.dispose();
    this.uiController.dispose();
  }
}

// Named re-exports for modular consumer flexibility
export {
  SceneManager,
  CameraManager,
  AssetLoader,
  LightingManager,
  AnimationManager,
  SimulationRenderer,
  UIController,
  ViewerState,
  TerrainManager,
  DamManager,
  RiverManager,
  FloodAnimator,
  WaterRenderer,
  ParticleRenderer,
  BreachAnimator,
};
