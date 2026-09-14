/**
 * config/api.js
 * Central API configuration
 */

const API_BASE =
  import.meta.env.VITE_API_URL?.replace(/\/+$/, "") ||
  "http://localhost:8000";

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
