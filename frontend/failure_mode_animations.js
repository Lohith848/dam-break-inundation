/**
 * failure_mode_animations.js — Failure-Mode Animation System (foundation)
 * =================================================================
 * Modular animation layer that prepares the 3D scene for river and flood
 * animations driven by the four failure modes:
 *
 *   overtopping | piping | structural | earthquake
 *
 * Design:
 *   - PRESETS hold every per-mode visual parameter in one place (single
 *     source of truth, matching backend/app/failure_modes.py physics).
 *   - FloodFailureAnimator is self-contained: it creates and owns its own
 *     scene objects (river streamers, crest-overflow sheets, piping jet)
 *     and restores/removes them on stop(), so it never corrupts the
 *     terrain, water, or dam objects owned by Flood3DViewer.
 *   - Nothing auto-starts. Wire it when the new dam model + river meshes
 *     arrive:  animator.start("overtopping")  /  animator.setPhase(0..1).
 *
 * The viewer ticks it:  animator.update(dt)  from Flood3DViewer.animate().
 * =================================================================
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Per-mode animation presets. `speedScale`, `surgeIntensity` and `waveScale`
// mirror the hydrograph behaviour of each mode (structural/earthquake produce
// steep, fast waves; overtopping a slow, prolonged rise).
// ---------------------------------------------------------------------------
export const FAILURE_ANIMATION_PRESETS = {
  overtopping: {
    label: "Overtopping",
    description: "Water flows over the dam crest causing erosion.",
    // River/flood visual character
    riverSpeed: 0.35,        // streamer speed multiplier (slow, sustained)
    turbulence: 0.25,        // lateral wobble of streamers
    waterTint: 0x6fa8dc,     // calmer, sediment-light tone
    // Failure actor: sheets of water spilling over the crest
    crestOverflow: { enabled: true, width: 26, intensity: 0.55 },
    pipingJet: { enabled: false },
    // Camera / surge
    cameraShake: { amplitude: 0.0, frequency: 0 },
    surgeIntensity: 0.35,    // flood-wave violence (drives foam/opacity)
    waveScale: 0.6,
    phaseProfile: "slow-rise", // maps simulation progress -> effect strength
  },
  piping: {
    label: "Piping (Internal Erosion)",
    description: "Internal seepage gradually erodes the dam.",
    riverSpeed: 0.55,
    turbulence: 0.4,
    waterTint: 0x7d6b4f,     // sediment-heavy (internal erosion carries soil)
    crestOverflow: { enabled: false },
    pipingJet: { enabled: true, radius: 1.4, intensity: 0.5 },
    cameraShake: { amplitude: 0.0, frequency: 0 },
    surgeIntensity: 0.5,
    waveScale: 0.8,
    phaseProfile: "gradual",
  },
  structural: {
    label: "Structural Failure",
    description: "Sudden collapse of the dam structure.",
    riverSpeed: 1.0,
    turbulence: 0.8,
    waterTint: 0x4a6d8c,
    crestOverflow: { enabled: false },
    pipingJet: { enabled: false },
    cameraShake: { amplitude: 0.18, frequency: 9, duration: 1.2 },
    surgeIntensity: 1.0,     // near-instant steep wave
    waveScale: 1.4,
    phaseProfile: "instant",
  },
  earthquake: {
    label: "Earthquake-Induced Failure",
    description: "Dam failure triggered by seismic activity.",
    riverSpeed: 0.9,
    turbulence: 0.7,
    waterTint: 0x55707f,
    crestOverflow: { enabled: false },
    pipingJet: { enabled: true, radius: 1.8, intensity: 0.7 },
    cameraShake: { amplitude: 0.35, frequency: 14, duration: 3.0 },
    surgeIntensity: 0.85,
    waveScale: 1.25,
    phaseProfile: "rapid",
  },
};

/** Progress (0..1) -> effect strength per mode's phase profile. */
function phaseCurve(profile, p) {
  const x = Math.max(0, Math.min(1, p));
  switch (profile) {
    case "instant":  return x < 0.05 ? x / 0.05 : 1;                    // snap on
    case "rapid":    return Math.min(1, x / 0.2);                       // fast ramp
    case "gradual":  return Math.pow(x, 0.7);                           // steady
    case "slow-rise":
    default:         return Math.pow(x, 1.6);                           // late ramp
  }
}

export class FloodFailureAnimator {
  /**
   * @param {object} viewer host Flood3DViewer (needs .scene, ._damWorldX,
   *        .camera, and exposure of .exaggeration via _crestInfo or default)
   */
  constructor(viewer) {
    this.viewer = viewer;
    this.mode = null;
    this.preset = null;
    this.phase = 0;          // 0..1 simulation/failure progress
    this._group = null;      // all animator-owned objects
    this._streamers = [];
    this._sheets = [];
    this._jet = null;
    this._shake = { t: 0, remaining: 0 };
    this._elapsed = 0;
  }

  // ---------------------------------------------------------------
  /** Begin animating a failure mode. Safe to call repeatedly. */
  start(failureMode) {
    const key = String(failureMode || "").toLowerCase();
    const preset = FAILURE_ANIMATION_PRESETS[key];
    if (!preset) {
      console.warn(`FloodFailureAnimator: unknown mode "${failureMode}". ` +
        `Available: ${Object.keys(FAILURE_ANIMATION_PRESETS).join(", ")}`);
      return false;
    }
    this.stop();
    this.mode = key;
    this.preset = preset;
    this.phase = 0;
    this._elapsed = 0;
    this._shake.remaining = preset.cameraShake.duration || 0;

    this._group = new THREE.Group();
    this._group.name = "failureAnimationRoot";
    this.viewer.scene.add(this._group);

    this._buildRiverStreamers();
    if (preset.crestOverflow.enabled) this._buildCrestOverflow(preset);
    if (preset.pipingJet.enabled) this._buildPipingJet(preset);

    console.info(`[FAILURE ANIM] started "${key}" (phase profile: ${preset.phaseProfile}).`);
    return true;
  }

