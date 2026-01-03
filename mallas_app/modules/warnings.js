// Warning computation module.
//
// NOTE: This file is created as part of the modularization plan.
// In the next step (edit app.js), we will move the *existing* warning logic here
// without changing behavior.
//
// Design constraints (must match existing app behavior):
// - Warnings never block actions.
// - Warnings do not change course background (only outline/border).
// - Mutual coreqs in the same semester do NOT generate warnings.
// - There are "soft" (yellow) and "hard" (red) warnings.
// - Ignored warnings are persisted in draft (ignored_warnings).

/**
 * Compute warnings.
 *
 * IMPORTANT: Implementation will be moved from app.js verbatim (behavior-preserving)
 * on the next "edit app.js" step.
 */
export function computeWarnings(/* args */) {
  throw new Error(
    "warnings.js not wired yet: computeWarnings() will be moved from app.js in the next step."
  );
}

/**
 * Utility: pick first hard/soft warning for top summary.
 * This is behavior-neutral and can be used by app.js once wired.
 */
export function firstWarningSummary(warnings) {
  const hard = warnings?.hard || warnings?.hardWarnings || [];
  const soft = warnings?.soft || warnings?.softWarnings || [];
  const firstHard = Array.isArray(hard) && hard.length ? hard[0] : null;
  const firstSoft = Array.isArray(soft) && soft.length ? soft[0] : null;
  return { firstHard, firstSoft };
}
