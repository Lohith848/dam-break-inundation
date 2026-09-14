/**
 * app.js — Main application module (ES Module)
 * =================================================================
 * Wires the Flood3DViewer, sidebar controls, live rainfall, real
 * progress, scenario comparison, PDF export, and 3D toolbar.
 * =================================================================
 */

import { Flood3DViewer } from "./three_viewer.js";
import { SimulationDashboard } from "./dashboard.js";
import { API_BASE } from "./config/api.js";

const API = API_BASE; // central config — no hardcoded hosts (see config/api.js)
const apiBase = API_BASE;
let ORIGIN_LAT = 11.8025, ORIGIN_LON = 77.8015;
let map, viewer3D = null, damMarker = null, dashboard = null;
let S = { river: null, dam: null, rivers: [], dams: [], simResult: null, abort: null, debounce: null, simRunning: false, startTime: 0, lastScenarioParams: null };

// ---------------------------------------------------------------------------
// Failure modes — fetched from /failure-modes (backend constants module).
// Bundled fallback keeps the UI working when the API is unreachable.
// ---------------------------------------------------------------------------
const FAILURE_MODES_FALLBACK = [
  { value: "overtopping", label: "Overtopping", description: "Water flows over the dam crest causing erosion.",
    defaults: { breach_formation_time_min: 67.5, breach_width_m: null, auto_breach_width: true } },
  { value: "piping", label: "Piping (Internal Erosion)", description: "Internal seepage gradually erodes the dam.",
    defaults: { breach_formation_time_min: 45, breach_width_m: 60, auto_breach_width: false } },
  { value: "structural", label: "Structural Failure", description: "Sudden collapse of the dam structure.",
    defaults: { breach_formation_time_min: 6.8, breach_width_m: 120, auto_breach_width: false } },
  { value: "earthquake", label: "Earthquake-Induced Failure", description: "Dam failure triggered by seismic activity.",
    defaults: { breach_formation_time_min: 13.5, breach_width_m: 108, auto_breach_width: false } },
];
let FAILURE_MODES = FAILURE_MODES_FALLBACK;
// Tracks manual edits so mode selection stops overriding user values (req. 4)
S.userEditedBreach = { width: false, time: false };

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  viewer3D = new Flood3DViewer(document.getElementById("threeContainer"));
  viewer3D.onProbe = onTerrainProbe;
  viewer3D.onFrameChange = onFrameChange;

  const dashContainer = document.getElementById("dashboardContainer");
  if (dashContainer) {
    dashboard = new SimulationDashboard(dashContainer);
    dashboard.bind(viewer3D);
    // Tapping the results grid on mobile dismisses the sidebar overlay
    dashContainer.addEventListener("click", () => {
      document.getElementById("sidebar")?.classList.remove("mobile-open");
      document.getElementById("mobileMenuBtn")?.classList.remove("active");
    });
  }

  setupViewSwitcher();
  setupSidebarLayout();
  setupRiverSearch();
  setupDamSearch();
  setupValidation();
  setupRunButton();
  setupAdvancedToggle();
  setup3DToolbar();
  setupFailureModes();
  if (typeof setupAIPanel === 'function') setupAIPanel();
  else if (typeof window.setupAIPanel === 'function') window.setupAIPanel();
  loadRivers().then(() => {
    // Auto-select benchmark dam (Mettur Dam) on initial startup for instant demo
    fetch(`${API}/dam/TN12HH0005`)
      .then((r) => r.json())
      .then((dam) => {
        if (dam && dam.id) {
          selectDam(dam);
        }
      })
      .catch(() => {});
  });
});

function initMap() {
  map = L.map("map").setView([ORIGIN_LAT - 0.15, ORIGIN_LON], 11);
  // High-resolution Esri World Imagery satellite basemap
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 18,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    }
  ).addTo(map);

  // Subtle CartoDB labels overlay for geographical reference
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 18,
      subdomains: "abcd",
      pane: "shadowPane",
      opacity: 0.85,
    }
  ).addTo(map);
}

// ---------------------------------------------------------------------------
// View Switcher
// ---------------------------------------------------------------------------
function setupViewSwitcher() {
  const b = { "3d": document.getElementById("btnView3D"), "split": document.getElementById("btnViewSplit"), "2d": document.getElementById("btnView2D") };
  const ws = document.querySelector(".workspace"), tv = document.getElementById("threeViewport"), lv = document.getElementById("leafletViewport");
  function sw(m) {
    Object.values(b).forEach(x => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
    ws.classList.remove("split-active"); tv.classList.add("hidden-viewport"); lv.classList.add("hidden-viewport");
    if (m === "3d") { b["3d"].classList.add("active"); tv.classList.remove("hidden-viewport"); }
    else if (m === "2d") { b["2d"].classList.add("active"); lv.classList.remove("hidden-viewport"); if (map) map.invalidateSize(); }
    else { b["split"].classList.add("active"); tv.classList.remove("hidden-viewport"); lv.classList.remove("hidden-viewport"); ws.classList.add("split-active"); if (map) map.invalidateSize(); }
    if (viewer3D) setTimeout(() => viewer3D.onResize(), 50);
  }
  b["3d"].onclick = () => sw("3d"); b["split"].onclick = () => sw("split"); b["2d"].onclick = () => sw("2d");
}

// ---------------------------------------------------------------------------
// Sidebar Layout — collapse/expand, drag-resize, persistence
// ---------------------------------------------------------------------------
const SIDEBAR_WIDTH_KEY = "dbim.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "dbim.sidebarCollapsed";
const SIDEBAR_MIN = 320, SIDEBAR_MAX = 450;

function setupSidebarLayout() {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebarResizer");
  const collapseBtn = document.getElementById("sidebarCollapseBtn");
  const mobileBtn = document.getElementById("mobileMenuBtn");
  if (!sidebar) return;

  const savedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || "", 10);
  if (!isNaN(savedWidth) && savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) {
    sidebar.style.setProperty("--sidebar-w", `${savedWidth}px`);
  }

  const applyCollapsed = (collapsed, persist = true) => {
    sidebar.classList.toggle("collapsed", collapsed);
    // Workspace flag only drives the expand-chevron visibility
    document.getElementById("workspace")?.classList.toggle("collapsed", collapsed);
    if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    setTimeout(() => viewer3D?.onResize(), 270); // after 250ms width transition
  };
  applyCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1", false);

  collapseBtn?.addEventListener("click", () => applyCollapsed(true));
  document.getElementById("sidebarExpandBtn")?.addEventListener("click", () => applyCollapsed(false));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      applyCollapsed(!sidebar.classList.contains("collapsed"));
    }
  });

  mobileBtn?.addEventListener("click", () => {
    const open = sidebar.classList.toggle("mobile-open");
    mobileBtn.classList.toggle("active", open);
  });

  // Drag-to-resize (disabled while collapsed)
  if (resizer) {
    let dragging = false;
    resizer.addEventListener("pointerdown", (e) => {
      if (sidebar.classList.contains("collapsed")) return;
      dragging = true;
      resizer.classList.add("active");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
      sidebar.style.setProperty("--sidebar-w", `${w}px`);
    });
    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const w = sidebar.getBoundingClientRect().width;
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w)));
      viewer3D?.onResize();
    });
    resizer.addEventListener("dblclick", () => {
      sidebar.style.removeProperty("--sidebar-w");
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
      viewer3D?.onResize();
    });
  }
}

