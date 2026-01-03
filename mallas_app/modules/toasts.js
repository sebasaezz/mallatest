// Toast notifications (info / soft / hard)
// - Top-right stack
// - Auto fade-out (default 5s)
// - No layout shift (fixed overlay)

const DEFAULTS = {
  ttlMs: 5000,
  maxToasts: 4,
  fadeMs: 260,
  hostId: "toastHost",
};

let _seq = 0;

function normalizeKind(kind) {
  const k = String(kind || "").toLowerCase().trim();
  if (k === "hard" || k === "error" || k === "danger") return "hard";
  if (k === "soft" || k === "warn" || k === "warning") return "soft";
  return "info";
}

function ensureHost(opts = {}) {
  const hostId = opts.hostId || DEFAULTS.hostId;
  let host = document.getElementById(hostId);
  if (host) return host;

  host = document.createElement("div");
  host.id = hostId;
  host.className = "toast-host";
  // Inline fallback so it works even if CSS is missing.
  host.style.position = "fixed";
  host.style.top = "12px";
  host.style.right = "12px";
  host.style.zIndex = "9999";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.gap = "8px";
  host.style.width = "min(420px, 20vw)";
  host.style.maxWidth = "20vw";
  host.style.pointerEvents = "none";

  document.body.appendChild(host);
  return host;
}

function applyKindClasses(el, kind) {
  // Prefer CSS to style these classes.
  el.classList.add("toast");
  el.classList.add(`toast-${kind}`);
}

function scheduleHide(el, ttlMs, fadeMs) {
  const hide = () => {
    if (!el.isConnected) return;
    el.classList.add("toast-hide");
    // Inline fallback fade.
    el.style.transition = `opacity ${fadeMs}ms ease`;
    el.style.opacity = "0";
    window.setTimeout(() => {
      if (el.isConnected) el.remove();
    }, fadeMs + 30);
  };

  window.setTimeout(hide, ttlMs);
}

function enforceMax(host, maxToasts) {
  const children = Array.from(host.children);
  if (children.length <= maxToasts) return;
  const extra = children.length - maxToasts;
  for (let i = 0; i < extra; i++) {
    const el = children[i];
    if (el && el.isConnected) el.remove();
  }
}

/**
 * Show a toast.
 * @param {"info"|"soft"|"hard"|string} kind
 * @param {string} message
 * @param {{ttlMs?: number, maxToasts?: number, fadeMs?: number, hostId?: string}} [opts]
 * @returns {string} toast id
 */
export function showToast(kind, message, opts = {}) {
  const k = normalizeKind(kind);
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULTS.ttlMs;
  const maxToasts = Number.isFinite(opts.maxToasts) ? opts.maxToasts : DEFAULTS.maxToasts;
  const fadeMs = Number.isFinite(opts.fadeMs) ? opts.fadeMs : DEFAULTS.fadeMs;

  const host = ensureHost(opts);
  enforceMax(host, maxToasts);

  const id = `t${Date.now()}_${++_seq}`;
  const toast = document.createElement("div");
  toast.dataset.toastId = id;
  applyKindClasses(toast, k);

  // Inline fallback styling (CSS can override).
  toast.style.pointerEvents = "auto";
  toast.style.padding = "10px 12px";
  toast.style.borderRadius = "10px";
  toast.style.boxShadow = "0 6px 18px rgba(0,0,0,.18)";
  toast.style.backdropFilter = "blur(6px)";
  toast.style.opacity = "1";

  // Kind colors fallback (keep minimal; CSS preferred).
  if (k === "hard") {
    toast.style.border = "1px solid rgba(255,0,0,.35)";
  } else if (k === "soft") {
    toast.style.border = "1px solid rgba(255,190,0,.45)";
  } else {
    toast.style.border = "1px solid rgba(255,255,255,.18)";
  }

  toast.textContent = String(message ?? "");
  host.appendChild(toast);

  scheduleHide(toast, ttlMs, fadeMs);
  return id;
}

/** Remove a toast by id. */
export function hideToast(id, opts = {}) {
  const host = document.getElementById(opts.hostId || DEFAULTS.hostId);
  if (!host) return;
  const el = host.querySelector(`[data-toast-id="${CSS.escape(String(id))}"]`);
  if (el) el.remove();
}

/** Remove all toasts. */
export function clearToasts(opts = {}) {
  const host = document.getElementById(opts.hostId || DEFAULTS.hostId);
  if (!host) return;
  host.innerHTML = "";
}

// --- Legacy compatibility ---
// Many places in the existing code use showNotice/hideNotice.
// Keep these wrappers so app.js can switch with minimal changes.

export function showNotice(a, b, opts = {}) {
  // Support both (kind, msg) and (msg) signatures.
  if (b === undefined) return showToast("info", String(a ?? ""), opts);
  return showToast(a, String(b ?? ""), opts);
}

export function hideNotice(id, opts = {}) {
  if (id === undefined || id === null || id === "") return clearToasts(opts);
  return hideToast(id, opts);
}
