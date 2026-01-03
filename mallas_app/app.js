// malla_app UI
// - Renderiza términos como columnas
// - Modo borrador: drag&drop + creación de períodos futuros
// - Warnings (soft/hard) + ignorar persistente (draft)
// - Unlock view: click en curso -> resalta + parpadea lo que desbloquea

import { byId } from "./modules/utils.js";
import { showNotice, hideNotice } from "./modules/toasts.js";
import { getConfig, getAll, getDraft, saveDraft } from "./modules/api.js";
import { state, setData, rebuildMaps } from "./modules/state.js";
import { computeWarnings, setLegacyComputeWarnings } from "./modules/warnings.js";

// State moved to modules/state.js (kept as a single shared object).
let ADD_TERM_TOUCHED=false; // si el usuario tocó addYear/addSem, no auto-sobrescribir

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
    getConfig(),
    getAll(),
    getDraft(),
  ]);
  setData({ config, all, draft });
  rebuildMaps();

  $("ver").textContent = state.all?.version || "";
  $("base").textContent = state.all?.debug?.base_dir || "";
  const mc = $("maxCred");
  if (mc) mc.textContent = state.config?.max_credits ?? "";
  $("debugPre").textContent = JSON.stringify(state.all, null, 2);

  state.dirtyDraft = false;
  ADD_TERM_TOUCHED = false;
  updateDraftButtons();
}

function updateDraftButtons() {
  const saveBtn = $("saveBtn"), resetBtn = $("resetBtn"), addBtn = $("addTermBtn");
  if (saveBtn) saveBtn.disabled = !state.draftMode || !state.dirtyDraft;
  if (resetBtn) resetBtn.disabled = !state.draftMode;
  if (addBtn) addBtn.disabled = !state.draftMode;
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

// ---------- Unlock view (click) ----------
const Unlock = {
  adj: null, dom: new Map(), active: [], selId: null, selEl: null,

  buildAdj(courses){
    const norm = (x) => String(x || "").trim().toUpperCase();
    const bySigla = new Map();
    for (const c of (courses || [])) {
      const s = norm(c?.sigla);
      if (s) bySigla.set(s, c);
    }
    const tmp = new Map();
    for (const c of (courses || [])) {
      for (const pr of normalizePrereqs(c?.prerrequisitos)) {
        if (pr.isCo) continue;
        const req = bySigla.get(norm(pr?.code));
        if (!req?.course_id || !c?.course_id) continue;
        if (!tmp.has(req.course_id)) tmp.set(req.course_id, new Set());
        tmp.get(req.course_id).add(c.course_id);
      }
    }
    const adj = new Map();
    for (const [k, s] of tmp.entries()) adj.set(k, Array.from(s));
    this.adj = adj;
  },

  collect(startId){
    const adj = this.adj;
    if (!adj || !startId) return [];
    const out = [], visited = new Set([startId]), q = [startId];
    for (let i = 0; i < q.length; i++) {
      for (const nid of (adj.get(q[i]) || [])) {
        if (!nid || visited.has(nid)) continue;
        visited.add(nid);
        out.push(nid);
        q.push(nid);
      }
    }
    return out;
  },

  clearBlink(){
    for (const el of this.active) { try { el.classList.remove("unlock-blink"); } catch {} }
    this.active = [];
  },
  applyBlink(startId){
    this.clearBlink();
    for (const id of this.collect(startId)) {
      const el = this.dom.get(id);
      if (!el) continue;
      el.classList.add("unlock-blink");
      this.active.push(el);
    }
  },

  clear(){
    if (this.selEl) { try { this.selEl.classList.remove("unlock-selected"); } catch {} }
    this.selId = null; this.selEl = null;
    this.clearBlink();
  },
  toggle(courseId){
    if (!courseId) return;
    if (this.selId === courseId) return this.clear();

    if (this.selEl) { try { this.selEl.classList.remove("unlock-selected"); } catch {} }
    this.selId = courseId;
    this.selEl = this.dom.get(courseId) || null;
    if (this.selEl) this.selEl.classList.add("unlock-selected");
    this.applyBlink(courseId);
  },
  reapply(){
    if (!this.selId) return;
    const el = this.dom.get(this.selId);
    if (!el) { this.selEl = null; this.clearBlink(); return; }
    if (this.selEl && this.selEl !== el) { try { this.selEl.classList.remove("unlock-selected"); } catch {} }
    this.selEl = el;
    el.classList.add("unlock-selected");
    this.applyBlink(this.selId);
  },
};

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
function computeWarningsLocal(terms, courses, placements, draft, config) {
  const warnings = [];
  const ignored = (draft && typeof draft.ignored_warnings === "object") ? draft.ignored_warnings : {};

  const termPos = new Map(terms.map((t, i) => [t.term_id, i]));
  const courseBySigla = new Map();

  for (const c of (courses || [])) {
    const s = String(c.sigla || "").trim();
    if (s) courseBySigla.set(s, c);
  }

  // Credit warnings per term
  const maxC = config?.max_credits ?? 65;
  const softC = config?.soft_credits ?? 50;

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
  return warnings;
}

// Wire legacy warning logic into the module so we can delete this block later.
setLegacyComputeWarnings(computeWarningsLocal);


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
  Unlock.dom = new Map();
  Unlock.clearBlink();
  grid.onclick = (ev) => { if (!ev.target.closest(".course")) Unlock.clear(); };

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
        if (!confirm(`¿Eliminar el período vacío ${t.term_id}?`)) return;
        const tid = t.term_id;
        state.draft.custom_terms = (Array.isArray(state.draft.custom_terms) ? state.draft.custom_terms : []).filter(x => String(x?.term_id || "") !== tid);
        state.draft.term_order = (Array.isArray(state.draft.term_order) ? state.draft.term_order : []).filter(x => String(x || "") !== tid);
        if (state.draft.placements && typeof state.draft.placements === "object") {
          for (const [cid, pt] of Object.entries(state.draft.placements)) if (String(pt) === tid) delete state.draft.placements[cid];
        }
        state.dirtyDraft = true;
        updateDraftButtons();
        fullRender();
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

      // unlock click
      Unlock.dom.set(c.course_id, card);
      card.addEventListener("click", (ev) => { ev.stopPropagation(); Unlock.toggle(c.course_id); });

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

      if (state.draftMode) {
        card.addEventListener("dragstart", (ev) => {
          ev.dataTransfer.setData("text/plain", c.course_id);
          ev.dataTransfer.effectAllowed = "move";
        });
      }

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

    if (state.draftMode) {
      list.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        list.classList.add("dragover");
        ev.dataTransfer.dropEffect = "move";
      });
      list.addEventListener("dragleave", () => list.classList.remove("dragover"));
      list.addEventListener("drop", (ev) => {
        ev.preventDefault();
        list.classList.remove("dragover");
        const cid = ev.dataTransfer.getData("text/plain");
        const tid = list.dataset.termId;
        if (!cid || !tid) return;
        state.draft.placements = state.draft.placements || {};
        state.draft.placements[cid] = tid;
        state.dirtyDraft = true;
        updateDraftButtons();
        fullRender();
      });
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

  Unlock.reapply();
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
      fullRender();
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
  Unlock.buildAdj(state.all.courses);
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
  await saveDraft(state.draft || {});
  state.dirtyDraft = false;
  updateDraftButtons();
  showNotice("info", "Borrador guardado.");
}