// ---------------------------------------------------------------------------
// Search Helpers
// ---------------------------------------------------------------------------
function fuzzy(q, t) { if (!t || !q) return true; q = q.toLowerCase(); t = t.toLowerCase(); if (t.includes(q)) return true; let i = 0; for (let c of t) { if (c === q[i]) i++; } return i === q.length; }
function hl(text, q) { if (!q || !text) return text || ""; const i = text.toLowerCase().indexOf(q.toLowerCase()); if (i === -1) return text; return text.slice(0, i) + "<mark>" + text.slice(i, i + q.length) + "</mark>" + text.slice(i + q.length); }
function navList(list, e, onAct) { const items = list.querySelectorAll(".search-item"), act = list.querySelector(".search-item.active"); let idx = Array.from(items).indexOf(act); if (e.key === "ArrowDown") { e.preventDefault(); if (act) act.classList.remove("active"); idx = Math.min(idx + 1, items.length - 1); items[idx]?.classList.add("active"); items[idx]?.scrollIntoView({ block: "nearest" }); } else if (e.key === "ArrowUp") { e.preventDefault(); if (act) act.classList.remove("active"); idx = Math.max(idx - 1, 0); items[idx]?.classList.add("active"); items[idx]?.scrollIntoView({ block: "nearest" }); } else if (e.key === "Enter") { e.preventDefault(); if (act) onAct(act); } else if (e.key === "Escape") { e.target.blur(); list.classList.remove("open"); } }

// ---------------------------------------------------------------------------
// River Search
// ---------------------------------------------------------------------------
async function loadRivers() {
  const list = document.getElementById("riverList");
  list.innerHTML = '<div class="search-loading">Loading rivers...</div>';
  try { const r = await fetch(`${API}/rivers`); const d = await r.json(); S.rivers = (d.rivers || []).filter(r => r.dam_count > 0); document.getElementById("riverCount").textContent = S.rivers.length; list.innerHTML = ""; }
  catch (e) { list.innerHTML = '<div class="search-empty">Unable to load rivers.<button class="search-retry" onclick="loadRivers()">Retry</button></div>'; }
}

function setupRiverSearch() {
  const input = document.getElementById("riverSearch"), list = document.getElementById("riverList"), clear = document.getElementById("riverClear");
  input.addEventListener("input", () => { clearTimeout(S.debounce); S.debounce = setTimeout(() => { renderRivers(input.value); list.classList.add("open"); }, 100); });
  input.addEventListener("focus", () => { renderRivers(input.value); list.classList.add("open"); });
  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 200));
  input.addEventListener("keydown", (e) => navList(list, e, (el) => el.click()));
  clear.addEventListener("click", (e) => { e.stopPropagation(); clearRiver(); });
}

function renderRivers(q) {
  const list = document.getElementById("riverList"), f = S.rivers.filter(r => fuzzy(q, r.name));
  if (!f.length) { list.innerHTML = `<div class="search-empty">No rivers found${q ? ` matching "${q}"` : ""}.</div>`; return; }
  list.innerHTML = f.slice(0, 100).map(r => `<div class="search-item" data-name="${r.name}"><span class="search-item-name">${hl(r.name, q)}</span><span class="search-item-meta">${r.dam_count} dams</span></div>`).join("");
  list.querySelectorAll(".search-item").forEach(el => el.addEventListener("mousedown", (e) => { e.preventDefault(); selectRiver(el.dataset.name); }));
}

function selectRiver(name) {
  S.river = name; S.dam = null;
  document.getElementById("riverSearch").value = name;
  document.getElementById("riverClear").style.display = "flex";
  document.getElementById("riverList").classList.remove("open");
  document.getElementById("damSearch").disabled = false;
  document.getElementById("damSearch").value = "";
  document.getElementById("damSearch").placeholder = `Search ${name} dams...`;
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damList").innerHTML = "";
  hidePanels();
  searchDams("");
}

function clearRiver() {
  S.river = null; S.dam = null;
  document.getElementById("riverSearch").value = "";
  document.getElementById("riverClear").style.display = "none";
  document.getElementById("damSearch").value = "";
  document.getElementById("damSearch").placeholder = "Search all dams...";
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damList").innerHTML = "";
  if (damMarker) { map.removeLayer(damMarker); damMarker = null; }
  hidePanels();
}

