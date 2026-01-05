// Warning computation module (canonical).
//
// This module is the single source of truth for warning generation.
// It returns an array of warning objects that the UI can render and/or ignore.
//
// Constraints (must match app behavior):
// - Warnings never block actions.
// - Warnings do not change course background (only outline/border).
// - Mutual coreqs in the same semester do NOT generate warnings.
// - There are "soft" (yellow) and "hard" (red) warnings.
// - Ignored warnings are persisted in draft (draft.ignored_warnings).

function termIdOfCourse(course, placements) {
  const cid = course?.course_id != null ? String(course.course_id) : null;
  if (cid && placements && Object.prototype.hasOwnProperty.call(placements, cid)) {
    const tid = placements[cid];
    return tid != null ? String(tid) : null;
  }
  return course?.term_id != null ? String(course.term_id) : null;
}

function buildTermIndex(terms) {
  const termIndex = new Map();
  (Array.isArray(terms) ? terms : []).forEach((t, i) => {
    if (t && t.term_id != null) termIndex.set(String(t.term_id), i);
  });
  return termIndex;
}

function termIdx(termIndex, tid) {
  if (tid == null) return Infinity;
  const k = String(tid);
  return termIndex.has(k) ? termIndex.get(k) : Infinity;
}

function kindRank(k) {
  return k === "hard" ? 0 : 1;
}

/**
 * Compute warnings (canonical).
 * @returns {Array<{id:string, kind:"soft"|"hard", ignored:boolean, text:string, scope?:"term"|"course", term_id?:string, course_id?:string, sigla?:string, prereq?:string, credits?:number}>}
 */
