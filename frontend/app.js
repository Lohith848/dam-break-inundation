/**
 * app.js — Main application module (ES Module)
 * =================================================================
 * Map-Based Dam Break Inundation Platform (SIH Version)
 * 100% Map-Based GIS Simulation & Analysis
 * 
 * Features:
 * - Clean India startup (Zoom 5, [20.5937, 78.9629])
 * - River & Dam search with smooth flyTo animation
 * - Real-time dam-anchored flood simulation
 * - Independent GIS Map Player (Depth, Velocity, Arrival, Hazard Risk)
 * - Live Point Probe HUD on cursor inspection
 * - Downstream settlement impact tracking
 * - Government-grade PDF Report export (.pdf)
 * =================================================================
 */

// Note: Three.js 3D viewer paused for SIH Map-Only requirement. Files preserved.
// import { Flood3DViewer } from "./three_viewer.js";
import { SimulationDashboard } from "./dashboard.js";
import { API_BASE } from "./config/api.js";

const API = API_BASE;
let ORIGIN_LAT = 20.5937, ORIGIN_LON = 78.9629; // India geographic center
let map = null;
let damMarker = null;
let reservoirLayer = null;
let poiMarkersLayer = null;
let floodCanvasOverlay = null;
let floodPolygonLayer = null;
let dashboard = null;

// Global application state
let S = {
  river: null,
  dam: null,
  rivers: [],
  dams: [],
  simResult: null,
  abort: null,
  debounce: null,
  simRunning: false,
  startTime: 0,
  lastScenarioParams: null,
  userEditedBreach: { width: false, time: false },
};

// Map simulation player state
let mapPlayer = {
  frames: [],
  velocityFrames: [],
  riskFrames: [],
  framePolygons: [],
  arrivalGrid: null,
  timestepsFormatted: [],
  snapshotTimes: [],
  totalFrames: 0,
  currentFrame: 0,
  playing: false,
  speed: 1.0,
  timer: null,
  activeLayer: "depth",
  bounds: null,
  demBounds: null,
};

// ---------------------------------------------------------------------------
// Failure modes catalog
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

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initMap();

  const dashContainer = document.getElementById("dashboardContainer");
  if (dashContainer) {
    dashboard = new SimulationDashboard(dashContainer);
  }

  setupSidebarLayout();
  setupRiverSearch();
  setupDamSearch();
  setupDurationPresets();
  setupValidation();
  setupRunButton();
  setupAdvancedToggle();
  setupFailureModes();
  setupGisLayerControls();
  setupMapPlayerControls();
  setupReportModal();

  if (typeof setupAIPanel === "function") setupAIPanel();
  else if (typeof window.setupAIPanel === "function") window.setupAIPanel();

  // Startup cleanly: Load river database and prefetch initial dams list
  loadRivers();
  loadInitialDams();
});

// ---------------------------------------------------------------------------
// Leaflet Map Initialization
// ---------------------------------------------------------------------------
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl) {
    console.error("Map container #map not found");
    return;
  }

  // India Viewport: Zoom 5, centered over India
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
  }).setView([ORIGIN_LAT, ORIGIN_LON], 5);

  L.control.zoom({ position: "topleft" }).addTo(map);

  // High-resolution Esri Satellite imagery
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 18,
      attribution: "Tiles &copy; Esri &mdash; National Geographic, USGS",
    }
  ).addTo(map);

  // Reference Labels overlay
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 18,
      subdomains: "abcd",
      pane: "shadowPane",
      opacity: 0.85,
    }
  ).addTo(map);

  poiMarkersLayer = L.layerGroup().addTo(map);
  floodPolygonLayer = L.geoJSON(null, {
    style: {
      color: "#38bdf8",
      weight: 2,
      opacity: 0.95,
      fillColor: "#0284c7",
      fillOpacity: 0.18,
    }
  }).addTo(map);

  // Live Point Probe on Map Hover / Click
  map.on("mousemove", onMapHover);
  map.on("click", onMapHover);

  // Periodic size invalidations to ensure full rendering across flexbox containers
  setTimeout(() => { if (map) map.invalidateSize(); }, 150);
  setTimeout(() => { if (map) map.invalidateSize(); }, 400);
  setTimeout(() => { if (map) map.invalidateSize(); }, 1000);
  window.addEventListener("resize", () => { if (map) map.invalidateSize(); });
}

// ---------------------------------------------------------------------------
// Duration Presets
// ---------------------------------------------------------------------------
function setupDurationPresets() {
  const container = document.getElementById("durationPresets");
  const input = document.getElementById("simHours");
  if (!container || !input) return;

  container.addEventListener("click", (e) => {
    const pill = e.target.closest(".preset-pill");
    if (!pill) return;
    const hours = parseFloat(pill.dataset.hours);
    if (!isNaN(hours)) {
      input.value = hours;
      container.querySelectorAll(".preset-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      validateAll();
      if (typeof window.updateAssistantDam === "function") window.updateAssistantDam(S.dam);
    }
  });

  input.addEventListener("input", () => {
    const val = parseFloat(input.value);
    container.querySelectorAll(".preset-pill").forEach((p) => {
      p.classList.toggle("active", parseFloat(p.dataset.hours) === val);
    });
    if (typeof window.updateAssistantDam === "function") window.updateAssistantDam(S.dam);
  });
}

// ---------------------------------------------------------------------------
// Sidebar Layout (Collapse / Expand / Drag-Resize)
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
    document.getElementById("workspace")?.classList.toggle("collapsed", collapsed);
    if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    if (map) setTimeout(() => map.invalidateSize(), 260);
  };
  applyCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1", false);

  collapseBtn?.addEventListener("click", () => applyCollapsed(true));
  document.getElementById("sidebarExpandBtn")?.addEventListener("click", () => applyCollapsed(false));

  mobileBtn?.addEventListener("click", () => {
    const open = sidebar.classList.toggle("mobile-open");
    mobileBtn.classList.toggle("active", open);
  });

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
      if (map) map.invalidateSize();
    });
  }
}

// ---------------------------------------------------------------------------
// Search Utilities
// ---------------------------------------------------------------------------
function fuzzy(q, t) {
  if (!t || !q) return true;
  q = q.toLowerCase();
  t = t.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (let c of t) {
    if (c === q[i]) i++;
  }
  return i === q.length;
}

function hl(text, q) {
  if (!q || !text) return text || "";
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return text.slice(0, i) + "<mark>" + text.slice(i, i + q.length) + "</mark>" + text.slice(i + q.length);
}

