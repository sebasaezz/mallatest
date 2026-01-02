// logic.js (Malla App)
// Extraído de app.js para reducir longitud y aislar lógica.
// Nota: cuando se cargue en index.html, debe ir ANTES que app.js.
// Este archivo NO toca DOM: solo helpers de términos, prereqs, placements y warnings.

// ---------- términos ----------
const TERM_RE = /^([0-9]{4})-([0-2])$/;
const termParts = (term_id) => {
  const m = TERM_RE.exec(term_id || "");
  return m ? { year: parseInt(m[1], 10), sem: parseInt(m[2], 10) } : null;
};
const termIndex = (term_id) => {
  const p = termParts(term_id);
  return p ? (p.year * 10 + p.sem) : 999999;
};
const SEM_CODE_BY_NUM = { 0:"V", 1:"I", 2:"P" };
const SEM_ORDER = ["V", "I", "P"];
const semCodeFromNum = (n) => SEM_CODE_BY_NUM.hasOwnProperty(n) ? SEM_CODE_BY_NUM[n] : null;
const parseSemCode = (raw) => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (Number.isFinite(n) && SEM_CODE_BY_NUM.hasOwnProperty(n)) return semCodeFromNum(n);
  const u = s.toUpperCase();
  if (SEM_ORDER.includes(u)) return u;
  return null;
};
function normalizeSemestreOfrecido(course) {
  const raw = (course && course.hasOwnProperty("semestreOfrecido")) ? course.semestreOfrecido : course?.frontmatter?.semestreOfrecido;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const set = new Set();
  for (const item of list) {
    const code = parseSemCode(item);
    if (code) set.add(code);
  }
  return set;
}
const nextNonSummer = (p) => {
  if (!p) return null;
  const { year:y, sem:s } = p;
  if (s === 0) return { year:y, sem:1 }; // V -> I
  if (s === 1) return { year:y, sem:2 }; // I -> P
  return { year:y + 1, sem:1 };          // P -> siguiente año I
};

// Default para "Agregar período": siguiente período NO-verano basado en el último período con cursos.
function computeNextNonSummerFromLast(terms, courses, placements){
  const countByTerm = new Map();
  for (const c of (courses || [])) {
    const tid = placements?.get?.(c.course_id) || c.term_id;
    if (!tid) continue;
    countByTerm.set(tid, (countByTerm.get(tid) || 0) + 1);
  }

  let lastTid = null, lastIdx = -1;
  for (const [tid, cnt] of countByTerm.entries()) {
    if (!cnt) continue;
    const idx = termIndex(tid);
    if (idx !== 999999 && idx > lastIdx) { lastIdx = idx; lastTid = tid; }
  }

  let base = lastTid ? termParts(lastTid) : null;
  if (!base) {
    let bestIdx = -1;
    for (const t of (terms || [])) {
      const idx = termIndex(t.term_id);
      if (idx !== 999999 && idx > bestIdx) { bestIdx = idx; base = { year: Number(t.year) || 0, sem: Number(t.sem) || 0 }; }
    }
  }

  if (!base?.year) {
    const now = new Date();
    return { year: now.getFullYear(), sem: 1 };
  }
  return nextNonSummer(base) || { year: base.year, sem: 1 };
}

// ---------- prereqs parsing ----------
function normalizePrereqs(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const out = [];
  for (const item0 of list) {
    const item = String(item0 || "").trim();
    if (!item || item.toLowerCase() === "nt") continue;
    const m = /^(.+?)\(c\)$/.exec(item);
    out.push(m ? { code: m[1].trim(), isCo: true, raw: item } : { code: item, isCo: false, raw: item });
  }
  return out;
}

