// Course menu (dummy)
// - Opens on second click of a course (handled by unlock.js via onSecondClick)
// - Always opens (even outside draft), but editing will be enabled only in draftMode later.
//
// This module is intentionally UI-only and does NOT mutate state.

import { showNotice } from "./toasts.js";

let _ov = null;
let _panel = null;
let _escBound = false;
let _onDeleteTempCourse = null;
let _onMoveTempToDisk = null;
let _onMaterialize = null;
let _onSaveCourse = null;
let _catalog = [];
let _siglaSet = new Set();

function normSigla(x) {
  return String(x || "").trim().toUpperCase();
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const v = String(x || "").trim();
    if (!v) continue;
    const k = v.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function listify(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  const s = String(x).trim();
  if (!s) return [];
  if (s.includes(",")) return s.split(",").map((p) => p.trim()).filter(Boolean);
  return [s];
}

function normalizeReqs(course) {
  const fm = course?.frontmatter || {};
  const raw = course?.prerrequisitos ?? fm?.prerrequisitos;
  const arr = listify(raw).map((v) => String(v).trim()).filter(Boolean);

  const prereq = [];
  const coreq = [];

  // If upstream already normalized corequisitos, respect it.
  const co = listify(course?.corequisitos ?? fm?.corequisitos);
  for (const c of co) {
    const cc = String(c || "").trim();
    if (cc) coreq.push(cc);
  }

  for (const it of arr) {
    const low = it.toLowerCase();
    if (!it || low === "nt") continue;
    const m = /^(.+?)\(c\)$/.exec(it);
    if (m) {
      const code = m[1].trim();
      if (code && !coreq.includes(code)) coreq.push(code);
    } else {
      prereq.push(it);
    }
  }

  return { prereq, coreq };
}

function normalizeOffered(course) {
  const fm = course?.frontmatter || {};
  const raw = course?.semestreOfrecido ?? fm?.semestreOfrecido;
  const arr = listify(raw).map((v) => String(v).trim()).filter(Boolean);
  // Accept [0,1,2] or ["V","I","P"]
  const map = { "0": "V", "1": "I", "2": "P", V: "V", I: "I", P: "P" };
  const out = [];
  for (const a of arr) {
    const k = map[String(a).toUpperCase()] || map[String(a)] || String(a).toUpperCase();
    if (k && !out.includes(k)) out.push(k);
  }
  // Keep stable order V I P
  const order = { V: 0, I: 1, P: 2 };
  out.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9) || a.localeCompare(b));
  return out;
}

function fieldRow(labelText, inputEl, helpText) {
  const row = el("div", "form-row", "");
  const lab = el("label", "form-label", labelText);
  const wrap = el("div", "form-control", "");
  wrap.appendChild(inputEl);
  row.appendChild(lab);
  row.appendChild(wrap);
  if (helpText) {
    const help = el("div", "form-help", helpText);
    row.appendChild(help);
  }
  return row;
}

function makeTextInput(id, placeholder) {
  const i = el("input", "input", "");
  i.type = "text";
  i.id = id;
  i.placeholder = placeholder || "";
  i.autocomplete = "off";
  i.spellcheck = false;
  return i;
}

function makeNumberInput(id, placeholder) {
  const i = el("input", "input", "");
  i.type = "number";
  i.id = id;
  i.placeholder = placeholder || "";
  i.min = "0";
  i.step = "1";
  return i;
}

function makeCheckbox(id, labelText) {
  const w = el("label", "chk", "");
  const c = el("input", "");
  c.type = "checkbox";
  c.id = id;
  const t = el("span", "chk-label", labelText);
  w.appendChild(c);
  w.appendChild(t);
  return { wrap: w, input: c };
}