function hidePanels() {
  ["summarySection", "paramsSection", "progressSection", "resultsSection", "errorSection"].forEach(id => {
    document.getElementById(id).style.display = "none";
  });
}

// ---------------------------------------------------------------------------
// Dam Search
// ---------------------------------------------------------------------------
function setupDamSearch() {
  const input = document.getElementById("damSearch"), list = document.getElementById("damList"), clear = document.getElementById("damClear");
  input.addEventListener("input", () => { clearTimeout(S.debounce); S.debounce = setTimeout(() => { searchDams(input.value); list.classList.add("open"); }, 200); });
  input.addEventListener("focus", () => { searchDams(input.value); list.classList.add("open"); });
  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 200));
  input.addEventListener("keydown", (e) => navList(list, e, (el) => el.click()));
  clear.addEventListener("click", (e) => { e.stopPropagation(); clearDam(); });
}

async function searchDams(q) {
  const list = document.getElementById("damList"), status = document.getElementById("damSelectorStatus");
  if (S.abort) S.abort.abort();
  S.abort = new AbortController();
  list.innerHTML = '<div class="search-loading">Searching...</div>';
  try {
    let url = S.river ? `${API}/rivers/${encodeURIComponent(S.river)}/dams` : `${API}/dams?max_results=200`;
    if (q) url += (url.includes("?") ? "&" : "?") + `q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { signal: S.abort.signal });
    const d = await r.json();
    S.dams = d.dams || [];
    status.textContent = S.dams.length;
    renderDams(S.dams, q);
  } catch (e) {
    if (e.name === "AbortError") return;
    list.innerHTML = '<div class="search-empty">Unable to load dams.<button class="search-retry">Retry</button></div>';
  }
}

function renderDams(dams, q) {
  const list = document.getElementById("damList");
  if (!dams.length) { list.innerHTML = `<div class="search-empty">No dams found${q ? ` matching "${q}"` : ""}.</div>`; return; }
  list.innerHTML = dams.slice(0, 80).map(d => `<div class="search-item" data-id="${d.id}"><div class="search-item-name">${hl(d.name, q)}</div><div class="search-item-meta">${d.river || ""} | ${d.state || ""} ${d.dam_height_m ? "| " + d.dam_height_m + "m" : ""}</div></div>`).join("");
  list.querySelectorAll(".search-item").forEach(el => el.addEventListener("mousedown", (e) => { e.preventDefault(); const dam = S.dams.find(d => d.id === el.dataset.id); if (dam) selectDam(dam); }));
}

function selectDam(dam) {
  S.dam = dam;
  document.getElementById("damSearch").value = dam.name;
  document.getElementById("damClear").style.display = "flex";
  document.getElementById("damList").classList.remove("open");

  if (dam.river && dam.river !== S.river) {
    S.river = dam.river;
    document.getElementById("riverSearch").value = dam.river;
    document.getElementById("riverClear").style.display = "flex";
    document.getElementById("damSearch").placeholder = `Search ${dam.river} dams...`;
  }

  showSummaryCard(dam);
  document.getElementById("paramsSection").style.display = "block";
  document.getElementById("progressSection").style.display = "none";
  document.getElementById("resultsSection").style.display = "none";
  document.getElementById("errorSection").style.display = "none";
  validateAll();

  // Fresh dam → reset metrics drawer to "—" / Idle (no stale values)
  dashboard?.reset();
  setDrawerStatus("idle");

  // Map
  ORIGIN_LAT = dam.latitude; ORIGIN_LON = dam.longitude;
  map.setView([ORIGIN_LAT, ORIGIN_LON], 13);
  if (damMarker) map.removeLayer(damMarker);
  damMarker = L.marker([ORIGIN_LAT, ORIGIN_LON]).addTo(map)
    .bindPopup(`<b>${dam.name}</b><br>${dam.river || ""}<br>${dam.state || ""}`).openPopup();

  // Fetch live rainfall
  fetchLiveRainfall(dam.latitude, dam.longitude);
}

function clearDam() {
  S.dam = null;
  document.getElementById("damSearch").value = "";
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damSelectorStatus").textContent = "";
  if (damMarker) { map.removeLayer(damMarker); damMarker = null; }
  hidePanels();
}

// ---------------------------------------------------------------------------
// Live Rainfall
// ---------------------------------------------------------------------------
async function fetchLiveRainfall(lat, lon) {
  const badge = document.getElementById("liveRainfallBtn");
  const hint = document.getElementById("rainfallHint");
  try {
    const res = await fetch(`${API}/weather/rainfall?lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error("Weather unavailable");
    const data = await res.json();
    const rainfall = data.current_mm_per_hr || 0;
    document.getElementById("rainfall").value = rainfall;
    badge.style.display = "inline-flex";
    hint.textContent = `Live: ${rainfall} mm/hr | 24h forecast: ${data.next_24h_total_mm} mm (Open-Meteo)`;
  } catch (e) {
    badge.style.display = "none";
    hint.textContent = "Additional rainfall during simulation (mm/hr)";
  }
}

// ---------------------------------------------------------------------------
// Summary Card
// ---------------------------------------------------------------------------
function showSummaryCard(dam) {
  document.getElementById("summarySection").style.display = "block";
  document.getElementById("sRiver").textContent = dam.river || "N/A";
  document.getElementById("sDam").textContent = dam.name;
  document.getElementById("sState").textContent = dam.state || "N/A";
  document.getElementById("sDem").textContent = "Pending";
  document.getElementById("sDem").className = "s-value";
  document.getElementById("sRes").textContent = "30 m";
  document.getElementById("sRuntime").textContent = `~${estimateRuntime(dam)} s`;
}

function estimateRuntime(dam) {
  const vol = dam.reservoir_volume_mcm || 100;
  if (vol < 10) return 5;
  if (vol < 100) return 8;
  if (vol < 1000) return 12;
  return 15;
}

