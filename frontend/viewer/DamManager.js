/**
 * viewer/DamManager.js
 * =============================================================================
 * Owns the dam asset: registration and terrain-relative alignment.
 * The dam is placed at the upstream reference of the twin (terrain origin)
 * and can be nudged via configure(). River/Buildings managers follow the
 * same pattern and align relative to the terrain origin.
 * =============================================================================
 */

import * as THREE from "three";

export class DamManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ViewerState.js').ViewerState} viewerState
   */
  constructor(scene, viewerState) {
    this.scene = scene;
    this.state = viewerState;
    this.dam = null;

    // Fine-tuning knobs for the placed dam (no code changes needed to retune).
    this.config = {
      position: { x: 0, y: 0, z: 0 },
      rotationYDeg: 0,
      scale: 1,
    };
  }

  /** Called by AssetLoader after the dam model is normalized & added. */
  register(damObject) {
    this._disposeCurrent();
    this.dam = damObject;
    this._applyConfig();
    return this.dam;
  }

  /** Update placement without reloading the asset. */
  configure({ position, rotationYDeg, scale } = {}) {
    if (position) this.config.position = { ...this.config.position, ...position };
    if (rotationYDeg !== undefined) this.config.rotationYDeg = rotationYDeg;
    if (scale !== undefined) this.config.scale = scale;
    this._applyConfig();
  }

  _applyConfig() {
    if (!this.dam) return;
    this.dam.position.set(this.config.position.x, this.config.position.y, this.config.position.z);
    this.dam.rotation.y = THREE.MathUtils.degToRad(this.config.rotationYDeg);
    this.dam.scale.setScalar(this.config.scale);
  }

  /** World-space bounds of the dam (used by the "Dam" camera preset). */
  getBounds() {
    if (!this.dam) return null;
    const box = new THREE.Box3().setFromObject(this.dam);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
      size: { x: size.x, y: size.y, z: size.z },
      center: { x: center.x, y: center.y, z: center.z },
    };
  }

  hasDam() {
    return Boolean(this.dam);
  }

  _disposeCurrent() {
    if (!this.dam) return;
    this.scene.remove(this.dam);
    this.dam.traverse?.((child) => {
      child.geometry?.dispose?.();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    });
    this.dam = null;
  }

  dispose() {
    this._disposeCurrent();
  }
}
