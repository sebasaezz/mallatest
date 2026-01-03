// Unlock view module (Phase 3)
//
// Features (must remain true):
// - Click a course -> toggles selection (selected highlight).
// - Courses unlocked transitively (via prerequisites graph) blink.
// - Click outside a course clears selection.
// - Works across re-renders (DOM changes): selection + blink are re-applied.
//
// Notes:
// - We treat prerequisites in `prerrequisitos` as edges (req -> dependent).
// - Correquisites encoded as "SIGLA(c)" are ignored for unlock graph.

import { state } from "./state.js";

let _installed = false;
let _enabled = true;

let _gridEl = null;
let _observer = null;
let _rafPending = false;

let _adj = null; // Map<course_id, Array<course_id>>
let _dom = new Map(); // Map<course_id, HTMLElement>

let _active = []; // elements currently blinking
let _selId = null;
let _selEl = null;

let _lastCoursesRef = null;

function normSigla(x) {
  return String(x || "").trim().toUpperCase();
}

function parsePrereqs(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const out = [];
  for (const item0 of list) {
    const item = String(item0 || "").trim();
    if (!item) continue;
    if (item.toLowerCase() === "nt") continue;

    const m = /^(.+?)\(c\)$/i.exec(item);
    if (m) out.push({ code: m[1].trim(), isCo: true });
    else out.push({ code: item, isCo: false });
  }
  return out;
}

function courseIdFromEl(el) {
  if (!el) return null;
  return (
    el.dataset?.courseId ||
    el.dataset?.course_id ||
    el.getAttribute?.("data-course-id") ||
    null
  );
}

function findUp(target, pred) {
  let el = target;
  while (el && el !== document.body && el !== document.documentElement) {
    if (pred(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function findCourseEl(target) {
  return findUp(target, (el) => el?.classList?.contains("course") && !!courseIdFromEl(el));
}

function clearBlink() {
  for (const el of _active) {
    try {
      el.classList.remove("unlock-blink");
    } catch {}
  }
  _active = [];
}

function collect(startId) {
  if (!_adj || !startId) return [];
  const out = [];
  const visited = new Set([startId]);
  const q = [startId];
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const nexts = _adj.get(cur) || [];
    for (const nid of nexts) {
      if (!nid || visited.has(nid)) continue;
      visited.add(nid);
      out.push(nid);
      q.push(nid);
    }
  }
  return out;
}

function applyBlink(startId) {
  clearBlink();
  for (const id of collect(startId)) {
    const el = _dom.get(id);
    if (!el) continue;
    el.classList.add("unlock-blink");
    _active.push(el);
  }
}

function applySelection() {
  // Remove previous selection class if element changed.
  if (_selEl && (!_selId || _dom.get(_selId) !== _selEl)) {
    try {
      _selEl.classList.remove("unlock-selected");
    } catch {}
    _selEl = null;
  }

  if (!_selId) {
    clearBlink();
    return;
  }

  const el = _dom.get(_selId) || null;
  if (!el) {
    _selEl = null;
    clearBlink();
    return;
  }

  _selEl = el;
  el.classList.add("unlock-selected");
  applyBlink(_selId);
}

function refreshDomMap() {
  _dom = new Map();
  if (!_gridEl) return;

  // Accept both data-course-id and data-course-id variants.
  const nodes = _gridEl.querySelectorAll?.(".course[data-course-id], .course[data-course-id], .course[data-course-id], .course") || [];
  for (const el of nodes) {
    const cid = courseIdFromEl(el);
    if (!cid) continue;
    _dom.set(String(cid), el);
  }
}

function maybeRebuildAdj() {
  const courses = state.all?.courses || null;
  if (!courses || courses === _lastCoursesRef) return;
  buildAdj(courses);
  _lastCoursesRef = courses;
}

function scheduleRefresh() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    if (!_enabled) return;
    maybeRebuildAdj();
    refreshDomMap();
    // Ensure selection class is removed from stale element.
    if (_selEl && !_dom.has(_selId)) {
      try {
        _selEl.classList.remove("unlock-selected");
      } catch {}
      _selEl = null;
    }
    applySelection();
  });
}

export function buildAdj(courses) {
  const bySigla = new Map();
  for (const c of courses || []) {
    const s = normSigla(c?.sigla);
    if (s) bySigla.set(s, c);
  }

  const tmp = new Map();
  for (const c of courses || []) {
    const cid = c?.course_id;
    if (!cid) continue;
    for (const pr of parsePrereqs(c?.prerrequisitos)) {
      if (pr.isCo) continue;
      const req = bySigla.get(normSigla(pr.code));
      const rid = req?.course_id;
      if (!rid) continue;
      if (!tmp.has(rid)) tmp.set(rid, new Set());
      tmp.get(rid).add(cid);
    }
  }

  const adj = new Map();
  for (const [k, s] of tmp.entries()) adj.set(String(k), Array.from(s).map(String));
  _adj = adj;
}

export function clearUnlock() {
  if (_selEl) {
    try {
      _selEl.classList.remove("unlock-selected");
    } catch {}
  }
  _selId = null;
  _selEl = null;
  clearBlink();
}

export function toggleUnlock(courseId) {
  if (!_enabled) return;
  if (!courseId) return;
  const cid = String(courseId);
  if (_selId === cid) return clearUnlock();

  if (_selEl) {
    try {
      _selEl.classList.remove("unlock-selected");
    } catch {}
  }
  _selId = cid;
  _selEl = _dom.get(cid) || null;
  if (_selEl) _selEl.classList.add("unlock-selected");
  applyBlink(cid);
}

export function reapplyUnlock() {
  if (!_enabled) return;
  scheduleRefresh();
}

export function setUnlockEnabled(on) {
  _enabled = !!on;
  if (!_enabled) clearUnlock();
}

/**
 * Initialize unlock module.
 * @param {{ gridId?: string, enabled?: boolean }} opts
 */
export function initUnlock(opts = {}) {
  if (_installed) return;
  _installed = true;

  _enabled = opts.enabled !== undefined ? !!opts.enabled : true;
  const gridId = opts.gridId || "grid";
  _gridEl = document.getElementById(gridId);

  // Build graph once if data already loaded.
  maybeRebuildAdj();

  if (_gridEl) {
    // Click behavior: course toggles; outside clears.
    _gridEl.addEventListener("click", (ev) => {
      if (!_enabled) return;
      const courseEl = findCourseEl(ev.target);
      if (!courseEl) {
        clearUnlock();
        return;
      }
      ev.stopPropagation();
      const cid = courseIdFromEl(courseEl);
      if (cid) toggleUnlock(cid);
    });

    // Observe DOM changes to reapply selection/blink after renders.
    _observer = new MutationObserver(() => scheduleRefresh());
    _observer.observe(_gridEl, { childList: true, subtree: true });

    // Initial DOM map.
    scheduleRefresh();
  } else {
    console.warn("[unlock] grid element not found", { gridId });
  }
}

// Debug helpers
export function getUnlockSelectedId() {
  return _selId;
}
