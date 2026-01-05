// Drag & drop module (Phase 3)
//
// Responsibilities:
// - Handle dragging courses between terms while in draftMode.
// - Update draft placements.
// - Remove empty custom terms (only) after moves.
// - Persist draft via provided saveDraft callback.
// - Trigger re-render via provided update callback.
//
// This module is intentionally UI-light: it uses event delegation and only
// relies on dataset attributes:
//   - Course element: data-course-id (or dataset.courseId / dataset.course_id)
//   - Term container: data-term-id (or dataset.termId / dataset.term_id)

import { state } from "./state.js";
import {
  addTempCourseToDraft,
  ensureDraftOverrides,
  ensureDraftTempCourses,
  listAllSiglas,
  makeTempCourse,
} from "./tempCourses.js";

let _installed = false;
let _dragCourseId = null;
let _dragEl = null;
let _overTermEl = null;
let _dragging = false;

function courseIdFromEl(el) {
  if (!el) return null;
  return (
    el.dataset?.courseId ||
    el.dataset?.course_id ||
    el.getAttribute?.("data-course-id") ||
    null
  );
}

function termIdFromEl(el) {
  if (!el) return null;
  return (
    el.dataset?.termId ||
    el.dataset?.term_id ||
    el.getAttribute?.("data-term-id") ||
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
  return findUp(target, (el) => !!courseIdFromEl(el));
}

function findTermEl(target) {
  return findUp(target, (el) => !!termIdFromEl(el));
}

function ensureDraft() {
  state.draft = state.draft || {};
  state.draft.placements = state.draft.placements || {};
  state.draft.term_order = Array.isArray(state.draft.term_order) ? state.draft.term_order : [];
  state.draft.custom_terms = Array.isArray(state.draft.custom_terms) ? state.draft.custom_terms : [];
  ensureDraftTempCourses(state.draft);
  return state.draft;
}

function listCustomTermIds(draft) {
  const arr = Array.isArray(draft?.custom_terms) ? draft.custom_terms : [];
  const out = [];
  for (const t of arr) {
    if (!t) continue;
    if (typeof t === "string") out.push(t);
    else if (t.term_id != null) out.push(String(t.term_id));
    else if (t.id != null) out.push(String(t.id));
  }
  return out;
}

function removeEmptyCustomTerms(draft) {
  const customIds = new Set(listCustomTermIds(draft));
  if (!customIds.size) return;

  const used = new Set(Object.values(draft.placements || {}).map((x) => (x == null ? null : String(x))));

  const keepCustom = [];
  for (const t of draft.custom_terms) {
    const tid = typeof t === "string" ? t : (t?.term_id != null ? String(t.term_id) : (t?.id != null ? String(t.id) : null));
    if (!tid) continue;
    if (used.has(tid)) keepCustom.push(t);
  }

  // If any were removed, also clean term_order.
  if (keepCustom.length !== draft.custom_terms.length) {
    const keepIds = new Set(listCustomTermIds({ custom_terms: keepCustom }));
    draft.custom_terms = keepCustom;
    if (Array.isArray(draft.term_order)) {
      draft.term_order = draft.term_order.filter((tid) => !customIds.has(String(tid)) || keepIds.has(String(tid)));
    }
  }
}

function setDraggingCss(el, on) {
  if (!el?.classList) return;
  el.classList.toggle("dragging", !!on);
}

function setGlobalDragging(on) {
  _dragging = !!on;
  document.documentElement.classList.toggle("is-dragging", _dragging);
}

function showDropHint(termEl) {
  if (!termEl) return;
  // Prefer CSS classes (if present) and also apply an inline fallback.
  termEl.classList.add("is-drop-target", "drag-over");

  const hint = termEl.querySelector?.(".drop-hint");
  if (!hint) return;
  hint.classList.add("is-visible");

  try {
    const cs = window.getComputedStyle(hint);
    if (cs.display === "none") hint.style.display = "block";
    if (Number(cs.opacity) === 0) hint.style.opacity = "1";
  } catch {
    hint.style.display = "block";
    hint.style.opacity = "1";
  }
}

function hideDropHint(termEl) {
  if (!termEl) return;
  termEl.classList.remove("is-drop-target", "drag-over");
  const hint = termEl.querySelector?.(".drop-hint");
  if (!hint) return;
  hint.classList.remove("is-visible");
  hint.style.display = "";
  hint.style.opacity = "";
}

function setDropTarget(termEl) {
  if (termEl === _overTermEl) return;
  if (_overTermEl) hideDropHint(_overTermEl);
  _overTermEl = termEl;
  if (_overTermEl) showDropHint(_overTermEl);
}

function clearDropTarget() {
  if (_overTermEl) hideDropHint(_overTermEl);
  _overTermEl = null;
}

function canUseDragDrop() {
  return !!state.draftMode;
}

function findCourseById(courseId) {
  const cid = String(courseId || "").trim();
  if (!cid) return null;
  return (
    state.maps?.courseById?.get?.(cid) ||
    (Array.isArray(state.all?.courses) ? state.all.courses.find((c) => String(c?.course_id || "") === cid) : null)
  );
}

function normalizeOffered(raw) {
  const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const map = { "0": "V", "1": "I", "2": "P" };
  const order = { V: 0, I: 1, P: 2 };
  const out = [];
  for (const x of arr) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    const upper = s.toUpperCase();
    const mapped = map[upper] ?? map[s] ?? upper;
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  out.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9) || a.localeCompare(b));
  return out;
}

