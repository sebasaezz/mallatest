// malla_app UI
// - Renderiza términos como columnas
// - Modo borrador: drag&drop + creación de períodos futuros
// - Warnings (soft/hard) + ignorar persistente (draft)
// - Unlock view: click en curso -> resalta + parpadea lo que desbloquea

let CONFIG=null, ALL=null, DRAFT=null;
let draftMode=false, dirtyDraft=false;
let ADD_TERM_TOUCHED=false; // si el usuario tocó addYear/addSem, no auto-sobrescribir

// Modal crear curso (draft)
let COURSE_MODAL_TERM_ID=null;
let _courseSuggestWired=false;

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);

// ---------- debug (colors/categories) ----------
// Actívalo abriendo la app con:  http://localhost:PORT/?debugColors=1
const DEBUG_COLORS = new URLSearchParams(location.search).has("debugColors");
const DEBUG_WARN = new URLSearchParams(location.search).has("debugWarn");
const DEBUG_LOG_LIMIT = 12;
let _dbgLogged = false;
let _dbgWarnSeq = 0;

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
// Helpers de términos (TERM_RE, termParts, computeNextNonSummerFromLast, etc.)
// viven en logic.js, cargado antes de este archivo desde index.html.
if (typeof termParts !== "function" || typeof computeWarnings !== "function") {
  throw new Error("logic.js debe cargarse antes que app.js");
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

let NOTICE_TO=null, NOTICE_FADE_TO=null;
function showNotice(kind, text) {
  const el = $("notice"), tx = $("noticeText");
  if (!el || !tx) return;
  if (NOTICE_TO) clearTimeout(NOTICE_TO);
  if (NOTICE_FADE_TO) clearTimeout(NOTICE_FADE_TO);
  el.classList.remove("soft", "hard", "info", "fading");
  el.classList.add(kind);
  tx.textContent = text;
  el.style.display = "flex";
  NOTICE_TO = setTimeout(() => {
    el.classList.add("fading");
    NOTICE_FADE_TO = setTimeout(hideNotice, 300);
  }, 5000);
}
function hideNotice(){
  const el = $("notice");
  if (NOTICE_TO) clearTimeout(NOTICE_TO);
  if (NOTICE_FADE_TO) clearTimeout(NOTICE_FADE_TO);
  NOTICE_TO = NOTICE_FADE_TO = null;
  if (!el) return;
  el.classList.remove("fading");
  el.style.display = "none";
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) throw new Error((data && data.error) ? data.error : `HTTP ${res.status}`);
  return data;
}

async function loadAll() {
  [CONFIG, ALL, DRAFT] = await Promise.all([
    fetchJSON("/api/config"),
    fetchJSON("/api/all"),
    fetchJSON("/api/draft"),
  ]);

  $("ver").textContent = ALL?.version || "";
  $("base").textContent = ALL?.debug?.base_dir || "";
  const mc = $("maxCred");
  if (mc) mc.textContent = CONFIG?.max_credits ?? "";
  $("debugPre").textContent = JSON.stringify(ALL, null, 2);

  // compat: asegurar estructura de cursos temporales (solo draft)
  DRAFT = DRAFT || {};
  DRAFT.temp_courses = Array.isArray(DRAFT.temp_courses) ? DRAFT.temp_courses : [];

  dirtyDraft = false;
  ADD_TERM_TOUCHED = false;
  updateDraftButtons();
}

function updateDraftButtons() {
  const saveBtn = $("saveBtn"), resetBtn = $("resetBtn"), addBtn = $("addTermBtn");
  if (saveBtn) saveBtn.disabled = !draftMode || !dirtyDraft;
  if (resetBtn) resetBtn.disabled = !draftMode;
  if (addBtn) addBtn.disabled = !draftMode;
}

// ---------- prereqs parsing ----------
// Las rutinas normalizePrereqs (y helpers de prereqs) se cargan desde logic.js.

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
// buildEffectiveTermsAndPlacements y computeWarnings se mueven a logic.js para evitar colisiones
// y mantenerlos compartidos entre archivos.

// ---------- course modal (draft: temp courses) ----------
const siglaNorm = (x) => String(x || "").trim().toUpperCase();
const parseCodes = (str) => String(str || "")
  .split(/[,\s]+/)
  .map(s => siglaNorm(s))
  .filter(Boolean);

