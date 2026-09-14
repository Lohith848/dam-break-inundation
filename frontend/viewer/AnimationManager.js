/**
 * viewer/AnimationManager.js
 * =============================================================================
 * Hydrodynamic Simulation Timeline & Playback Controller.
 * Coordinates play/pause, step forward/back, playSpeed, and frame callbacks.
 * =============================================================================
 */

export class AnimationManager {
  constructor() {
    this.playing = false;
    this.frameIndex = 0;
    this.totalFrames = 0;
    this.playSpeed = 1.0;
    this.fps = 10; // 10 timesteps per simulated second playback default
    this.timestepsHours = [];

    this._lastFrameTime = 0;
    this.onFrameChange = null;
  }

  setSimulationData(data) {
    if (!data) return;
    const depthGrids = data.depth_grids || [];
    this.totalFrames = depthGrids.length;
    this.timestepsHours = data.timesteps_hours || [];
    this.frameIndex = 0;
    this.notifyFrame();
  }

  play() {
    this.playing = true;
    this._lastFrameTime = performance.now();
  }

  pause() {
    this.playing = false;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  step(delta = 1) {
    if (this.totalFrames <= 0) return;
    const next = this.frameIndex + delta;
    this.setFrame(next);
  }

  setFrame(index) {
    if (this.totalFrames <= 0) {
      this.frameIndex = 0;
      return;
    }
    this.frameIndex = Math.max(0, Math.min(this.totalFrames - 1, index));
    this.notifyFrame();
  }

  setSpeed(multiplier) {
    this.playSpeed = Math.max(0.1, Math.min(10.0, multiplier));
  }

  getCurrentHour() {
    if (this.timestepsHours && this.timestepsHours[this.frameIndex] !== undefined) {
      return this.timestepsHours[this.frameIndex];
    }
    return this.frameIndex * 0.1;
  }

  notifyFrame() {
    if (typeof this.onFrameChange === "function") {
      this.onFrameChange(this.frameIndex, this.getCurrentHour());
    }
  }

  update(delta, timestamp) {
    if (!this.playing || this.totalFrames <= 1) return;

    const frameIntervalMs = 1000 / (this.fps * this.playSpeed);
    if (timestamp - this._lastFrameTime >= frameIntervalMs) {
      this._lastFrameTime = timestamp;
      let nextIndex = this.frameIndex + 1;
      if (nextIndex >= this.totalFrames) {
        nextIndex = 0; // loop playback
      }
      this.setFrame(nextIndex);
    }
  }

  dispose() {
    this.pause();
    this.onFrameChange = null;
  }
}