function navList(list, e, onAct) {
  const items = list.querySelectorAll(".search-item");
  const act = list.querySelector(".search-item.active");
  let idx = Array.from(items).indexOf(act);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (act) act.classList.remove("active");
    idx = Math.min(idx + 1, items.length - 1);
    items[idx]?.classList.add("active");
    items[idx]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (act) act.classList.remove("active");
    idx = Math.max(idx - 1, 0);
    items[idx]?.classList.add("active");
    items[idx]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (act) onAct(act);
  } else if (e.key === "Escape") {
    e.target.blur();
    list.classList.remove("open");
  }
}

// ---------------------------------------------------------------------------
// River Search
// ---------------------------------------------------------------------------
async function loadRivers() {
  const list = document.getElementById("riverList");
  list.innerHTML = '<div class="search-loading">Loading rivers...</div>';
  try {
    const r = await fetch(`${API}/rivers`);
    const d = await r.json();
    S.rivers = (d.rivers || [])
      .filter((r) => r.dam_count > 0 && !r.name.includes("<") && !r.name.includes(">") && r.name.toLowerCase() !== "unknown river")
      .sort((a, b) => b.dam_count - a.dam_count);
    const countEl = document.getElementById("riverCount");
    if (countEl) countEl.textContent = S.rivers.length;
    renderRivers("");
  } catch (e) {
    console.error("Failed to load rivers:", e);
    list.innerHTML = '<div class="search-empty">Unable to load rivers.<button class="search-retry" onclick="loadRivers()">Retry</button></div>';
  }
}

async function loadInitialDams() {
  const status = document.getElementById("damSelectorStatus");
  try {
    const r = await fetch(`${API}/dams?max_results=80`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.dams && d.dams.length && !S.dam && !S.river) {
      S.dams = d.dams;
      if (status) status.textContent = d.count || d.dams.length;
      renderDams(S.dams, "");
    }
  } catch (e) {
    console.warn("Initial dams prefetch:", e);
  }
}

function setupRiverSearch() {
  const input = document.getElementById("riverSearch");
  const list = document.getElementById("riverList");
  const clear = document.getElementById("riverClear");

  input.addEventListener("input", () => {
    clearTimeout(S.debounce);
    S.debounce = setTimeout(() => {
      renderRivers(input.value);
      list.classList.add("open");
    }, 100);
  });
  input.addEventListener("focus", () => {
    renderRivers(input.value);
    list.classList.add("open");
  });
  input.addEventListener("click", () => {
    renderRivers(input.value);
    list.classList.add("open");
  });
  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 250));
  input.addEventListener("keydown", (e) => navList(list, e, (el) => el.click()));
  clear.addEventListener("click", (e) => {
    e.stopPropagation();
    clearRiver();
  });
}

function renderRivers(q) {
  const list = document.getElementById("riverList");
  const f = S.rivers.filter((r) => fuzzy(q, r.name));
  if (!f.length) {
    list.innerHTML = `<div class="search-empty">No rivers found${q ? ` matching "${q}"` : ""}.</div>`;
    return;
  }
  list.innerHTML = f.slice(0, 100).map((r) => `
    <div class="search-item" data-name="${r.name}">
      <span class="search-item-name">${hl(r.name, q)}</span>
      <span class="search-item-meta">${r.dam_count} dams</span>
    </div>
  `).join("");

  list.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      selectRiver(el.dataset.name);
    });
  });
}

function selectRiver(name) {
  S.river = name;
  S.dam = null;
  document.getElementById("riverSearch").value = name;
  document.getElementById("riverClear").style.display = "flex";
  document.getElementById("riverList").classList.remove("open");
  const damInput = document.getElementById("damSearch");
  damInput.disabled = false;
  damInput.value = "";
  damInput.placeholder = `Select or search ${name} dam...`;
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damList").innerHTML = "";
  hidePanels();
  resetMapSimulation();
  searchDams("", true);
}

function clearRiver() {
  S.river = null;
  S.dam = null;
  document.getElementById("riverSearch").value = "";
  document.getElementById("riverClear").style.display = "none";
  document.getElementById("damSearch").value = "";
  document.getElementById("damSearch").placeholder = "Search all dams...";
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damList").innerHTML = "";
  clearDamMarkers();
  resetMapSimulation();
  hidePanels();
  if (map) map.flyTo([ORIGIN_LAT, ORIGIN_LON], 5, { duration: 1.5 });
  loadInitialDams();
}

function hidePanels() {
  ["summarySection", "paramsSection", "progressSection", "resultsSection", "errorSection"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

// ---------------------------------------------------------------------------
// Dam Search
// ---------------------------------------------------------------------------
function setupDamSearch() {
  const input = document.getElementById("damSearch");
  const list = document.getElementById("damList");
  const clear = document.getElementById("damClear");

  input.addEventListener("input", () => {
    clearTimeout(S.debounce);
    S.debounce = setTimeout(() => {
      searchDams(input.value, true);
    }, 150);
  });
  input.addEventListener("focus", () => {
    searchDams(input.value, true);
  });
  input.addEventListener("click", () => {
    searchDams(input.value, true);
  });
  input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 250));
  input.addEventListener("keydown", (e) => navList(list, e, (el) => el.click()));
  clear.addEventListener("click", (e) => {
    e.stopPropagation();
    clearDam();
  });
}

