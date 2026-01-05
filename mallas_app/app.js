// malla_app UI
// - Renderiza términos como columnas
// - Modo borrador: drag&drop + creación de períodos futuros
// - Warnings (soft/hard) + ignorar persistente (draft)
// - Unlock view: click en curso -> resalta + parpadea lo que desbloquea

import { byId } from "./modules/utils.js";
import { showNotice, hideNotice } from "./modules/toasts.js";
import * as api from "./modules/api.js";
import { state, setData, rebuildMaps } from "./modules/state.js";
import { computeWarnings as computeWarningsBase } from "./modules/warnings.js";
import {
  initRender,
  fullRender as fullRenderMod,
  openWarningsModal as openWarningsModalMod,
  closeWarningsModal as closeWarningsModalMod,
} from "./modules/render.js";
import { initDragDrop } from "./modules/dragdrop.js";
import { initUnlock } from "./modules/unlock.js";
import { openCourseMenu, closeCourseMenu } from "./modules/courseMenu.js";
import { openCreateCourseModal } from "./modules/courseModal.js";
import {
  ensureDraftTempCourses,
  mergeTempCourses,
  makeTempCourse,
  addTempCourseToDraft,
  ensureDraftOverrides,
  listAllSiglas,
} from "./modules/tempCourses.js";

// State moved to modules/state.js (kept as a single shared object).
let ADD_TERM_TOUCHED=false; // si el usuario tocó addYear/addSem, no auto-sobrescribir
let MATERIALIZE_ALL_BUSY = false; // lock para materializar todos los temporales

const $ = byId;
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

// ---------- debug (colors/categories) ----------
// Actívalo abriendo la app con:  http://localhost:PORT/?debugColors=1
const DEBUG_COLORS = new URLSearchParams(location.search).has("debugColors");
const DEBUG_LOG_LIMIT = 12;
let _dbgLogged = false;

// ---------- theme (optional dark mode) ----------
const setTheme = (theme) => {
  document.documentElement.dataset.theme = (theme === "dark") ? "dark" : "light";
};
function loadTheme(){
  const saved = localStorage.getItem("theme");
  const theme = (saved === "dark" || saved === "light") ? saved : "light";
  setTheme(theme);
  const t = $("themeToggle");
  if (t) t.checked = (theme === "dark");
}
function saveTheme(theme){
  const t = (theme === "dark") ? "dark" : "light";
  localStorage.setItem("theme", t);
  setTheme(t);
}

// ---------- concentraciones (colores + orden) ----------
// Orden vertical dentro de cada período (arriba→abajo): MScB, Major, Minor, FI, OFG, extra
const CAT = {
  MScB:{ name:"Matemáticas y ciencias básicas", abbr:"MScB", color:"#FFCA08", cls:"cat-mscb",  order:0 },
  M:   { name:"Major",                        abbr:"M",    color:"#F1592A", cls:"cat-major", order:1 },
  m:   { name:"Minor",                        abbr:"m",    color:"#D8DD26", cls:"cat-minor", order:2 },
  FI:  { name:"Fundamentos de Ingeniería",     abbr:"FI",   color:"#56A2D6", cls:"cat-fi",    order:3 },
  OFG: { name:"Formación general",            abbr:"OFG",  color:"#7389C5", cls:"cat-ofg",   order:4 },
  ex:  { name:"Extra",                        abbr:"ex",   color:"#CCCCCC", cls:"cat-extra", order:5 },
};
const CAT_KEY = { MSCB:"MScB", FI:"FI", OFG:"OFG", EX:"ex", M:"M" };
function normalizeCat(raw){
  const s = String(raw || "").trim();
  if (!s) return "ex";
  if (s === "m" || s === "M") return s;
  return CAT_KEY[s.toUpperCase()] || "ex";
}
function getCatInfo(course){
  const fm = course?.frontmatter;
  const raw = course?.concentracion ?? fm?.concentracion ?? fm?.["concentración"] ?? "ex";
  return CAT[normalizeCat(raw)] || CAT.ex;
}

