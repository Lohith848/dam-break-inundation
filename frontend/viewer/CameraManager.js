/**
 * viewer/CameraManager.js
 * =============================================================================
 * Constrained Engineering Camera for the digital twin.
 *
 * The camera exists to explain the simulation — not to inspect the underside
 * of the terrain. OrbitControls are constrained so that:
 *   • the camera can never go below terrain (polar clamp + min height clamp)
 *   • free orbit azimuth is limited to roughly ±25° around the current preset
 *   • upside-down views are impossible
 *   • transitions are always smooth (900ms ease, never snapping)
 *
 * During a running simulation, `locked` mode allows zoom and slight orbit
 * only, preventing users from rotating away from the flood animation.
 * =============================================================================
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraManager {
  constructor(container, domElement, viewerState) {
    const rect = container.getBoundingClientRect();
    const aspect = Math.max(1, rect.width) / Math.max(1, rect.height);

    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 20000);
    this.state = viewerState;

    // ---- Orbit constraints (strictly prevent under-terrain or upside-down views) ----
    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;            // panning drifts off the twin
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(75); // ≈75° strictly prevents looking below terrain
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(20); // ≈20° strictly prevents upside-down / top stick
    this.controls.minDistance = 15;
    this.controls.maxDistance = 800;

    // Bounded orbit window around viewing angle to prevent looking behind terrain wall
    this._orbitWindow = THREE.MathUtils.degToRad(70);
    this._refAzimuth = 0;
    this._lastAzimuth = 0;

    // Terrain-relative clamps (defaults until terrain/model bounds define the world)
    this._minHeight = 2.5;
    this._maxPresetDistance = 800;

    this._tween = null;
    this._presetsCache = null;
    this._presetsSourceBounds = null;

    // ---- Default camera: isometric engineering angle ------------------------
    const def = this._defaultPreset();
    this.camera.position.set(...def.pos);
    this.controls.target.set(...def.target);
    this._syncRefAzimuth();
    this._installGuards();
  }

  // ==========================================================================
  // Presets — Dam / Valley / Overview / Top / Reset (computed from bounds)
  // ==========================================================================
  _terrainBounds() {
    return this.state?.get("masterBounds") || this.state?.get("terrainBounds") || null;
  }

  _defaultPreset() {
    const b = this._terrainBounds();
    if (!b) return { pos: [115, 95, 120], target: [0, 5, 0] };
    const s = Math.max(b.size.x, b.size.z) || 100;
    const cx = b.center.x, cy = b.center.y, cz = b.center.z;
    return {
      pos: [cx + 0.68 * s, cy + 0.58 * s, cz + 0.72 * s],
      target: [cx, cy + 0.12 * b.size.y, cz],
    };
  }

  _presets() {
    const b = this._terrainBounds();
    if (!b) {
      return {
        dam:      { pos: [55, 42, 60],    target: [0, 8, 0] },
        valley:   { pos: [-40, 55, 110],  target: [0, 0, 60] },
        overview: this._defaultPreset(),
        top:      { pos: [0.01, 150, 45], target: [0, 0, 0] },
        reset:    this._defaultPreset(),
      };
    }

    const s = Math.max(b.size.x, b.size.z) || 100;
    const cx = b.center.x, cy = b.center.y, cz = b.center.z;
    const sy = b.size.y;
    const meta = this.state?.get("sceneMetadata");
    const metaPresets = meta?.camera_presets;

    if (metaPresets) {
      const resolveMeta = (mp, defTargetZ = 0) => {
        if (!mp?.relative_position) return null;
        return {
          pos: [
            cx + mp.relative_position.x * s,
            cy + mp.relative_position.y * s,
            cz + mp.relative_position.z * s,
          ],
          target: [
            cx + (mp.relative_target?.x ?? 0) * s,
            cy + (mp.relative_target?.y ?? 0.1) * sy,
            cz + (mp.relative_target?.z ?? defTargetZ) * s,
          ],
        };
      };

      const ov = resolveMeta(metaPresets.overview) || this._defaultPreset();
      const dm = resolveMeta(metaPresets.dam) || {
        pos: [cx + 0.02 * s, cy + 0.32 * s, cz + 0.48 * s],
        target: [cx, cy + 0.18 * sy, cz],
      };
      const vl = resolveMeta(metaPresets.valley, 0.3) || {
        pos: [cx + 0.36 * s, cy + 0.42 * s, cz + 0.88 * s],
        target: [cx, cy + 0.08 * sy, cz + 0.32 * s],
      };
      const tp = resolveMeta(metaPresets.top) || {
        pos: [cx + 0.01, cy + 1.25 * s, cz + 0.35 * s],
        target: [cx, cy, cz],
      };

      return { dam: dm, valley: vl, overview: ov, top: tp, reset: ov };
    }

    // Default algorithmic presets computed strictly from model bounds
    return {
      dam: {
        pos: [cx + 0.02 * s, cy + 0.32 * s, cz + 0.48 * s],
        target: [cx, cy + 0.18 * sy, cz],
      },
      valley: {
        pos: [cx + 0.36 * s, cy + 0.42 * s, cz + 0.88 * s],
        target: [cx, cy + 0.08 * sy, cz + 0.32 * s],
      },
      overview: {
        pos: [cx + 0.68 * s, cy + 0.58 * s, cz + 0.72 * s],
        target: [cx, cy + 0.12 * sy, cz],
      },
      top: {
        pos: [cx + 0.01, cy + 1.25 * s, cz + 0.35 * s],
        target: [cx, cy, cz],
      },
      reset: {
        pos: [cx + 0.68 * s, cy + 0.58 * s, cz + 0.72 * s],
        target: [cx, cy + 0.12 * sy, cz],
      },
    };
  }

  setPreset(name, duration = 900) {
    const key = (name || "overview").toLowerCase();
    const presets = this._presets();
    const preset = presets[key] || presets.overview;
    this.state?.set("currentPreset", key);
    this.animateTo(preset.pos, preset.target, duration);
  }

  // ==========================================================================
  // Terrain-aware constraint updates
  // ==========================================================================
  applyTerrainConstraints(bounds) {
    if (!bounds) return;
    const size = Math.max(bounds.size.x, bounds.size.z, bounds.size.y) || 100;
    const radius = bounds.radius || (size * 0.5);

    this._minHeight = Math.max(2.0, bounds.min.y + 2.0);
    // Bounded zoom limits derived from model bounding sphere
    this.controls.minDistance = Math.max(12, radius * 0.28);
    this.controls.maxDistance = Math.max(120, radius * 3.6);
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(75);
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(20);
    this._maxPresetDistance = 2.4 * size;

    this._presetsCache = null;
    this._presetsSourceBounds = bounds;
  }

  // ==========================================================================
  // Simulation lock — zoom + slight orbit only
  // ==========================================================================
  setLocked(locked) {
    this._locked = Boolean(locked);
    if (this._locked) {
      this.controls.enableRotate = true; // slight orbit remains allowed
      this._setOrbitWindow(THREE.MathUtils.degToRad(12)); // tighter during sim
      this.controls.enableZoom = true;
      this.controls.enablePan = false;
    } else {
      this._setOrbitWindow(THREE.MathUtils.degToRad(25));
    }
  }

  _setOrbitWindow(rad) {
    this._orbitWindow = rad;
    this._syncRefAzimuth();
  }

  // ==========================================================================
  // Guards: azimuth window + above-terrain clamp
  // ==========================================================================
  _syncRefAzimuth() {
    if (!this._tween) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      const sph = new THREE.Spherical().setFromVector3(offset);
      this._refAzimuth = sph.theta;
      this._lastAzimuth = sph.theta;
    }
    this._lastAzimuth = this._cameraAzimuth();
  }

  _cameraAzimuth() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    return new THREE.Spherical().setFromVector3(offset).theta;
  }

  _installGuards() {
    const controls = this.controls;

    controls.addEventListener("change", () => {
      // --- Azimuth window clamp -------------------------------------------
      if (this._orbitWindow > 0) {
        let delta = this._cameraAzimuth() - this._refAzimuth;
        // wrap to [-π, π]
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;

        const limit = this._orbitWindow;
        if (Math.abs(delta) > limit) {
          const clamped = this._refAzimuth + Math.sign(delta) * limit;
          const offset = this.camera.position.clone().sub(this.controls.target);
          const sph = new THREE.Spherical().setFromVector3(offset);
          sph.theta = clamped;
          this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(sph));
          this._lastAzimuth = clamped;
        } else {
          this._lastAzimuth = this._cameraAzimuth();
        }
      }

      // --- Minimum height above terrain ------------------------------------
      const minY = this._minHeight + this.controls.target.y;
      if (this.camera.position.y < minY) {
        this.camera.position.y = minY;
      }
    });
  }

  /** Re-anchor the orbit window to wherever the user currently is. */
  recenterOrbitWindow() {
    this._refAzimuth = this._cameraAzimuth();
    this._lastAzimuth = this._refAzimuth;
  }

  // ==========================================================================
  // Animated transitions (never snap)
  // ==========================================================================
  animateTo(targetPos, targetLookAt, duration = 900) {
    const fromPos = this.camera.position.clone();
    const toPos = new THREE.Vector3(...targetPos);
    const fromTarget = this.controls.target.clone();
    const toTarget = new THREE.Vector3(...targetLookAt);

    this._tween = {
      fromPos, toPos, fromTarget, toTarget,
      startTime: performance.now(),
      duration: Math.max(100, duration),
    };
  }

  update(delta, timestamp) {
    if (this._tween) {
      const elapsed = timestamp - this._tween.startTime;
      const progress = Math.min(1, elapsed / this._tween.duration);
      const eased = easeInOutCubic(progress);

      this.camera.position.lerpVectors(this._tween.fromPos, this._tween.toPos, eased);
      this.controls.target.lerpVectors(this._tween.fromTarget, this._tween.toTarget, this._tween._lastTargetEase ?? (this._tween._lastTargetEase = eased));

      this._lastAzimuth = this._cameraAzimuth();

      if (progress >= 1) {
        this._tween = null;
        this._syncRefAzimuth();
      }
    }

    this.controls.update();
  }

  // ==========================================================================
  // Framing
  // ==========================================================================
  fitObject(object3D, offsetFactor = 1.35) {
    if (!object3D) {
      this.setPreset("reset", 900);
      return;
    }
    const box = new THREE.Box3().setFromObject(object3D);
    if (box.isEmpty()) {
      this.setPreset("reset", 900);
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (sphere.radius / Math.sin(fov / 2)) * offsetFactor;
    const dir = new THREE.Vector3(0.66, 0.52, 0.66).normalize();
    const newPos = sphere.center.clone().add(dir.multiplyScalar(dist));
    this.animateTo([newPos.x, newPos.y, newPos.z], [sphere.center.x, sphere.center.y, sphere.center.z], 900);
  }

  dispose() {
    this._tween = null;
    this.controls.dispose();
  }
}
