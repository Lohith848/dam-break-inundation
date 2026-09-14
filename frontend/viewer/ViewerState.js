/**
 * viewer/ViewerState.js
 * =============================================================================
 * Shared, observable state for the digital-twin viewer.
 *
 * One instance is owned by Flood3DViewer and passed by reference to every
 * module. Modules never reach into each other — they read and observe state.
 * =============================================================================
 */

const DEFAULT_STATE = {
  // ---- Asset pipeline -------------------------------------------------------
  /** null until real terrain is loaded. Drives empty-state vs twin mode. */
  terrainBounds: null, // { min: {x,y,z}, max: {x,y,z}, size: {x,y,z}, center:{x,y,z} }
  loadedAssets: {}, // e.g. { terrain: url, dam: url, river: url }

  // ---- Simulation -----------------------------------------------------------
  simulationRunning: false,
  simulationData: null,
  /** Lock camera to presets + zoom-only during flood animation. */
  cameraLocked: false,

  // ---- Camera ---------------------------------------------------------------
  currentPreset: "overview",
};

export class ViewerState {
  constructor() {
    this._state = { ...DEFAULT_STATE, loadedAssets: {} };
    this._listeners = new Map(); // key -> Set<fn>
  }

  /** Read a value. */
  get(key) {
    return this._state[key];
  }

  /** Read the whole state (defensive copy). */
  snapshot() {
    return { ...this._state };
  }

  /**
   * Set a value and notify subscribers.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    const prev = this._state[key];
    if (prev === value) return;
    this._state[key] = value;
    this._emit(key, value, prev);
  }

  /**
   * Subscribe to changes on a key.
   * @param {string} key
   * @param {(value:any, prev:any)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  subscribe(key, fn) {
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(fn);
    return () => this._listeners.get(key)?.delete(fn);
  }

  _emit(key, value, prev) {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(value, prev);
      } catch (err) {
        console.error(`ViewerState listener error for "${key}":`, err);
      }
    }
  }

  dispose() {
    this._listeners.clear();
  }
}