async function searchDams(q, autoOpen = false) {
  const list = document.getElementById("damList");
  const status = document.getElementById("damSelectorStatus");
  if (S.abort) S.abort.abort();
  S.abort = new AbortController();
  list.innerHTML = '<div class="search-loading">Searching dams...</div>';
  if (autoOpen) list.classList.add("open");

  try {
    let url = S.river ? `${API}/rivers/${encodeURIComponent(S.river)}/dams` : `${API}/dams?max_results=200`;
    if (q) url += (url.includes("?") ? "&" : "?") + `q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { signal: S.abort.signal });
    const d = await r.json();
    S.dams = d.dams || [];
    if (status) status.textContent = d.count || S.dams.length;
    renderDams(S.dams, q);
    if (autoOpen) list.classList.add("open");

    // When a river is selected, plot all its dams on the map as interactive markers
    if (S.river && S.dams.length && !S.dam && poiMarkersLayer) {
      poiMarkersLayer.clearLayers();
      const coords = [];
      S.dams.forEach((dm) => {
        if (dm.latitude && dm.longitude) {
          coords.push([dm.latitude, dm.longitude]);
          const pin = L.circleMarker([dm.latitude, dm.longitude], {
            radius: 8,
            fillColor: "#0284c7",
            color: "#ffffff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.85,
          }).addTo(poiMarkersLayer);
          pin.bindPopup(`
            <div style="font-family: var(--font-ui); padding: 4px;">
              <div style="font-weight: 700; color: #0b3d59; font-size: 12px;">${dm.name}</div>
              <div style="color: #666; font-size: 11px;">River: ${dm.river || S.river} | State: ${dm.state || "N/A"}</div>
              <div style="color: #333; font-size: 11px; margin-top: 2px;">Height: <b>${dm.dam_height_m || 30} m</b></div>
            </div>
          `);
          pin.on("click", () => selectDam(dm));
        }
      });
      if (coords.length && map) {
        if (coords.length === 1) {
          map.setView(coords[0], 11);
        } else {
          map.fitBounds(coords, { padding: [50, 50], maxZoom: 11 });
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    list.innerHTML = '<div class="search-empty">Unable to load dams.<button class="search-retry" onclick="searchDams(\'\', true)">Retry</button></div>';
  }
}

function renderDams(dams, q) {
  const list = document.getElementById("damList");
  if (!dams.length) {
    list.innerHTML = `<div class="search-empty">No dams found${q ? ` matching "${q}"` : ""}.</div>`;
    return;
  }
  list.innerHTML = dams.slice(0, 80).map((d) => `
    <div class="search-item" data-id="${d.id}">
      <div class="search-item-name">${hl(d.name, q)}</div>
      <div class="search-item-meta">${d.river || "Unknown River"} | ${d.state || ""} ${d.dam_height_m ? "| " + d.dam_height_m + "m" : ""}</div>
    </div>
  `).join("");

  list.querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const dam = S.dams.find((d) => d.id === el.dataset.id);
      if (dam) selectDam(dam);
    });
  });
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

  dashboard?.reset();
  setDrawerStatus("idle");

  // Reset any running playback
  resetMapSimulation();

  // Smooth camera flight to the selected dam
  map.flyTo([dam.latitude, dam.longitude], 13, { duration: 1.8 });

  // Clear previous dam marker & reservoir
  clearDamMarkers();

  // Create pulsing Dam marker (Strictly NO emojis)
  const damPulseIcon = L.divIcon({
    className: "dam-marker-wrap",
    html: '<div class="dam-pulse-marker"><div class="dam-pulse-ring"></div><div class="dam-pulse-circle"></div></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  damMarker = L.marker([dam.latitude, dam.longitude], { icon: damPulseIcon }).addTo(map)
    .bindPopup(`
      <div style="font-family: var(--font-ui); padding: 4px;">
        <div style="font-weight: 700; color: #0b3d59; font-size: 13px;">${dam.name}</div>
        <div style="color: #666; font-size: 11px; margin-top: 2px;">River: ${dam.river || "Unknown"} | State: ${dam.state || "N/A"}</div>
        <div style="color: #444; font-size: 11px; margin-top: 4px;">Height: <b>${dam.dam_height_m || 30} m</b> | Capacity: <b>${dam.reservoir_volume_mcm || 100} MCM</b></div>
      </div>
    `).openPopup();

  // Draw reservoir estimation perimeter buffer circle
  const volMcm = dam.reservoir_volume_mcm || 100;
  const radiusMeters = Math.min(4500, Math.max(900, Math.sqrt(volMcm) * 160));
  reservoirLayer = L.circle([dam.latitude, dam.longitude], {
    radius: radiusMeters,
    color: "#0284c7",
    weight: 2,
    dashArray: "4, 6",
    fillColor: "#38bdf8",
    fillOpacity: 0.18,
  }).addTo(map);

  // Fetch live meteorological rainfall
  fetchLiveRainfall(dam.latitude, dam.longitude);

  // Sync with floating assistant
  if (typeof window.updateAssistantDam === "function") {
    window.updateAssistantDam(dam);
  }
}

function clearDam() {
  S.dam = null;
  document.getElementById("damSearch").value = "";
  document.getElementById("damClear").style.display = "none";
  document.getElementById("damSelectorStatus").textContent = "";
  clearDamMarkers();
  resetMapSimulation();
  hidePanels();
  if (typeof window.updateAssistantDam === "function") {
    window.updateAssistantDam(null);
  }
}

function clearDamMarkers() {
  if (damMarker) {
    map.removeLayer(damMarker);
    damMarker = null;
  }
  if (reservoirLayer) {
    map.removeLayer(reservoirLayer);
    reservoirLayer = null;
  }
  if (poiMarkersLayer) {
    poiMarkersLayer.clearLayers();
  }
}

function resetMapSimulation() {
  pausePlayback();
  mapPlayer.totalFrames = 0;
  mapPlayer.currentFrame = 0;
  mapPlayer.frames = [];
  mapPlayer.velocityFrames = [];
  mapPlayer.riskFrames = [];
  mapPlayer.framePolygons = [];
  mapPlayer.arrivalGrid = null;

  if (floodCanvasOverlay) {
    map.removeLayer(floodCanvasOverlay);
    floodCanvasOverlay = null;
  }
  if (floodPolygonLayer) {
    floodPolygonLayer.clearLayers();
  }
  if (poiMarkersLayer) {
    poiMarkersLayer.clearLayers();
  }

  const hud = document.getElementById("gisPlayerHud");
  if (hud) hud.style.display = "none";
  const legend = document.getElementById("gisLegendCard");
  if (legend) legend.style.display = "none";
  const probe = document.getElementById("gisProbeHud");
  if (probe) probe.style.display = "none";
}

// ---------------------------------------------------------------------------
// Weather / Rainfall
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
  document.getElementById("sDem").textContent = "Ready";
  document.getElementById("sDem").className = "s-value s-ok";
  document.getElementById("sRes").textContent = "30 m";
  document.getElementById("sRuntime").textContent = `~${estimateRuntime(dam)} s`;
}

function estimateRuntime(dam) {
  const vol = dam.reservoir_volume_mcm || 100;
  if (vol < 10) return 4;
  if (vol < 100) return 6;
  if (vol < 1000) return 9;
  return 12;
}

// ---------------------------------------------------------------------------
// Failure Modes
// ---------------------------------------------------------------------------
function setupFailureModes() {
  const select = document.getElementById("failureMode");
  const hint = document.getElementById("failureModeHint");
  if (!select) return;

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
    if (typeof window.updateAssistantDam === "function") window.updateAssistantDam(S.dam);
  });

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
      select.value = previous;
      showFailureModeDescription(select.value);
      if (!S.userEditedBreach.width && !S.userEditedBreach.time) {
        applyFailureModeDefaults(select.value, true);
      }
      if (hint) hint.textContent = "How the dam breach initiates";
    })
    .catch(() => {
      if (hint) hint.textContent = "How the dam breach initiates (offline defaults)";
    });
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

  if (timeEl && (force || !S.userEditedBreach.time)) {
    timeEl.value = d.breach_formation_time_min ?? "";
  }
  if (widthEl && (force || !S.userEditedBreach.width)) {
    if (d.auto_breach_width) {
      widthEl.value = "";
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
  ["waterLevel", "manningN", "rainfall", "simHours", "breachWidth", "breachTime"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", validateAll);
  });
}

function setupAdvancedToggle() {
  const toggle = document.getElementById("advancedToggle");
  const panel = document.getElementById("advancedPanel");
  toggle?.addEventListener("click", () => {
    toggle.classList.toggle("open");
    panel.classList.toggle("open");
  });
}

function validateAll() {
  if (!S.dam) return;
  let valid = true;
  const errors = {};

  const wl = parseFloat(document.getElementById("waterLevel").value);
  if (isNaN(wl) || wl < 10 || wl > 100) {
    errors.waterLevel = "Must be 10–100%";
    valid = false;
  }

  const rf = parseFloat(document.getElementById("rainfall").value);
  if (isNaN(rf) || rf < 0) {
    errors.rainfall = "Must be ≥ 0";
    valid = false;
  }

  const dur = parseFloat(document.getElementById("simHours").value);
  if (isNaN(dur) || dur <= 0 || dur > 24) {
    errors.simHours = "Must be 0.5–24 hours";
    valid = false;
  }

  const bw = document.getElementById("breachWidth").value;
  if (bw && (isNaN(parseFloat(bw)) || parseFloat(bw) <= 0)) {
    errors.breachWidth = "Must be positive";
    valid = false;
  }

  const bt = document.getElementById("breachTime").value;
  if (bt && (isNaN(parseFloat(bt)) || parseFloat(bt) <= 0)) {
    errors.breachTime = "Must be positive";
    valid = false;
  }

  Object.keys(errors).forEach((k) => {
    const el = document.getElementById("err" + k.charAt(0).toUpperCase() + k.slice(1));
    const input = document.getElementById(k);
    if (el) el.textContent = errors[k];
    if (input) input.classList.toggle("field-input-error", !!errors[k]);
  });

  const runBtn = document.getElementById("runBtn");
  if (runBtn) runBtn.disabled = !valid;
}

// ---------------------------------------------------------------------------
// Run Simulation Execution
// ---------------------------------------------------------------------------
function setupRunButton() {
  document.getElementById("runBtn")?.addEventListener("click", runSimulation);
  document.getElementById("retryBtn")?.addEventListener("click", runSimulation);
  document.getElementById("exportReportBtn")?.addEventListener("click", exportReport);
}

async function runSimulation() {
  if (!S.dam || S.simRunning) return;
  S.simRunning = true;

  const btn = document.getElementById("runBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="run-spinner"></span><span class="run-btn-text">Computing Hydrodynamics...</span>';

  document.getElementById("progressSection").style.display = "block";
  document.getElementById("resultsSection").style.display = "none";
  document.getElementById("errorSection").style.display = "none";

  const steps = [
    { id: "dem", label: "Acquire DEM" },
    { id: "terrain", label: "Analyze Downstream Slope" },
    { id: "breach", label: "Breach Hydrograph" },
    { id: "routing", label: "Routing Shallow Water Equations" },
    { id: "hazard", label: "Compute Inundation & Risk" },
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
    </div>
  `).join("");

  S.startTime = Date.now();
  const timer = setInterval(() => {
    const ms = Date.now() - S.startTime;
    elapsedEl.textContent = `${(ms / 1000).toFixed(1)} s`;
  }, 100);

  const bwRaw = document.getElementById("breachWidth").value.trim();
  const btRaw = document.getElementById("breachTime").value.trim();

  const params = {
    dam_id: S.dam.id,
    dam_name: S.dam.name,
    latitude: S.dam.latitude,
    longitude: S.dam.longitude,
    reservoir_volume_m3: (S.dam.reservoir_volume_mcm || 100) * 1e6 * (parseFloat(document.getElementById("waterLevel").value) / 100),
    dam_height_m: S.dam.dam_height_m || 30,
    failure_mode: document.getElementById("failureMode").value,
    manning_n: parseFloat(document.getElementById("manningN").value),
    total_sim_hours: parseFloat(document.getElementById("simHours").value),
    dem_type: "COP30",
    breach_width_m: bwRaw !== "" ? parseFloat(bwRaw) : null,
    breach_formation_time_min: btRaw !== "" ? parseFloat(btRaw) : null,
  };

  S.lastScenarioParams = { ...params };
  setDrawerStatus("running");
  markStepRunning(0, steps, stepLabel, remainEl);

  try {
    let data;
    try {
      data = await runWithSSE(params, steps, barEl, stepLabel, remainEl);
    } catch (sseErr) {
      console.warn("SSE progress stream unavailable, falling back to direct /simulate:", sseErr.message);
      stepLabel.textContent = "Solving 2D Shallow Water Equations...";

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
      steps.forEach((_, i) => markStepDone(i, steps));
      barEl.style.width = "100%";
    }

    clearInterval(timer);
    barEl.style.width = "100%";
    stepLabel.textContent = "Simulation Completed";
    remainEl.textContent = "";
    const totalMs = Date.now() - S.startTime;
    elapsedEl.textContent = `${(totalMs / 1000).toFixed(1)} s`;

    S.simResult = data;
    showResults(data, totalMs);
  } catch (err) {
    clearInterval(timer);
    showError(err);
  } finally {
    S.simRunning = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="run-btn-text">Run Simulation</span>';
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
        if (msg.error) {
          es.close();
          reject(new Error(msg.error));
          return;
        }
        const pct = ((msg.step + 1) / msg.total_steps) * 100;
        barEl.style.width = Math.min(pct, 96) + "%";
        stepLabel.textContent = `${msg.label}...`;
        remainEl.textContent = `Step ${msg.step + 1} of ${msg.total_steps}`;

        for (let i = 0; i < msg.step; i++) markStepDone(i, steps);
        markStepRunning(msg.step, steps, stepLabel, remainEl);
        if (msg.done) markStepDone(msg.step, steps);
      } catch (e) {}
    };
    es.addEventListener("result", (event) => {
      es.close();
      try {
        const data = JSON.parse(event.data);
        steps.forEach((_, i) => markStepDone(i, steps));
        resolve(data);
      } catch (e) {
        reject(new Error("Failed to parse result"));
      }
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
  if (icon) {
    icon.className = "";
    icon.innerHTML = '<span class="pt-spinner-icon"></span>';
  }
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
  if (doneIcon) {
    doneIcon.className = "pt-check-icon";
    doneIcon.textContent = "✓";
  }
}

// ---------------------------------------------------------------------------
// Results Handling & Map Player Initialization
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

  document.getElementById("exportReportBtn").style.display = "inline-flex";

  if (dashboard) {
    dashboard.setSummary(data, simTimeMs);
  }
  setDrawerStatus("completed");

  // Load simulation data into the Map Player
  initMapPlayer(data);

  // Render live hydrograph chart
  initHydrograph(data);

  // Trigger AI Copilot completion callback if loaded
  if (typeof window.onAISimulationComplete === "function") {
    window.onAISimulationComplete(data);
  }
}