function makeSelect(id, options) {
  const s = el("select", "select", "");
  s.id = id;
  for (const opt of options || []) {
    const o = el("option", "", opt.value);
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.selected) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function createChip(text, onRemove) {
  const chip = el("span", "chip", "");
  const txt = el("span", "chip-text", text);
  const x = el("button", "chip-x", "×");
  x.type = "button";
  x.addEventListener("click", () => onRemove?.());
  chip.appendChild(txt);
  chip.appendChild(x);
  return chip;
}

function makeSuggestList() {
  const box = el("div", "suggest", "");
  box.style.display = "none";
  return box;
}

function buildSuggestions(items, q) {
  const qq = String(q || "").trim().toUpperCase();
  if (!qq) return [];
  const out = [];
  for (const it of items || []) {
    const sig = normSigla(it.sigla);
    const name = String(it.nombre || "").toUpperCase();
    if (sig.includes(qq) || name.includes(qq)) out.push(it);
    if (out.length >= 8) break;
  }
  out.sort((a, b) => {
    const as = normSigla(a.sigla);
    const bs = normSigla(b.sigla);
    const ap = as.startsWith(qq) ? 0 : 1;
    const bp = bs.startsWith(qq) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return as.localeCompare(bs);
  });
  return out.slice(0, 8);
}

function makeChipInput({ id, placeholder, catalog, siglaSet, onSoftUnknown }) {
  const root = el("div", "chip-input", "");
  root.id = id;

  const chipsRow = el("div", "chips", "");
  const input = makeTextInput(id + "_input", placeholder);
  const suggest = makeSuggestList();

  const chips = [];

  function renderSuggest(list) {
    suggest.innerHTML = "";
    if (!list.length) {
      suggest.style.display = "none";
      return;
    }
    for (const it of list) {
      const b = el("button", "suggest-item", "");
      b.type = "button";
      const sigDiv = el("div", "suggest-sigla", normSigla(it.sigla));
      const nameDiv = el("div", "suggest-name", it.nombre || "");
      b.appendChild(sigDiv);
      b.appendChild(nameDiv);
      b.addEventListener("click", () => {
        addChip(normSigla(it.sigla), false);
        input.focus();
      });
      suggest.appendChild(b);
    }
    suggest.style.display = "block";
  }

  function refreshSuggest() {
    const list = buildSuggestions(catalog, input.value);
    renderSuggest(list);
  }

  function removeAt(idx) {
    const it = chips[idx];
    if (!it) return;
    chips.splice(idx, 1);
    chipsRow.removeChild(it.el);
  }

  function addChip(codeRaw, emitUnknown = true) {
    const code = normSigla(codeRaw);
    if (!code) return;
    if (chips.some((c) => c.code === code)) {
      input.value = "";
      suggest.style.display = "none";
      return;
    }

    if (emitUnknown && siglaSet && siglaSet.has && !siglaSet.has(code)) {
      onSoftUnknown?.(code);
    }

    const idx = chips.length;
    const c = { code, el: null };
    const chipEl = createChip(code, () => removeAt(idx));
    c.el = chipEl;
    chips.push(c);
    chipsRow.appendChild(chipEl);
    input.value = "";
    suggest.style.display = "none";
  }

  input.addEventListener("input", () => refreshSuggest());

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      addChip(input.value, true);
    } else if (ev.key === "Escape") {
      suggest.style.display = "none";
    } else if (ev.key === "Backspace" && !input.value) {
      if (chips.length) removeAt(chips.length - 1);
    }
  });

  input.addEventListener("blur", () => setTimeout(() => (suggest.style.display = "none"), 120));

  root.appendChild(chipsRow);
  root.appendChild(input);
  root.appendChild(suggest);

  return {
    root,
    getValues: () => chips.map((c) => c.code),
    setValues: (vals) => {
      chips.splice(0, chips.length);
      chipsRow.innerHTML = "";
      for (const v of uniq(vals).map(normSigla)) addChip(v, false);
    },
    focus: () => input.focus(),
  };
}

function getConcsFromCatalog(catalog, fallback = ["MScB", "M", "m", "FI", "OFG", "ex"]) {
  const set = new Set();
  for (const c of catalog || []) {
    const v = String(c.concentracion || c.concentración || "").trim();
    if (v) set.add(v);
  }
  const arr = Array.from(set);
  if (!arr.length) return fallback;
  arr.sort((a, b) => a.localeCompare(b));
  for (const f of fallback) if (!set.has(f)) arr.push(f);
  return arr;
}

