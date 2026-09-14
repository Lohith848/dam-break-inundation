/**
 * viewer/UIController.js
 * =============================================================================
 * Viewport UI Controller.
 * Manages the Metrics Drawer state only. The 3D viewport intentionally shows
 * an empty engineering scene (grid + axes + lighting) until assets are loaded —
 * no placeholder overlays, exactly like professional CAD software.
 * =============================================================================
 */

export class UIController {
  constructor(viewportElement) {
    this.viewport = viewportElement;
    this.metricsDrawer = document.getElementById("metricsDrawer") || document.getElementById("dashboardDock");
    this.metricsOpen = false;
  }

  /** Digital-twin mode active — assets loaded. Kept for facade compatibility. */
  setTwinReady(ready) {
    this.twinReady = Boolean(ready);
  }

  toggleMetricsDrawer(forceState = null) {
    if (!this.metricsDrawer) {
      this.metricsDrawer = document.getElementById("metricsDrawer") || document.getElementById("dashboardDock");
    }
    if (!this.metricsDrawer) return false;

    const newState = forceState !== null ? Boolean(forceState) : !this.metricsOpen;
    this.metricsOpen = newState;

    if (this.metricsOpen) {
      this.metricsDrawer.classList.add("open");
      this.metricsDrawer.classList.remove("minimized");
    } else {
      this.metricsDrawer.classList.remove("open");
    }

    // Body flag lets CSS reposition floating elements (e.g. AI button)
    document.body.classList.toggle("metrics-open", this.metricsOpen);

    const toggleBtn = document.getElementById("tbToggleMetrics");
    if (toggleBtn) {
      toggleBtn.classList.toggle("active", this.metricsOpen);
    }

    // Trigger resize after the 250ms transition so Three.js fits the viewport
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 270);

    return this.metricsOpen;
  }

  isMetricsOpen() {
    return this.metricsOpen;
  }

  dispose() {
    // No overlay DOM to clean up — the empty scene is intentional.
  }
}
