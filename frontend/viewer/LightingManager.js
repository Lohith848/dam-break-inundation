/**
 * viewer/LightingManager.js
 * =============================================================================
 * Standard Engineering Lighting Rig.
 * Sets up HemisphereLight, DirectionalLight, and AmbientLight.
 * =============================================================================
 */

import * as THREE from "three";

export class LightingManager {
  constructor(scene) {
    this.scene = scene;

    // 1. Hemisphere Light (Soft atmospheric daylight sky + dark ground)
    this.hemiLight = new THREE.HemisphereLight(0xd8e8f8, 0x1a222d, 0.50);
    this.hemiLight.position.set(0, 100, 0);
    this.scene.add(this.hemiLight);

    // 2. Directional Sunlight (Sun casting soft shadows)
    this.dirLight = new THREE.DirectionalLight(0xfff6ea, 0.90);
    this.dirLight.position.set(70, 120, 60);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(2048, 2048);
    this.dirLight.shadow.camera.near = 10;
    this.dirLight.shadow.camera.far = 500;
    this.dirLight.shadow.camera.left = -150;
    this.dirLight.shadow.camera.right = 150;
    this.dirLight.shadow.camera.top = 150;
    this.dirLight.shadow.camera.bottom = -150;
    this.dirLight.shadow.bias = -0.0003;
    this.scene.add(this.dirLight);

    // 3. Ambient Light (Even neutral fill)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(this.ambientLight);
  }

  setIntensity(factor = 1.0) {
    this.hemiLight.intensity = 0.50 * factor;
    this.dirLight.intensity = 0.90 * factor;
    this.ambientLight.intensity = 0.25 * factor;
  }

  adjustToSceneBounds(bounds) {
    if (!bounds) return;
    const size = Math.max(bounds.size.x, bounds.size.z, bounds.size.y) || 100;
    const cx = bounds.center.x, cy = bounds.center.y, cz = bounds.center.z;
    const span = size * 0.75;

    // Reposition sunlight to illuminate digital twin from upper quarter
    this.dirLight.position.set(cx + size * 0.8, cy + size * 1.1, cz + size * 0.7);
    this.dirLight.target.position.set(cx, cy, cz);
    if (!this.dirLight.target.parent) {
      this.scene.add(this.dirLight.target);
    }

    // Adapt shadow camera frustum precisely to model extents (no clipping, tight shadow maps)
    this.dirLight.shadow.camera.left = -span;
    this.dirLight.shadow.camera.right = span;
    this.dirLight.shadow.camera.top = span;
    this.dirLight.shadow.camera.bottom = -span;
    this.dirLight.shadow.camera.near = 5;
    this.dirLight.shadow.camera.far = size * 3.5;
    this.dirLight.shadow.bias = -0.0004;
    this.dirLight.shadow.camera.updateProjectionMatrix();
  }

  applyMetadataLighting(cfg) {
    if (!cfg) return;
    if (typeof cfg.ambient_intensity === "number") {
      this.ambientLight.intensity = cfg.ambient_intensity;
    }
    if (typeof cfg.sun_intensity === "number") {
      this.dirLight.intensity = cfg.sun_intensity;
    }
    if (cfg.sun_position) {
      this.dirLight.position.set(cfg.sun_position.x, cfg.sun_position.y, cfg.sun_position.z);
    }
    if (typeof cfg.shadow_bias === "number") {
      this.dirLight.shadow.bias = cfg.shadow_bias;
    }
  }

  dispose() {
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.dirLight);
    if (this.dirLight.target && this.dirLight.target.parent) {
      this.scene.remove(this.dirLight.target);
    }
    this.scene.remove(this.ambientLight);
  }
}
