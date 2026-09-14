/**
 * viewer/SceneManager.js
 * =============================================================================
 * Core Scene, WebGLRenderer, and Render Loop Lifecycle.
 * Maintains an empty infinite 3D environment with Grid and Axes helpers.
 * =============================================================================
 */

import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

export class SceneManager {
  constructor(container) {
    if (!container) throw new Error("SceneManager requires a valid container DOM element.");
    this.container = container;

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth);
    const height = Math.max(1, rect.height || window.innerHeight);

    // 1. Three.js Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14); // Deep infinite dark space
    this.scene.fog = new THREE.FogExp2(0x0b0e14, 0.0012); // Subtle atmospheric depth fog

    // 2. WebGLRenderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.75;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    // 3. CSS2DRenderer for potential HUD overlays
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(width, height);
    Object.assign(this.labelRenderer.domElement.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
    });
    this.container.style.position = this.container.style.position || "relative";
    this.container.appendChild(this.labelRenderer.domElement);

    // 4. Infinite Helpers: GridHelper & AxesHelper
    this.gridHelper = new THREE.GridHelper(300, 60, 0x364559, 0x18202c);
    this.gridHelper.position.y = 0;
    this.scene.add(this.gridHelper);

    this.axesHelper = new THREE.AxesHelper(20);
    this.axesHelper.renderOrder = 1;
    this.scene.add(this.axesHelper);

    // Render loop callbacks
    this._onUpdateCallbacks = [];
    this._isRunning = false;
    this._rafId = null;

    // Window resize observer
    this._resizeObserver = new ResizeObserver(() => this.handleResize());
    this._resizeObserver.observe(this.container);

    this._renderLoop = this._renderLoop.bind(this);
  }

  addUpdateCallback(fn) {
    if (typeof fn === "function") this._onUpdateCallbacks.push(fn);
  }

  removeUpdateCallback(fn) {
    this._onUpdateCallbacks = this._onUpdateCallbacks.filter((f) => f !== fn);
  }

  start(camera) {
    this._activeCamera = camera;
    if (!this._isRunning) {
      this._isRunning = true;
      this._lastTimestamp = performance.now();
      this._rafId = requestAnimationFrame(this._renderLoop);
    }
  }

  stop() {
    this._isRunning = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _renderLoop(timestamp) {
    if (!this._isRunning) return;
    const delta = Math.min((timestamp - (this._lastTimestamp || timestamp)) / 1000, 0.1);
    this._lastTimestamp = timestamp;

    for (let i = 0; i < this._onUpdateCallbacks.length; i++) {
      try {
        this._onUpdateCallbacks[i](delta, timestamp);
      } catch (err) {
        console.error("SceneManager render loop error:", err);
      }
    }

    if (this._activeCamera) {
      this.renderer.render(this.scene, this._activeCamera);
      this.labelRenderer.render(this.scene, this._activeCamera);
    }

    this._rafId = requestAnimationFrame(this._renderLoop);
  }

  handleResize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);

    if (this._activeCamera && this._activeCamera.isPerspectiveCamera) {
      this._activeCamera.aspect = width / height;
      this._activeCamera.updateProjectionMatrix();
    }
  }

  /** Cleanly dispose a node and all child geometries/materials/textures */
  disposeHierarchy(root) {
    if (!root) return;
    root.traverse((node) => {
      if (node.isMesh) {
        node.geometry?.dispose?.();
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => {
          if (!m) return;
          m.map?.dispose?.();
          m.normalMap?.dispose?.();
          m.roughnessMap?.dispose?.();
          m.metalnessMap?.dispose?.();
          m.dispose?.();
        });
      }
    });
  }

  dispose() {
    this.stop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.gridHelper?.geometry.dispose();
    this.axesHelper?.geometry.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    if (this.labelRenderer.domElement.parentNode) {
      this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement);
    }
  }
}