async function resetDraftFromServer() {
  state.draft = await getDraft();
  ADD_TERM_TOUCHED = false;
  state.dirtyDraft = false;
  updateDraftButtons();
  fullRender();
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

function initHandlers() {
  on("noticeClose", "click", clearWarnNotice);

  on("reloadBtn", "click", async () => {
    try {
      await loadAll();
      renderLegend();
      fullRender();
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

  on("themeToggle", "change", () => saveTheme($("themeToggle")?.checked ? "dark" : "light"));

  on("draftToggle", "change", () => {
    state.draftMode = !!$("draftToggle")?.checked;
    updateDraftButtons();
    fullRender();
  });

  // Sync inicial: si el checkbox viene marcado al cargar (estado persistido por el browser)
  state.draftMode = !!$("draftToggle")?.checked;
  updateDraftButtons();

  on("filter", "input", fullRender);
  on("warningsBtn", "click", openWarningsModal);
  on("warningsClose", "click", closeWarningsModal);

  on("warningsModal", "click", (ev) => {
    if (ev.target === $("warningsModal")) closeWarningsModal();
  });

  on("showIgnored", "change", fullRender);

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
    fullRender();
    showNotice("info", `Período agregado: ${tid}.`);
  });
}

async function main() {
  try {
    initHandlers();
    loadTheme();
    await loadAll();
    renderLegend();
    fullRender();
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