// ---------------------------------------------------------------------------
// GIS Map Simulation Player (Dam-Anchored, Strictly NO Emojis)
// ---------------------------------------------------------------------------
function initMapPlayer(data) {
  mapPlayer.frames = data.depth_grids || [];
  mapPlayer.velocityFrames = data.velocity_grids || [];
  mapPlayer.riskFrames = data.risk_grids || [];
  mapPlayer.framePolygons = data.frame_polygons || [];
  mapPlayer.arrivalGrid = data.arrival_grid || null;
  mapPlayer.timestepsFormatted = data.timesteps_formatted || [];
  mapPlayer.snapshotTimes = data.snapshot_times_s || [];
  mapPlayer.totalFrames = mapPlayer.frames.length;
  mapPlayer.currentFrame = 0;
  mapPlayer.demBounds = data.dem_bounds;

  // Derive geographical bounding box
  if (data.dem_bounds) {
    const b = data.dem_bounds;
    mapPlayer.bounds = [[b.south, b.west], [b.north, b.east]];
  } else {
    const lat = data.dam_location?.latitude || S.dam.latitude;
    const lon = data.dam_location?.longitude || S.dam.longitude;
    mapPlayer.bounds = [[lat - 0.25, lon - 0.15], [lat + 0.1, lon + 0.35]];
  }

  // Setup timeline slider
  const slider = document.getElementById("playerTimeline");
  if (slider) {
    slider.min = 0;
    slider.max = Math.max(0, mapPlayer.totalFrames - 1);
    slider.value = 0;
  }

  // Show player HUD and active layer legend
  document.getElementById("gisPlayerHud").style.display = "block";
  document.getElementById("gisLegendCard").style.display = "block";
  updateGisLegend(mapPlayer.activeLayer);

  // Clear any marker addons so the flood polygon on map is clean with no addons
  if (poiMarkersLayer) poiMarkersLayer.clearLayers();

  // Clear any existing overlay from prior simulation
  if (floodCanvasOverlay) {
    map.removeLayer(floodCanvasOverlay);
    floodCanvasOverlay = null;
  }
  if (floodPolygonLayer) {
    floodPolygonLayer.clearLayers();
  }

  // Smoothly fit map to the simulation bounding box so the flood wave is in clear view
  if (mapPlayer.bounds && map) {
    map.fitBounds(mapPlayer.bounds, { padding: [40, 40], maxZoom: 14 });
  }

  // Render initial frame strictly at dam
  renderMapFrame(0);

  // Auto-play preview
  startPlayback();
}

