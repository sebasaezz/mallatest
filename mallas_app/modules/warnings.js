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
export function computeWarnings(terms, courses, placements, draft, config) {
  const ignored = (draft && typeof draft.ignored_warnings === "object" && draft.ignored_warnings) || {};

  const maxC = config?.max_credits ?? 65;
  const softC = config?.soft_credits ?? 50;

  const termIndex = new Map();
  (Array.isArray(terms) ? terms : []).forEach((t, i) => {
    if (t && t.term_id != null) termIndex.set(String(t.term_id), i);
  });

  const byId = new Map();
  const bySigla = new Map();
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;
    if (c.course_id != null) byId.set(String(c.course_id), c);
    if (c.sigla != null) bySigla.set(String(c.sigla), c);
  }

  const getTermIdForCourse = (c) => {
    const cid = c?.course_id != null ? String(c.course_id) : null;
    if (cid && placements && Object.prototype.hasOwnProperty.call(placements, cid)) {
      const tid = placements[cid];
      return tid != null ? String(tid) : null;
    }
    return c?.term_id != null ? String(c.term_id) : null;
  };

  const getTermIdx = (tid) => {
    if (tid == null) return Infinity;
    const k = String(tid);
    return termIndex.has(k) ? termIndex.get(k) : Infinity;
  };

  const hard = [];
  const soft = [];

  const pushWarn = (kind, w) => {
    const id = String(w.id || "");
    const isIgnored = !!(id && ignored[id]);
    w.kind = kind;
    w.ignored = isIgnored;
    if (isIgnored) return;
    if (kind === "hard") hard.push(w);
    else soft.push(w);
  };

  // --- Credit load per term ---
  const creditsByTerm = new Map();
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;
    const tid = getTermIdForCourse(c);
    if (!tid) continue;
    const cr = Number(c.creditos ?? c.créditos ?? 0) || 0;
    creditsByTerm.set(tid, (creditsByTerm.get(tid) || 0) + cr);
  }

  for (const [tid, total] of creditsByTerm.entries()) {
    if (total > maxC) {
      pushWarn("hard", {
        id: `credits:hard:${tid}`,
        term_id: tid,
        text: `Sobrecarga: ${total} créditos (máx ${maxC})`,
        credits: total,
      });
    } else if (total > softC) {
      pushWarn("soft", {
        id: `credits:soft:${tid}`,
        term_id: tid,
        text: `Carga alta: ${total} créditos (sobre ${softC})`,
        credits: total,
      });
    }
  }

  // --- Per-course checks ---
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;

    const cid = c.course_id != null ? String(c.course_id) : "";
    const sigla = c.sigla != null ? String(c.sigla) : "";
    const tid = getTermIdForCourse(c);
    const cIdx = getTermIdx(tid);

    // Skip prerequisite/offering checks for approved courses.
    if (c.aprobado === true) continue;

    // Offered semester check (soft)
    const offered = Array.isArray(c.semestreOfrecido) ? c.semestreOfrecido.filter(Boolean).map(String) : [];
    if (offered.length && tid && termIndex.has(String(tid))) {
      const t = terms[termIndex.get(String(tid))];
      const code = t?.code != null ? String(t.code) : null;
      if (code && !offered.includes(code)) {
        pushWarn("soft", {
          id: `offered:${cid}:${tid}`,
          course_id: cid,
          sigla,
          term_id: tid,
          text: `${sigla || "Curso"} no se ofrece en este período (${code}).`,
        });
      }
    }

    // Prerequisites check
    const prereqs = Array.isArray(c.prerrequisitos) ? c.prerrequisitos.filter(Boolean).map(String) : [];
    for (const p of prereqs) {
      const pc = bySigla.get(p);
      if (!pc) {
        pushWarn("soft", {
          id: `prereq:unknown:${cid}:${p}`,
          course_id: cid,
          sigla,
          term_id: tid,
          prereq: p,
          text: `${sigla || "Curso"} tiene prerrequisito desconocido: ${p}.`,
        });
        continue;
      }

      if (pc.aprobado === true) continue;

      const ptid = getTermIdForCourse(pc);
      const pIdx = getTermIdx(ptid);

      // Mutual coreq in same term: A requires B and B requires A, scheduled same term.
      if (pIdx === cIdx && pIdx !== Infinity) {
        const ppr = Array.isArray(pc.prerrequisitos) ? pc.prerrequisitos.filter(Boolean).map(String) : [];
        if (sigla && ppr.includes(sigla)) {
          continue; // mutual coreq => no warning
        }
      }

      if (pIdx >= cIdx) {
        pushWarn("hard", {
          id: `prereq:missing:${cid}:${p}:${tid || ""}`,
          course_id: cid,
          sigla,
          term_id: tid,
          prereq: p,
          text: `${sigla || "Curso"} requiere ${p} antes.`,
        });
      }
    }
  }

  // Sort: keep stable but predictable.
  const byTermThenText = (a, b) => {
    const ai = getTermIdx(a.term_id);
    const bi = getTermIdx(b.term_id);
    if (ai !== bi) return ai - bi;
    return String(a.text || "").localeCompare(String(b.text || ""), "es");
  };
  hard.sort(byTermThenText);
  soft.sort(byTermThenText);

  return { hard, soft };
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