function _isTransparentColor(c) {
  const s = String(c || "").trim().toLowerCase();
  if (!s) return true;
  if (s === "transparent") return true;
  if (s === "rgba(0, 0, 0, 0)" || s === "rgba(0,0,0,0)") return true;
  return false;
}

function _parseRgb(c) {
  const s = String(c || "").trim().toLowerCase();
  if (!s.startsWith("rgb")) return null;
  const i0 = s.indexOf("(");
  const i1 = s.lastIndexOf(")");
  if (i0 < 0 || i1 < 0 || i1 <= i0) return null;
  const inside = s.slice(i0 + 1, i1);
  const parts = inside.split(",").map((p) => p.trim());
  if (parts.length < 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  const a = parts.length >= 4 ? Number(parts[3]) : 1;
  if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
  return { r, g, b, a };
}

function _isNeutralRgb(c) {
  const rgb = _parseRgb(c);
  if (!rgb) return false;
  const { r, g, b, a } = rgb;
  if (a === 0) return true;
  const hi = r > 245 && g > 245 && b > 245;
  const lo = r < 15 && g < 15 && b < 15;
  return hi || lo;
}

function _pickAccentFromSourceEl(sourceEl) {
  if (!sourceEl || !window.getComputedStyle) return null;
  const cs = window.getComputedStyle(sourceEl);

  // Prefer explicit CSS vars if renderer sets them.
  const vars = ["--cat-color", "--course-color", "--accent", "--varColor"];
  for (const v of vars) {
    const val = String(cs.getPropertyValue(v) || "").trim();
    if (val && !_isTransparentColor(val) && !_isNeutralRgb(val)) return val;
  }

  // Background is often the category color; skip if neutral.
  const bg = cs.backgroundColor;
  if (bg && !_isTransparentColor(bg) && !_isNeutralRgb(bg)) return bg;

  // Fallback to borders/outline/text.
  const candidates = [cs.borderLeftColor, cs.borderTopColor, cs.outlineColor, cs.color];
  for (const c of candidates) {
    if (c && !_isTransparentColor(c) && !_isNeutralRgb(c)) return c;
  }

  return null;
}

function ensureDOM() {
  if (_ov) return;

  _ov = el("div", "modal-overlay");
  _ov.id = "courseMenuModal";
  _ov.style.display = "none";

  _panel = el("div", "modal");
  _panel.id = "courseMenuPanel";

  _ov.appendChild(_panel);
  document.body.appendChild(_ov);

  // Click outside closes
  _ov.addEventListener("click", (ev) => {
    if (ev.target === _ov) closeCourseMenu();
  });

  if (!_escBound) {
    _escBound = true;
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeCourseMenu();
    });
  }
}

