// Unlock view module (Phase 3)
//
// Features (must remain true):
// - Click a course -> toggles selection (selected highlight).
// - Courses unlocked transitively (via prerequisites graph) blink.
// - Click outside a course clears selection.
// - Works across re-renders (DOM changes): selection + blink are re-applied.
//
// Notes:
// - We treat prerequisites *and* correquisites in `prerrequisitos` as edges (req -> dependent).
// - A course only participates in the unlock graph if its prereqs (< term) and coreqs (<= term) are satisfied.

import { state } from "./state.js";

const DEBUG_UNLOCK = false;

let _installed = false;
let _enabled = true;

let _gridEl = null;
let _observer = null;
let _rafPending = false;

let _adj = null; // Map<course_id, Array<course_id>>
let _dom = new Map(); // Map<course_id, HTMLElement>
let _unlockedIds = new Set(); // Set<course_id>

let _active = []; // elements currently blinking
let _selId = null;
let _selEl = null;

// Optional hook: when user clicks the *selected* course again, open course menu.
// This keeps unlock behavior on first click, but enables a second-click menu without
// forcing draftMode logic into this module.
let _onSecondClick = null;

let _lastCoursesRef = null;
let _lastPlacementSig = null;

const TERM_RE = /^([0-9]{4})-([0-2])$/;

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
  const enforceUnlock = _unlockedIds && _unlockedIds.size > 0;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    const nexts = _adj.get(cur) || [];
    for (const nid of nexts) {
      if (!nid || visited.has(nid)) continue;
      if (enforceUnlock && !_unlockedIds.has(nid)) continue;
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
  const placementSig = buildPlacementSignature();
  if (placementSig !== _lastPlacementSig) {
    _lastPlacementSig = placementSig;
    buildAdj(courses);
    _lastCoursesRef = courses;
    return;
  }
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
  _unlockedIds = new Set();

  const bySigla = new Map();
  const byId = new Map();
  for (const c of courses || []) {
    const s = normSigla(c?.sigla);
    const cid = c?.course_id;
    if (s) bySigla.set(s, c);
    if (cid) byId.set(String(cid), c);
  }

  const placements = buildPlacements(byId);
  const unlocked = computeUnlocked(byId, bySigla, placements);
  _unlockedIds = unlocked;

  if (DEBUG_UNLOCK) {
    try {
      console.log("[unlock] unlocked (count)", unlocked.size, {
        sample: Array.from(unlocked).slice(0, 12),
      });
    } catch {}
  }

  const tmp = new Map();
  for (const c of courses || []) {
    const cid = c?.course_id;
    if (!cid) continue;
    for (const pr of parsePrereqs(c?.prerrequisitos)) {
      const req = bySigla.get(normSigla(pr.code));
      const rid = req?.course_id;
      if (!rid) continue;
      if (!_unlockedIds.has(cid)) continue;
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
 * @param {{ gridId?: string, enabled?: boolean, onSecondClick?: (courseId: string, courseEl: HTMLElement) => void }} opts
 */
export function initUnlock(opts = {}) {
  // Allow calling initUnlock multiple times to update options (common after modular reloads).
  // First call installs listeners; subsequent calls only update flags/callbacks.
  if (_installed) {
    if ("enabled" in opts) _enabled = !!opts.enabled;
    if ("onSecondClick" in opts) {
      _onSecondClick = typeof opts.onSecondClick === "function" ? opts.onSecondClick : null;
    }
    scheduleRefresh();
    return;
  }

  _installed = true;

  _enabled = opts.enabled !== undefined ? !!opts.enabled : true;
  _onSecondClick = typeof opts.onSecondClick === "function" ? opts.onSecondClick : null;
  const gridId = opts.gridId || "grid";
  _gridEl = document.getElementById(gridId);

  // Build graph once if data already loaded.
  maybeRebuildAdj();

  if (_gridEl) {
    // Click behavior:
    // - Click a course: select + blink unlock chain.
    // - Click outside: clear selection.
    // - If opts.onSecondClick is provided: clicking the *selected* course again calls it
    //   (menu) instead of clearing; user can still clear by clicking outside.
    _gridEl.addEventListener("click", (ev) => {
      if (!_enabled) return;
      const courseEl = findCourseEl(ev.target);
      if (!courseEl) {
        clearUnlock();
        return;
      }
      ev.stopPropagation();
      const cidRaw = courseIdFromEl(courseEl);
      if (!cidRaw) return;
      const cid = String(cidRaw);

      if (_onSecondClick && _selId === cid) {
        try {
          _onSecondClick(cid, courseEl);
        } catch (e) {
          console.warn("[unlock] onSecondClick failed", e);
        }
        return;
      }

      toggleUnlock(cid);
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

function buildPlacementSignature() {
  const p = state.draft?.placements;
  if (!p || typeof p !== "object") return "";
  const entries = Object.entries(p)
    .filter(([k, v]) => k != null && v != null)
    .map(([k, v]) => `${k}:${v}`);
  entries.sort();
  return entries.join("|");
}

function termParts(term_id) {
  const m = TERM_RE.exec(term_id || "");
  return m ? { year: parseInt(m[1], 10), sem: parseInt(m[2], 10) } : null;
}

function termIndex(term_id) {
  const p = termParts(term_id);
  return p ? p.year * 10 + p.sem : Infinity;
}

function buildPlacements(byId) {
  const placements = new Map();
  const draft = state.draft;
  const overrides =
    draft && typeof draft.placements === "object" ? draft.placements : {};

  for (const [cid, course] of byId.entries()) {
    const ov = overrides?.[cid];
    const tid =
      (ov != null && String(ov || "").trim()) || course?.term_id || null;
    if (tid) placements.set(cid, String(tid));
  }
  return placements;
}

function courseTermIdx(cid, placements) {
  return termIndex(placements.get(cid)) || Infinity;
}

function computeUnlocked(byId, bySigla, placements) {
  const unlocked = new Set();
  const unlockedSiglas = new Set();
  const byTermIdx = new Map();

  for (const [cid, c] of byId.entries()) {
    if (c?.aprobado === true) {
      unlocked.add(cid);
      const s = normSigla(c?.sigla);
      if (s) unlockedSiglas.add(s);
    }
    const idx = courseTermIdx(cid, placements);
    if (!byTermIdx.has(idx)) byTermIdx.set(idx, []);
    byTermIdx.get(idx).push(cid);
  }

  const termIdxs = Array.from(byTermIdx.keys()).sort((a, b) => a - b);

  for (const idx of termIdxs) {
    const ids = byTermIdx.get(idx) || [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const cid of ids) {
        if (unlocked.has(cid)) continue;
        const course = byId.get(cid);
        if (!course) continue;
        const sigla = normSigla(course.sigla);
        const prereqs = parsePrereqs(course.prerrequisitos);

        const prereqOk = prereqs
          .filter((p) => !p.isCo)
          .every((p) => {
            const req = bySigla.get(normSigla(p.code));
            if (!req) return false;
            const rid = req.course_id ? String(req.course_id) : null;
            if (!rid) return false;
            if (req.aprobado === true) return true;
            if (!unlockedSiglas.has(normSigla(req.sigla))) return false;
            const ridx = courseTermIdx(rid, placements);
            return ridx < idx;
          });

        if (!prereqOk) continue;

        const coreqOk = prereqs
          .filter((p) => p.isCo)
          .every((p) => {
            const req = bySigla.get(normSigla(p.code));
            if (!req) return false;
            const rid = req.course_id ? String(req.course_id) : null;
            if (!rid) return false;
            if (req.aprobado === true) return true;
            const ridx = courseTermIdx(rid, placements);
            if (ridx > idx) return false;
            if (ridx < idx) return unlockedSiglas.has(normSigla(req.sigla));
            return ridx === idx;
          });

        if (!coreqOk) continue;

        unlocked.add(cid);
        if (sigla) unlockedSiglas.add(sigla);
        changed = true;
      }
    }
  }

  return unlocked;
}
