// Shared tiny utilities (ES modules). Keep this file dependency-free.

/** @param {string} id */
export function byId(id) {
  return document.getElementById(id);
}

/** @param {string} sel @param {ParentNode} [root] */
export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/** @param {string} sel @param {ParentNode} [root] */
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Create element helper.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param  {...any} children
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === "class") el.className = String(v);
      else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
  }
  for (const ch of children.flat()) {
    if (ch === undefined || ch === null) continue;
    el.appendChild(typeof ch === "string" ? document.createTextNode(ch) : ch);
  }
  return el;
}

export function clamp(n, a, b) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : a;
}

/** Minimal HTML escape for text insertion in innerHTML contexts. */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function asInt(x, fallback = 0) {
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