function renderMenu({ course, isDraftMode }) {
  const fm = course?.frontmatter || {};
  _panel?.classList?.add?.("course-menu");
  const sigla = String(course?.sigla ?? fm?.sigla ?? "").trim();
  const nombre = String(course?.nombre ?? fm?.nombre ?? "").trim();
  const creditos = Number(course?.creditos ?? fm?.creditos ?? fm?.créditos ?? 0) || 0;
  const concentracion = String(course?.concentracion ?? fm?.concentracion ?? fm?.["concentración"] ?? "ex").trim() || "ex";
  const aprobado = !!(course?.aprobado ?? fm?.aprobado);

  const { prereq, coreq } = normalizeReqs(course);
  const offered = normalizeOffered(course);

  // Source info
  const isTemp = !!course?.is_temp;
  const tempKind = String(course?.temp_kind || "").trim();
  const src = isTemp ? (tempKind ? `Temporal (${tempKind})` : "Temporal") : "En disco";

  if (_panel) {
    _panel.dataset.src = src;
    _panel.dataset.isTemp = isTemp ? "1" : "0";
    _panel.dataset.tempKind = tempKind || "";
    _panel.dataset.concentracion = concentracion;
  }

  _panel.innerHTML = "";

  // Header
  const h = el("div", "modal-header");
  const title = el("div", "modal-title", sigla ? `${sigla}` : "Curso");
  const right = el("div", "modal-controls");
  const badge = el("div", "tag menu-accent", src);
  const closeBtn = el("button", "modal-close", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Cerrar";
  closeBtn.addEventListener("click", closeCourseMenu);
  right.appendChild(badge);
  right.appendChild(closeBtn);
  h.appendChild(title);
  h.appendChild(right);

  // Body
  const body = el("div", "modal-body");

  // Footer
  const foot = el("div", "modal-footer");

  if (isTemp && isDraftMode) {
    // Editable form for temporary courses in draft mode
    const siglaInput = makeTextInput("edit_sigla", "Opcional (ej. TMP-001)");
    siglaInput.value = sigla;

    const nombreInput = makeTextInput("edit_nombre", "Nombre del curso");
    nombreInput.value = nombre;

    const creditosInput = makeNumberInput("edit_creditos", "Créditos");
    creditosInput.value = creditos || "";

    const concs = getConcsFromCatalog(_catalog, ["MScB", "M", "m", "FI", "OFG", "ex"]);
    if (concentracion && !concs.includes(concentracion)) concs.push(concentracion);
    const concSel = makeSelect(
      "edit_conc",
      concs.map((v) => ({ value: v, label: v, selected: v === concentracion }))
    );

    const offeredWrap = el("div", "offered", "");
    const ckI = makeCheckbox("edit_off_I", "I");
    const ckP = makeCheckbox("edit_off_P", "P");
    const ckV = makeCheckbox("edit_off_V", "V");
    ckI.input.checked = offered.includes("I");
    ckP.input.checked = offered.includes("P");
    ckV.input.checked = offered.includes("V");
    offeredWrap.appendChild(ckI.wrap);
    offeredWrap.appendChild(ckP.wrap);
    offeredWrap.appendChild(ckV.wrap);

    const chipsPrereq = makeChipInput({
      id: "edit_prer",
      placeholder: "Escribe una sigla y Enter…",
      catalog: _catalog,
      siglaSet: _siglaSet,
      onSoftUnknown: (code) => showNotice?.("soft", `Requisito inexistente: ${code}`),
    });

    const chipsCoreq = makeChipInput({
      id: "edit_coreq",
      placeholder: "Escribe una sigla y Enter…",
      catalog: _catalog,
      siglaSet: _siglaSet,
      onSoftUnknown: (code) => showNotice?.("soft", `Correquisito inexistente: ${code}`),
    });

    chipsPrereq.setValues(prereq);
    chipsCoreq.setValues(coreq);

    const aprobadoChk = makeCheckbox("edit_aprobado", "Aprobado");
    aprobadoChk.input.checked = aprobado;

    body.appendChild(fieldRow("Sigla", siglaInput, "Opcional. Si la dejas vacía se mantiene la actual."));
    body.appendChild(fieldRow("Nombre", nombreInput));
    body.appendChild(fieldRow("Créditos", creditosInput));
    body.appendChild(fieldRow("Prerrequisitos", chipsPrereq.root, "Agrega con Enter. Se sugieren cursos existentes."));
    body.appendChild(fieldRow("Correquisitos", chipsCoreq.root, "Agrega con Enter. Deben dictarse en el mismo semestre."));
    body.appendChild(fieldRow("Ofrecido en", offeredWrap));
    body.appendChild(fieldRow("Concentración", concSel));
    body.appendChild(fieldRow("", aprobadoChk.wrap));

    const materialize = el("button", "btn", "Guardar en disco");
    materialize.type = "button";
    if (typeof _onMaterialize === "function") materialize.addEventListener("click", () => _onMaterialize(course));
    else materialize.disabled = true;
    foot.appendChild(materialize);

    const del = el("button", "btn bad", "Eliminar");
    del.type = "button";
    if (typeof _onDeleteTempCourse === "function") del.addEventListener("click", () => _onDeleteTempCourse(course));
    else del.disabled = true;
    foot.appendChild(del);

    const cancel = el("button", "btn", "Cancelar");
    cancel.type = "button";
    cancel.addEventListener("click", closeCourseMenu);
    foot.appendChild(cancel);

    const save = el("button", "btn primary", "Guardar");
    save.type = "button";
    if (typeof _onSaveCourse === "function") {
      save.addEventListener("click", () => {
        const offeredSel = [];
        if (ckI.input.checked) offeredSel.push("I");
        if (ckP.input.checked) offeredSel.push("P");
        if (ckV.input.checked) offeredSel.push("V");

        const form = {
          sigla: normSigla(siglaInput.value) || sigla,
          nombre: String(nombreInput.value || "").trim(),
          creditos: Number(String(creditosInput.value || "0").trim() || 0),
          prerrequisitos: chipsPrereq.getValues(),
          correquisitos: chipsCoreq.getValues(),
          semestreOfrecido: offeredSel,
          concentracion: String(concSel.value || "ex").trim() || "ex",
          aprobado: !!aprobadoChk.input.checked,
        };

        if (!form.nombre) {
          showNotice?.("soft", "El nombre del curso está vacío.");
          return;
        }
        if (!(Number.isFinite(form.creditos) && form.creditos > 0)) {
          showNotice?.("soft", "Los créditos deben ser un número positivo.");
          return;
        }

        _onSaveCourse(course, form);
      });
    } else {
      save.disabled = true;
    }
    foot.appendChild(save);
  } else {
    // Read-only view
    body.appendChild(el("div", "muted", nombre || "(sin nombre)"));

    const meta = el("div", "w-item");
    const metaMain = el("div", "w-main");
    metaMain.appendChild(el("div", "w-text", `Créditos: ${creditos}`));
    metaMain.appendChild(el("div", "w-sub", `Concentración: ${concentracion}`));
    metaMain.appendChild(el("div", "w-sub", `Ofrecido en: ${offered.length ? offered.join(", ") : "(sin info)"}`));
    meta.appendChild(el("div", "w-dot menu-accent"));
    meta.appendChild(metaMain);
    body.appendChild(meta);

    const reqBlock = el("div", "w-item");
    const reqMain = el("div", "w-main");
    reqMain.appendChild(el("div", "w-text", `Prerrequisitos: ${prereq.length ? prereq.join(", ") : "(ninguno)"}`));
    reqMain.appendChild(el("div", "w-sub", `Correquisitos: ${coreq.length ? coreq.join(", ") : "(ninguno)"}`));
    reqBlock.appendChild(el("div", "w-dot menu-accent"));
    reqBlock.appendChild(reqMain);
    body.appendChild(reqBlock);

    const hint = el(
      "div",
      "form-help",
      isDraftMode
        ? "(Modo borrador) Próximo: editar atributos, borrar temporales, override de cursos de disco."
        : "(Solo lectura) Activa modo borrador para editar más adelante."
    );
    body.appendChild(hint);

    const ok = el("button", "btn primary", "Cerrar");
    ok.type = "button";
    ok.addEventListener("click", closeCourseMenu);
    foot.appendChild(ok);
  }

  _panel.appendChild(h);
  _panel.appendChild(body);
  _panel.appendChild(foot);
}

export function openCourseMenu({
  course,
  isDraftMode = false,
  sourceEl,
  onDeleteTempCourse = null,
  onMoveTempToDisk = null,
  onMaterialize = null,
  onSaveCourse = null,
  catalog = [],
  siglaSet = null,
} = {}) {
  ensureDOM();
  _onDeleteTempCourse = typeof onDeleteTempCourse === "function" ? onDeleteTempCourse : null;
  _onMoveTempToDisk = typeof onMoveTempToDisk === "function" ? onMoveTempToDisk : null;
  _onMaterialize = typeof onMaterialize === "function" ? onMaterialize : null;
  _onSaveCourse = typeof onSaveCourse === "function" ? onSaveCourse : null;
  _catalog = Array.isArray(catalog) ? catalog : [];
  _siglaSet = siglaSet instanceof Set ? siglaSet : new Set(siglaSet ? Array.from(siglaSet) : []);
  if (!course) return;
  // Pick accent color from the rendered course element (best source of truth).
  const accent = _pickAccentFromSourceEl(sourceEl);
  if (_panel) {
    _panel.style.setProperty("--menu-accent", accent || "var(--info-border)");
  }

  renderMenu({ course, isDraftMode: !!isDraftMode });
  _ov.style.display = "block"; // CSS upgrades to flex overlay
}

export function closeCourseMenu() {
  if (!_ov) return;
  _ov.style.display = "none";
}
