/**
 * dashboard.js — Hydrodynamic Simulation Metrics Drawer
 * =============================================================================
 * Professional engineering metrics dashboard (HEC-RAS / ArcGIS Pro style).
 *
 * CRITICAL REQUIREMENTS:
 *   • Metrics must ONLY consume backend JSON (data.summary, data.breach).
 *   • Never estimate values or invent numbers.
 *   • Empty/absent fields remain "—" (dash).
 *   • Displays all 8 core metrics:
 *       1. Peak Discharge (m³/s)
 *       2. Flood Area (km²)
 *       3. Maximum Depth (m)
 *       4. Maximum Velocity (m/s)
 *       5. Arrival Time (min)
 *       6. Simulation Runtime (s)
 *       7. Failure Mode
 *       8. Simulation Status
 * =============================================================================
 */

export const METRIC_DEFS = [
  { key: "peakDischarge", title: "Peak Discharge", unit: "m³/s" },
  { key: "floodedArea",   title: "Flood Area",     unit: "km²" },
  { key: "maxDepth",      title: "Max Depth",      unit: "m" },
  { key: "maxVelocity",   title: "Max Velocity",   unit: "m/s" },
  { key: "arrivalTime",   title: "Arrival Time",   unit: "min" },
  { key: "simRuntime",    title: "Runtime",        unit: "s" },
  { key: "failureMode",   title: "Failure Mode",   unit: "" },
  { key: "simStatus",     title: "Status",         unit: "" },
];

// Em-dash placeholder — shown when data is not yet computed or unavailable.
const PENDING = "\u2014"; // —
const UPDATING = "Updating...";

export class SimulationDashboard {
  constructor(container) {
    if (!container) throw new Error("SimulationDashboard: container element is required");
    this.container = container;
    this.summary = null;
    this._cards = {};
    this._render();
  }

  _render() {
    this.container.innerHTML = "";
    this.container.className = "metrics-drawer-grid";

    METRIC_DEFS.forEach((def) => {
      const card = document.createElement("div");
      card.className = "metric-card";
      card.setAttribute("data-metric", def.key);
      card.innerHTML = `
        <div class="metric-card-title">${def.title}</div>
        <div class="metric-card-value" data-val="${def.key}">${PENDING}</div>
        <div class="metric-card-unit" data-unit="${def.key}">${def.unit || ""}</div>
      `;
      this.container.appendChild(card);
      this._cards[def.key] = card;
    });

    this._setBadge("Idle", "idle");
  }

  _setValue(key, value, customUnit) {
    const card = this._cards[key];
    if (!card) return;
    const valEl = card.querySelector(`[data-val="${key}"]`);
    const unitEl = card.querySelector(`[data-unit="${key}"]`);
    const def = METRIC_DEFS.find((d) => d.key === key);

    if (valEl) {
      valEl.textContent = (value !== null && value !== undefined && value !== "") ? value : PENDING;
      valEl.classList.toggle("is-pending", valEl.textContent === PENDING || valEl.textContent === UPDATING);
    }
    if (unitEl && def) {
      if (!value || value === PENDING || value === UPDATING) {
        unitEl.textContent = "";
      } else {
        unitEl.textContent = customUnit !== undefined ? customUnit : def.unit;
      }
    }
  }

  /** Set the drawer status badge (Idle | Running | Completed | Failed). */
  _setBadge(state, variant) {
    const badge = document.getElementById("drawerStatusBadge");
    if (!badge) return;
    badge.textContent = state;
    badge.classList.remove("idle", "running", "completed", "failed");
    if (variant) badge.classList.add(variant);
  }

  /** While the simulation is running. */
  setCalculating() {
    [
      "peakDischarge", "floodedArea", "maxDepth", "maxVelocity",
      "arrivalTime", "simRuntime", "failureMode"
    ].forEach((k) => {
      this._setValue(k, UPDATING);
    });
    this._setValue("simStatus", "Running", "");
    this._setBadge("Running", "running");
  }