function setupGisLayerControls() {
  const group = document.getElementById("layerBtnGroup");
  if (!group) return;

  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".gis-layer-btn");
    if (!btn) return;
    const layer = btn.dataset.layer;
    if (!layer || layer === mapPlayer.activeLayer) return;

    group.querySelectorAll(".gis-layer-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    mapPlayer.activeLayer = layer;
    updateGisLegend(layer);
    renderMapFrame(mapPlayer.currentFrame);
  });
}

function updateGisLegend(layer) {
  const title = document.getElementById("gisLegendTitle");
  const bar = document.getElementById("gisLegendBar");
  const labels = document.getElementById("gisLegendLabels");
  if (!title || !bar || !labels) return;

  if (layer === "depth") {
    title.textContent = "Water Depth (m)";
    bar.style.background = "linear-gradient(to right, #26c6da, #2196f3, #1565c0, #e65100, #d50000)";
    labels.innerHTML = "<span>0.1m</span><span>1.0m</span><span>2.5m</span><span>4.0m</span><span>&gt;5.0m</span>";
  } else if (layer === "velocity") {
    title.textContent = "Flow Velocity (m/s)";
    bar.style.background = "linear-gradient(to right, #4caf50, #fbc02d, #f57c00, #d32f2f)";
    labels.innerHTML = "<span>0.2</span><span>1.5</span><span>3.0</span><span>&gt;4.5 m/s</span>";
  } else if (layer === "arrival") {
    title.textContent = "Arrival Time (min)";
    bar.style.background = "linear-gradient(to right, #e91e63, #ff9800, #ffeb3b, #4caf50, #00bcd4)";
    labels.innerHTML = "<span>0 min</span><span>30 min</span><span>60 min</span><span>120+ min</span>";
  } else if (layer === "risk") {
    title.textContent = "Hazard Risk (D × V)";
    bar.style.background = "linear-gradient(to right, #34d399, #38bdf8, #f59e0b, #ef4444)";
    labels.innerHTML = "<span>Low</span><span>Moderate</span><span>High</span><span>Critical</span>";
  }
}

function setupMapPlayerControls() {
  const playBtn = document.getElementById("playerPlayBtn");
  const prevBtn = document.getElementById("playerPrevBtn");
  const nextBtn = document.getElementById("playerNextBtn");
  const slider = document.getElementById("playerTimeline");
  const speedGroup = document.querySelector(".player-speed-group");

  playBtn?.addEventListener("click", () => {
    if (mapPlayer.playing) pausePlayback();
    else startPlayback();
  });

  prevBtn?.addEventListener("click", () => {
    pausePlayback();
    const prev = (mapPlayer.currentFrame - 1 + mapPlayer.totalFrames) % mapPlayer.totalFrames;
    renderMapFrame(prev);
  });

  nextBtn?.addEventListener("click", () => {
    pausePlayback();
    const next = (mapPlayer.currentFrame + 1) % mapPlayer.totalFrames;
    renderMapFrame(next);
  });

  slider?.addEventListener("input", (e) => {
    pausePlayback();
    const idx = parseInt(e.target.value, 10);
    renderMapFrame(idx);
  });

  speedGroup?.addEventListener("click", (e) => {
    const btn = e.target.closest(".speed-btn");
    if (!btn) return;
    const spd = parseFloat(btn.dataset.speed);
    if (!isNaN(spd)) {
      mapPlayer.speed = spd;
      speedGroup.querySelectorAll(".speed-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (mapPlayer.playing) {
        pausePlayback();
        startPlayback();
      }
    }
  });
}

function startPlayback() {
  if (!mapPlayer.totalFrames) return;
  mapPlayer.playing = true;
  document.getElementById("playIcon").style.display = "none";
  document.getElementById("pauseIcon").style.display = "block";

  clearInterval(mapPlayer.timer);
  const intervalMs = Math.max(80, Math.round(600 / mapPlayer.speed));
  mapPlayer.timer = setInterval(() => {
    const next = (mapPlayer.currentFrame + 1) % mapPlayer.totalFrames;
    renderMapFrame(next);
  }, intervalMs);
}