function getSiglaSet() {
  const set = new Set();
  for (const c of (ALL?.courses || [])) { const s = siglaNorm(c?.sigla); if (s) set.add(s); }
  for (const c of (DRAFT?.temp_courses || [])) { const s = siglaNorm(c?.sigla); if (s) set.add(s); }
  return set;
}
function getSiglaOptions() { return Array.from(getSiglaSet()).sort(); }

function replaceLastToken(s0, token) {
  const s = String(s0 || "");
  const i = s.lastIndexOf(",");
  const head = (i >= 0) ? s.slice(0, i + 1) : "";
  return head + (head ? " " : "") + token + ", ";
}

function wireSuggest(inputEl, menuEl, optionsFn) {
  if (!inputEl || !menuEl) return;
  const close = () => { menuEl.classList.remove("show"); menuEl.innerHTML = ""; };
  const show = (items) => {
    menuEl.innerHTML = "";
    if (!items.length) return close();
    for (const v of items) {
      const it = mk("div", "item", v);
      it.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        inputEl.value = replaceLastToken(inputEl.value, v);
        close();
        try { inputEl.focus(); } catch {}
      });
      menuEl.appendChild(it);
    }
    menuEl.classList.add("show");
  };

  const update = () => {
    const tok = siglaNorm(String(inputEl.value || "").split(",").slice(-1)[0]);
    if (!tok) return close();
    const opts = (optionsFn ? optionsFn() : []).filter(s => s.startsWith(tok)).slice(0, 12);
    show(opts);
  };

  inputEl.addEventListener("input", update);
  inputEl.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
  inputEl.addEventListener("blur", () => setTimeout(close, 120));
}

function wireCourseSuggestOnce() {
  if (_courseSuggestWired) return;
  wireSuggest($("cPrereq"), $("cPrereqSuggest"), getSiglaOptions);
  wireSuggest($("cCoreq"), $("cCoreqSuggest"), getSiglaOptions);
  _courseSuggestWired = true;
}

function openCourseModal(termId) {
  if (!draftMode) return;
  const el = $("courseModal");
  if (!el) return;
  COURSE_MODAL_TERM_ID = String(termId || "").trim() || null;

  const set = (id, v) => { const x = $(id); if (x) x.value = v; };
  set("cSigla", "");
  set("cNombre", "");
  set("cCreditos", "");
  set("cPrereq", "");
  set("cCoreq", "");
  const v = $("cOffV"), i = $("cOffI"), p = $("cOffP");
  if (v) v.checked = false;
  if (i) i.checked = false;
  if (p) p.checked = false;
  const conc = $("cConc");
  if (conc) conc.value = "ex";

  $("cPrereqSuggest")?.classList.remove("show");
  $("cCoreqSuggest")?.classList.remove("show");
  $("cPrereqSuggest") && ($("cPrereqSuggest").innerHTML = "");
  $("cCoreqSuggest") && ($("cCoreqSuggest").innerHTML = "");

  wireCourseSuggestOnce();
  el.style.display = "flex";
  setTimeout(() => { try { $("cSigla")?.focus(); } catch {} }, 0);
}

function closeCourseModal() {
  const el = $("courseModal");
  if (el) el.style.display = "none";
  COURSE_MODAL_TERM_ID = null;
}

