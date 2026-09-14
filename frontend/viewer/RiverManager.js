/**
 * viewer/RiverManager.js
 * =============================================================================
 * Owns the river asset: registration and terrain-relative alignment.
 * Mirrors DamManager. Buildings/vegetation are registered directly by the
 * AssetLoader into the scene (they carry no camera/simulation semantics yet).
 * =============================================================================
 */

import * as THREE from "three";

export class RiverManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ViewerState.js').ViewerState} viewerState
   */
  constructor(scene, viewerState) {
    this.scene = scene;
    this.state = viewerState;
    this.river = null;
  }

  /** Called by AssetLoader after the river model is normalized & added. */
  register(riverObject) {
    this._disposeCurrent();
    this.river = riverObject;
    return this.river;
  }

  hasRiver() {
    return Boolean(this.river);
  }

  _disposeCurrent() {
    if (!this.river) return;
    this.scene.remove(this.river);
    this.river.traverse?.((child) => {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.river = null;
  }

  dispose() {
    this._disposeCurrent();
  }
}