// ---------- draft terms + placements ----------
function buildEffectiveTermsAndPlacements(allTerms, allCourses, draft) {
  const termsById = new Map();
  for (const t of (allTerms || [])) termsById.set(t.term_id, { ...t });

  const termCode = (sem) => (CONFIG?.term_code_by_sem && (CONFIG.term_code_by_sem[String(sem)] || CONFIG.term_code_by_sem[sem])) || "?";
  const ensureTerm = (tid) => {
    if (!tid || termsById.has(tid)) return;
    const p = termParts(tid) || { year: 0, sem: 0 };
    termsById.set(tid, {
      term_id: tid, year: p.year, sem: p.sem, code: termCode(p.sem),
      folderName: tid, folderRel: "(draft)", searchRootRel: "(draft)", hasCoursesDir: false, isCustom: true,
    });
  };

  for (const ct of (Array.isArray(draft?.custom_terms) ? draft.custom_terms : [])) {
    const tid = String(ct?.term_id || "").trim();
    if (tid) ensureTerm(tid);
  }

  const placements = new Map();
  for (const c of (allCourses || [])) placements.set(c.course_id, c.term_id);

  const pDraft = (draft && typeof draft.placements === "object") ? draft.placements : {};
  for (const [cid, tid0] of Object.entries(pDraft || {})) {
    const tid = String(tid0 || "").trim();
    if (!cid || !tid) continue;
    ensureTerm(tid);
    placements.set(cid, tid);
  }

  const order = Array.isArray(draft?.term_order) ? draft.term_order : [];
  let terms = Array.from(termsById.values());
  if (order.length) {
    const idx = new Map(order.map((id, i) => [id, i]));
    terms.sort((a, b) => {
      const ia = idx.has(a.term_id) ? idx.get(a.term_id) : 999999;
      const ib = idx.has(b.term_id) ? idx.get(b.term_id) : 999999;
      return (ia - ib) || (termIndex(a.term_id) - termIndex(b.term_id));
    });
  } else {
    terms.sort((a, b) => termIndex(a.term_id) - termIndex(b.term_id));
  }

  return { terms, placements };
}