// ---------------------------------------------------------------------------
// Failure Modes — dropdown, description, per-mode defaults
// ---------------------------------------------------------------------------
function setupFailureModes() {
  const select = document.getElementById("failureMode");
  const hint = document.getElementById("failureModeHint");
  if (!select) return;

  // Track manual edits: once the user types a value, mode changes no longer
  // override that field (requirement 4). Clearing the field re-enables
  // auto-fill so mode defaults apply again.
  ["breachWidth", "breachTime"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      const key = id === "breachWidth" ? "width" : "time";
      S.userEditedBreach[key] = el.value.trim() !== "";
    });
  });

  select.addEventListener("change", () => {
    showFailureModeDescription(select.value);
    applyFailureModeDefaults(select.value);
  });

  // Populate from backend constants (single source of truth), fall back locally
  populateFailureModeSelect(FAILURE_MODES);
  showFailureModeDescription(select.value || "piping");
  applyFailureModeDefaults(select.value || "piping", true);

  fetch(`${API}/failure-modes`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((modes) => {
      if (!Array.isArray(modes) || !modes.length) return;
      FAILURE_MODES = modes;
      const previous = select.value;
      populateFailureModeSelect(modes);
      select.value = previous; // restore selection after re-population
      showFailureModeDescription(select.value);
      if (!S.userEditedBreach.width && !S.userEditedBreach.time) {
        applyFailureModeDefaults(select.value, true);
      }
      if (hint) hint.textContent = "How the dam breach initiates";
    })
    .catch(() => { if (hint) hint.textContent = "How the dam breach initiates (offline defaults)"; });
}

function populateFailureModeSelect(modes) {
  const select = document.getElementById("failureMode");
  if (!select) return;
  select.innerHTML = modes
    .map((m) => `<option value="${m.value}">${m.label}</option>`)
    .join("");
}

function showFailureModeDescription(value) {
  const hint = document.getElementById("failureModeHint");
  const mode = FAILURE_MODES.find((m) => m.value === value);
  if (hint && mode) hint.textContent = mode.description;
}

function applyFailureModeDefaults(value, force = false) {
  const mode = FAILURE_MODES.find((m) => m.value === value);
  if (!mode) return;
  const widthEl = document.getElementById("breachWidth");
  const timeEl = document.getElementById("breachTime");
  const d = mode.defaults || {};

  // Requirement 4: never clobber values the user typed by hand.
  if (timeEl && (force || !S.userEditedBreach.time)) {
    timeEl.value = d.breach_formation_time_min ?? "";
  }
  if (widthEl && (force || !S.userEditedBreach.width)) {
    if (d.auto_breach_width) {
      widthEl.value = ""; // backend computes from regression + mode multiplier
      widthEl.placeholder = "Auto (mode default)";
    } else {
      widthEl.value = d.breach_width_m ?? "";
      widthEl.placeholder = "Leave empty to calculate automatically";
    }
  }
  validateAll();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function setupValidation() {
  ["waterLevel", "manningN", "rainfall", "simHours", "breachWidth", "breachTime"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", validateAll);
  });
}

function setupAdvancedToggle() {
  const toggle = document.getElementById("advancedToggle");
  const panel = document.getElementById("advancedPanel");
  toggle.addEventListener("click", () => {
    toggle.classList.toggle("open");
    panel.classList.toggle("open");
  });
  const progToggle = document.getElementById("progDetailsToggle");
  const progSteps = document.getElementById("progressSteps");
  if (progToggle && progSteps) {
    progToggle.addEventListener("click", () => {
      progToggle.classList.toggle("open");
      progSteps.style.display = progSteps.style.display === "none" ? "flex" : "none";
    });
  }
}

function validateAll() {
  if (!S.dam) return;
  let valid = true;
  const errors = {};

  const wl = parseFloat(document.getElementById("waterLevel").value);
  if (isNaN(wl) || wl < 10 || wl > 100) { errors.waterLevel = "Must be 10–100%"; valid = false; }

  const rf = parseFloat(document.getElementById("rainfall").value);
  if (isNaN(rf) || rf < 0) { errors.rainfall = "Must be ≥ 0"; valid = false; }

  const dur = parseFloat(document.getElementById("simHours").value);
  if (isNaN(dur) || dur <= 0 || dur > 12) { errors.simHours = "Must be 0.5–12 hours"; valid = false; }

  const bw = document.getElementById("breachWidth").value;
  if (bw && (isNaN(parseFloat(bw)) || parseFloat(bw) <= 0)) { errors.breachWidth = "Must be positive"; valid = false; }

  const bt = document.getElementById("breachTime").value;
  if (bt && (isNaN(parseFloat(bt)) || parseFloat(bt) <= 0)) { errors.breachTime = "Must be positive"; valid = false; }

  Object.keys(errors).forEach(k => {
    const el = document.getElementById("err" + k.charAt(0).toUpperCase() + k.slice(1));
    const input = document.getElementById(k);
    if (el) el.textContent = errors[k];
    if (input) input.classList.toggle("field-input-error", !!errors[k]);
  });

  document.getElementById("runBtn").disabled = !valid;
  if (valid) document.getElementById("validationMsg").textContent = "";
}

// ---------------------------------------------------------------------------
// Run Simulation
// ---------------------------------------------------------------------------
function setupRunButton() {
  document.getElementById("runBtn").addEventListener("click", runSimulation);
  document.getElementById("retryBtn")?.addEventListener("click", runSimulation);
  document.getElementById("copyErrorBtn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("errorMessage").textContent);
  });
  document.getElementById("exportReportBtn")?.addEventListener("click", exportReport);
  document.getElementById("compareBtn")?.addEventListener("click", showCompareFlow);
}