let _legendDone = false;
function renderLegend(){
  if (_legendDone) return;
  const el = $("legend");
  if (!el) return;
  el.innerHTML = "";
  const items = Object.entries(CAT).map(([key, v]) => ({ key, ...v })).sort((a,b)=>a.order-b.order);
  for (const it of items) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="sw" style="--swatch:${it.color}"></div><div class="lbl">${it.name} (${it.abbr})</div>`;
    el.appendChild(item);
  }
  _legendDone = true;
}

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

function setAddTermDefaultIfUntouched(terms, courses, placements, force=false){
  const yEl = $("addYear"), sEl = $("addSem");
  if (!yEl || !sEl) return;
  if (!force && ADD_TERM_TOUCHED) return;
  const next = computeNextNonSummerFromLast(terms, courses, placements);
  if (!next) return;
  yEl.value = String(next.year);
  sEl.value = String(next.sem);
}

// ---------- UI helpers ----------
const mk = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
};
const append = (p, ...kids) => { for (const k of kids) if (k) p.appendChild(k); return p; };

let WARN_NOTICE_ID = null;
function setWarnNotice(kind, text) {
  try { if (WARN_NOTICE_ID) hideNotice(WARN_NOTICE_ID); } catch {}
  WARN_NOTICE_ID = showNotice(kind, text);
}
function clearWarnNotice(){
  try { if (WARN_NOTICE_ID) hideNotice(WARN_NOTICE_ID); } catch {}
  WARN_NOTICE_ID = null;
}


async function loadAll() {
  const [config, all, draft] = await Promise.all([
    api.getConfig(),
    api.getAll(),
    api.getDraft(),
  ]);

  // Keep a reference to the real course list from the backend.
  // We'll merge draft.temp_courses on top for runtime.
  state._realCourses = Array.isArray(all?.courses) ? all.courses : [];

  setData({ config, all, draft });
  mergeCoursesWithTemps();

  $("ver").textContent = state.all?.version || "";
  $("base").textContent = state.all?.debug?.base_dir || "";
  const mc = $("maxCred");
  if (mc) mc.textContent = state.config?.max_credits ?? "";
  $("debugPre").textContent = JSON.stringify(state.all, null, 2);

  state.dirtyDraft = false;
  ADD_TERM_TOUCHED = false;
  updateDraftButtons();
}

let _materializeAllClickHandler = null;
function syncMaterializeAllHandler() {
  const btn = $("materializeAllTemps");
  if (!btn) return;
  if (!state.draftMode) {
    if (_materializeAllClickHandler) {
      btn.removeEventListener("click", _materializeAllClickHandler);
      _materializeAllClickHandler = null;
    }
    return;
  }
  if (_materializeAllClickHandler) return;
  _materializeAllClickHandler = () => {
    if (!state.draftMode || MATERIALIZE_ALL_BUSY) return;
    materializeAllTempCourses();
  };
  btn.addEventListener("click", _materializeAllClickHandler);
}

function updateDraftButtons() {
  const saveBtn = $("saveBtn"), resetBtn = $("resetBtn"), addBtn = $("addTermBtn"), hardBtn = $("hardResetBtn"), matBtn = $("materializeAllTemps");
  if (saveBtn) saveBtn.disabled = !state.draftMode || !state.dirtyDraft;
  if (resetBtn) resetBtn.disabled = !state.draftMode;
  if (hardBtn) hardBtn.disabled = !state.draftMode;
  if (addBtn) addBtn.disabled = !state.draftMode;
  if (matBtn) matBtn.disabled = !state.draftMode || MATERIALIZE_ALL_BUSY;
  syncMaterializeAllHandler();
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

// ---------- temp courses (draft-only) ----------
function mergeCoursesWithTemps() {
  if (!state.all || !state.draft) return;
  ensureDraftTempCourses(state.draft);

  const baseReal = Array.isArray(state._realCourses)
    ? state._realCourses.filter((c) => !c?.is_temp)
    : (Array.isArray(state.all?.courses) ? state.all.courses : []).filter((c) => !c?.is_temp);

  // Keep an always-clean copy of real courses (no temps) to avoid duplication on repeated merges.
  state._realCourses = baseReal;

  const real = baseReal;

  // Replace array reference so unlock/warnings can detect changes.
  state.all.courses = mergeTempCourses(real, state.draft);
  rebuildMaps();
}

function openTempCourseCreator(termId) {
  if (!state.draftMode) return;
  const term_id = String(termId || "").trim();
  if (!term_id) return;

  const catalog = Array.isArray(state.all?.courses) ? state.all.courses : [];
  const siglaSet = listAllSiglas(catalog);

  openCreateCourseModal({
    term_id,
    catalog,
    siglaSet,
    defaultConcentracion: "ex",
    onSubmit: (form) => {
      try {
        const existingSiglas = listAllSiglas(Array.isArray(state.all?.courses) ? state.all.courses : []);
        const course = makeTempCourse(form, term_id, { existingSiglas });
        addTempCourseToDraft(state.draft, course, term_id);

        state.dirtyDraft = true;
        mergeCoursesWithTemps();
        updateDraftButtons();
        fullRenderMod();
        showNotice("info", `Curso temporal creado: ${course.sigla}.`);
      } catch (e) {
        const kind = e?.noticeKind === "soft" ? "soft" : "hard";
        showNotice(kind, String(e?.message || e));
      }
    },
  });
}

function deleteTempCourse(course_id) {
  const cid = String(course_id || "").trim();
  if (!cid) return;
  if (!state?.draft || typeof state.draft !== "object") {
    showNotice("soft", "No hay borrador cargado.");
    return;
  }

  const temps = ensureDraftTempCourses(state.draft);
  const course = temps.find((c) => String(c?.course_id || "") === cid);
  if (!course) {
    showNotice("soft", "Curso temporal no encontrado.");
    return;
  }

  const ok = confirm(`¿Eliminar curso temporal ${course.sigla || course.nombre || cid}?`);
  if (!ok) return;

  state.draft.placements = state.draft.placements && typeof state.draft.placements === "object" ? state.draft.placements : {};
  state.draft.temp_courses = temps.filter((c) => String(c?.course_id || "") !== cid);
  delete state.draft.placements[cid];
  const overriddenId = String(course?.override_of || "").trim();
  if (overriddenId) {
    const overrides = ensureDraftOverrides(state.draft);
    state.draft.overrides = overrides.filter((id) => id !== overriddenId);
  }

  state.dirtyDraft = true;
  mergeCoursesWithTemps();
  updateDraftButtons();
  fullRender();
  closeCourseMenu();

  const label = String(course?.sigla || course?.nombre || cid);
  showNotice("info", `Curso temporal eliminado: ${label}.`);
}

function updateTempCourse(course, form) {
  if (!state?.draft || typeof state.draft !== "object") {
    showNotice("soft", "No hay borrador cargado.");
    return;
  }

  const cid = String(course?.course_id || "").trim();
  if (!cid) return;

  const nombre = String(form?.nombre || "").trim();
  const creditos = Number(form?.creditos) || 0;
  if (!nombre) {
    showNotice("soft", "El nombre del curso está vacío.");
    return;
  }
  if (!(Number.isFinite(creditos) && creditos > 0)) {
    showNotice("soft", "Los créditos deben ser un número positivo.");
    return;
  }

  const temps = ensureDraftTempCourses(state.draft);
  const draftCourse = temps.find((c) => String(c?.course_id || "") === cid);
  if (!draftCourse) {
    showNotice("soft", "Curso temporal no encontrado.");
    return;
  }

  const oldSigla = String(draftCourse.sigla || "").trim().toUpperCase();
  let newSigla = String(form?.sigla || "").trim().toUpperCase();
  if (!newSigla) newSigla = oldSigla;

  const existing = listAllSiglas(state.all?.courses || []);
  existing.delete(oldSigla);
  if (existing.has(newSigla)) {
    const base = newSigla;
    for (let i = 0; i < 26; i++) {
      const trial = base + String.fromCharCode(65 + i);
      if (!existing.has(trial)) {
        newSigla = trial;
        break;
      }
    }
  }

  draftCourse.sigla = newSigla;
  draftCourse.frontmatter = draftCourse.frontmatter && typeof draftCourse.frontmatter === "object" ? draftCourse.frontmatter : {};
  draftCourse.frontmatter.sigla = newSigla;

  draftCourse.nombre = nombre;
  draftCourse.frontmatter.nombre = draftCourse.nombre;

  draftCourse.creditos = creditos;
  draftCourse.frontmatter.creditos = draftCourse.creditos;

  draftCourse.concentracion = String(form?.concentracion || "ex").trim() || "ex";
  draftCourse.frontmatter.concentracion = draftCourse.concentracion;

  const offered = Array.isArray(form?.semestreOfrecido) ? form.semestreOfrecido.slice() : [];
  draftCourse.semestreOfrecido = offered;
  draftCourse.frontmatter.semestreOfrecido = offered.slice();

  const prereqsArr = Array.isArray(form?.prerrequisitos) ? form.prerrequisitos.map((s) => String(s).trim()).filter(Boolean) : [];
  const coreqsArr = Array.isArray(form?.correquisitos) ? form.correquisitos.map((s) => String(s).trim()).filter(Boolean) : [];
  const combinedReqs = prereqsArr.concat(coreqsArr.map((c) => `${c}(c)`));
  draftCourse.prerrequisitos = combinedReqs;
  draftCourse.frontmatter.prerrequisitos = combinedReqs;

  draftCourse.aprobado = !!form?.aprobado;
  draftCourse.frontmatter.aprobado = draftCourse.aprobado;

  state.dirtyDraft = true;
  mergeCoursesWithTemps();
  updateDraftButtons();
  fullRenderMod();

  const label = String(draftCourse.sigla || draftCourse.nombre || cid);
  showNotice("info", `Curso temporal actualizado: ${label}.`);
  closeCourseMenu();
}

function overrideCourse(course, form) {
  if (!state?.draft || typeof state.draft !== "object") {
    showNotice("soft", "No hay borrador cargado.");
    return;
  }

  const cid = String(course?.course_id || "").trim();
  if (!cid) return;

  const nombre = String(form?.nombre || "").trim();
  const creditos = Number(form?.creditos) || 0;
  if (!nombre) {
    showNotice("soft", "El nombre del curso está vacío.");
    return;
  }
  if (!(Number.isFinite(creditos) && creditos > 0)) {
    showNotice("soft", "Los créditos deben ser un número positivo.");
    return;
  }

  const placementTid = (state.draft?.placements && state.draft.placements[cid]) || course.term_id;
  const term_id = String(placementTid || "").trim();
  if (!term_id) {
    showNotice("soft", "El curso no tiene período asignado.");
    return;
  }

  const oldSigla = String(course.sigla || "").trim().toUpperCase();
  let newSigla = String(form?.sigla || "").trim().toUpperCase();
  if (!newSigla) newSigla = oldSigla;

  const existing = listAllSiglas(state.all?.courses || []);
  existing.delete(oldSigla);
  if (existing.has(newSigla)) {
    const base = newSigla;
    for (let i = 0; i < 26; i++) {
      const trial = base + String.fromCharCode(65 + i);
      if (!existing.has(trial)) {
        newSigla = trial;
        break;
      }
    }
  }

  const prereqsArr = Array.isArray(form?.prerrequisitos) ? form.prerrequisitos.map((s) => String(s).trim()).filter(Boolean) : [];
  const coreqsArr = Array.isArray(form?.correquisitos) ? form.correquisitos.map((s) => String(s).trim()).filter(Boolean) : [];
  const offered = Array.isArray(form?.semestreOfrecido) ? form.semestreOfrecido : [];
  const conc = String(form?.concentracion || "ex").trim() || "ex";

  const payload = {
    ...form,
    sigla: newSigla,
    nombre,
    creditos,
    prerrequisitos: prereqsArr,
    correquisitos: coreqsArr,
    semestreOfrecido: offered,
    concentracion: conc,
  };

  let newCourse;
  try {
    newCourse = makeTempCourse(payload, term_id, { existingSiglas: existing });
  } catch (e) {
    const kind = e?.noticeKind === "soft" ? "soft" : "hard";
    showNotice(kind, String(e?.message || e));
    return;
  }

  newCourse.temp_kind = "override";
  newCourse.override_of = cid;
  newCourse.aprobado = !!form?.aprobado;
  newCourse.frontmatter = newCourse.frontmatter && typeof newCourse.frontmatter === "object" ? newCourse.frontmatter : {};
  newCourse.frontmatter.aprobado = newCourse.aprobado;

  ensureDraftOverrides(state.draft);
  if (!state.draft.overrides.includes(cid)) state.draft.overrides.push(cid);
  if (state.draft.placements && typeof state.draft.placements === "object") {
    delete state.draft.placements[cid];
  }

  addTempCourseToDraft(state.draft, newCourse, term_id);

  state.dirtyDraft = true;
  mergeCoursesWithTemps();
  updateDraftButtons();
  fullRenderMod();

  const label = String(newCourse.sigla || newCourse.nombre || newCourse.course_id);
  showNotice("info", `Curso temporal creado: ${label}.`);
  closeCourseMenu();
}

function moveTempCourseToDisk(course) {
  const label = String(course?.sigla || course?.nombre || "").trim() || "curso temporal";
  showNotice("soft", `Mover a disco aún no está disponible para ${label}.`);
}

async function materializeTempCourse(course) {
  const cid = String(course?.course_id || "").trim();
  if (!cid || !course) {
    showNotice("soft", "Curso temporal inválido.");
    return;
  }
  if (!course.is_temp) {
    showNotice("soft", "Solo se pueden guardar cursos temporales en disco.");
    return;
  }

  const placementTid = (state.draft?.placements && state.draft.placements[cid]) || course.term_id;
  const term_id = String(placementTid || "").trim();
  if (!term_id) {
    showNotice("hard", "El curso temporal no tiene período asignado.");
    return;
  }

  const fm = course.frontmatter && typeof course.frontmatter === "object" ? course.frontmatter : {};
  const payload = {
    term_id,
    sigla: course.sigla || fm.sigla,
    nombre: course.nombre || fm.nombre,
    creditos: course.creditos ?? course.créditos ?? fm.creditos ?? fm.créditos,
    aprobado: course.aprobado ?? fm.aprobado,
    concentracion: course.concentracion ?? course.concentración ?? fm.concentracion ?? fm["concentración"],
    prerrequisitos: course.prerrequisitos ?? fm.prerrequisitos,
    semestreOfrecido: course.semestreOfrecido ?? fm.semestreOfrecido,
    frontmatter: fm,
  };

  try {
    // Backward-compatible: some deployments may not expose materializeCourse yet.
    const materializeFn =
      typeof api.materializeCourse === "function"
        ? api.materializeCourse
        : (body) =>
            api.fetchJSON("/api/materialize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body ?? {}),
            });

    const res = await materializeFn(payload);

    ensureDraftTempCourses(state.draft);
    state.draft.temp_courses = state.draft.temp_courses.filter((c) => String(c?.course_id || "") !== cid);
    if (state.draft.placements && typeof state.draft.placements === "object") {
      delete state.draft.placements[cid];
    }
    const overriddenId = String(course?.override_of || "").trim();
    if (overriddenId) {
      const overrides = ensureDraftOverrides(state.draft);
      state.draft.overrides = overrides.filter((id) => id !== overriddenId);
    }

    state.dirtyDraft = true;
    await api.saveDraft(state.draft || {});
    state.dirtyDraft = false;

    const [all, draft] = await Promise.all([api.getAll(), api.getDraft()]);
    setData({ config: state.config, all, draft });
    mergeCoursesWithTemps();
    updateDraftButtons();
    fullRenderMod();

    const rel = res?.fileRel ? ` (${res.fileRel})` : "";
    showNotice("info", `Curso guardado en disco${rel ? ":" : ""}${rel}`);
    closeCourseMenu();
  } catch (e) {
    showNotice("hard", String(e?.message || e));
  }
}

async function materializeAllTempCourses() {
  if (!state.draftMode) return;
  if (!state?.draft || typeof state.draft !== "object") {
    showNotice("soft", "No hay borrador cargado.");
    return;
  }

  const btn = $("materializeAllTemps");
  const temps = ensureDraftTempCourses(state.draft);
  const list = Array.isArray(temps) ? temps.filter((c) => c && c.is_temp) : [];
  if (!list.length) {
    showNotice("soft", "No hay cursos temporales para guardar en disco.");
    return;
  }

  MATERIALIZE_ALL_BUSY = true;
  const prevLabel = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardando en disco…";
  }
  updateDraftButtons();

  try {
    for (const course of list) {
      await materializeTempCourse(course);
    }
    showNotice("info", "Cursos temporales guardados en disco.");
  } catch (e) {
    showNotice("hard", String(e?.message || e));
  } finally {
    MATERIALIZE_ALL_BUSY = false;
    if (btn) {
      btn.textContent = prevLabel || "Guardar en disco";
    }
    updateDraftButtons();
  }
}

// ---------- draft terms + placements ----------
function buildEffectiveTermsAndPlacements(allTerms, allCourses, draft) {
  const termsById = new Map();
  for (const t of (allTerms || [])) termsById.set(t.term_id, { ...t });

  const termCode = (sem) => (state.config?.term_code_by_sem && (state.config.term_code_by_sem[String(sem)] || state.config.term_code_by_sem[sem])) || "?";
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
    // IMPORTANT: keep chronological order (termIndex) as the primary sort key.
    // term_order only breaks ties / stabilizes ordering, otherwise custom terms
    // would jump to the far-left just because they are present in term_order.
    const idx = new Map(order.map((id, i) => [String(id), i]));
    terms.sort((a, b) => {
      const ta = termIndex(a.term_id);
      const tb = termIndex(b.term_id);
      if (ta !== tb) return ta - tb;
      const ia = idx.has(a.term_id) ? (idx.get(a.term_id) ?? 999999) : 999999;
      const ib = idx.has(b.term_id) ? (idx.get(b.term_id) ?? 999999) : 999999;
      return (ia - ib) || String(a.term_id || "").localeCompare(String(b.term_id || ""));
    });
  } else {
    terms.sort((a, b) => termIndex(a.term_id) - termIndex(b.term_id));
  }

  return { terms, placements };
}

// ---------- warnings (soft/hard) ----------
// Adapter notes:
// - modules/warnings.js expects placements as a plain object (not Map).
// - our frontmatter encodes correquisitos as "CODIGO(c)".
//   We pass them as `corequisitos: [...]` (for proper co-req warnings) and strip them from `prerrequisitos`
//   so they don't generate false "unknown prereq" warnings.
function computeWarnings(terms, courses, placementsMap, draft, config) {
  const placementsObj = Object.fromEntries(placementsMap?.entries?.() || []);

  const normalizedCourses = (courses || []).map((c) => {
    const prs = normalizePrereqs(c?.prerrequisitos);
    const onlyPrereq = prs.filter((p) => !p.isCo).map((p) => p.code);
    const coreqs = prs.filter((p) => p.isCo).map((p) => p.code);
    return { ...c, prerrequisitos: onlyPrereq, corequisitos: coreqs };
  });

  return computeWarningsBase(terms, normalizedCourses, placementsObj, draft, config) || [];
}

// ---------- render ----------
function render(terms, courses, placements, warnings) {
  const filter = ($("filter")?.value || "").trim().toLowerCase();
  const showIgnored = !!$("showIgnored")?.checked;

  // Debug
  const dbg = DEBUG_COLORS && !_dbgLogged;
  let dbgLeft = dbg ? DEBUG_LOG_LIMIT : 0;
  if (dbg) console.log("[DBG colors] start render", { terms: terms?.length || 0, courses: courses?.length || 0 });

  // byTerm
  const byTerm = new Map();
  for (const t of terms) byTerm.set(t.term_id, []);
  for (const c of (courses || [])) {
    const tid = placements.get(c.course_id) || c.term_id;
    if (!byTerm.has(tid)) byTerm.set(tid, []);
    byTerm.get(tid).push(c);
  }

  for (const arr of byTerm.values()) {
    arr.sort((a, b) => {
      const ca = getCatInfo(a).order, cb = getCatInfo(b).order;
      return (ca - cb) || String(a.sigla||"").localeCompare(String(b.sigla||""));
    });
  }

  // Warnings visibles + index por curso
  const activeWarnings = (warnings || []).filter(w => showIgnored ? true : !w.ignored);
  const wByCourse = new Map();
  for (const w of activeWarnings) {
    if (!w.course_id) continue;
    if (!wByCourse.has(w.course_id)) wByCourse.set(w.course_id, []);
    wByCourse.get(w.course_id).push(w);
  }

  $("count").textContent = String(courses?.length || 0);
  $("warnCount").textContent = String(activeWarnings.length);

  // Créditos por término
  const creditsByTerm = new Map();
  for (const c of (courses || [])) {
    const tid = placements.get(c.course_id) || c.term_id;
    creditsByTerm.set(tid, (creditsByTerm.get(tid) || 0) + (Number(c.creditos) || 0));
  }

  const grid = $("grid");
  grid.innerHTML = "";

  for (const t of terms) {
    const col = mk("div", "term");
    col.dataset.termId = t.term_id;

    const th = mk("div", "term-h");
    const title = mk("div");
    title.innerHTML = `<div class="term-title">${t.term_id}</div><div class="term-sub">${t.code}</div>`;

    const total = creditsByTerm.get(t.term_id) || 0;
    const maxC = state.config?.max_credits ?? 65;
    const softC = state.config?.soft_credits ?? 50;
    const cred = mk("div", "term-credits", `${total} cr`);
    if (total > maxC) cred.classList.add("bad");
    else if (total > softC) cred.classList.add("warn");

    append(th, title, cred);

    if (state.draftMode && t.isCustom && !(byTerm.get(t.term_id) || []).length) {
      const del = mk("button", "term-del", "✕");
      del.type = "button";
      del.title = "Eliminar período vacío";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
                const tid = t.term_id;
        state.draft.custom_terms = (Array.isArray(state.draft.custom_terms) ? state.draft.custom_terms : []).filter(x => String(x?.term_id || "") !== tid);
        state.draft.term_order = (Array.isArray(state.draft.term_order) ? state.draft.term_order : []).filter(x => String(x || "") !== tid);
        if (state.draft.placements && typeof state.draft.placements === "object") {
          for (const [cid, pt] of Object.entries(state.draft.placements)) if (String(pt) === tid) delete state.draft.placements[cid];
        }
        state.dirtyDraft = true;
        updateDraftButtons();
    fullRenderMod();
        showNotice("info", `Período eliminado: ${tid}.`);
      });
      th.appendChild(del);
    }

    const list = mk("div", "list");
    list.dataset.termId = t.term_id;

    list.appendChild(mk("div", "drop-hint", "Suelta aquí"));

    for (const c of (byTerm.get(t.term_id) || [])) {
      const sigla = String(c.sigla || "").trim();
      const nombre = String(c.nombre || "").trim();
      if (filter) {
        const hay = `${sigla} ${nombre}`.toLowerCase();
        if (!hay.includes(filter)) continue;
      }

      const card = mk("div", "course");
      const cat = getCatInfo(c);
      if (cat?.cls) card.classList.add(cat.cls);

      card.draggable = !!state.draftMode;
      card.dataset.courseId = c.course_id;

      const isApproved = (c.aprobado === true);
      if (isApproved) card.classList.add("aprobado");

      const cw = wByCourse.get(c.course_id) || [];
      if (cw.some(w => w.kind === "hard")) card.classList.add("bad");

      const row1 = mk("div", "row1");
      const right = mk("div", "row1-right");
      append(right,
        mk("div", "cred", String(Number(c.creditos) || 0)),
        isApproved ? mk("div", "status-badge approved inline", "✓") : null,
      );
      append(row1, mk("div", "sigla", sigla), right);

      append(card,
        row1,
        nombre ? mk("div", "name", nombre) : null,
        cw.length ? (() => {
          const tags = mk("div", "tags");
          for (const w of cw.slice(0, 3)) tags.appendChild(mk("div", `tag ${w.kind === "hard" ? "bad" : "warn"}`, w.kind === "hard" ? "HARD" : "SOFT"));
          return tags;
        })() : null,
      );

      list.appendChild(card);

      if (dbg && dbgLeft > 0) {
        dbgLeft--;
        const rawCat = c.concentracion ?? c.frontmatter?.concentracion ?? c.frontmatter?.["concentración"];
        const key = normalizeCat(rawCat);
        const varColor = getComputedStyle(card).getPropertyValue("--course-color").trim();
        const beforeBg = getComputedStyle(card, "::before").backgroundColor;
        console.log("[DBG colors] course", { sigla, rawCat, key, cls: cat?.cls, order: cat?.order, varColor, beforeBg, className: card.className });
      }
    }

    // "+" (solo state.draftMode): botón visual al final del período
    if (state.draftMode) {
      const add = mk("button", "course course-add", "+");
      add.type = "button";
      add.title = `Agregar curso en ${t.term_id}`;
      add.dataset.termId = t.term_id;
      add.draggable = false;
      add.addEventListener("click", (ev) => { ev.stopPropagation(); });
      list.appendChild(add);
    }

    append(col, th, list);
    grid.appendChild(col);
  }

  if (dbg) {
    _dbgLogged = true;
    console.log("[DBG colors] end render (logged once)");
    console.log("[DBG colors] Tip: si ves clases cat-* pero varColor vacío/transparent, el CSS de .cat-* no está aplicando o hay un error de sintaxis en styles.css.");
    console.log("[DBG colors] Tip: si varColor está bien pero no se ve la franja, revisa si algún border-left de .aprobado está tapando el lado izquierdo.");
  }

  renderWarningsModal(activeWarnings);
}

function renderWarningsModal(activeWarnings) {
  const list = $("warningsList");
  if (!list) return;
  list.innerHTML = "";

  if (!activeWarnings.length) {
    list.appendChild(mk("div", "muted", "Sin warnings."));
    return;
  }

  for (const w of activeWarnings) {
    const item = mk("div", "w-item");
    const dot = mk("div", `w-dot ${w.kind}`);

    const main = mk("div", "w-main");
    append(main,
      mk("div", "w-text", w.text),
      w.sub ? mk("div", "w-sub", w.sub) : null,
    );

    const actions = mk("div", "w-actions");
    const btn = mk("button", null, w.ignored ? "Des-ignorar" : "Ignorar");
    btn.type = "button";
    btn.addEventListener("click", () => {
      state.draft.ignored_warnings = state.draft.ignored_warnings || {};
      if (w.ignored) delete state.draft.ignored_warnings[w.id];
      else state.draft.ignored_warnings[w.id] = true;
      state.dirtyDraft = true;
      updateDraftButtons();
    fullRenderMod();
    });
    actions.appendChild(btn);

    append(item, dot, main, actions);
    list.appendChild(item);
  }
}

const openWarningsModal = () => { const el = $("warningsModal"); if (el) el.style.display = "flex"; };
const closeWarningsModal = () => { const el = $("warningsModal"); if (el) el.style.display = "none"; };

function fullRender() {
  if (!state.all || !state.config || !state.draft) return;

  const { terms, placements } = buildEffectiveTermsAndPlacements(state.all.terms, state.all.courses, state.draft);

  setAddTermDefaultIfUntouched(terms, state.all.courses, placements);

  const warnings = computeWarnings(terms, state.all.courses, placements, state.draft, state.config);

  // show first (non-ignored) hard, else soft (banner)
  const showIgnored = !!$("showIgnored")?.checked;
  const visibleWarnings = warnings.filter(w => showIgnored ? true : !w.ignored);
  const firstHard = visibleWarnings.find(w => w.kind === "hard");
  const firstSoft = visibleWarnings.find(w => w.kind === "soft");

  if (firstHard) setWarnNotice("hard", firstHard.text);
  else if (firstSoft) setWarnNotice("soft", firstSoft.text);
  else clearWarnNotice();

  render(terms, state.all.courses, placements, warnings);
}

async function saveDraftToServer() {
  await api.saveDraft(state.draft || {});
  mergeCoursesWithTemps();
  state.dirtyDraft = false;
  updateDraftButtons();
  showNotice("info", "Borrador guardado.");
}

async function resetDraftFromServer() {
  state.draft = await api.getDraft();
  ADD_TERM_TOUCHED = false;
  state.dirtyDraft = false;
  mergeCoursesWithTemps();
  updateDraftButtons();
  fullRenderMod();
  showNotice("info", "Borrador reseteado (se recargó desde disco)." );
}

// ---------- handlers ----------
const parseSemValue = (raw) => {
  const sRaw = String(raw ?? "0").trim();
  const n = parseInt(sRaw, 10);
  if (Number.isFinite(n)) return n;
  const u = sRaw.toUpperCase();
  if (u === "V") return 0;
  if (u === "I") return 1;
  if (u === "P") return 2;
  return NaN;
};

// Second-click course menu: implemented in app.js to be robust against init-order issues.
// - First click selects (unlock)
// - Second click on the same course opens the course menu (dummy)
let _armedCourseMenuId = null;
const _getCourseElFromTarget = (t) => {
  const el = t?.closest?.(".course");
  if (!el) return null;
  if (el.classList.contains("course-add")) return null;
  return el;
};
const _getCourseIdFromEl = (el) => {
  return (
    el?.dataset?.courseId ||
    el?.dataset?.course_id ||
    el?.getAttribute?.("data-course-id") ||
    el?.getAttribute?.("data-courseid") ||
    null
  );
};
const _openMenuForCourseId = (courseId, sourceEl = null) => {
  const cid = String(courseId || "").trim();
  if (!cid) return;
  const course =
    state.byId?.get?.(cid) ||
    (Array.isArray(state.all?.courses) ? state.all.courses.find((c) => c?.course_id === cid) : null);
  if (!course) {
    showNotice("soft", `No se encontró el curso para abrir menú: ${cid}.`);
    return;
  }
  openCourseMenu({
    course,
    isDraftMode: !!state.draftMode,
    sourceEl: sourceEl || undefined,
    onDeleteTempCourse: (c) => deleteTempCourse(c?.course_id),
    onMoveTempToDisk: (c) => moveTempCourseToDisk(c),
    onMaterialize: (c) => materializeTempCourse(c),
    onSaveCourse: (c, form) => (c?.is_temp ? updateTempCourse(c, form) : overrideCourse(c, form)),
    catalog: state.all?.courses || [],
    siglaSet: listAllSiglas(state.all?.courses || []),
  });
};

function initHandlers() {
  // Capture-phase handlers so they still work even if some child stops propagation.
  // 1) (+) create temp course
  // 2) second-click course menu (dummy)

  $("grid")?.addEventListener(
    "click",
    (ev) => {
      // (+) create temp course
      if (state.draftMode) {
        const btn = ev.target?.closest?.(".course-add");
        if (btn) {
          const tid =
            btn.dataset?.termId ||
            btn.dataset?.term_id ||
            btn.getAttribute?.("data-term-id") ||
            btn.getAttribute?.("data-termid");
          if (tid) {
            ev.preventDefault();
            openTempCourseCreator(tid);
            return;
          }
        }
      }

      // second-click course menu (always opens)
      const courseEl = _getCourseElFromTarget(ev.target);
      const cid = courseEl ? _getCourseIdFromEl(courseEl) : null;
      if (cid) {
        const id = String(cid);
        if (_armedCourseMenuId === id) {
          ev.preventDefault();
          ev.stopPropagation();
          _openMenuForCourseId(id, courseEl);
          // keep it armed so repeated clicks keep opening the menu until user clicks elsewhere
          return;
        }
        _armedCourseMenuId = id;
        return; // let unlock handle selection on first click
      }

      // click outside any course: disarm
      _armedCourseMenuId = null;
    },
    true
  );
  on("noticeClose", "click", clearWarnNotice);

  on("reloadBtn", "click", async () => {
    try {
      await loadAll();
      renderLegend();
      fullRenderMod();
      showNotice("info", "Recargado.");
    } catch (e) {
      showNotice("hard", String(e.message || e));
    }
  });

  on("saveBtn", "click", async () => {
    try { await saveDraftToServer(); }
    catch (e) { showNotice("hard", String(e.message || e)); }
  });

  on("resetBtn", "click", async () => {
    try { await resetDraftFromServer(); }
    catch (e) { showNotice("hard", String(e.message || e)); }
  });

  on("hardResetBtn", "click", async () => {
    if (!state.draftMode) return;
    const ok = confirm(
      "Esto borrará el borrador guardado en disco (malla_draft.json) y restaurará la malla real desde Obsidian. ¿Continuar?"
    );
    if (!ok) return;
    try {
      await api.hardResetDraft();
      showNotice("info", "Borrador eliminado. Recargando…");
      setTimeout(() => location.reload(), 150);
    } catch (e) {
      showNotice("hard", String(e.message || e));
    }
  });

  on("themeToggle", "change", () => saveTheme($("themeToggle")?.checked ? "dark" : "light"));

  on("draftToggle", "change", () => {
    state.draftMode = !!$("draftToggle")?.checked;
    updateDraftButtons();
    fullRenderMod();
  });

  // Sync inicial: si el checkbox viene marcado al cargar (estado persistido por el browser)
  state.draftMode = !!$("draftToggle")?.checked;
  updateDraftButtons();

  on("filter", "input", fullRenderMod);
  on("warningsBtn", "click", openWarningsModalMod);
  on("warningsClose", "click", closeWarningsModalMod);

  on("warningsModal", "click", (ev) => {
    if (ev.target === $("warningsModal")) closeWarningsModalMod();
  });

  on("showIgnored", "change", fullRenderMod);

  // Si el usuario toca los controles de "Agregar período", no volver a auto-setear defaults.
  for (const ev of ["input", "change"]) {
    on("addYear", ev, () => { ADD_TERM_TOUCHED = true; });
    on("addSem", ev, () => { ADD_TERM_TOUCHED = true; });
  }

  on("addTermBtn", "click", (ev) => {
    try { ev.preventDefault(); } catch {}
    if (!state.draftMode) return;

    const y = parseInt($("addYear")?.value || "0", 10);
    const s = parseSemValue($("addSem")?.value);

    if (!y || y < 1900 || y > 2500) return showNotice("hard", "Año inválido.");
    if (![0,1,2].includes(s)) return showNotice("hard", "Sem inválido (V/I/P o 0/1/2)." );

    const tid = `${y}-${s}`;
    state.draft.custom_terms = Array.isArray(state.draft.custom_terms) ? state.draft.custom_terms : [];
    if (!state.draft.custom_terms.some(t => t && t.term_id === tid)) state.draft.custom_terms.push({ term_id: tid });

    state.draft.term_order = Array.isArray(state.draft.term_order) ? state.draft.term_order : [];
    if (!state.draft.term_order.includes(tid)) state.draft.term_order.push(tid);

    // Auto-avanzar selector a siguiente período NO-verano
    const base = termParts(tid);
    const next = nextNonSummer(base);
    const yEl = $("addYear"), sEl = $("addSem");
    if (next && yEl && sEl) {
      yEl.value = String(next.year);
      sEl.value = String(next.sem);
      ADD_TERM_TOUCHED = true;
    }

    state.dirtyDraft = true;
    updateDraftButtons();
    fullRenderMod();
    showNotice("info", `Período agregado: ${tid}.`);
  });
}

async function main() {
  try {
    initHandlers();
    initRender({ computeWarnings });

    // Drag & drop (draft only). Saving remains manual via the Save button.
    initDragDrop({
      update: () => {
        updateDraftButtons();
        fullRenderMod();
      },
      saveDraft: async (_draft) => {},
      notify: null,
      mergeCoursesWithTemps: () => mergeCoursesWithTemps(),
    });

    // Unlock view (click a course to highlight + blink unlocks)
    initUnlock({
      gridId: "grid",
      enabled: true,
      onSecondClick: (courseId, courseEl) => {
        // Keep unlock.js callback too, but primary behavior is implemented in app.js capture handler.
        // This is a safety net in case event propagation changes.
        _openMenuForCourseId(courseId, courseEl);
      },
    });

    loadTheme();
    await loadAll();
    renderLegend();
    fullRenderMod();
  } catch (e) {
    showNotice("hard", String(e.message || e));
  }
}

// --- module compatibility ---
// index.html now loads this file as an ES Module (type="module").
// If the HTML ever uses inline handlers (onclick="..."), module-scope symbols won't be global.
// Expose a tiny, safe surface on window for debugging / compatibility.
try {
  window.MALLA = window.MALLA || {};
  Object.assign(window.MALLA, {
    openWarningsModal,
    closeWarningsModal,
    fullRender,
    showNotice,
    hideNotice,
    saveDraftToServer,
    resetDraftFromServer,
  });
} catch {}

main();