function pausePlayback() {
  mapPlayer.playing = false;
  document.getElementById("playIcon").style.display = "block";
  document.getElementById("pauseIcon").style.display = "none";
  clearInterval(mapPlayer.timer);
}

function renderMapFrame(frameIdx) {
  if (!mapPlayer.totalFrames || frameIdx < 0 || frameIdx >= mapPlayer.totalFrames) return;
  mapPlayer.currentFrame = frameIdx;

  // Update slider & labels
  const slider = document.getElementById("playerTimeline");
  if (slider) slider.value = frameIdx;

  const timeLabel = mapPlayer.timestepsFormatted[frameIdx] || `${(frameIdx * 0.25).toFixed(2)}h`;
  document.getElementById("playerTimestamp").textContent = timeLabel;
  document.getElementById("playerFrameBadge").textContent = `Frame ${frameIdx + 1} / ${mapPlayer.totalFrames}`;

  // Sync hydrograph scrubber to current playback frame
  syncHydrographScrubber(frameIdx);

  // Update crisp GeoJSON flood boundary polygon
  if (floodPolygonLayer) {
    floodPolygonLayer.clearLayers();
    const framePoly = mapPlayer.framePolygons ? mapPlayer.framePolygons[frameIdx] : null;
    if (framePoly && framePoly.coordinates && framePoly.coordinates.length > 0) {
      let strokeColor = "#38bdf8";
      let fillColor = "#0284c7";
      if (mapPlayer.activeLayer === "risk") {
        strokeColor = "#f59e0b";
        fillColor = "#ef4444";
      } else if (mapPlayer.activeLayer === "velocity") {
        strokeColor = "#f57c00";
        fillColor = "#ea580c";
      }
      floodPolygonLayer.addData(framePoly);
      floodPolygonLayer.setStyle({
        color: strokeColor,
        weight: 2,
        opacity: 0.95,
        fillColor: fillColor,
        fillOpacity: 0.18,
      });
    }
  }

  // Generate dynamic canvas texture for this frame
  const depthGrid = mapPlayer.frames[frameIdx];
  const velGrid = mapPlayer.velocityFrames[frameIdx];
  const riskGrid = mapPlayer.riskFrames[frameIdx];

  if (!depthGrid || !depthGrid.length) return;
  const rows = depthGrid.length;
  const cols = depthGrid[0].length;

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = depthGrid[r][c];
      const v = velGrid ? velGrid[r][c] : 0;
      const rk = riskGrid ? riskGrid[r][c] : 0;
      const i = (r * cols + c) * 4;

      if (d > 0.05) {
        if (mapPlayer.activeLayer === "depth") {
          // Dynamic calculated depth color ramp (Critical levels clearly distinct)
          if (d <= 0.5) {
            img.data[i] = 38; img.data[i + 1] = 198; img.data[i + 2] = 218; img.data[i + 3] = 190;
          } else if (d <= 1.5) {
            img.data[i] = 33; img.data[i + 1] = 150; img.data[i + 2] = 243; img.data[i + 3] = 210;
          } else if (d <= 3.0) {
            img.data[i] = 21; img.data[i + 1] = 101; img.data[i + 2] = 192; img.data[i + 3] = 230;
          } else if (d <= 5.0) {
            img.data[i] = 230; img.data[i + 1] = 81; img.data[i + 2] = 0; img.data[i + 3] = 240;
          } else {
            // Critical depth (> 5m)
            img.data[i] = 213; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
          }
        } else if (mapPlayer.activeLayer === "velocity") {
          // Dynamic flow velocity coloring
          if (v <= 1.0) {
            img.data[i] = 76; img.data[i + 1] = 175; img.data[i + 2] = 80; img.data[i + 3] = 190;
          } else if (v <= 2.5) {
            img.data[i] = 251; img.data[i + 1] = 192; img.data[i + 2] = 45; img.data[i + 3] = 210;
          } else if (v <= 4.0) {
            img.data[i] = 245; img.data[i + 1] = 124; img.data[i + 2] = 0; img.data[i + 3] = 235;
          } else {
            img.data[i] = 211; img.data[i + 1] = 47; img.data[i + 2] = 47; img.data[i + 3] = 250;
          }
        } else if (mapPlayer.activeLayer === "risk") {
          // Dynamic depth x velocity hazard coloring
          if (rk === 4) {
            // Critical hazard
            img.data[i] = 239; img.data[i + 1] = 68; img.data[i + 2] = 68; img.data[i + 3] = 250;
          } else if (rk === 3) {
            // High hazard
            img.data[i] = 245; img.data[i + 1] = 158; img.data[i + 2] = 11; img.data[i + 3] = 230;
          } else if (rk === 2) {
            // Moderate hazard
            img.data[i] = 56; img.data[i + 1] = 189; img.data[i + 2] = 248; img.data[i + 3] = 210;
          } else {
            // Low hazard
            img.data[i] = 52; img.data[i + 1] = 211; img.data[i + 2] = 153; img.data[i + 3] = 190;
          }
        } else if (mapPlayer.activeLayer === "arrival") {
          // Arrival time wavefront
          const arr = mapPlayer.arrivalGrid ? mapPlayer.arrivalGrid[r][c] : 0;
          if (arr <= 30) {
            img.data[i] = 233; img.data[i + 1] = 30; img.data[i + 2] = 99; img.data[i + 3] = 220;
          } else if (arr <= 60) {
            img.data[i] = 255; img.data[i + 1] = 152; img.data[i + 2] = 0; img.data[i + 3] = 210;
          } else {
            img.data[i] = 0; img.data[i + 1] = 188; img.data[i + 2] = 212; img.data[i + 3] = 190;
          }
        }
      } else {
        img.data[i + 3] = 0; // dry terrain cell
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  const dataUrl = canvas.toDataURL();

  if (floodCanvasOverlay) {
    floodCanvasOverlay.setUrl(dataUrl);
  } else {
    floodCanvasOverlay = L.imageOverlay(dataUrl, mapPlayer.bounds, { opacity: 0.88 }).addTo(map);
  }
}

function plotSettlementPOIs(pois) {
  // Deliberately empty: Polygon on map is strictly clean with NO addons (no village/settlement markers).
  if (poiMarkersLayer) {
    poiMarkersLayer.clearLayers();
  }
}


// ---------------------------------------------------------------------------
// Live Map Point Probe HUD
// ---------------------------------------------------------------------------
function onMapHover(e) {
  if (!mapPlayer.totalFrames || !mapPlayer.bounds || !mapPlayer.demBounds) {
    document.getElementById("gisProbeHud").style.display = "none";
    return;
  }

  const b = mapPlayer.demBounds;
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;

  if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) {
    document.getElementById("gisProbeHud").style.display = "none";
    return;
  }

  const depthGrid = mapPlayer.frames[mapPlayer.currentFrame];
  if (!depthGrid) return;
  const rows = depthGrid.length;
  const cols = depthGrid[0].length;

  const r = Math.floor(((b.north - lat) / (b.north - b.south)) * rows);
  const c = Math.floor(((lon - b.west) / (b.east - b.west)) * cols);

  if (r < 0 || r >= rows || c < 0 || c >= cols) {
    document.getElementById("gisProbeHud").style.display = "none";
    return;
  }

  const d = depthGrid[r][c];
  const v = mapPlayer.velocityFrames[mapPlayer.currentFrame] ? mapPlayer.velocityFrames[mapPlayer.currentFrame][r][c] : 0;
  const rk = mapPlayer.riskFrames[mapPlayer.currentFrame] ? mapPlayer.riskFrames[mapPlayer.currentFrame][r][c] : 0;
  const arr = mapPlayer.arrivalGrid ? mapPlayer.arrivalGrid[r][c] : -1;

  const hud = document.getElementById("gisProbeHud");
  hud.style.display = "block";
  document.getElementById("probeDepthVal").textContent = `${d.toFixed(2)} m`;
  document.getElementById("probeVelVal").textContent = `${v.toFixed(2)} m/s`;
  document.getElementById("probeRiskVal").textContent = rk === 4 ? "Critical" : rk === 3 ? "High" : rk === 2 ? "Moderate" : d > 0.05 ? "Low" : "Dry";
  document.getElementById("probeArrivalVal").textContent = arr > 0 ? `${arr} min` : d > 0.05 ? "Submerged" : "—";
  document.getElementById("probeCoordsVal").textContent = `${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`;
}

