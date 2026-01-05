// Unlock view module (Phase 3)
//
// Features (must remain true):
// - Click a course -> toggles selection (selected highlight).
// - Courses unlocked transitively (via prerequisites + corequisites graph) blink.
// - Click outside a course clears selection.
// - Works across re-renders (DOM changes): selection + blink are re-applied.
//
// Notes:
// - We treat prerequisites/corequisites in `prerrequisitos`/`corequisitos` as edges (req -> dependent),
//   respecting term order: prereqs < term, coreqs <= term, approved always counts.

import { state } from "./state.js";

const DEBUG_UNLOCK = false;
const dbg = (...args) => {
  if (!DEBUG_UNLOCK) return;
  try {
    console.log("[unlock]", ...args);
  } catch {}
};

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

// Optional hook: when user clicks the *selected* course again, open course menu.
// This keeps unlock behavior on first click, but enables a second-click menu without
// forcing draftMode logic into this module.
let _onSecondClick = null;

let _lastCoursesRef = null;
let _lastPlacementSig = null;

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

const TERM_RE = /^([0-9]{4})-([0-2])$/;
function termParts(term_id) {
  const m = TERM_RE.exec(term_id || "");
  return m ? { year: parseInt(m[1], 10), sem: parseInt(m[2], 10) } : null;
}
function termIndex(term_id) {
  const p = termParts(term_id);
  return p ? p.year * 10 + p.sem : Infinity;
}

function placementsFromState(courses) {
  const placements = new Map();
  for (const c of courses || []) {
    if (c?.course_id) placements.set(String(c.course_id), c.term_id != null ? String(c.term_id) : null);
  }
  const draftP = state?.draft?.placements && typeof state.draft.placements === "object" ? state.draft.placements : null;
  if (draftP) {
    for (const [cid, tid0] of Object.entries(draftP)) {
      placements.set(String(cid), tid0 != null ? String(tid0) : null);
    }
  }
  return placements;
}

function placementsSig(pMap) {
  return Array.from(pMap.entries())
    .map(([cid, tid]) => `${cid}:${tid ?? ""}`)
    .sort()
    .join("|");
}

function normalizeReqs(course) {
  const prereq = [];
  const coreq = [];
  for (const pr of parsePrereqs(course?.prerrequisitos)) {
    const code = normSigla(pr.code);
    if (!code) continue;
    if (pr.isCo) {
      if (!coreq.includes(code)) coreq.push(code);
    } else {
      if (!prereq.includes(code)) prereq.push(code);
    }
  }
  const extraCo = Array.isArray(course?.corequisitos) ? course.corequisitos : [];
  for (const raw of extraCo) {
    const code = normSigla(raw);
    if (code && !coreq.includes(code)) coreq.push(code);
  }
  return { prereq, coreq };
}

function courseTermId(course, placements) {
  const cid = course?.course_id != null ? String(course.course_id) : null;
  if (cid && placements.has(cid)) return placements.get(cid);
  return course?.term_id != null ? String(course.term_id) : null;
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
  if (!courses) return;
  const placements = placementsFromState(courses);
  const sig = placementsSig(placements);
  if (courses === _lastCoursesRef && sig === _lastPlacementSig) return;
  buildAdj(courses, placements);
  _lastCoursesRef = courses;
  _lastPlacementSig = sig;
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

export function buildAdj(courses, placements = placementsFromState(courses)) {
  const bySigla = new Map();
  const reqByCourseId = new Map();
  const termByCourseId = new Map();

  for (const c of courses || []) {
    if (!c) continue;
    const sig = normSigla(c.sigla);
    if (sig) bySigla.set(sig, c);
    if (c.course_id != null) {
      reqByCourseId.set(String(c.course_id), normalizeReqs(c));
      const tid = courseTermId(c, placements);
      if (tid) termByCourseId.set(String(c.course_id), tid);
    }
  }

  const approved = new Set();
  for (const c of courses || []) {
    if (c?.aprobado === true) {
      const sig = normSigla(c.sigla);
      if (sig) approved.add(sig);
    }
  }

  const byTerm = new Map();
  for (const c of courses || []) {
    const cid = c?.course_id != null ? String(c.course_id) : null;
    if (!cid) continue;
    const tid = termByCourseId.get(cid);
    if (!tid) continue;
    if (!byTerm.has(tid)) byTerm.set(tid, []);
    byTerm.get(tid).push(c);
  }

  const termOrder = Array.from(byTerm.keys()).sort((a, b) => termIndex(a) - termIndex(b));
  const validSiglas = new Set(approved);
  const adjSets = new Map();
  const ensureEdge = (fromId, toId) => {
    if (!fromId || !toId) return;
    if (!adjSets.has(fromId)) adjSets.set(fromId, new Set());
    adjSets.get(fromId).add(toId);
  };

  for (const tid of termOrder) {
    const termCourses = byTerm.get(tid) || [];
    const prevValid = new Set(validSiglas);
    const validThisTerm = new Set();
    const curIdx = termIndex(tid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of termCourses) {
        const cid = c?.course_id != null ? String(c.course_id) : null;
        const sig = normSigla(c?.sigla);
        if (!cid || !sig) continue;
        if (validSiglas.has(sig)) continue;

        const reqs = reqByCourseId.get(cid) || { prereq: [], coreq: [] };
        const prereqOk = reqs.prereq.every((code) => prevValid.has(code));
        if (!prereqOk) continue;

        const coreqOk = reqs.coreq.every((code) => {
          if (!code) return true;
          if (approved.has(code)) return true;
          if (prevValid.has(code) || validThisTerm.has(code)) return true;
          const reqCourse = bySigla.get(code);
          if (!reqCourse) return false;
          const rtid = courseTermId(reqCourse, placements);
          if (!rtid) return false;
          return termIndex(rtid) <= curIdx;
        });
        if (!coreqOk) continue;

        validSiglas.add(sig);
        validThisTerm.add(sig);
        changed = true;

        for (const code of reqs.prereq) {
          const reqCourse = bySigla.get(code);
          const rid = reqCourse?.course_id != null ? String(reqCourse.course_id) : null;
          if (rid) ensureEdge(rid, cid);
        }
        for (const code of reqs.coreq) {
          const reqCourse = bySigla.get(code);
          const rid = reqCourse?.course_id != null ? String(reqCourse.course_id) : null;
          if (rid) ensureEdge(rid, cid);
        }
      }
    }
  }

  const adj = new Map();
  for (const [k, s] of adjSets.entries()) adj.set(String(k), Array.from(s).map(String));
  _adj = adj;
  dbg("buildAdj done", { nodes: adj.size });
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