function splitReqs(rawList, coreqList) {
  const prereqs = [];
  const coreqs = [];
  const rawArr = Array.isArray(rawList) ? rawList : rawList != null ? [rawList] : [];
  for (const it of rawArr) {
    const s = String(it ?? "").trim();
    if (!s || s.toLowerCase() === "nt") continue;
    const m = /^(.+?)\(c\)$/i.exec(s);
    if (m) coreqs.push(m[1].trim());
    else prereqs.push(s);
  }
  const extraCoreqs = Array.isArray(coreqList) ? coreqList : coreqList != null ? [coreqList] : [];
  for (const c of extraCoreqs) {
    const s = String(c ?? "").trim();
    if (s && !coreqs.includes(s)) coreqs.push(s);
  }
  return { prereqs, coreqs };
}

function createOverrideFromDiskCourse(course, termId, mergeCoursesWithTemps) {
  const cid = String(course?.course_id || "").trim();
  if (!cid) return null;

  const fm = course?.frontmatter && typeof course.frontmatter === "object" ? course.frontmatter : {};
  const offeredRaw = course?.semestreOfrecido ?? fm?.semestreOfrecido;
  const concRaw = course?.concentracion ?? course?.concentración ?? fm?.concentracion ?? fm?.["concentración"] ?? "ex";
  const creditosRaw = course?.creditos ?? course?.créditos ?? fm?.creditos ?? fm?.créditos;
  const { prereqs, coreqs } = splitReqs(course?.prerrequisitos ?? fm?.prerrequisitos, course?.corequisitos ?? fm?.corequisitos);

  const payload = {
    sigla: course?.sigla ?? fm?.sigla,
    nombre: course?.nombre ?? fm?.nombre,
    creditos: creditosRaw,
    prerrequisitos: prereqs,
    correquisitos: coreqs,
    semestreOfrecido: normalizeOffered(offeredRaw),
    concentracion: concRaw,
    aprobado: course?.aprobado ?? fm?.aprobado,
  };

  const existingSiglas = listAllSiglas(state.all?.courses || []);
  const currentSigla = String(payload.sigla || "").trim().toUpperCase();
  if (currentSigla) existingSiglas.delete(currentSigla);

  const newCourse = makeTempCourse(payload, termId, { existingSiglas });
  newCourse.temp_kind = "override";
  newCourse.override_of = cid;
  newCourse.aprobado = !!(course?.aprobado ?? fm?.aprobado);
  newCourse.frontmatter = newCourse.frontmatter && typeof newCourse.frontmatter === "object" ? newCourse.frontmatter : {};
  newCourse.frontmatter.aprobado = newCourse.aprobado;

  ensureDraftOverrides(state.draft);
  if (!state.draft.overrides.includes(cid)) state.draft.overrides.push(cid);
  if (state.draft.placements && typeof state.draft.placements === "object") {
    delete state.draft.placements[cid];
  }

  addTempCourseToDraft(state.draft, newCourse, termId);
  state.dirtyDraft = true;
  if (typeof mergeCoursesWithTemps === "function") {
    try {
      mergeCoursesWithTemps();
    } catch (e) {
      console.warn("[dragdrop] mergeCoursesWithTemps failed", e);
    }
  }
  return newCourse;
}

