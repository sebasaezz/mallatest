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

/**
 * Install drag/drop handlers.
 * @param {{
 *   update: Function,
 *   saveDraft: (draft:any)=>Promise<any>,
 *   notify?: (kind:string, msg:string)=>any,
 * }} deps
 */
export function initDragDrop(deps) {
  if (_installed) return;
  _installed = true;

  const update = typeof deps?.update === "function" ? deps.update : () => {};
  const saveDraft = typeof deps?.saveDraft === "function" ? deps.saveDraft : async () => {};
  const notify = typeof deps?.notify === "function" ? deps.notify : null;

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

      // Update placement
      draft.placements[String(cid)] = String(tid);

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