async function runSimulation() {
  if (!S.dam || S.simRunning) return;
  S.simRunning = true;
  const btn = document.getElementById("runBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="run-spinner"></span><span class="run-btn-text">Running...</span>';

  document.getElementById("progressSection").style.display = "block";
  document.getElementById("resultsSection").style.display = "none";
  document.getElementById("errorSection").style.display = "none";

  const progToggle = document.getElementById("progDetailsToggle");
  const progStepsEl = document.getElementById("progressSteps");
  if (progToggle) progToggle.classList.remove("open");
  if (progStepsEl) progStepsEl.style.display = "none";

  const steps = [
    { id: "dem", label: "Download DEM" },
    { id: "terrain", label: "Load Terrain" },
    { id: "mesh", label: "Generate Mesh" },
    { id: "sim", label: "Run Simulation" },
    { id: "flood", label: "Generate Flood Map" },
    { id: "ai", label: "AI Analysis" },
  ];

  const progEl = document.getElementById("progressSteps");
  const barEl = document.getElementById("progressBar");
  const elapsedEl = document.getElementById("progElapsed");
  const stepLabel = document.getElementById("progStepLabel");
  const remainEl = document.getElementById("progRemaining");

  progEl.innerHTML = steps.map((s, i) => `
    <div class="pt-step" id="pt-${s.id}">
      <div class="pt-icon"><span class="pt-pending-icon">${i + 1}</span></div>
      <span class="pt-label">${s.label}</span>
      <span class="pt-time"></span>
    </div>`).join("");

  S.startTime = Date.now();

  // Timer to update elapsed time
  const timer = setInterval(() => {
    const ms = Date.now() - S.startTime;
    elapsedEl.textContent = `${(ms / 1000).toFixed(1)} s`;
  }, 100);

  // Breach overrides: only sent when the user typed a value (else the
  // backend applies the failure-mode defaults).
  const bwRaw = document.getElementById("breachWidth").value.trim();
  const btRaw = document.getElementById("breachTime").value.trim();

  const params = {
    dam_id: S.dam.id, dam_name: S.dam.name, latitude: S.dam.latitude, longitude: S.dam.longitude,
    reservoir_volume_m3: (S.dam.reservoir_volume_mcm || 100) * 1e6 * (parseFloat(document.getElementById("waterLevel").value) / 100),
    dam_height_m: S.dam.dam_height_m || 30,
    failure_mode: document.getElementById("failureMode").value,
    manning_n: parseFloat(document.getElementById("manningN").value),
    total_sim_hours: parseFloat(document.getElementById("simHours").value),
    dem_type: "COP30",
    breach_width_m: bwRaw !== "" ? parseFloat(bwRaw) : null,
    breach_formation_time_min: btRaw !== "" ? parseFloat(btRaw) : null,
  };

  // Save for scenario comparison
  S.lastScenarioParams = { ...params };

  // Mark step 1 as running immediately
  markStepRunning(0, steps, stepLabel, remainEl);
  dashboard?.setCalculating();
  setDrawerStatus("running");
  syncTimeButtons();

  // Digital twin: lock the camera to the flood view (zoom + slight orbit only)
  viewer3D?.setCameraPreset("valley", 900);
  viewer3D?.setCameraLocked(true);

  try {
    // Try SSE-backed progress first
    let data;
    try {
      data = await runWithSSE(params, steps, barEl, stepLabel, remainEl);
    } catch (sseErr) {
      // Fallback to direct /simulate call
      console.warn("SSE progress unavailable, falling back to direct call:", sseErr.message);
      stepLabel.textContent = "Running (direct)...";

      const res = await fetch(`${API}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      data = await res.json();

      // Mark all steps done
      steps.forEach((s, i) => markStepDone(i, steps));
      barEl.style.width = "100%";
    }

    clearInterval(timer);

    barEl.style.width = "100%";
    stepLabel.textContent = "Complete";
    remainEl.textContent = "";
    const totalMs = Date.now() - S.startTime;
    elapsedEl.textContent = `${(totalMs / 1000).toFixed(1)} s`;

    S.simResult = data;
    showResults(data, totalMs);

    document.getElementById("sDem").textContent = "Downloaded";
    document.getElementById("sDem").classList.add("s-ok");
    if (progStepsEl) progStepsEl.style.display = "none";

  } catch (err) {
    clearInterval(timer);
    showError(err);
  } finally {
    S.simRunning = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="run-btn-text">Run Simulation</span>';
    // Release the camera back to the constrained free mode
    viewer3D?.setCameraLocked(false);
    viewer3D?.cameraManager?.recenterOrbitWindow();
  }
}

async function runWithSSE(params, steps, barEl, stepLabel, remainEl) {
  const startRes = await fetch(`${API}/simulate/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!startRes.ok) throw new Error("SSE start failed");
  const { job_id } = await startRes.json();

  return new Promise((resolve, reject) => {
    const es = new EventSource(`${API}/simulate/stream/${job_id}`);
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.error && msg.error !== null) {
          es.close();
          reject(new Error(msg.error));
          return;
        }
        const pct = ((msg.step + 1) / msg.total_steps) * 100;
        barEl.style.width = Math.min(pct, 95) + "%";
        stepLabel.textContent = `${msg.label}...`;
        remainEl.textContent = `Step ${msg.step + 1} of ${msg.total_steps}`;

        // Mark previous steps done, current as running
        for (let i = 0; i < msg.step; i++) markStepDone(i, steps);
        markStepRunning(msg.step, steps, stepLabel, remainEl);

        if (msg.done) {
          markStepDone(msg.step, steps);
        }
      } catch (e) { /* skip parse errors */ }
    };
    es.addEventListener("result", (event) => {
      es.close();
      try {
        const data = JSON.parse(event.data);
        steps.forEach((_, i) => markStepDone(i, steps));
        resolve(data);
      } catch (e) { reject(new Error("Failed to parse result")); }
    });
    es.onerror = () => {
      es.close();
      reject(new Error("SSE connection error"));
    };
  });
}