  /** On failure — surface Failed status without fabricated numbers. */
  setFailed() {
    [
      "peakDischarge", "floodedArea", "maxDepth", "maxVelocity",
      "arrivalTime", "simRuntime", "failureMode"
    ].forEach((k) => {
      this._setValue(k, PENDING);
    });
    this._setValue("simStatus", "Failed", "");
    this._setBadge("Failed", "failed");
  }

  /** Reset to idle (e.g. when the selected dam changes). */
  reset() {
    METRIC_DEFS.forEach((def) => this._setValue(def.key, PENDING, def.unit || ""));
    this._setBadge("Idle", "idle");
  }

  /**
   * Populate metrics strictly from backend JSON response.
   *
   * @param {object} data Backend simulation result
   * @param {number} [elapsedMs] Measured wall-clock time in ms
   */
  setSummary(data, elapsedMs = null) {
    if (!data) return;
    this.summary = data;
    const summ = data.summary || {};
    const breach = data.breach_summary || data.breach || {};

    // 1. Peak Discharge (m³/s)
    const peakQ = breach.peak_outflow_cms ?? summ.peak_discharge_m3s ?? null;
    this._setValue("peakDischarge", (peakQ != null && !isNaN(peakQ)) ? Math.round(peakQ).toLocaleString() : PENDING);

    // 2. Flood Inundation Area (km²)
    const areaKm2 = summ.max_inundated_area_km2 ?? summ.inundated_area_km2 ?? summ.flooded_area_km2 ?? null;
    this._setValue("floodedArea", (areaKm2 != null && !isNaN(areaKm2)) ? Number(areaKm2).toFixed(2) : PENDING);

    // 3. Maximum Flood Depth (m)
    const maxH = summ.max_flood_depth_m ?? summ.max_depth_m ?? null;
    this._setValue("maxDepth", (maxH != null && !isNaN(maxH)) ? Number(maxH).toFixed(1) : PENDING);

    // 4. Maximum Flow Velocity (m/s)
    const maxV = summ.max_velocity_ms ?? summ.velocity_estimate_ms ?? null;
    this._setValue("maxVelocity", (maxV != null && !isNaN(maxV)) ? Number(maxV).toFixed(1) : PENDING);

    // 5. Estimated Arrival Time (min)
    const arrivals = summ.settlement_arrival_times || [];
    const pois = summ.points_of_interest || [];
    if (arrivals.length > 0 && arrivals[0].arrival_time_hours != null) {
      const mins = Math.round(arrivals[0].arrival_time_hours * 60);
      this._setValue("arrivalTime", `${mins}`, "min");
    } else if (pois.length > 0 && pois[0].arrival_time_min != null) {
      this._setValue("arrivalTime", `${Math.round(pois[0].arrival_time_min)}`, "min");
    } else {
      this._setValue("arrivalTime", PENDING);
    }

    // 6. Simulation Runtime (s)
    const runtimeMs = data.simulation_time_ms ?? elapsedMs;
    if (runtimeMs != null && !isNaN(runtimeMs) && runtimeMs > 0) {
      this._setValue("simRuntime", `${(runtimeMs / 1000).toFixed(1)}`, "s");
    } else {
      this._setValue("simRuntime", PENDING);
    }

    // 7. Failure Mode (mode title)
    const mode = data.failure_mode || data.config?.failure_mode;
    if (mode) {
      const formattedMode = mode.charAt(0).toUpperCase() + mode.slice(1);
      this._setValue("failureMode", formattedMode, "");
    } else {
      this._setValue("failureMode", PENDING);
    }

    // 8. Simulation Status
    this._setValue("simStatus", "Completed", "");
    this._setBadge("Completed", "completed");
  }

  bind(viewer) {
    // Preserved for lifecycle compatibility
  }
}
