// Render module (Phase 3 scaffolding).
//
// This file provides a stable module API for rendering and the warnings modal.
// Initially it delegates to the current legacy functions that still live in app.js
// (exposed via window.MALLA). Next step: move the render implementation here and
// delete it from app.js (big size reduction).

import { state } from "./state.js";

let _computeWarnings = null;

/**
 * Initialize render module.
 * @param {{ computeWarnings?: Function }} deps
 */
export function initRender(deps = {}) {
  _computeWarnings = typeof deps.computeWarnings === "function" ? deps.computeWarnings : null;
}

/**
 * Render the full grid.
 *
 * Current behavior: delegates to legacy app.js implementation.
 * Next iteration: implement here using `state` + `_computeWarnings`.
 */
export function fullRender() {
  const legacy = window.MALLA?.fullRender;
  if (typeof legacy === "function") return legacy();

  // Fallback (should not happen while migrating): avoid hard crash.
  console.warn("[render] legacy fullRender() not found; render skipped", { hasState: !!state.all });
}

export function openWarningsModal() {
  const legacy = window.MALLA?.openWarningsModal;
  if (typeof legacy === "function") return legacy();
  console.warn("[render] legacy openWarningsModal() not found");
}

export function closeWarningsModal() {
  const legacy = window.MALLA?.closeWarningsModal;
  if (typeof legacy === "function") return legacy();
  console.warn("[render] legacy closeWarningsModal() not found");
}

// Optional helper for future in-module implementation.
export function computeWarningsForCurrentState() {
  if (typeof _computeWarnings !== "function") return [];

  // app.js currently builds placements as a Map and normalizes prereqs/coreqs before calling warnings.
  // Once render is moved here, we will either:
  //  - import the adapter from a dedicated module, or
  //  - move that adapter into warnings.js.
  // For now, this helper is unused.
  try {
    const terms = state.all?.terms || [];
    const courses = state.all?.courses || [];
    const placements = state.draft?.placements || {};
    return _computeWarnings(terms, courses, new Map(Object.entries(placements)), state.draft, state.config) || [];
  } catch (e) {
    console.warn("[render] computeWarningsForCurrentState failed", e);
    return [];
  }
}
