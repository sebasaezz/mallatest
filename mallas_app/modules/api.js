// Minimal API client for the local Python backend.
// Keep dependency-free; let app.js decide how to surface errors (toasts, modal, etc.).

async function readBodyAsText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Fetch JSON from an endpoint.
 * Throws Error on network failure or non-2xx.
 * @param {string} url
 * @param {RequestInit} [init]
 */
export async function fetchJSON(url, init = {}) {
  const res = await fetch(url, init);
  const text = await readBodyAsText(res);

  if (!res.ok) {
    // Try to extract {error} or {message}, otherwise raw text.
    try {
      const j = text ? JSON.parse(text) : null;
      const msg = (j && (j.error || j.message)) ? String(j.error || j.message) : (text || res.statusText);
      throw new Error(msg);
    } catch {
      throw new Error(text || res.statusText || `HTTP ${res.status}`);
    }
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    // Backend should always return JSON, but keep a safe fallback.
    return null;
  }
}

export function getConfig() {
  return fetchJSON("/api/config", { method: "GET" });
}

export function getAll() {
  return fetchJSON("/api/all", { method: "GET" });
}

export function getDraft() {
  return fetchJSON("/api/draft", { method: "GET" });
}

/**
 * Save draft (POST /api/draft). Returns backend response {ok:true}.
 * @param {any} draft
 */
export function saveDraft(draft) {
  return fetchJSON("/api/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft ?? {}),
  });
}

/**
 * Hard reset draft on disk (POST /api/draft/reset).
 * Deletes malla_draft.json if present.
 * Frontend MUST confirm with the user before calling this.
 */
export function hardResetDraft() {
  return fetchJSON("/api/draft/reset", { method: "POST" });
}