/**
 * Install drag/drop handlers.
 * @param {{
 *   update: Function,
 *   saveDraft: (draft:any)=>Promise<any>,
 *   notify?: (kind:string, msg:string)=>any,
 *   mergeCoursesWithTemps?: Function,
 * }} deps
 */
export function initDragDrop(deps) {
  if (_installed) return;
  _installed = true;

  const update = typeof deps?.update === "function" ? deps.update : () => {};
  const saveDraft = typeof deps?.saveDraft === "function" ? deps.saveDraft : async () => {};
  const notify = typeof deps?.notify === "function" ? deps.notify : null;
  const mergeCoursesWithTemps = typeof deps?.mergeCoursesWithTemps === "function" ? deps.mergeCoursesWithTemps : null;

  // dragstart (capture so we catch early)
  document.addEventListener(
    "dragstart",
    (ev) => {
      if (!canUseDragDrop()) return;
      const courseEl = findCourseEl(ev.target);
      if (!courseEl) return;

      const cid = courseIdFromEl(courseEl);
      if (!cid) return;

      _dragCourseId = String(cid);
      _dragEl = courseEl;
      setDraggingCss(courseEl, true);
      setGlobalDragging(true);
      clearDropTarget();

      try {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", _dragCourseId);
      } catch {}
    },
    true
  );

  document.addEventListener(
    "dragend",
    () => {
      if (_dragEl) setDraggingCss(_dragEl, false);
      _dragEl = null;
      _dragCourseId = null;
      clearDropTarget();
      setGlobalDragging(false);
    },
    true
  );

  document.addEventListener(
    "dragover",
    (ev) => {
      if (!canUseDragDrop()) return;
      if (!_dragging) return;

      const termEl = findTermEl(ev.target);
      if (!termEl) {
        setDropTarget(null);
        return;
      }

      setDropTarget(termEl);

      // Allow drop
      ev.preventDefault();
      try {
        ev.dataTransfer.dropEffect = "move";
      } catch {}
    },
    true
  );

  document.addEventListener(
    "drop",
    async (ev) => {
      if (!canUseDragDrop()) return;
      const termEl = findTermEl(ev.target);
      if (!termEl) return;

      ev.preventDefault();

      // End visual state early so UI doesn't get stuck.
      clearDropTarget();
      setGlobalDragging(false);

      let cid = _dragCourseId;
      try {
        const fromDT = ev.dataTransfer?.getData?.("text/plain");
        if (fromDT) cid = String(fromDT);
      } catch {}

      const tid = termIdFromEl(termEl);
      if (!cid || !tid) return;

      const draft = ensureDraft();
      const course = findCourseById(cid);
      const isTemp = !!course?.is_temp;

      let handled = false;
      if (course && !isTemp) {
        try {
          const newCourse = createOverrideFromDiskCourse(course, String(tid), mergeCoursesWithTemps);
          handled = !!newCourse;
        } catch (e) {
          console.warn("[dragdrop] override move failed", e);
          notify?.("hard", "No se pudo mover el curso.");
        }
      }

      if (!handled) {
        // Update placement (temps or unknown fallback)
        draft.placements[String(cid)] = String(tid);
      }

      // Remove empty custom terms if needed
      removeEmptyCustomTerms(draft);

      // Mark dirty and persist
      state.dirtyDraft = true;

      try {
        await saveDraft(draft);
        notify?.("info", "Borrador guardado.");
      } catch (e) {
        console.warn("[dragdrop] saveDraft failed", e);
        notify?.("hard", "No se pudo guardar el borrador.");
      }

      // Re-render
      try {
        update();
      } catch (e) {
        console.warn("[dragdrop] update failed", e);
      }
    },
    true
  );
}
