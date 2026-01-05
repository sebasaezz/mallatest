// Temporary courses (draft-only) utilities.
//
// Goals:
// - Represent temp courses with (mostly) the same shape as backend /api/all courses.
// - Persist them inside draft.temp_courses.
// - Merge them into the runtime course list so render/warnings/unlock treat them as normal.
//
// IMPORTANT:
// Some subsystems may rely on `course.frontmatter` existing. For temp courses we always
// provide a frontmatter object mirroring the primary fields.

function nowStamp() {
  // Compact readable stamp for ids.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function rand6() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return (a[0] >>> 0).toString(36).padStart(6, "0").slice(0, 6);
  } catch {
    return Math.random().toString(36).slice(2, 8).padEnd(6, "0").slice(0, 6);
  }
}

export function ensureDraftTempCourses(draft) {
  if (!draft || typeof draft !== "object") return [];
  if (!Array.isArray(draft.temp_courses)) draft.temp_courses = [];
  // Keep dict-like entries only.
  draft.temp_courses = draft.temp_courses.filter((x) => x && typeof x === "object");
  return draft.temp_courses;
}

export function ensureDraftOverrides(draft) {
  if (!draft || typeof draft !== "object") return [];
  const seen = new Set();
  const cleaned = [];
  const raw = Array.isArray(draft.overrides) ? draft.overrides : [];
  for (const v of raw) {
    const s = String(v ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  draft.overrides = cleaned;
  return draft.overrides;
}

export function listAllSiglas(courses) {
  const set = new Set();
  for (const c of courses || []) {
    if (!c) continue;
    const s = String(c.sigla || "").trim();
    if (s) set.add(s.toUpperCase());
  }
  return set;
}

export function nextTempSigla(existingSiglas) {
  const set = existingSiglas instanceof Set ? existingSiglas : new Set(existingSiglas || []);
  // TMP-001, TMP-002, ...
  for (let i = 1; i < 10000; i++) {
    const s = `TMP-${String(i).padStart(3, "0")}`;
    if (!set.has(s.toUpperCase())) return s;
  }
  return `TMP-${nowStamp()}`;
}

function normalizeOffered(offered) {
  const valid = new Set(["I", "P", "V"]);
  const out = [];
  for (const x of Array.isArray(offered) ? offered : []) {
    const v = String(x || "").trim().toUpperCase();
    if (valid.has(v)) out.push(v);
  }
  // de-dup, keep order I/P/V if repeated
  return Array.from(new Set(out));
}

function normalizePrereqList(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    if (s.toLowerCase() === "nt") continue;
    out.push(s);
  }
  return out;
}

function asInt(x, def = 0) {
  const n = Number(String(x ?? "").trim());
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

export function stableCourseId() {
  // Unique enough; persisted inside draft.
  return `tmp:${nowStamp()}:${rand6()}`;
}

function softError(message) {
  const err = new Error(message);
  err.noticeKind = "soft";
  return err;
}

export function makeTempCourse(form, term_id, opts = {}) {
  const existingSiglas = opts.existingSiglas instanceof Set ? opts.existingSiglas : new Set(opts.existingSiglas || []);

  const nombre = String(form?.nombre || "").trim();
  const creditos = asInt(form?.creditos ?? form?.créditos, NaN);

  if (!nombre) throw softError("El nombre del curso temporal es obligatorio.");
  if (!Number.isFinite(creditos) || creditos <= 0) throw softError("Los créditos deben ser un número positivo.");

  let sigla = String(form?.sigla || "").trim();
  if (!sigla) sigla = nextTempSigla(existingSiglas);
  sigla = sigla.toUpperCase();

  // Ensure uniqueness vs existing siglas.
  if (existingSiglas.has(sigla)) {
    // Add suffix until unique: TMP-001A, TMP-001B, ...
    const base = sigla;
    for (let i = 0; i < 26; i++) {
      const s2 = base + String.fromCharCode(65 + i);
      if (!existingSiglas.has(s2)) {
        sigla = s2;
        break;
      }
    }
  }

  const concentracion = String(form?.concentracion || form?.concentración || "ex").trim() || "ex";

  // We store prereqs and coreqs in the same array with "(c)" marker for coreqs.
  // This keeps compatibility with existing normalizePrereqs logic.
  const prereqs = normalizePrereqList(form?.prerrequisitos);
  const coreqs = normalizePrereqList(form?.correquisitos);
  const prerrequisitos = prereqs.concat(coreqs.map((x) => `${x}(c)`));

  const semestreOfrecido = normalizeOffered(form?.semestreOfrecido);

  const course_id = stableCourseId();

  const frontmatter = {
    sigla,
    nombre,
    creditos,
    aprobado: false,
    concentracion,
    prerrequisitos,
    semestreOfrecido,
  };

  return {
    is_temp: true,
    course_id,
    fileRel: "",
    term_id: String(term_id || ""),
    sigla,
    nombre,
    creditos,
    aprobado: false,
    concentracion,
    prerrequisitos,
    semestreOfrecido,
    frontmatter,
  };
}

export function cloneCourseAsTempOverride(course, term_id) {
  if (!course || typeof course !== "object") return null;

  const fm = course.frontmatter && typeof course.frontmatter === "object" ? course.frontmatter : {};
  const sigla = String(course.sigla ?? fm.sigla ?? "").trim();
  const nombre = String(course.nombre ?? fm.nombre ?? "").trim();
  const creditos = asInt(course.creditos ?? course.créditos ?? fm.creditos ?? fm.créditos, 0);
  const aprobado = !!(course.aprobado ?? fm.aprobado);
  const concentracion = String(
    course.concentracion ?? course.concentración ?? fm.concentracion ?? fm["concentración"] ?? "ex"
  ).trim() || "ex";
  const prerrequisitos = normalizePrereqList(course.prerrequisitos ?? fm.prerrequisitos);
  const semestreOfrecido = normalizeOffered(course.semestreOfrecido ?? fm.semestreOfrecido);

  const frontmatter = {
    ...fm,
    sigla,
    nombre,
    creditos,
    aprobado,
    concentracion,
    prerrequisitos,
    semestreOfrecido,
  };

  return {
    ...course,
    is_temp: true,
    temp_kind: "override",
    override_of: course.course_id,
    course_id: stableCourseId(),
    term_id: String(term_id ?? course.term_id ?? ""),
    sigla,
    nombre,
    creditos,
    aprobado,
    concentracion,
    prerrequisitos,
    semestreOfrecido,
    frontmatter,
  };
}

export function addTempCourseToDraft(draft, course, term_id) {
  if (!draft || typeof draft !== "object") return;
  ensureDraftTempCourses(draft);
  draft.placements = draft.placements && typeof draft.placements === "object" ? draft.placements : {};

  if (course && typeof course === "object") {
    draft.temp_courses.push(course);
    if (course.course_id != null && term_id != null) {
      draft.placements[String(course.course_id)] = String(term_id);
    }
  }
}

export function mergeTempCourses(realCourses, draft) {
  const out = [];
  const seen = new Set();

  const real = Array.isArray(realCourses) ? realCourses : [];
  const overridesSet = new Set(ensureDraftOverrides(draft));
  for (const c of real) {
    if (!c || c.course_id == null) continue;
    const id = String(c.course_id);
    if (overridesSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }

  const temps = ensureDraftTempCourses(draft);
  for (const c of temps) {
    if (!c || c.course_id == null) continue;
    const id = String(c.course_id);
    if (seen.has(id)) continue;

    // Ensure required fields exist.
    const sigla = String(c.sigla || c.frontmatter?.sigla || "").trim();
    const nombre = String(c.nombre || c.frontmatter?.nombre || "").trim();
    const creditos = asInt(c.creditos ?? c.créditos ?? c.frontmatter?.creditos ?? c.frontmatter?.créditos, 0);
    const aprobado = !!(c.aprobado ?? c.frontmatter?.aprobado);
    const concentracion = String(
      c.concentracion || c.concentración || c.frontmatter?.concentracion || c.frontmatter?.concentración || "ex"
    ).trim() || "ex";
    const prerrequisitos = normalizePrereqList(c.prerrequisitos ?? c.frontmatter?.prerrequisitos);
    const semestreOfrecido = normalizeOffered(c.semestreOfrecido ?? c.frontmatter?.semestreOfrecido);

    const frontmatter =
      c.frontmatter && typeof c.frontmatter === "object"
        ? c.frontmatter
        : {
            sigla,
            nombre,
            creditos,
            aprobado,
            concentracion,
            prerrequisitos,
            semestreOfrecido,
          };

    out.push({
      is_temp: true,
      ...c,
      course_id: id,
      sigla,
      nombre,
      creditos,
      aprobado,
      concentracion,
      prerrequisitos,
      semestreOfrecido,
      frontmatter,
    });
    seen.add(id);
  }

  return out;
}
