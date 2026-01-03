// Course menu (dummy)
// - Opens on second click of a course (handled by unlock.js via onSecondClick)
// - Always opens (even outside draft), but editing will be enabled only in draftMode later.
//
// This module is intentionally UI-only and does NOT mutate state.

let _ov = null;
let _panel = null;
let _escBound = false;

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
  const sigla = String(course?.sigla ?? fm?.sigla ?? "").trim();
  const nombre = String(course?.nombre ?? fm?.nombre ?? "").trim();
  const creditos = Number(course?.creditos ?? fm?.creditos ?? fm?.créditos ?? 0) || 0;
  const concentracion = String(course?.concentracion ?? fm?.concentracion ?? fm?.["concentración"] ?? "ex").trim() || "ex";

  const { prereq, coreq } = normalizeReqs(course);
  const offered = normalizeOffered(course);

  // Source info
  const isTemp = !!course?.is_temp;
  const tempKind = String(course?.temp_kind || "").trim();
  const src = isTemp ? (tempKind ? `Temporal (${tempKind})` : "Temporal") : "En disco";

  _panel.innerHTML = "";

  // Header
  const h = el("div", "modal-header");
  const title = el("div", "modal-title", sigla ? `${sigla}` : "Curso");
  const right = el("div", "modal-controls");
  const badge = el("div", "tag", src);
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
  body.appendChild(el("div", "muted", nombre || "(sin nombre)"));

  const meta = el("div", "w-item");
  const metaMain = el("div", "w-main");
  metaMain.appendChild(el("div", "w-text", `Créditos: ${creditos}`));
  metaMain.appendChild(el("div", "w-sub", `Concentración: ${concentracion}`));
  metaMain.appendChild(el("div", "w-sub", `Ofrecido en: ${offered.length ? offered.join(", ") : "(sin info)"}`));
  meta.appendChild(el("div", "w-dot soft"));
  meta.appendChild(metaMain);
  body.appendChild(meta);

  const reqBlock = el("div", "w-item");
  const reqMain = el("div", "w-main");
  reqMain.appendChild(el("div", "w-text", `Prerrequisitos: ${prereq.length ? prereq.join(", ") : "(ninguno)"}`));
  reqMain.appendChild(el("div", "w-sub", `Correquisitos: ${coreq.length ? coreq.join(", ") : "(ninguno)"}`));
  reqBlock.appendChild(el("div", "w-dot soft"));
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

  // Footer
  const foot = el("div", "modal-footer");
  const ok = el("button", "btn primary", "Cerrar");
  ok.type = "button";
  ok.addEventListener("click", closeCourseMenu);
  foot.appendChild(ok);

  _panel.appendChild(h);
  _panel.appendChild(body);
  _panel.appendChild(foot);
}

export function openCourseMenu({ course, isDraftMode = false } = {}) {
  ensureDOM();
  if (!course) return;
  renderMenu({ course, isDraftMode: !!isDraftMode });
  _ov.style.display = "block"; // CSS upgrades to flex overlay
}

export function closeCourseMenu() {
  if (!_ov) return;
  _ov.style.display = "none";
}
