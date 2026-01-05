// Course creation modal (draft-only temp courses)
//
// Requirements:
// - Open from the (+) button under a term.
// - Looks/behaves like the existing warnings modal (overlay + centered panel).
// - Ask: sigla(optional), nombre, creditos, prerrequisitos (chips + suggest), correquisitos (chips + suggest),
//        semestreOfrecido (I/P/V checkboxes), concentracion (dropdown).
// - While typing, suggest existing courses by sigla and nombre.
// - On Enter: add chip; if code not found -> emit soft warn.
// - Do NOT block creation; unknown prereqs/coreqs become warnings later.
//
// Integration:
// - openCreateCourseModal(...) resolves via callbacks; does not persist itself.

import { showNotice } from "./toasts.js";

function $(id) {
  return document.getElementById(id);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

function buildOverlay() {
  // Reuse existing modal if present (warnings modal style).
  // Otherwise, create our own minimal overlay/panel with classes compatible with styles.
  let ov = $("courseModal");
  if (ov) return ov;

  ov = el("div", "modal-overlay", "");
  ov.id = "courseModal";
  ov.style.display = "none";

  const panel = el("div", "modal", "");
  panel.id = "courseModalPanel";

  const header = el("div", "modal-header", "");
  const title = el("div", "modal-title", "Crear curso temporal");
  const close = el("button", "modal-close", "×");
  close.type = "button";
  close.id = "courseModalClose";
  header.appendChild(title);
  header.appendChild(close);

  const body = el("div", "modal-body", "");
  body.id = "courseModalBody";

  const footer = el("div", "modal-footer", "");
  const cancel = el("button", "btn", "Cancelar");
  cancel.type = "button";
  cancel.id = "courseModalCancel";

  const create = el("button", "btn primary", "Crear");
  create.type = "button";
  create.id = "courseModalCreate";

  footer.appendChild(cancel);
  footer.appendChild(create);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  ov.appendChild(panel);
  document.body.appendChild(ov);

  // Close on backdrop click
  ov.addEventListener("click", (ev) => {
    if (ev.target === ov) {
      close.click();
    }
  });

  return ov;
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
  for (const it of items) {
    const sig = normSigla(it.sigla);
    const name = String(it.nombre || "").toUpperCase();
    if (sig.includes(qq) || name.includes(qq)) out.push(it);
    if (out.length >= 8) break;
  }
  // Prefer sigla prefix matches
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
      b.innerHTML = `<div class="suggest-sigla">${esc(normSigla(it.sigla))}</div><div class="suggest-name">${esc(it.nombre || "")}</div>`;
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

    if (emitUnknown && siglaSet && !siglaSet.has(code)) {
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
      // remove last chip
      if (chips.length) removeAt(chips.length - 1);
    }
  });

  // Hide suggestions on blur (with small delay so click works)
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
  // Ensure fallback essentials exist
  for (const f of fallback) if (!set.has(f)) arr.push(f);
  return arr;
}

export function openCreateCourseModal({
  term_id,
  catalog = [],
  siglaSet = null,
  defaultConcentracion = "ex",
  onSubmit,
  onCancel,
} = {}) {
  const ov = buildOverlay();
  const body = $("courseModalBody");
  const btnClose = $("courseModalClose");
  const btnCancel = $("courseModalCancel");
  const btnCreate = $("courseModalCreate");

  // Title
  const titleEl = ov.querySelector?.(".modal-title");
  if (titleEl) titleEl.textContent = `Crear curso temporal (${term_id || ""})`;

  body.innerHTML = "";

  const sigla = makeTextInput("tmp_sigla", "Opcional (ej. TMP-001)");
  const nombre = makeTextInput("tmp_nombre", "Nombre del curso");
  const creditos = makeNumberInput("tmp_creditos", "Créditos");

  const concs = getConcsFromCatalog(catalog);
  const concSel = makeSelect(
    "tmp_conc",
    concs.map((v) => ({ value: v, label: v, selected: v === defaultConcentracion }))
  );

  const offeredWrap = el("div", "offered", "");
  const ckI = makeCheckbox("tmp_off_I", "I");
  const ckP = makeCheckbox("tmp_off_P", "P");
  const ckV = makeCheckbox("tmp_off_V", "V");
  // Default: I+P checked
  ckI.input.checked = true;
  ckP.input.checked = true;
  ckV.input.checked = false;
  offeredWrap.appendChild(ckI.wrap);
  offeredWrap.appendChild(ckP.wrap);
  offeredWrap.appendChild(ckV.wrap);

  const chipsPrereq = makeChipInput({
    id: "tmp_prer",
    placeholder: "Escribe una sigla y Enter…",
    catalog,
    siglaSet,
    onSoftUnknown: (code) => showNotice?.("soft", `Requisito inexistente: ${code}`),
  });

  const chipsCoreq = makeChipInput({
    id: "tmp_coreq",
    placeholder: "Escribe una sigla y Enter…",
    catalog,
    siglaSet,
    onSoftUnknown: (code) => showNotice?.("soft", `Correquisito inexistente: ${code}`),
  });

  body.appendChild(fieldRow("Sigla", sigla, "Opcional. Si la dejas vacía se autogenera."));
  body.appendChild(fieldRow("Nombre", nombre));
  body.appendChild(fieldRow("Créditos", creditos));
  body.appendChild(fieldRow("Prerrequisitos", chipsPrereq.root, "Agrega con Enter. Se sugieren cursos existentes."));
  body.appendChild(
    fieldRow(
      "Correquisitos",
      chipsCoreq.root,
      "Agrega con Enter. Deben dictarse en el mismo semestre o en uno anterior."
    )
  );
  body.appendChild(fieldRow("Ofrecido en", offeredWrap));
  body.appendChild(fieldRow("Concentración", concSel));

  function close() {
    ov.style.display = "none";
  }

  function submit() {
    const offered = [];
    if (ckI.input.checked) offered.push("I");
    if (ckP.input.checked) offered.push("P");
    if (ckV.input.checked) offered.push("V");

    const form = {
      term_id,
      sigla: normSigla(sigla.value),
      nombre: String(nombre.value || "").trim(),
      creditos: Number(String(creditos.value || "0").trim() || 0),
      prerrequisitos: chipsPrereq.getValues(),
      correquisitos: chipsCoreq.getValues(),
      semestreOfrecido: offered,
      concentracion: String(concSel.value || "ex").trim() || "ex",
    };

    if (!form.nombre) {
      showNotice?.("soft", "El nombre del curso está vacío.");
    }

    onSubmit?.(form);
    close();
  }

  const onClose = () => {
    close();
    onCancel?.();
  };

  btnClose.onclick = onClose;
  btnCancel.onclick = onClose;
  btnCreate.onclick = submit;

  // Enter on name/credits submits
  nombre.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  });
  creditos.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  });

  ov.style.display = "block";
  // Focus name by default
  setTimeout(() => nombre.focus(), 0);

  return { close };
}