// ---------- warnings (soft/hard) ----------
function computeWarnings(terms, courses, placements, draft) {
  const warnings = [];
  const ignored = (draft && typeof draft.ignored_warnings === "object") ? draft.ignored_warnings : {};

  const isTemp = (cid) => String(cid || "").startsWith("draft:");
  let dbgTempLeft = (typeof DEBUG_WARN !== "undefined" && DEBUG_WARN) ? 5 : 0;
  if (typeof DEBUG_WARN !== "undefined" && DEBUG_WARN) {
    console.groupCollapsed("[DBG warn] computeWarnings", { terms: terms?.length || 0, courses: courses?.length || 0 });
  }

  const termPos = new Map(terms.map((t, i) => [t.term_id, i]));
  const courseBySigla = new Map();

  for (const c of (courses || [])) {
    const s = String(c.sigla || "").trim();
    if (s) courseBySigla.set(s, c);
  }

  // Credit warnings per term
  const maxC = CONFIG?.max_credits ?? 65;
  const softC = CONFIG?.soft_credits ?? 50;

  const creditsByTerm = new Map();
  for (const c of (courses || [])) {
    const tid = placements.get(c.course_id) || c.term_id;
    creditsByTerm.set(tid, (creditsByTerm.get(tid) || 0) + (Number(c.creditos) || 0));
  }

  for (const t of terms) {
    const total = creditsByTerm.get(t.term_id) || 0;
    if (total > maxC) warnings.push({
      id:`credits:hard:${t.term_id}:${total}`, kind:"hard", scope:"term", term_id:t.term_id, course_id:null,
      text:`Créditos en ${t.term_id}: ${total} (máx ${maxC}).`, sub:"Excede el máximo permitido por período.",
    });
    else if (total > softC) warnings.push({
      id:`credits:soft:${t.term_id}:${total}`, kind:"soft", scope:"term", term_id:t.term_id, course_id:null,
      text:`Créditos en ${t.term_id}: ${total} (sobre ${softC}).`, sub:"Carga alta (warning soft).",
    });
  }

  // Prereq warnings per course
  for (const c of (courses || [])) {
    const tid = placements.get(c.course_id) || c.term_id;
    const tpos = termPos.has(tid) ? termPos.get(tid) : 999999;
    const termInfo = termParts(tid);
    const termSemCode = termInfo ? semCodeFromNum(termInfo.sem) : null;
    const offered = normalizeSemestreOfrecido(c);
    const offeredList = SEM_ORDER.filter(x => offered.has(x));

    if ((typeof DEBUG_WARN !== "undefined" && DEBUG_WARN) && dbgTempLeft > 0 && isTemp(c?.course_id)) {
      dbgTempLeft--;
      console.log("[DBG warn] temp course fields", {
        sigla: c?.sigla, course_id: c?.course_id, tid,
        prerrequisitos: c?.prerrequisitos,
        fm_prerrequisitos: c?.frontmatter?.prerrequisitos,
        semestreOfrecido: c?.semestreOfrecido,
        fm_semestreOfrecido: c?.frontmatter?.semestreOfrecido,
        normalized: normalizePrereqs(c?.prerrequisitos),
      });
    }

    if (termSemCode && offered.size && !offered.has(termSemCode)) {
      const allowedText = offeredList.length ? offeredList.join("/") : "V/I/P";
      warnings.push({
        id:`offer:${c.sigla}:${tid}`, kind:"soft", scope:"course", term_id:tid, course_id:c.course_id,
        text:`${c.sigla}: oferta ${allowedText}, ubicado en ${tid}.`, sub:"Verifica que el período coincida con los semestres ofrecidos.",
        meta:{ offered: offeredList, termSemCode },
      });
    }

    for (const pr of normalizePrereqs(c.prerrequisitos)) {
      const reqCode = pr.code;
      const reqCourse = courseBySigla.get(reqCode);
      const baseId = `${pr.isCo ? "co" : "pre"}:${c.sigla}:${reqCode}:${tid}`;

      if (!reqCourse) {
        warnings.push({
          id:`missing:${baseId}`, kind:"hard", scope:"course", term_id:tid, course_id:c.course_id,
          text:`${c.sigla}: No existe requisito ${reqCode}.`, sub: pr.isCo ? "Correquisito faltante." : "Prerrequisito faltante.",
          meta:{ reqCode, isCo: pr.isCo },
        });
        continue;
      }

      if (reqCourse.aprobado === true) continue;

      const reqTid = placements.get(reqCourse.course_id) || reqCourse.term_id;
      const reqPos = termPos.has(reqTid) ? termPos.get(reqTid) : 999999;
      const okTemporal = pr.isCo ? (reqPos <= tpos) : (reqPos < tpos);

      if (!okTemporal) {
        warnings.push({
          id:`temporal:${baseId}`, kind:"hard", scope:"course", term_id:tid, course_id:c.course_id,
          text:`${c.sigla}: ${pr.isCo ? "Correquisito" : "Prerrequisito"} ${reqCode} está mal ubicado (${reqTid}).`,
          sub: pr.isCo ? "Debe estar en el mismo período o antes." : "Debe estar en un período anterior.",
          meta:{ reqCode, isCo: pr.isCo, reqTid },
        });
        continue;
      }

      if (pr.isCo) continue; // correquisito: no soft

      warnings.push({
        id:`notapproved:${baseId}`, kind:"soft", scope:"course", term_id:tid, course_id:c.course_id,
        text:`${c.sigla}: Requisito ${reqCode} no está aprobado.`, sub:"No bloquea, pero es warning soft.",
        meta:{ reqCode, isCo: pr.isCo, reqTid },
      });
    }
  }

  for (const w of warnings) w.ignored = !!ignored[w.id];

  if (typeof DEBUG_WARN !== "undefined" && DEBUG_WARN) {
    const tempW = warnings.filter(w => isTemp(w.course_id));
    console.log("[DBG warn] warnings for temp courses", tempW.length, tempW.slice(0, 12));
    console.groupEnd();
  }
  return warnings;
}
