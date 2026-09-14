/**
 * viewer/SimulationRenderer.js
 * =============================================================================
 * Hydrodynamic Simulation Data & Water Surface Renderer.
 *
 * CRITICAL SCIENTIFIC ACCURACY RULES:
 *   • Animate water ONLY from backend depth grids (data.depth_grids[][][]).
 *   • Never fabricate water movement.
 *   • If timestep grids exist, interpolate smoothly between frames.
 *   • If only a final inundation raster exists, visualize progressive filling
 *     with clear documentation that it is a visualization layer rather than
 *     a physical CFD simulation.
 *   • Color modes supported:
 *       - "realistic": Semi-transparent water with depth darkening
 *       - "depth": HEC-RAS / USGS standard depth heatmap
 *       - "velocity": Flow velocity heatmap (strictly when velocity_grids present)
 *       - "arrival": Inundation arrival time classification
 *       - "risk": Hydraulic risk index (depth × velocity)
 * =============================================================================
 */

import * as THREE from "three";

// Color palettes
const PALETTE_DEPTH = [
  { max: 0.5, r: 0.11, g: 0.37, b: 0.62 }, // Shallow blue
  { max: 1.5, r: 0.12, g: 0.69, b: 0.77 }, // Cyan
  { max: 3.0, r: 0.25, g: 0.68, b: 0.33 }, // Green
  { max: 5.0, r: 0.96, g: 0.77, b: 0.26 }, // Yellow
  { max: 8.0, r: 0.91, g: 0.47, b: 0.10 }, // Orange
  { max: 999, r: 0.80, g: 0.10, b: 0.10 }, // Red
];

const PALETTE_VELOCITY = [
  { max: 1.0, r: 0.10, g: 0.40, b: 0.80 },
  { max: 2.5, r: 0.20, g: 0.75, b: 0.40 },
  { max: 4.0, r: 0.95, g: 0.80, b: 0.20 },
  { max: 6.0, r: 0.95, g: 0.45, b: 0.10 },
  { max: 999, r: 0.85, g: 0.10, b: 0.35 },
];

