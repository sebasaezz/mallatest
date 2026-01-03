// Centralized in-memory state container.
// Goal: reduce global variables in app.js without changing data shapes.
// Keep dependency-free.

export const state = {
  // Backend payloads
  config: null,
  all: null,
  draft: null,

  // UI flags
  draftMode: false,
  unlockMode: false,

  // Draft sync
  dirtyDraft: false,
  savingDraft: false,
  lastSavedAt: 0,

  // Runtime helpers (optional)
  // e.g., maps built by app.js/render for quick lookup
  maps: {
    courseById: new Map(),
    courseBySigla: new Map(),
    termById: new Map(),
  },
};

/** Replace config/all/draft in one shot (keeps reference to state object). */
export function setData({ config = null, all = null, draft = null } = {}) {
  state.config = config;
  state.all = all;
  state.draft = draft;
}

export function setDraft(draft) {
  state.draft = draft;
}

export function setDraftMode(v) {
  state.draftMode = !!v;
}

export function setUnlockMode(v) {
  state.unlockMode = !!v;
}

export function markDraftDirty(v = true) {
  state.dirtyDraft = !!v;
}

export function markDraftSaving(v = true) {
  state.savingDraft = !!v;
  if (!v) state.lastSavedAt = Date.now();
}

/**
 * Rebuild basic lookup maps from state.all.
 * Safe to call repeatedly.
 */
export function rebuildMaps() {
  state.maps.courseById = new Map();
  state.maps.courseBySigla = new Map();
  state.maps.termById = new Map();

  const all = state.all;
  if (!all) return state.maps;

  const terms = Array.isArray(all.terms) ? all.terms : [];
  const courses = Array.isArray(all.courses) ? all.courses : [];

  for (const t of terms) {
    if (t && t.term_id) state.maps.termById.set(String(t.term_id), t);
  }
  for (const c of courses) {
    if (!c) continue;
    if (c.course_id) state.maps.courseById.set(String(c.course_id), c);
    if (c.sigla) state.maps.courseBySigla.set(String(c.sigla), c);
  }

  return state.maps;
}
