/**
 * config/api.js — Central API Configuration
 * =================================================================
 * SINGLE SOURCE OF TRUTH for the backend API origin.
 *
 * Resolution order:
 *   1. window.__API_BASE__  (set inline in index.html for deployments)
 *   2. Same origin as the page (works when served by the backend at :8000)
 *   3. http://localhost:8000 (dev fallback — page opened via Live Server/file://)
 * =================================================================
 */

function resolveApiBase() {
  if (typeof window !== "undefined" && window.__API_BASE__) {
    return String(window.__API_BASE__).replace(/\/+$/, "");
  }
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    const loc = window.location;
    if (loc.protocol === "http:" || loc.protocol === "https:") {
      if (loc.port === "8000" || (loc.port === "" && loc.hostname !== "localhost")) {
        return loc.origin;
      }
    }
  }
  return "http://localhost:8000";
}

export const API_BASE = resolveApiBase();

/** Fetch helper: JSON parse + timeout + consistent error surface. */
export async function apiFetch(path, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, signal: options.signal || controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail || `HTTP ${res.status}`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