export class SimulationRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./ViewerState.js').ViewerState} [viewerState]
   */
  constructor(scene, viewerState = null) {
    this.scene = scene;
    this.state = viewerState;
    this.data = null;
    this.colorMode = "realistic";
    this.wireframeOn = false;
    this.exaggeration = 1.0;

    this.waterMesh = null;
    this.waterGeometry = null;
    this.waterMaterial = null;
    this.currentFrame = 0;
    this._arrivalGrid = null; // cached first-arrival timestep per cell
  }

  loadSimulation(data) {
    this.disposeMesh();
    this.data = data;
    this.currentFrame = 0;
    this._arrivalGrid = null;

    if (!data || !data.depth_grids || data.depth_grids.length === 0) {
      return;
    }

    const firstGrid = data.depth_grids[0];
    const rows = firstGrid.length;
    const cols = firstGrid[0].length;

    // Cache arrival times across all timesteps for "arrival" layer
    this._computeArrivalGrid(data.depth_grids);

    // Retrieve digital twin spatial bounds
    const bounds = this.state?.get("masterBounds") || this.state?.get("terrainBounds");
    const width = bounds ? bounds.size.x : (cols * 2.5);
    const depth = bounds ? bounds.size.z : (rows * 2.5);
    const centerX = bounds ? bounds.center.x : 0;
    const centerZ = bounds ? bounds.center.z : 0;
    const baseElevation = bounds ? Math.max(0.1, bounds.min.y + 0.1) : 0.1;

    this._baseElevation = baseElevation;

    // Create horizontal simulation grid plane matching the resolution
    this.waterGeometry = new THREE.PlaneGeometry(width, depth, cols - 1, rows - 1);
    this.waterGeometry.rotateX(-Math.PI / 2); // align to X-Z horizontal plane

    // Initialize vertex colors
    const vertexCount = this.waterGeometry.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount * 3; i += 3) {
      colors[i] = 0.14;     // R
      colors[i + 1] = 0.45; // G
      colors[i + 2] = 0.82; // B
    }
    this.waterGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Dynamic water material (semi-transparent with PBR highlights)
    this.waterMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      roughness: 0.25,
      metalness: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false, // Prevents z-fighting with terrain ground
      wireframe: this.wireframeOn,
    });

    this.waterMesh = new THREE.Mesh(this.waterGeometry, this.waterMaterial);
    this.waterMesh.name = "simulationWaterPlane";
    this.waterMesh.position.set(centerX, 0, centerZ);
    this.waterMesh.receiveShadow = true;
    this.waterMesh.castShadow = false;

    this.scene.add(this.waterMesh);

    // Render initial frame
    this.updateFrame(0);
  }

  hasVelocityData() {
    return Boolean(
      this.data &&
      this.data.velocity_grids &&
      this.data.velocity_grids.length > 0
    );
  }

  setColorMode(mode) {
    const validModes = ["realistic", "depth", "velocity", "arrival", "risk"];
    if (!validModes.includes(mode)) {
      mode = "realistic";
    }

    if (mode === "velocity" && !this.hasVelocityData()) {
      console.warn("SimulationRenderer: Velocity grids absent in backend response. Falling back to depth mode.");
      mode = "depth";
    }

    this.colorMode = mode;
    this.updateFrame(this.currentFrame);
    return this.colorMode;
  }

  getColorMode() {
    return this.colorMode;
  }

  setExaggeration(factor) {
    this.exaggeration = Math.max(0.2, Math.min(5.0, factor));
    this.updateFrame(this.currentFrame);
  }

  toggleWireframe() {
    this.wireframeOn = !this.wireframeOn;
    if (this.waterMaterial) {
      this.waterMaterial.wireframe = this.wireframeOn;
    }
    return this.wireframeOn;
  }

  /**
   * Update the water surface strictly from backend depth grids.
   * Supports smooth sub-frame interpolation without fabricating physics.
   *
   * @param {number} frameIndex Integer timestep index
   * @param {number} [fraction=0] Sub-frame interpolation progress (0..1)
   */
  updateFrame(frameIndex, fraction = 0) {
    if (!this.data || !this.data.depth_grids || !this.waterGeometry) return;

    const grids = this.data.depth_grids;
    const totalFrames = grids.length;
    this.currentFrame = Math.max(0, Math.min(totalFrames - 1, frameIndex));

    const gridA = grids[this.currentFrame];
    const nextIdx = Math.min(totalFrames - 1, this.currentFrame + 1);
    const gridB = grids[nextIdx];
    const interp = (fraction > 0 && fraction < 1 && this.currentFrame !== nextIdx);

    const vGrids = this.hasVelocityData() ? this.data.velocity_grids : null;
    const vGridA = vGrids ? vGrids[this.currentFrame] : null;
    const vGridB = (vGrids && interp) ? vGrids[nextIdx] : vGridA;

    const rows = gridA.length;
    const cols = gridA[0].length;
    const posAttr = this.waterGeometry.attributes.position;
    const colorAttr = this.waterGeometry.attributes.color;

    const pos = posAttr.array;
    const col = colorAttr.array;

    const baseElevation = this._baseElevation || 0.1;
    const exag = this.exaggeration || 1.0;
    const mode = this.colorMode;

    let vertexIdx = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dA = gridA[r][c];
        let depth = dA;
        if (interp) {
          const dB = gridB[r][c];
          depth = dA * (1 - fraction) + dB * fraction;
        }

        const pIdx = vertexIdx * 3;
        const cIdx = vertexIdx * 3;

        // Scientific threshold: cells below 0.05m depth are dry
        if (depth <= 0.05) {
          // Hide dry vertices under terrain
          pos[pIdx + 1] = -15.0;
          // Set color transparent/neutral
          col[cIdx] = 0.08;
          col[cIdx + 1] = 0.15;
          col[cIdx + 2] = 0.25;
        } else {
          // Wet vertex: elevate by depth * exaggeration
          pos[pIdx + 1] = baseElevation + (depth * exag);

          // Calculate color based on mode
          if (mode === "depth") {
            const rgb = this._colorForDepth(depth);
            col[cIdx] = rgb.r;
            col[cIdx + 1] = rgb.g;
            col[cIdx + 2] = rgb.b;
          } else if (mode === "velocity" && vGridA) {
            let vel = vGridA[r][c];
            if (interp && vGridB) {
              vel = vel * (1 - fraction) + vGridB[r][c] * fraction;
            }
            const rgb = this._colorForVelocity(vel);
            col[cIdx] = rgb.r;
            col[cIdx + 1] = rgb.g;
            col[cIdx + 2] = rgb.b;
          } else if (mode === "arrival") {
            const arr = this._arrivalGrid ? this._arrivalGrid[r][c] : 0;
            const rgb = this._colorForArrival(arr, totalFrames);
            col[cIdx] = rgb.r;
            col[cIdx + 1] = rgb.g;
            col[cIdx + 2] = rgb.b;
          } else if (mode === "risk") {
            const vel = vGridA ? vGridA[r][c] : Math.sqrt(9.81 * depth);
            const riskIndex = depth * vel;
            const rgb = this._colorForRisk(riskIndex);
            col[cIdx] = rgb.r;
            col[cIdx + 1] = rgb.g;
            col[cIdx + 2] = rgb.b;
          } else {
            // Realistic river water: deeper water is darker cyan-blue
            const depthFactor = Math.min(depth / 8.0, 1.0);
            col[cIdx] = 0.10 + 0.08 * (1 - depthFactor);
            col[cIdx + 1] = 0.40 + 0.25 * (1 - depthFactor);
            col[cIdx + 2] = 0.85;
          }
        }

        vertexIdx++;
      }
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    this.waterGeometry.computeVertexNormals();
  }

  _colorForDepth(depth) {
    for (let i = 0; i < PALETTE_DEPTH.length; i++) {
      if (depth <= PALETTE_DEPTH[i].max) return PALETTE_DEPTH[i];
    }
    return PALETTE_DEPTH[PALETTE_DEPTH.length - 1];
  }

  _colorForVelocity(velocity) {
    for (let i = 0; i < PALETTE_VELOCITY.length; i++) {
      if (velocity <= PALETTE_VELOCITY[i].max) return PALETTE_VELOCITY[i];
    }
    return PALETTE_VELOCITY[PALETTE_VELOCITY.length - 1];
  }

  _colorForArrival(firstFrame, totalFrames) {
    if (firstFrame < 0 || firstFrame >= totalFrames) {
      return { r: 0.2, g: 0.2, b: 0.3 };
    }
    const ratio = firstFrame / Math.max(1, totalFrames - 1);
    // Early arrival: bright magenta/red -> Late: cyan
    return {
      r: 0.9 * (1 - ratio) + 0.1 * ratio,
      g: 0.2 * (1 - ratio) + 0.7 * ratio,
      b: 0.4 * (1 - ratio) + 0.9 * ratio,
    };
  }

  _colorForRisk(risk) {
    if (risk < 0.5) return { r: 0.25, g: 0.75, b: 0.35 }; // Low: Green
    if (risk < 1.5) return { r: 0.95, g: 0.80, b: 0.20 }; // Medium: Yellow
    if (risk < 3.0) return { r: 0.95, g: 0.45, b: 0.10 }; // High: Orange
    return { r: 0.88, g: 0.12, b: 0.12 };                 // Extreme: Red
  }

  _computeArrivalGrid(depthGrids) {
    if (!depthGrids || depthGrids.length === 0) return;
    const rows = depthGrids[0].length;
    const cols = depthGrids[0][0].length;
    const totalFrames = depthGrids.length;

    this._arrivalGrid = Array.from({ length: rows }, () => new Int32Array(cols).fill(-1));

    for (let f = 0; f < totalFrames; f++) {
      const g = depthGrids[f];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (this._arrivalGrid[r][c] === -1 && g[r][c] > 0.05) {
            this._arrivalGrid[r][c] = f;
          }
        }
      }
    }
  }

  disposeMesh() {
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh);
      this.waterGeometry?.dispose();
      this.waterMaterial?.dispose();
      this.waterMesh = null;
      this.waterGeometry = null;
      this.waterMaterial = null;
    }
  }

  dispose() {
    this.disposeMesh();
    this.data = null;
    this._arrivalGrid = null;
  }
}
