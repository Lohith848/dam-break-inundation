/**
 * config/api.js
 * Central API configuration
 */

const API_BASE = (() => {
  if (typeof window !== "undefined" && window.__API_BASE__) {
    return String(window.__API_BASE__).replace(/\/+$/, "");
  }
  if (typeof import.meta !== "undefined" && import.meta?.env?.VITE_API_URL) {
    return String(import.meta.env.VITE_API_URL).replace(/\/+$/, "");
  }
  if (typeof window !== "undefined" && window.location) {
    const { origin, protocol, port } = window.location;
    if (port === "5173") {
      // In Vite dev server, requests are proxied directly to backend
      return "";
    }
    if (protocol === "http:" || protocol === "https:") {
      return origin;
    }
  }
  return "http://localhost:8000";
})();

export { API_BASE };

export async function apiFetch(path, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: options.signal || controller.signal,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data?.detail || `HTTP ${res.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}