function markStepRunning(index, steps, stepLabel, remainEl) {
  const s = steps[index];
  if (!s) return;
  const el = document.getElementById(`pt-${s.id}`);
  if (!el) return;
  el.classList.add("running");
  const icon = el.querySelector(".pt-pending-icon");
  if (icon) { icon.className = ""; icon.innerHTML = '<span class="pt-spinner-icon"></span>'; }
  if (stepLabel) stepLabel.textContent = `${s.label}...`;
  if (remainEl) remainEl.textContent = `Step ${index + 1} of ${steps.length}`;
}

function markStepDone(index, steps) {
  const s = steps[index];
  if (!s) return;
  const el = document.getElementById(`pt-${s.id}`);
  if (!el) return;
  el.classList.remove("running");
  el.classList.add("done");
  const doneIcon = el.querySelector(".pt-spinner-icon") || el.querySelector(".pt-pending-icon");
  if (doneIcon) { doneIcon.className = "pt-check-icon"; doneIcon.textContent = "✓"; }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function showResults(data, simTimeMs) {
  document.getElementById("resultsSection").style.display = "block";
  document.getElementById("rStatus").textContent = "Completed";
  document.getElementById("rStatus").className = "r-value r-status r-ok";
  document.getElementById("rSimTime").textContent = `${(simTimeMs / 1000).toFixed(1)} s`;
  document.getElementById("rPeakFlow").textContent = `${data.breach?.peak_outflow_cms || "-"} m³/s`;
  document.getElementById("rFloodArea").textContent = `${data.summary?.max_inundated_area_km2 || "-"} km²`;
  document.getElementById("rMaxDepth").textContent = `${data.summary?.max_flood_depth_m || "-"} m`;
  document.getElementById("rAiReady").textContent = data.simulation_id ? "Yes" : "No";

  // Show action buttons
  document.getElementById("exportReportBtn").style.display = "inline-flex";
  document.getElementById("compareBtn").style.display = "inline-flex";

  // Update live simulation metrics (drawer remains hidden by default until toggled)
  if (dashboard) {
    dashboard.setSummary(data, simTimeMs);
  }
  setDrawerStatus("completed");
  syncTimeButtons();

  // Reset playback to frame 0 and focus the flood view
  viewer3D?.pause();
  viewer3D?.animationManager?.setFrame(0);
  syncTimeButtons();

  // Load into 3D viewport
  if (viewer3D) {
    try {
      viewer3D.loadSimulation(data);
      document.getElementById("viewportToolbar").style.display = "flex";
    } catch (vErr) {
      console.error("Viewer error:", vErr);
    }
  }
  updateMapOverlay(data);

  // Trigger AI analysis if panel is available
  if (typeof window.onAISimulationComplete === 'function') {
    window.onAISimulationComplete(data);
  }
}

function updateMapOverlay(data) {
  if (!data?.depth_grids || !map) return;
  const last = data.depth_grids[data.depth_grids.length - 1];
  const rows = last.length, cols = last[0].length;
  const canvas = document.createElement("canvas");
  canvas.width = cols; canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = last[r][c], i = (r * cols + c) * 4;
      if (d > 0.05) {
        // Precise data-driven depth coloring
        if (d <= 0.5) {
          img.data[i] = 38; img.data[i + 1] = 198; img.data[i + 2] = 218; img.data[i + 3] = 190;
        } else if (d <= 2.0) {
          img.data[i] = 33; img.data[i + 1] = 150; img.data[i + 2] = 243; img.data[i + 3] = 210;
        } else if (d <= 5.0) {
          img.data[i] = 26; img.data[i + 1] = 35; img.data[i + 2] = 126; img.data[i + 3] = 230;
        } else {
          img.data[i] = 229; img.data[i + 1] = 57; img.data[i + 2] = 53; img.data[i + 3] = 240;
        }
      } else {
        img.data[i + 3] = 0; // dry cell
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const b = data.dem_bounds;
  const bounds = b ? [[b.south, b.west], [b.north, b.east]] : [[ORIGIN_LAT - 0.3, ORIGIN_LON - 0.2], [ORIGIN_LAT + 0.1, ORIGIN_LON + 0.3]];
  if (window._floodOverlay) map.removeLayer(window._floodOverlay);
  window._floodOverlay = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 0.85 }).addTo(map);

  addMapLegend();
}

function addMapLegend() {
  if (window._mapLegend || !map) return;
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-flood-legend");
    div.innerHTML = `
      <div style="background: rgba(15, 19, 24, 0.92); border: 1px solid #2a3342; border-radius: 4px; padding: 6px 10px; color: #e8ecf0; font-family: monospace; font-size: 10px; line-height: 1.4; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
        <div style="font-weight: 600; color: #4a9eff; margin-bottom: 4px; text-transform: uppercase;">Inundation Depth</div>
        <div style="display: flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 12px; height: 10px; background: #e53935; border-radius: 2px;"></span> &gt; 5.0 m (Critical)</div>
        <div style="display: flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 12px; height: 10px; background: #1a237e; border-radius: 2px;"></span> 2.0 &ndash; 5.0 m (High)</div>
        <div style="display: flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 12px; height: 10px; background: #2196f3; border-radius: 2px;"></span> 0.5 &ndash; 2.0 m (Moderate)</div>
        <div style="display: flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 12px; height: 10px; background: #26c6da; border-radius: 2px;"></span> 0.05 &ndash; 0.5 m (Low)</div>
      </div>
    `;
    return div;
  };
  legend.addTo(map);
  window._mapLegend = legend;
}

// ---------------------------------------------------------------------------
// 3D Toolbar — shared playback helpers
// ---------------------------------------------------------------------------
function hasSimulationResults() {
  return Boolean(S.simResult);
}

