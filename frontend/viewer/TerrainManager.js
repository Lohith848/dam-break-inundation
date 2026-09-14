/**
 * viewer/TerrainManager.js
 * =============================================================================
 * Owns the terrain asset in the digital twin: registration, world bounds,
 * framing data for the camera, and empty-scene helpers (grid/axes visibility).
 * =============================================================================
 */

import * as THREE from "three";

export class TerrainManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ViewerState.js').ViewerState} viewerState
   * @param {import('./CameraManager.js').CameraManager} cameraManager
   */
  constructor(scene, viewerState, cameraManager) {
    this.scene = scene;
    this.state = viewerState;
    this.cameraManager = cameraManager;

    this.terrain = null;
    this.bounds = null;
  }

  /**
   * Called by AssetLoader when a terrain asset has been normalized & added.
   * @param {THREE.Object3D} terrainObject
   * @callback optional onReady invoked after framing data is prepared
   */
  register(terrainObject) {
    this._disposeCurrent();
    this.terrain = terrainObject;
    this.bounds = this._computeBounds(terrainObject);

    this.state.set("terrainBounds", this.bounds);
    this.cameraManager.applyTerrainConstraints(this.bounds);

    // Real terrain arrived — hide the empty-scene helpers.
    this.setHelpersVisible(false);

    return this.bounds;
  }

  /** World-space bounding box helpers for the camera & simulation layers. */
  _computeBounds(object) {
    const box = new THREE.Box3().setByObject
      ? null
      : new THREE.Box3().setFromObject(object);

    const finalBox = box || new THREE.Box3().setFromObject(object);
    if (finalBox.isEmpty()) return null;

    const size = finalBox.getSize(new THREE.Vector3());
    const center = finalBox.getCenter(new THREE.Vector3());
    return {
      min: { x: finalBox.min.x, y: finalBox.min.y, z: finalBox.min.z },
      max: { x: finalBox.max.x, y: finalBox.max.y, z: finalBox.max.z },
      size: { x: size.x, y: size.y, z: size.z },
      center: { x: center.x, y: center.y, z: center.z },
    };
  }

  setHelpersVisible(visible) {
    if (this.gridHelper && this.gridHelper.parent) {
      this.gridHelper.visible = visible;
    }
    if (this.axesHelper && this.axesHelper.parent) {
      this.axesHelper.visible = visible;
    }
  }

  /** Attach empty-scene helpers (grid/axes) so TerrainManager can toggle them. */
  setHelpers(gridHelper, axesHelper) {
    this.gridHelper = gridHelper;
    this.axesHelper = axesHelper;
  }

  /** Whether real terrain is present (drives empty-state UI). */
  hasTerrain() {
    return Boolean(this.terrain);
  }

  _disposeCurrent() {
    if (!this.terrain) return;
    this.scene.remove(this.terrain);
    this.terrain.traverse?.((child) => {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.terrain = null;
    this.bounds = null;
  }

  dispose() {
    this._disposeCurrent();
  }
}