  /** Stop and remove every animator-owned object. */
  stop() {
    if (this._group) {
      this._group.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); }
      });
      this.viewer.scene.remove(this._group);
      this._group = null;
    }
    this._streamers = [];
    this._sheets = [];
    this._jet = null;
    const had = !!this.mode;
    this.mode = null;
    this.preset = null;
    if (had) console.info("[FAILURE ANIM] stopped.");
  }

  /** Set failure progress 0..1 (e.g. from the timeline / hydrograph). */
  setPhase(p) { this.phase = Math.max(0, Math.min(1, Number(p) || 0)); }

  get isActive() { return !!this.mode; }

  // ---------------------------------------------------------------
  // Actors
  // ---------------------------------------------------------------
  _buildRiverStreamers() {
    // Elongated translucent slabs flowing downstream (+x) from the dam.
    // Replaced/augmented when real river meshes arrive — geometry is
    // intentionally independent of terrain data.
    const p = this.preset;
    const damX = this.viewer._damWorldX ?? 0;
    const mat = new THREE.MeshBasicMaterial({
      color: p.waterTint, transparent: true, opacity: 0.28, depthWrite: false,
    });
    for (let i = 0; i < 6; i++) {
      const len = 30 + (i % 3) * 14;
      const geo = new THREE.BoxGeometry(len, 0.35, 2.2 + (i % 2) * 1.6);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(damX + 10 + i * 22, 0.6, (i - 2.5) * 3.2);
      mesh.userData.speed = p.riverSpeed * (0.8 + 0.3 * ((i % 3) / 2));
      mesh.userData.baseX = mesh.position.x;
      mesh.userData.lane = i;
      this._group.add(mesh);
      this._streamers.push(mesh);
    }
  }

  _buildCrestOverflow(preset) {
    // Thin white-blue sheets spilling down the downstream face.
    const cfg = preset.crestOverflow;
    const damX = this.viewer._damWorldX ?? 0;
    const crestY = 6; // visual height; refined when the new dam model lands
    for (let i = 0; i < 3; i++) {
      const geo = new THREE.PlaneGeometry(cfg.width, 9 + i * 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xcfe8ff, transparent: true, opacity: 0.0, depthWrite: false,
        side: THREE.DoubleSide,
      });
      const sheet = new THREE.Mesh(geo, mat);
      sheet.position.set(damX - 4 - i * 2.5, crestY - 4.5 - i * 0.5, 0);
      sheet.rotation.y = Math.PI / 2;
      sheet.userData.baseOpacity = cfg.intensity * (1 - i * 0.25);
      this._group.add(sheet);
      this._sheets.push(sheet);
    }
  }

  _buildPipingJet(preset) {
    // Jet of sediment-laden water through the dam body at breach level.
    const cfg = preset.pipingJet;
    const damX = this.viewer._damWorldX ?? 0;
    const geo = new THREE.CylinderGeometry(cfg.radius, cfg.radius * 1.35, 16, 12);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: this.preset.waterTint, transparent: true, opacity: 0.0, depthWrite: false,
    });
    this._jet = new THREE.Mesh(geo, mat);
    this._jet.position.set(damX + 4, 2.2, 0);
    this._jet.userData.baseOpacity = cfg.intensity;
    this._group.add(this._jet);
  }

  // ---------------------------------------------------------------
  /** Per-frame tick — called from Flood3DViewer.animate(). */
  update(dt) {
    if (!this.mode || !this._group) return;
    this._elapsed += dt;
    const p = this.preset;
    const strength = phaseCurve(p.phaseProfile, this.phase);

    // River streamers: flow downstream, wrap around, gentle turbulence.
    for (const s of this._streamers) {
      s.position.x += s.userData.speed * 12 * dt * (0.4 + 0.6 * strength);
      if (s.position.x > s.userData.baseX + 60) s.position.x = s.userData.baseX - 40;
      s.position.z += Math.sin(this._elapsed * 2 + s.userData.lane) * p.turbulence * dt * 2;
      s.material.opacity = 0.18 + 0.25 * strength;
    }

    // Crest overflow sheets fade in with phase and pulse.
    for (const sheet of this._sheets) {
      sheet.material.opacity = sheet.userData.baseOpacity * strength *
        (0.75 + 0.25 * Math.sin(this._elapsed * 3));
    }

    // Piping jet thickens as erosion progresses.
    if (this._jet) {
      this._jet.material.opacity = this._jet.userData.baseOpacity * strength;
      const s = 0.6 + 0.5 * strength;
      this._jet.scale.set(s, 1, s);
    }

    // Camera shake (decaying), for structural/earthquake.
    const cs = p.cameraShake;
    if (this._shake.remaining > 0 && cs.amplitude > 0) {
      this._shake.remaining -= dt;
      this._shake.t += dt;
      const decay = Math.max(0, this._shake.remaining) / (cs.duration || 1);
      const a = cs.amplitude * decay * strength;
      this.viewer.camera.position.x += Math.sin(this._shake.t * cs.frequency * 2.1) * a;
      this.viewer.camera.position.y += Math.cos(this._shake.t * cs.frequency * 1.7) * a * 0.6;
    }
  }
}