// ---------------------------------------------------------------------------
// PDF Report Export (.pdf Format)
// ---------------------------------------------------------------------------
async function downloadPdf(simId) {
  if (!simId) return;

  const reportBtn = document.getElementById("exportReportBtn");
  const modalDownloadBtn = document.getElementById("reportModalDownloadBtn");

  if (reportBtn) reportBtn.textContent = "Generating PDF...";
  if (modalDownloadBtn) modalDownloadBtn.innerHTML = '<span class="run-spinner"></span> Generating Official PDF...';

  try {
    const res = await fetch(`${API}/report/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ simulation_id: simId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    const damName = S.dam?.name || S.simResult?.dam_name || "Dam";
    const safeDamName = damName.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const disp = res.headers.get("Content-Disposition");
    let filename = `${safeDamName}_Dam_Break_Report.pdf`;
    if (disp && disp.includes("filename=")) {
      const m = disp.match(/filename=["']?([^"';]+)["']?/);
      if (m && m[1]) filename = m[1];
    }
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("PDF Export failed:", e);
    alert(`Failed to download PDF report: ${e.message}`);
  } finally {
    if (reportBtn) reportBtn.textContent = "Export Report";
    if (modalDownloadBtn) modalDownloadBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download Official PDF Report (.pdf)
    `;
  }
}

async function exportReport() {
  if (!S.simResult) return;
  showReportModal(S.simResult);
  if (S.simResult.simulation_id) {
    downloadPdf(S.simResult.simulation_id);
  }
}

function setupReportModal() {
  const modal = document.getElementById("reportModal");
  const closeBtn = document.getElementById("reportModalClose");
  const footerCloseBtn = document.getElementById("reportModalCloseBtn");
  const downloadBtn = document.getElementById("reportModalDownloadBtn");

  closeBtn?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  footerCloseBtn?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
  downloadBtn?.addEventListener("click", () => {
    if (S.simResult?.simulation_id) {
      downloadPdf(S.simResult.simulation_id);
    }
  });
}

function showReportModal(data) {
  const modal = document.getElementById("reportModal");
  const body = document.getElementById("reportModalBody");
  if (!modal || !body) return;

  const breach = data.breach || {};
  const summary = data.summary || {};
  const hyd = data.hydraulic_parameters || {};
  const pois = summary.points_of_interest || [];

  body.innerHTML = `
    <div style="font-family: var(--font-ui); color: var(--text-1);">
      <div style="background: var(--surface-2); border: 1px solid var(--border-1); border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;">
        <div style="font-size: 16px; font-weight: 700; color: var(--text-0);">${data.dam_name || "Dam"} — Dam Break Simulation</div>
        <div style="font-size: 11px; color: var(--text-3); margin-top: 2px;">Failure Mode: <b style="text-transform: capitalize; color: var(--text-1);">${data.failure_mode}</b> | Simulation ID: <code style="font-family: var(--font-mono);">${data.simulation_id}</code></div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px;">
        <div style="background: var(--surface-0); border: 1px solid var(--border-1); padding: 10px; border-radius: 6px;">
          <div style="font-size: 10px; text-transform: uppercase; color: var(--text-3);">Peak Breach Outflow</div>
          <div style="font-size: 18px; font-weight: 700; color: var(--sonar); font-family: var(--font-mono);">${breach.peak_outflow_cms || "—"} m³/s</div>
        </div>
        <div style="background: var(--surface-0); border: 1px solid var(--border-1); padding: 10px; border-radius: 6px;">
          <div style="font-size: 10px; text-transform: uppercase; color: var(--text-3);">Max Inundated Area</div>
          <div style="font-size: 18px; font-weight: 700; color: var(--text-0); font-family: var(--font-mono);">${summary.max_inundated_area_km2 || "—"} km²</div>
        </div>
        <div style="background: var(--surface-0); border: 1px solid var(--border-1); padding: 10px; border-radius: 6px;">
          <div style="font-size: 10px; text-transform: uppercase; color: var(--text-3);">Max Flood Depth</div>
          <div style="font-size: 18px; font-weight: 700; color: var(--alert); font-family: var(--font-mono);">${summary.max_flood_depth_m || "—"} m</div>
        </div>
      </div>

      <h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-2); margin-bottom: 8px;">Downstream Hydrologic Corridor Assessment</h4>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px;">
        <div style="background: var(--surface-2); border: 1px solid var(--border-1); padding: 10px; border-radius: 6px;">
          <div style="font-size: 10px; color: var(--text-3); text-transform: uppercase;">Facility & River Basin</div>
          <div style="font-size: 13px; font-weight: 600; color: var(--text-0); margin-top: 2px;">${S.dam?.name || data.dam_name || "Dam"} (${S.dam?.river || data.river || "River Reach"})</div>
          <div style="font-size: 11px; color: var(--text-2); margin-top: 2px;">${S.dam?.state || data.state || "National"} · ${S.dam?.latitude ? S.dam.latitude.toFixed(4) + '°N, ' + S.dam.longitude.toFixed(4) + '°E' : 'GIS Origin'}</div>
        </div>
        <div style="background: var(--surface-2); border: 1px solid var(--border-1); padding: 10px; border-radius: 6px;">
          <div style="font-size: 10px; color: var(--text-3); text-transform: uppercase;">Breach & Terrain Mechanics</div>
          <div style="font-size: 13px; font-weight: 600; color: var(--text-0); margin-top: 2px;">${data.failure_mode || "Piping"} Mode · Froehlich Equations</div>
          <div style="font-size: 11px; color: var(--text-2); margin-top: 2px;">Breach Width: ${breach.breach_width_m || hyd.breach_width_m || "—"} m · Formation: ${breach.breach_formation_time_min || hyd.breach_formation_time_min || "—"} min</div>
        </div>
      </div>

      <div style="background: rgba(239, 68, 68, 0.08); border-left: 3px solid var(--critical); padding: 8px 12px; font-size: 11px; line-height: 1.5; color: var(--text-1);">
        <b>Emergency Action Directive:</b> Immediate evacuation orders recommended for settlements within the 10km downstream corridor. Alert local district disaster management authorities immediately.
      </div>
    </div>
  `;

  modal.style.display = "flex";
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------
function showError(err) {
  document.getElementById("errorSection").style.display = "block";
  let msg = err.message || "Unknown error occurred";
  if (msg.includes("HTTP 502")) msg = "DEM acquisition failed. Check network connection.";
  else if (msg.includes("HTTP 503")) msg = "Simulation service currently busy.";
  document.getElementById("errorMessage").textContent = msg;
  console.error("[Simulation Error]", err);
  dashboard?.setFailed();
  setDrawerStatus("failed");
}

function setDrawerStatus(state) {
  const badge = document.getElementById("drawerStatusBadge");
  if (!badge) return;
  const map = {
    idle: { text: "Idle", cls: "idle" },
    running: { text: "Running", cls: "running" },
    completed: { text: "Completed", cls: "completed" },
    failed: { text: "Failed", cls: "failed" },
  };
  const s = map[state] || map.idle;
  badge.textContent = s.text;
  badge.classList.remove("idle", "running", "completed", "failed");
  badge.classList.add(s.cls);
  badge.dataset.status = state;
}

// Expose globally for HTML onclick handlers
window.loadRivers = loadRivers;
window.exportReport = exportReport;

// ---------------------------------------------------------------------------
// Live Hydrograph Chart (Chart.js)
// ---------------------------------------------------------------------------
let _hydrographChart = null;  // Chart.js instance
let _hydrographSnapshotTimes = [];  // snapshot_times_s — for scrubber mapping

/**
 * Build or rebuild the Chart.js breach hydrograph.
 * Called once per simulation from showResults().
 *
 * @param {object} data  Full simulation response from /simulate
 */
function initHydrograph(data) {
  const card = document.getElementById("hydrographCard");
  const canvas = document.getElementById("hydrographChart");
  if (!card || !canvas) return;

  // Guard: Chart.js must be loaded from CDN
  if (typeof Chart === "undefined") {
    console.warn("[Hydrograph] Chart.js not loaded — skipping hydrograph chart.");
    return;
  }

  const times = data.hydrograph_times_min || [];
  const q = data.hydrograph_q_cms || [];

  if (!times.length || !q.length) {
    card.style.display = "none";
    return;
  }

  // Cache snapshot times for scrubber sync
  _hydrographSnapshotTimes = (data.snapshot_times_s || []).map(t => t / 60.0);

  // Destroy previous chart instance if re-running a simulation
  if (_hydrographChart) {
    _hydrographChart.destroy();
    _hydrographChart = null;
  }

  const peakQ = Math.max(...q);
  const peakMeta = document.getElementById("hydrographMeta");
  if (peakMeta) {
    const peakT = times[q.indexOf(peakQ)];
    peakMeta.textContent =
      `Peak ${Math.round(peakQ).toLocaleString()} m\u00b3/s at ${peakT?.toFixed(1)} min — Time from breach (min)`;
  }

  // Vertical scrubber annotation plugin (inline, no external plugin needed)
  const scrubberPlugin = {
    id: "hydrographScrubber",
    afterDraw(chart) {
      const scrubX = chart._scrubberX;
      if (scrubX == null) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      ctx.save();
      ctx.strokeStyle = "rgba(74, 158, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(scrubX, chartArea.top);
      ctx.lineTo(scrubX, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const ctx = canvas.getContext("2d");
  _hydrographChart = new Chart(ctx, {
    type: "line",
    plugins: [scrubberPlugin],
    data: {
      labels: times,
      datasets: [{
        label: "Breach Outflow Q(t)",
        data: q,
        borderColor: "#4a9eff",
        backgroundColor: "rgba(74, 158, 255, 0.10)",
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1c2128",
          borderColor: "#2a3342",
          borderWidth: 1,
          titleColor: "#b8c4d0",
          bodyColor: "#e8ecf0",
          callbacks: {
            title: (items) => `T = ${Number(items[0].label).toFixed(1)} min`,
            label: (item) => `Q = ${Math.round(item.raw).toLocaleString()} m\u00b3/s`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: false },
          ticks: {
            color: "#4f6078",
            font: { size: 9, family: "'JetBrains Mono', monospace" },
            maxTicksLimit: 8,
            callback: (v) => `${v}m`,
          },
          grid: { color: "rgba(46, 56, 70, 0.6)", lineWidth: 0.5 },
          border: { color: "#2a3342" },
        },
        y: {
          title: { display: false },
          ticks: {
            color: "#4f6078",
            font: { size: 9, family: "'JetBrains Mono', monospace" },
            maxTicksLimit: 5,
            callback: (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v,
          },
          grid: { color: "rgba(46, 56, 70, 0.6)", lineWidth: 0.5 },
          border: { color: "#2a3342" },
        },
      },
    },
  });

  card.style.display = "block";
}

/**
 * Move the vertical scrubber indicator on the hydrograph to the position
 * corresponding to the current map player frame.
 *
 * @param {number} frameIdx  Current map player frame index
 */
function syncHydrographScrubber(frameIdx) {
  if (!_hydrographChart) return;
  const snapshotTimeMin = _hydrographSnapshotTimes[frameIdx];
  if (snapshotTimeMin == null) return;

  const chart = _hydrographChart;
  const xScale = chart.scales.x;
  if (!xScale) return;

  // Convert sim time (min) to canvas pixel X
  const xPixel = xScale.getPixelForValue(snapshotTimeMin);
  chart._scrubberX = xPixel;
  chart.draw();
}