/** Reflect playback state onto the play/pause button (▶ when idle, ⏸ when playing). */
function syncTimeButtons() {
  const tbPlay = document.getElementById("tbPlay");
  const tbStepBack = document.getElementById("tbStepBack");
  const tbStepFwd = document.getElementById("tbStepFwd");
  const hasResults = hasSimulationResults();

  // Playback stays disabled until a simulation result exists.
  if (tbPlay) {
    tbPlay.disabled = !hasResults;
    tbPlay.textContent = viewer3D?.playing ? "⏸" : "▶";
    tbPlay.title = viewer3D?.playing ? "Pause" : "Play";
  }
  if (tbStepBack) tbStepBack.disabled = !hasResults;
  if (tbStepFwd) tbStepFwd.disabled = !hasResults;
}

function setup3DToolbar() {
  // 1. Camera Presets: Dam, Valley, Overview, Top, Reset
  const camPresets = {
    camDam: "dam",
    camValley: "valley",
    camOverview: "overview",
    camTop: "top",
    camReset: "reset",
  };
  Object.entries(camPresets).forEach(([btnId, preset]) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    el.addEventListener("click", () => {
      document.querySelectorAll(".toolbar-view .toolbar-btn").forEach((b) => b.classList.remove("active"));
      el.classList.add("active");
      viewer3D?.setCameraPreset(preset);
    });
  });

  // 3. Layer Controls: Water, Depth, Velocity, Arrival, Risk
  const renderModes = {
    modeRealistic: "realistic",
    modeDepth: "depth",
    modeVelocity: "velocity",
    modeArrival: "arrival",
    modeRisk: "risk",
  };
  Object.entries(renderModes).forEach(([btnId, mode]) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    el.addEventListener("click", () => {
      document.querySelectorAll(".toolbar-layer .toolbar-btn").forEach((b) => b.classList.remove("active"));
      el.classList.add("active");
      viewer3D?.setColorMode(mode);
      updateHeatmapLegend(mode);
    });
  });

  // 4. Time Controls: ⏮ previous · ▶ play / ⏸ pause · ⏭ next
  const tbPlay = document.getElementById("tbPlay");
  const tbStepBack = document.getElementById("tbStepBack");
  const tbStepFwd = document.getElementById("tbStepFwd");

  tbStepBack?.addEventListener("click", () => {
    if (!viewer3D || !hasSimulationResults()) return;
    viewer3D.pause();
    viewer3D.step(-1);
    syncTimeButtons();
  });

  tbStepFwd?.addEventListener("click", () => {
    if (!viewer3D || !hasSimulationResults()) return;
    viewer3D.pause();
    viewer3D.step(1);
    syncTimeButtons();
  });

  tbPlay?.addEventListener("click", () => {
    if (!viewer3D || !hasSimulationResults()) return;
    if (viewer3D.playing) viewer3D.pause();
    else viewer3D.play();
    syncTimeButtons();
  });

  // 5. Metrics Drawer Toggle (Slides up from bottom ~25-30% screen, viewport resizes)
  const toggleMetricsBtn = document.getElementById("tbToggleMetrics");
  toggleMetricsBtn?.addEventListener("click", () => {
    viewer3D?.uiController?.toggleMetricsDrawer();
  });
  document.getElementById("drawerCloseBtn")?.addEventListener("click", () => {
    viewer3D?.uiController?.toggleMetricsDrawer(false);
  });
}

function updateHeatmapLegend(mode) {
  const legend = document.getElementById("heatmapLegend");
  const title = document.getElementById("legendTitle");
  const unit = document.getElementById("legendUnit");
  const bar = document.getElementById("legendBar");
  const labels = document.getElementById("legendLabels");
  if (!legend || !title || !unit || !bar || !labels) return;

  if (mode === "realistic") {
    legend.style.display = "none";
    return;
  }

  legend.style.display = "flex";
  if (mode === "depth") {
    title.textContent = "Water Depth";
    unit.textContent = "m";
    bar.style.background = "linear-gradient(to right, #1c5f9e, #1fb0c4, #3fae55, #f5c542, #e8791a, #8a1010)";
    labels.innerHTML = `
      <span>0m</span>
      <span>0.5m</span>
      <span>1.5m</span>
      <span>3m</span>
      <span>5m</span>
      <span>8m+</span>
    `;
  } else if (mode === "velocity") {
    title.textContent = "Flow Velocity";
    unit.textContent = "m/s";
    bar.style.background = "linear-gradient(to right, #1c5f9e, #3fae55, #f5c542, #e8791a, #c81e1e)";
    labels.innerHTML = `
      <span>0</span>
      <span>1.0</span>
      <span>2.5</span>
      <span>4.0</span>
      <span>6+ m/s</span>
    `;
  } else if (mode === "arrival") {
    title.textContent = "Arrival Time";
    unit.textContent = "rel";
    bar.style.background = "linear-gradient(to right, #e91e63, #ff9800, #ffeb3b, #4caf50, #00bcd4)";
    labels.innerHTML = `
      <span>Early (t₀)</span>
      <span>Mid</span>
      <span>Late</span>
    `;
  } else if (mode === "risk") {
    title.textContent = "Hydraulic Risk (d × v)";
    unit.textContent = "index";
    bar.style.background = "linear-gradient(to right, #4caf50, #ffeb3b, #ff9800, #f44336)";
    labels.innerHTML = `
      <span>Low (&lt;0.5)</span>
      <span>Med (1.0)</span>
      <span>High (2.5)</span>
      <span>Crit (&gt;3)</span>
    `;
  }
}

function onFrameChange(index, hours) {
  const label = document.getElementById("tbTimeLabel");
  if (label) label.textContent = `${(hours || 0).toFixed(2)} hr`;
  if (viewer3D && !viewer3D.playing) {
    document.getElementById("tbPlay").textContent = "▶";
  }
}