function createTempCourseFromModal() {
  if (!draftMode) return showNotice("hard", "Activa modo borrador para crear cursos.");
  if (!DRAFT) return;

  const sigla = siglaNorm($("cSigla")?.value);
  if (!sigla) return showNotice("hard", "Sigla requerida.");

  const existing = getSiglaSet();
  if (existing.has(sigla)) return showNotice("hard", `La sigla ${sigla} ya existe.`);

  const cred0 = String($("cCreditos")?.value || "").trim();
  const creditos = parseInt(cred0 || "0", 10);
  if (!Number.isFinite(creditos) || creditos < 0) return showNotice("hard", "Créditos inválidos.");

  const nombre = String($("cNombre")?.value || "").trim();
  const pre = parseCodes($("cPrereq")?.value);
  const co = parseCodes($("cCoreq")?.value);

  const unknown = [];
  for (const code of [...pre, ...co]) if (!existing.has(code)) unknown.push(code);

  const req = [];
  for (const code of pre) req.push(code);
  for (const code of co) req.push(`${code}(c)`);
  const prerrequisitos = req.length ? req : ["nt"];

  const semestreOfrecido = [];
  if ($("cOffV")?.checked) semestreOfrecido.push("V");
  if ($("cOffI")?.checked) semestreOfrecido.push("I");
  if ($("cOffP")?.checked) semestreOfrecido.push("P");

  const concentracion = $("cConc")?.value || "ex";

  let term_id = COURSE_MODAL_TERM_ID;
  if (!term_id) {
    let best = null, bestIdx = -1;
    for (const t of (ALL?.terms || [])) {
      const idx = termIndex(t?.term_id);
      if (idx !== 999999 && idx > bestIdx) { bestIdx = idx; best = t.term_id; }
    }
    term_id = best || null;
  }

  const course_id = `draft:${sigla}`;
  const c = {
    course_id, term_id,
    sigla, nombre,
    creditos,
    concentracion,
    prerrequisitos,
    semestreOfrecido,
    aprobado: false,
    frontmatter: {},
  };

  DRAFT.temp_courses = Array.isArray(DRAFT.temp_courses) ? DRAFT.temp_courses : [];
  DRAFT.temp_courses.push(c);

  DRAFT.placements = DRAFT.placements || {};
  if (term_id) DRAFT.placements[course_id] = term_id;

  dirtyDraft = true;
  updateDraftButtons();
  closeCourseModal();
  fullRender();

  if (unknown.length) showNotice("soft", `Requisito(s) no existe(n): ${unknown.join(", ")} (se creó igual).`);
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
    const maxC = CONFIG?.max_credits ?? 65;
    const softC = CONFIG?.soft_credits ?? 50;
    const cred = mk("div", "term-credits", `${total} cr`);
    if (total > maxC) cred.classList.add("bad");
    else if (total > softC) cred.classList.add("warn");

    append(th, title, cred);

    if (draftMode && t.isCustom && !(byTerm.get(t.term_id) || []).length) {
      const del = mk("button", "term-del", "✕");
      del.type = "button";
      del.title = "Eliminar período vacío";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm(`¿Eliminar el período vacío ${t.term_id}?`)) return;
        const tid = t.term_id;
        DRAFT.custom_terms = (Array.isArray(DRAFT.custom_terms) ? DRAFT.custom_terms : []).filter(x => String(x?.term_id || "") !== tid);
        DRAFT.term_order = (Array.isArray(DRAFT.term_order) ? DRAFT.term_order : []).filter(x => String(x || "") !== tid);
        if (DRAFT.placements && typeof DRAFT.placements === "object") {
          for (const [cid, pt] of Object.entries(DRAFT.placements)) if (String(pt) === tid) delete DRAFT.placements[cid];
        }
        dirtyDraft = true;
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

      card.draggable = !!draftMode;
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

      const offered = normalizeSemestreOfrecido(c);
      const offeredList = SEM_ORDER.filter(x => offered.has(x));
      const offeredLabel = offeredList.length ? offeredList.join(" / ") : "V / I / P";
      const tags = mk("div", "tags");
      tags.appendChild(mk("div", "tag offer", `Oferta: ${offeredLabel}`));

      for (const w of cw.slice(0, 3)) {
        tags.appendChild(mk("div", `tag ${w.kind === "hard" ? "bad" : "warn"}`, w.kind === "hard" ? "HARD" : "SOFT"));
      }

      append(card,
        row1,
        nombre ? mk("div", "name", nombre) : null,
        tags,
      );

      if (draftMode) {
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

    // "+" (solo draftMode): botón visual al final del período
    if (draftMode) {
      const add = mk("button", "course course-add", "+");
      add.type = "button";
      add.title = `Agregar curso en ${t.term_id}`;
      add.dataset.termId = t.term_id;
      add.draggable = false;
      add.addEventListener("click", (ev) => { ev.stopPropagation(); openCourseModal(t.term_id); });
      list.appendChild(add);
    }

    if (draftMode) {
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
        DRAFT.placements = DRAFT.placements || {};
        DRAFT.placements[cid] = tid;
        dirtyDraft = true;
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
      DRAFT.ignored_warnings = DRAFT.ignored_warnings || {};
      if (w.ignored) delete DRAFT.ignored_warnings[w.id];
      else DRAFT.ignored_warnings[w.id] = true;
      dirtyDraft = true;
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
  if (!ALL || !CONFIG || !DRAFT) return;

  const temp = Array.isArray(DRAFT.temp_courses) ? DRAFT.temp_courses : [];
  const coursesEff = [...(ALL.courses || []), ...temp];

  if (DEBUG_WARN) {
    const n = ++_dbgWarnSeq;
    const samp = (temp || []).slice(0, 5).map(c => ({
      sigla: c?.sigla, course_id: c?.course_id, term_id: c?.term_id,
      prerrequisitos: c?.prerrequisitos,
      fm_prerrequisitos: c?.frontmatter?.prerrequisitos,
      semestreOfrecido: c?.semestreOfrecido,
      fm_semestreOfrecido: c?.frontmatter?.semestreOfrecido,
    }));
    console.groupCollapsed(`[DBG warn] fullRender #${n} (draftMode=${draftMode})`);
    console.log("temp_courses", temp?.length || 0, "coursesEff", coursesEff.length);
    if (samp.length) console.table(samp);
    console.groupEnd();
  }

  const { terms, placements } = buildEffectiveTermsAndPlacements(ALL.terms, coursesEff, DRAFT);
  Unlock.buildAdj(coursesEff);
  setAddTermDefaultIfUntouched(terms, coursesEff, placements);

  const warnings = computeWarnings(terms, coursesEff, placements, DRAFT);

  // show first (non-ignored) hard, else soft (banner)
  const showIgnored = !!$("showIgnored")?.checked;
  const visibleWarnings = warnings.filter(w => showIgnored ? true : !w.ignored);
  const firstHard = visibleWarnings.find(w => w.kind === "hard");
  const firstSoft = visibleWarnings.find(w => w.kind === "soft");

  if (firstHard) showNotice("hard", firstHard.text);
  else if (firstSoft) showNotice("soft", firstSoft.text);
  else hideNotice();

  render(terms, coursesEff, placements, warnings);
}

async function saveDraftToServer() {
  await fetchJSON("/api/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(DRAFT || {}, null, 2),
  });
  dirtyDraft = false;
  updateDraftButtons();
  showNotice("info", "Borrador guardado.");
}

async function resetDraftFromServer() {
  DRAFT = await fetchJSON("/api/draft");
  DRAFT = DRAFT || {};
  DRAFT.temp_courses = Array.isArray(DRAFT.temp_courses) ? DRAFT.temp_courses : [];
  ADD_TERM_TOUCHED = false;
  dirtyDraft = false;
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
  on("noticeClose", "click", hideNotice);

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
    draftMode = !!$("draftToggle")?.checked;
    updateDraftButtons();
    fullRender();
  });

  // Sync inicial: si el checkbox viene marcado al cargar (estado persistido por el browser)
  draftMode = !!$("draftToggle")?.checked;
  updateDraftButtons();

  on("filter", "input", fullRender);
  on("warningsBtn", "click", openWarningsModal);
  on("warningsClose", "click", closeWarningsModal);

  // Modal crear curso (draft)
  on("courseClose", "click", closeCourseModal);
  on("courseCreate", "click", (ev) => { try { ev.preventDefault(); } catch {} createTempCourseFromModal(); });
  on("courseModal", "click", (ev) => { if (ev.target === $("courseModal")) closeCourseModal(); });

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
    if (!draftMode) return;

    const y = parseInt($("addYear")?.value || "0", 10);
    const s = parseSemValue($("addSem")?.value);

    if (!y || y < 1900 || y > 2500) return showNotice("hard", "Año inválido.");
    if (![0,1,2].includes(s)) return showNotice("hard", "Sem inválido (V/I/P o 0/1/2)." );

    const tid = `${y}-${s}`;
    DRAFT.custom_terms = Array.isArray(DRAFT.custom_terms) ? DRAFT.custom_terms : [];
    if (!DRAFT.custom_terms.some(t => t && t.term_id === tid)) DRAFT.custom_terms.push({ term_id: tid });

    DRAFT.term_order = Array.isArray(DRAFT.term_order) ? DRAFT.term_order : [];
    if (!DRAFT.term_order.includes(tid)) DRAFT.term_order.push(tid);

    // Auto-avanzar selector a siguiente período NO-verano
    const base = termParts(tid);
    const next = nextNonSummer(base);
    const yEl = $("addYear"), sEl = $("addSem");
    if (next && yEl && sEl) {
      yEl.value = String(next.year);
      sEl.value = String(next.sem);
      ADD_TERM_TOUCHED = true;
    }

    dirtyDraft = true;
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

main();