export function computeWarnings(terms, courses, placements, draft, config) {
  const ignored =
    (draft && typeof draft.ignored_warnings === "object" && draft.ignored_warnings) || {};

  const maxC = config?.max_credits ?? 65;
  const softC = config?.soft_credits ?? 50;

  const tIndex = buildTermIndex(terms);

  // Lookups.
  const bySigla = new Map();
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;
    if (c.sigla != null) bySigla.set(String(c.sigla), c);
  }

  /** @type {Array<any>} */
  const warnings = [];

  const pushWarn = (kind, w) => {
    const id = String(w.id || "");
    const isIgnored = !!(id && ignored[id]);
    warnings.push({ ...w, id, kind, ignored: isIgnored });
  };

  // --- Credit load per term ---
  const creditsByTerm = new Map();
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;
    const tid = termIdOfCourse(c, placements);
    if (!tid) continue;
    const cr = Number(c.creditos ?? c.créditos ?? 0) || 0;
    creditsByTerm.set(tid, (creditsByTerm.get(tid) || 0) + cr);
  }

  for (const [tid, total] of creditsByTerm.entries()) {
    if (total > maxC) {
      pushWarn("hard", {
        id: `credits:hard:${tid}`,
        scope: "term",
        term_id: tid,
        text: `Sobrecarga: ${total} créditos (máx ${maxC})`,
        credits: total,
      });
    } else if (total > softC) {
      pushWarn("soft", {
        id: `credits:soft:${tid}`,
        scope: "term",
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
    const tid = termIdOfCourse(c, placements);
    const cIdx = termIdx(tIndex, tid);

    // Skip prerequisite/offering checks for approved courses.
    if (c.aprobado === true) continue;

    // Offered semester check (soft)
    const offered = Array.isArray(c.semestreOfrecido)
      ? c.semestreOfrecido.filter(Boolean).map(String)
      : [];
    if (offered.length && tid && tIndex.has(String(tid))) {
      const t = terms[tIndex.get(String(tid))];
      const code = t?.code != null ? String(t.code) : null;
      if (code && !offered.includes(code)) {
        pushWarn("soft", {
          id: `offered:${cid}:${tid}`,
          scope: "course",
          course_id: cid,
          sigla,
          term_id: tid,
          text: `${sigla || "Curso"} no se ofrece en este período (${code}).`,
        });
      }
    }

    // Prerequisites check
    const prereqs = Array.isArray(c.prerrequisitos)
      ? c.prerrequisitos.filter(Boolean).map(String)
      : [];

    for (const p of prereqs) {
      const pc = bySigla.get(p);
      if (!pc) {
        pushWarn("soft", {
          id: `prereq:unknown:${cid}:${p}`,
          scope: "course",
          course_id: cid,
          sigla,
          term_id: tid,
          prereq: p,
          text: `${sigla || "Curso"} tiene prerrequisito desconocido: ${p}.`,
        });
        continue;
      }

      if (pc.aprobado === true) continue;

      const ptid = termIdOfCourse(pc, placements);
      const pIdx = termIdx(tIndex, ptid);

      // Mutual coreq in same term: A requires B and B requires A, scheduled same term.
      if (pIdx === cIdx && pIdx !== Infinity) {
        const ppr = Array.isArray(pc.prerrequisitos)
          ? pc.prerrequisitos.filter(Boolean).map(String)
          : [];
        if (sigla && ppr.includes(sigla)) {
          continue; // mutual coreq => no warning
        }
      }

      if (pIdx >= cIdx) {
        pushWarn("hard", {
          id: `prereq:missing:${cid}:${p}:${tid || ""}`,
          scope: "course",
          course_id: cid,
          sigla,
          term_id: tid,
          prereq: p,
          text: `${sigla || "Curso"} requiere ${p} antes.`,
        });
      }
    }
  }

  // --- Co-requisites check ---
  // Expect each course to optionally provide: corequisitos: ["SIGLA", ...]
  // Rule:
  // - OK if the co-requisite is approved, or scheduled in the same term or an earlier one.
  // - HARD warning if scheduled in a later term or not scheduled.
  // - SOFT warning if the co-requisite code is unknown.
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!c) continue;

    // Skip checks for approved courses.
    if (c.aprobado === true) continue;

    const cid = c.course_id != null ? String(c.course_id) : "";
    const sigla = c.sigla != null ? String(c.sigla) : "";
    const tid = termIdOfCourse(c, placements);
    const cIdx = termIdx(tIndex, tid);

    const coreqs = Array.isArray(c.corequisitos)
      ? c.corequisitos.filter(Boolean).map(String)
      : [];

    for (const q of coreqs) {
      const qc = bySigla.get(q);
      if (!qc) {
        pushWarn("soft", {
          id: `coreq:unknown:${cid}:${q}`,
          scope: "course",
          course_id: cid,
          sigla,
          term_id: tid,
          coreq: q,
          text: `${sigla || "Curso"} tiene correquisito desconocido: ${q}.`,
        });
        continue;
      }

      if (qc.aprobado === true) continue;

      const qtid = termIdOfCourse(qc, placements);
      const qIdx = termIdx(tIndex, qtid);

      if (tid == null || qtid == null || cIdx === Infinity || qIdx === Infinity) {
        pushWarn("hard", {
          id: `coreq:missing:${cid}:${q}:${tid || ""}`,
          scope: "course",
          course_id: cid,
          sigla,
          term_id: tid,
          coreq: q,
          text: `${sigla || "Curso"} requiere correquisito ${q} en el mismo semestre o en uno anterior.`,
        });
        continue;
      }

      if (qIdx <= cIdx) continue;

      pushWarn("hard", {
        id: `coreq:missing:${cid}:${q}:${tid || ""}`,
        scope: "course",
        course_id: cid,
        sigla,
        term_id: tid,
        coreq: q,
        text: `${sigla || "Curso"} requiere correquisito ${q} en el mismo semestre o en uno anterior.`,
      });
    }
  }

  // Sort: stable & predictable.
  warnings.sort((a, b) => {
    // Active warnings first, ignored later.
    const ai = a.ignored ? 1 : 0;
    const bi = b.ignored ? 1 : 0;
    if (ai !== bi) return ai - bi;

    const ak = kindRank(a.kind);
    const bk = kindRank(b.kind);
    if (ak !== bk) return ak - bk;

    const ati = termIdx(tIndex, a.term_id);
    const bti = termIdx(tIndex, b.term_id);
    if (ati !== bti) return ati - bti;

    return String(a.text || "").localeCompare(String(b.text || ""), "es");
  });

  return warnings;
}

/**
 * Utility: pick first hard/soft warning for top summary.
 */
export function firstWarningSummary(warnings) {
  if (!Array.isArray(warnings)) return { firstHard: null, firstSoft: null };
  const firstHard = warnings.find((w) => w && w.kind === "hard" && !w.ignored) || null;
  const firstSoft = warnings.find((w) => w && w.kind === "soft" && !w.ignored) || null;
  return { firstHard, firstSoft };
}