function onTerrainProbe(info) {
  const card = document.getElementById("probeCard");
  const text = document.getElementById("probeText");
  if (!info) { card.style.display = "none"; return; }
  card.style.display = "block";
  const velStr = (info.velocity !== null && info.velocity !== undefined)
    ? ` | Vel: ${info.velocity.toFixed(2)} m/s`
    : "";
  text.textContent = `Elev: ${info.elevation.toFixed(1)}m | Depth: ${info.depth.toFixed(2)}m${velStr} | WSE: ${info.waterSurface.toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------
async function exportReport() {
  if (!S.simResult?.simulation_id) return;
  try {
    const res = await fetch(`${API}/report/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ simulation_id: S.simResult.simulation_id }),
    });
    if (!res.ok) throw new Error("Report generation failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dam_break_report_${S.simResult.simulation_id}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Export failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Scenario Comparison
// ---------------------------------------------------------------------------
async function showCompareFlow() {
  if (!S.lastScenarioParams) { alert("Run a simulation first."); return; }
  const baseMode = S.lastScenarioParams.failure_mode;
  // Alternate against the next failure mode in the catalog (wraps around)
  const modeValues = FAILURE_MODES.map((m) => m.value);
  const altMode = modeValues[(modeValues.indexOf(baseMode) + 1) % modeValues.length] || "overtopping";

  const confirmMsg = `Compare current "${baseMode}" scenario with "${altMode}" scenario for ${S.dam?.name || "this dam"}?`;
  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById("compareBtn");
  btn.textContent = "Comparing...";
  btn.disabled = true;

  try {
    const scenarioA = { ...S.lastScenarioParams };
    const scenarioB = { ...S.lastScenarioParams, failure_mode: altMode };

    const res = await fetch(`${API}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenarios: [scenarioA, scenarioB],
        labels: [`${baseMode} (current)`, `${altMode} (comparison)`],
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Comparison failed");

    const data = await res.json();
    showCompareResults(data);
  } catch (e) {
    alert(`Comparison failed: ${e.message}`);
  } finally {
    btn.textContent = "Compare Scenarios";
    btn.disabled = false;
  }
}

function showCompareResults(data) {
  // Build comparison modal/overlay
  const overlay = document.createElement("div");
  overlay.className = "compare-overlay";
  overlay.innerHTML = `
    <div class="compare-card">
      <div class="compare-header">
        <h3>Scenario Comparison</h3>
        <button class="compare-close" onclick="this.closest('.compare-overlay').remove()">&times;</button>
      </div>
      <div class="compare-body">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Metric</th>
              ${data.scenarios.map(s => `<th>${s.label}</th>`).join("")}
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Peak Outflow</td>
              ${data.scenarios.map(s => `<td>${s.breach.peak_outflow_cms} m³/s</td>`).join("")}
              <td>${(data.scenarios[1].breach.peak_outflow_cms - data.scenarios[0].breach.peak_outflow_cms).toFixed(1)} m³/s</td>
            </tr>
            <tr>
              <td>Flood Area</td>
              ${data.scenarios.map(s => `<td>${s.summary.max_inundated_area_km2} km²</td>`).join("")}
              <td class="${data.delta.area_km2 > 0 ? 'delta-bad' : 'delta-good'}">${data.delta.area_km2 > 0 ? '+' : ''}${data.delta.area_km2} km²</td>
            </tr>
            <tr>
              <td>Max Depth</td>
              ${data.scenarios.map(s => `<td>${s.summary.max_flood_depth_m} m</td>`).join("")}
              <td class="${data.delta.peak_depth_m > 0 ? 'delta-bad' : 'delta-good'}">${data.delta.peak_depth_m > 0 ? '+' : ''}${data.delta.peak_depth_m} m</td>
            </tr>
          </tbody>
        </table>
        ${data.village_delta.length ? `
          <h4 style="margin:12px 0 8px;color:var(--text-0);font-size:13px;">Settlement Arrival Time Changes</h4>
          <table class="compare-table">
            <thead><tr><th>Settlement</th><th>Scenario A</th><th>Scenario B</th><th>Delta</th></tr></thead>
            <tbody>
              ${data.village_delta.map(v => `
                <tr>
                  <td>${v.name}</td>
                  <td>${v.arrival_a_min != null ? v.arrival_a_min + ' min' : '—'}</td>
                  <td>${v.arrival_b_min != null ? v.arrival_b_min + ' min' : '—'}</td>
                  <td class="${(v.delta_min || 0) < 0 ? 'delta-bad' : 'delta-good'}">${v.delta_min != null ? (v.delta_min > 0 ? '+' : '') + v.delta_min + ' min' : '—'}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        ` : ""}
        <div style="margin-top:12px;font-size:11px;color:var(--text-3);">Computed in ${(data.elapsed_ms / 1000).toFixed(1)} s</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------
function showError(err) {
  document.getElementById("errorSection").style.display = "block";
  let msg = err.message || "Unknown error";
  if (msg.includes("HTTP 502")) msg = "DEM download failed. Check network connection.";
  else if (msg.includes("HTTP 503")) msg = "API service unavailable.";
  else if (msg.includes("timeout")) msg = "Simulation timed out.";
  else if (msg.includes("fetch")) msg = "Network unavailable.";
  document.getElementById("errorMessage").textContent = msg;
  console.error("[Simulation Error]", err);
  dashboard?.setFailed();
  setDrawerStatus("failed");
  syncTimeButtons();
}

// ---------------------------------------------------------------------------
// Drawer status helper — Idle / Running / Completed / Failed
// ---------------------------------------------------------------------------
function setDrawerStatus(state) {
  const badge = document.getElementById("drawerStatusBadge");
  if (!badge) return;
  const map = {
    idle:      { text: "Idle",      cls: "idle" },
    running:   { text: "Running",   cls: "running" },
    completed: { text: "Completed", cls: "completed" },
    failed:    { text: "Failed",    cls: "failed" },
  };
  const s = map[state] || map.idle;
  badge.textContent = s.text;
  badge.classList.remove("idle", "running", "completed", "failed");
  badge.classList.add(s.cls);
  badge.dataset.status = state;
}

// Expose loadRivers globally for retry button
window.loadRivers = loadRivers;
