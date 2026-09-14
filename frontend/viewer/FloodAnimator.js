/**
 * viewer/FloodAnimator.js
 * =============================================================================
 * FloodAnimator — coordinates failure mode animations and simulation timeline.
 * Integrates with FloodFailureAnimator for distinct visual behavior per mode:
 *   • overtopping: water flows over crest
 *   • piping: internal erosion starts first, then breach widens
 *   • structural: central wall collapse, sudden release
 *   • earthquake: seismic motion, crack instability, followed by breach
 * =============================================================================
 */

import { FloodFailureAnimator } from "../failure_mode_animations.js";

export class FloodAnimator {
  constructor({ viewerState, scene, camera, viewer } = {}) {
    this.viewerState = viewerState;
    this.scene = scene || null;
    this.camera = camera || null;
    this.viewer = viewer || null;
    this.terrain = null;
    this.bounds = null;
    this.data = null;
    this.frameIndex = 0;
    this.failureAnimator = null;
  }

  setViewer(viewer) {
    this.viewer = viewer;
    this.scene = viewer?.scene || this.scene;
    this.camera = viewer?.camera || this.camera;
  }

  attach(terrain, bounds) {
    this.terrain = terrain;
    this.bounds = bounds;
  }

  loadSimulation(data) {
    this.data = data;
    this.frameIndex = 0;

    if (!data) {
      this.failureAnimator?.stop();
      return;
    }

    // Initialize failure mode animation if scene/viewer is available
    const host = this.viewer || {
      scene: this.scene,
      camera: this.camera,
      _damWorldX: 0,
    };

    if (host.scene) {
      if (!this.failureAnimator) {
        this.failureAnimator = new FloodFailureAnimator(host);
      }
      const mode = data.failure_mode || "overtopping";
      this.failureAnimator.start(mode);
      this.failureAnimator.setPhase(0);
    }
  }

  updateFrame(frameIndex, dt = 0.016) {
    this.frameIndex = frameIndex;
    if (!this.data) return;

    const totalFrames = this.data.depth_grids?.length || 1;
    const progress = totalFrames > 1 ? (frameIndex / (totalFrames - 1)) : 0;

    if (this.failureAnimator && this.failureAnimator.isActive) {
      this.failureAnimator.setPhase(progress);
      this.failureAnimator.update(dt);
    }
  }

  setColorMode(mode) {
    return mode;
  }

  dispose() {
    if (this.failureAnimator) {
      this.failureAnimator.stop();
      this.failureAnimator = null;
    }
    this.data = null;
    this.terrain = null;
  }
}

/**
 * viewer/WaterRenderer — interface for the water surface render layer.
 */
export class WaterRenderer {
  constructor({ scene } = {}) {
    this.scene = scene;
    this.mesh = null;
  }

  build(bounds) {}

  updateFrame(frameIndex) {}

  dispose() {
    this.mesh?.geometry?.dispose?.();
    this.mesh = null;
  }
}

/**
 * viewer/ParticleRenderer — interface for spray/sediment/debris particles.
 */
export class ParticleRenderer {
  constructor({ scene } = {}) {
    this.scene = scene;
    this.system = null;
  }

  emit(position, options = {}) {}

  update(dt) {}

  dispose() {
    this.system = null;
  }
}

/**
 * viewer/BreachAnimator — interface for the dam breach formation sequence.
 */
export class BreachAnimator {
  constructor({ scene } = {}) {
    this.scene = scene;
    this.progress = 0;
  }

  setProgress(progress) {
    this.progress = Math.max(0, Math.min(1, progress));
  }

  update(dt) {}

  dispose() {}
}
