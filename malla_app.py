#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import os
import re
import sys
import threading
import webbrowser
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP_NAME = "malla_app"
APP_VERSION = "0.9.64"

TERM_RE = re.compile(r"^(?P<y>\d{4})-(?P<s>[012])(?:\b|$)")
COURSE_DIRS = [",Cursos", "Cursos"]
UI_DIRNAME = "mallas_app"
DRAFT_FILE = "malla_draft.json"

TERM_CODE = {0: "V", 1: "I", 2: "P"}  # 0 Verano, 1 1er semestre, 2 2do semestre
MAX_CREDITS = 65
SOFT_CREDITS = 50

FALLBACK_INDEX = """<!doctype html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Malla</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:18px}
pre{background:#f6f6f6;border:1px solid #ddd;border-radius:10px;padding:10px;white-space:pre-wrap}
</style></head><body>
<h1>Malla</h1>
<p>No se encontró la UI modular en la carpeta <b>mallas_app</b>.</p>
<pre>Ingeniería Civil/
  malla_app.py (o malla_app.exe)
  malla_draft.json (se crea solo)
  mallas_app/
    index.html
    app.js
    styles.css</pre>
</body></html>
"""


def _jdefault(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, Path):
        return str(o)
    return str(o)


def jdump(o, **kw):
    return json.dumps(o, ensure_ascii=False, default=_jdefault, **kw)


def basedir() -> Path:
    return Path(sys.argv[0]).resolve().parent


def pick_ui_dir(b: Path):
    for p in (b / UI_DIRNAME, b / "_internal" / UI_DIRNAME):
        if (p / "index.html").exists():
            return p
    for p in (b / UI_DIRNAME, b / "_internal" / UI_DIRNAME):
        if p.exists() and p.is_dir():
            return p
    return None


# ---------- frontmatter ----------

def split_frontmatter(text: str):
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1 :])
    return None, text


def parse_frontmatter(fm: str | None) -> dict:
    if not fm:
        return {}
    # Prefer PyYAML si está instalado
    try:
        import yaml  # type: ignore

        d = yaml.safe_load(fm)
        return d if isinstance(d, dict) else {}
    except Exception:
        pass

    # Fallback mínimo (key: value + listas "- item")
    out, key = {}, None
    for raw in fm.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if key and line.startswith("- "):
            out.setdefault(key, []).append(line[2:].strip())
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        key, v = k.strip(), v.strip()
        if v == "":
            out[key] = []
            continue
        if v.lower() in ("true", "false"):
            out[key] = v.lower() == "true"
            continue
        out[key] = int(v) if re.fullmatch(r"[+-]?\d+", v) else v
    return out


def get(fm: dict, *keys, default=None):
    for k in keys:
        if k in fm:
            return fm.get(k)
    return default


def listify(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    if isinstance(x, str):
        s = x.strip()
        if not s:
            return []
        return [p.strip() for p in s.split(",")] if "," in s else [s]
    return [str(x)]


def as_int(x, default=0):
    try:
        if isinstance(x, bool):
            return default
        return int(float(str(x).strip()))
    except Exception:
        return default


def as_bool(x) -> bool:
    if isinstance(x, bool):
        return x
    return str(x).strip().lower() == "true"


# ---------- discovery ----------

def parse_term(name: str):
    m = TERM_RE.match(name)
    return (int(m.group("y")), int(m.group("s"))) if m else None


def term_sort(p: Path):
    t = parse_term(p.name)
    return (t[0], t[1], p.name) if t else (9999, 9, p.name)


def find_terms(b: Path, max_depth=5):
    direct = [p for p in b.iterdir() if p.is_dir() and parse_term(p.name)]
    if direct:
        return sorted(direct, key=term_sort), "direct"

    found = []
    b_res = b.resolve()
    for root, dirs, _ in os.walk(b_res):
        rel = Path(root).resolve().relative_to(b_res)
        if len(rel.parts) > max_depth:
            dirs[:] = []
            continue
        if root == str(b_res):
            continue
        if parse_term(Path(root).name):
            found.append(Path(root))
            dirs[:] = []
    seen, out = set(), []
    for p in sorted(found, key=term_sort):
        rp = str(p.resolve())
        if rp in seen:
            continue
        seen.add(rp)
        out.append(p)
    return out, f"fallback_depth{max_depth}"


def find_courses_root(term_dir: Path):
    for name in COURSE_DIRS:
        p = term_dir / name
        if p.is_dir():
            return p, True
    wanted = {n.lower() for n in COURSE_DIRS}
    for ch in term_dir.iterdir():
        if ch.is_dir() and ch.name.lower() in wanted:
            return ch, True
    return term_dir, False


def rel(p: Path, base: Path) -> str:
    try:
        return str(p.resolve().relative_to(base.resolve()))
    except Exception:
        return str(p)


def discover_all(b: Path):
    debug = dict(
        app_name=APP_NAME,
        app_version=APP_VERSION,
        base_dir=str(b),
        mode=None,
        terms_detected=0,
        md_found_total=0,
        warnings=[],
        term_dirs=[],
    )
    if not b.exists():
        debug["warnings"].append(f"Base dir no existe: {b}")
        return [], [], debug

    term_dirs, mode = find_terms(b)
    debug["mode"], debug["terms_detected"] = mode, len(term_dirs)

    terms, courses = [], []
    for tdir in term_dirs:
        y, s = parse_term(tdir.name)  # type: ignore
        term_id = f"{y}-{s}"
        root, has_courses = find_courses_root(tdir)
        md_files = sorted(root.rglob("*.md"))
        debug["md_found_total"] += len(md_files)

        terms.append(
            dict(
                term_id=term_id,
                year=y,
                sem=s,
                code=TERM_CODE.get(s, "?"),
                folderName=tdir.name,
                folderRel=rel(tdir, b),
                searchRootRel=rel(root, b),
                hasCoursesDir=bool(has_courses),
            )
        )
        debug["term_dirs"].append(
            dict(
                term_id=term_id,
                folderName=tdir.name,
                searchRootRel=rel(root, b),
                mdCount=len(md_files),
                hasCoursesDir=bool(has_courses),
            )
        )

        for md in md_files:
            relp = rel(md, b)
            try:
                txt = md.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                txt = md.read_text(encoding="utf-8", errors="replace")
            except Exception as e:
                courses.append(
                    dict(
                        course_id=relp,
                        fileRel=relp,
                        term_id=term_id,
                        sigla=md.stem,
                        nombre="",
                        creditos=0,
                        aprobado=False,
                        concentracion="ex",
                        prerrequisitos=[],
                        semestreOfrecido=[],
                        frontmatter={},
                        error=f"No se pudo leer: {e}",
                    )
                )
                continue

            fm_text, _ = split_frontmatter(txt)
            fm = parse_frontmatter(fm_text)

            sigla = str(get(fm, "sigla", "código", "codigo", default=md.stem) or md.stem).strip()
            nombre = str(get(fm, "nombre", default="") or "").strip()
            creditos = as_int(get(fm, "créditos", "creditos", default=0), 0)
            aprobado = as_bool(get(fm, "aprobado", default=False))

            catv = get(fm, "concentracion", "concentración", default="ex")
            if isinstance(catv, list):
                catv = catv[0] if catv else "ex"
            concentracion = str(catv or "").strip() or "ex"

            prer = [str(x).strip() for x in listify(get(fm, "prerrequisitos", default=[])) if str(x).strip()]
            prer = [p for p in prer if p.lower() != "nt"]
            sem_of = [str(x).strip() for x in listify(get(fm, "semestreOfrecido", default=[])) if str(x).strip()]

            courses.append(
                dict(
                    course_id=relp,  # estable
                    fileRel=relp,
                    term_id=term_id,
                    sigla=sigla,
                    nombre=nombre,
                    creditos=creditos,
                    aprobado=aprobado,
                    concentracion=concentracion,
                    prerrequisitos=prer,
                    semestreOfrecido=sem_of,
                    frontmatter=fm,
                )
            )

    return terms, courses, debug


# ---------- draft ----------

def draft_default():
    # Draft schema (persisted in malla_draft.json)
    # - term_order: ordering of terms in UI
    # - placements: course_id -> term_id overrides
    # - custom_terms: user-created terms
    # - ignored_warnings: persisted ignore flags by warning id
    # - temp_courses: courses that exist only in draft (UI-created)
    return {
        "term_order": [],
        "placements": {},
        "custom_terms": [],
        "ignored_warnings": {},
        "temp_courses": [],
    }


def draft_path(b: Path) -> Path:
    return b / DRAFT_FILE


def sanitize_draft(d: dict) -> dict:
    base = draft_default()
    if not isinstance(d, dict):
        return base
    for k, v in base.items():
        d.setdefault(k, v)
    if not isinstance(d["term_order"], list):
        d["term_order"] = []
    if not isinstance(d["placements"], dict):
        d["placements"] = {}
    if not isinstance(d["custom_terms"], list):
        d["custom_terms"] = []
    if not isinstance(d["ignored_warnings"], dict):
        d["ignored_warnings"] = {}
    if not isinstance(d.get("temp_courses"), list):
        d["temp_courses"] = []
    else:
        # Keep only dict-like entries to avoid crashes in the UI.
        d["temp_courses"] = [x for x in d["temp_courses"] if isinstance(x, dict)]
    return d


def load_draft(b: Path) -> dict:
    p = draft_path(b)
    if not p.exists():
        return draft_default()
    try:
        return sanitize_draft(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return draft_default()


def save_draft(b: Path, d: dict):
    draft_path(b).write_text(jdump(sanitize_draft(d), indent=2), encoding="utf-8")


# ---------- http ----------

def send(h, status, ctype, body: bytes):
    try:
        h.send_response(status)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(len(body)))
        h.end_headers()
        if body:
            h.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        pass


def handler_factory(b: Path, ui_dir):
    lock = threading.Lock()

    class H(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=str(ui_dir) if ui_dir else None, **kw)

        def log_message(self, *args):
            return

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/favicon.ico":
                return send(self, 204, "image/x-icon", b"")
            if path.startswith("/api/"):
                return self.api_get(path)
            if ui_dir is None:
                if path in ("/", "/index.html"):
                    return send(self, 200, "text/html; charset=utf-8", FALLBACK_INDEX.encode("utf-8"))
                return send(self, 404, "text/plain; charset=utf-8", b"404 Not Found")
            return super().do_GET()

        def do_POST(self):
            path = urlparse(self.path).path

            if path == "/api/draft":
                try:
                    n = int(self.headers.get("Content-Length", "0"))
                    raw = self.rfile.read(n) if n > 0 else b"{}"
                    d = sanitize_draft(json.loads(raw.decode("utf-8")))
                    save_draft(b, d)
                    return send(self, 200, "application/json; charset=utf-8", jdump({"ok": True}).encode("utf-8"))
                except Exception as e:
                    return send(
                        self,
                        400,
                        "application/json; charset=utf-8",
                        jdump({"ok": False, "error": str(e)}).encode("utf-8"),
                    )

            if path == "/api/draft/reset":
                # Hard reset: delete malla_draft.json (frontend must confirm).
                try:
                    p = draft_path(b)
                    existed = p.exists()
                    try:
                        p.unlink()
                    except FileNotFoundError:
                        existed = False
                    return send(
                        self,
                        200,
                        "application/json; charset=utf-8",
                        jdump({"ok": True, "deleted": existed}).encode("utf-8"),
                    )
                except Exception as e:
                    return send(
                        self,
                        400,
                        "application/json; charset=utf-8",
                        jdump({"ok": False, "error": str(e)}).encode("utf-8"),
                    )

            if path == "/api/materialize":
                try:
                    n = int(self.headers.get("Content-Length", "0"))
                    raw = self.rfile.read(n) if n > 0 else b"{}"
                    payload = json.loads(raw.decode("utf-8"))
                    if not isinstance(payload, dict):
                        raise ValueError("Payload inválido")

                    term_id = str(payload.get("term_id", "") or "").strip()
                    fm = payload.get("frontmatter") if isinstance(payload.get("frontmatter"), dict) else {}

                    sigla = str(payload.get("sigla") or fm.get("sigla") or "").strip()
                    nombre = str(payload.get("nombre") or fm.get("nombre") or "").strip()
                    creditos = payload.get("creditos")
                    if creditos is None:
                        creditos = fm.get("creditos", fm.get("créditos"))
                    aprobado = payload.get("aprobado") if payload.get("aprobado") is not None else fm.get("aprobado")
                    concentracion = payload.get("concentracion") or payload.get("concentración")
                    if concentracion is None:
                        concentracion = fm.get("concentracion", fm.get("concentración"))
                    prerrequisitos = payload.get("prerrequisitos", fm.get("prerrequisitos"))
                    semestre_ofrecido = payload.get("semestreOfrecido", fm.get("semestreOfrecido"))

                    if not term_id or not TERM_RE.match(term_id):
                        raise ValueError("term_id inválido")
                    if not sigla:
                        raise ValueError("sigla obligatoria")

                    term_match = TERM_RE.match(term_id)
                    sem_val = int(term_match.group("s")) if term_match else 0
                    year_val = int(term_match.group("y")) if term_match else date.today().year

                    fm.setdefault("sigla", sigla)
                    if nombre:
                        fm.setdefault("nombre", nombre)
                    if creditos is not None:
                        fm.setdefault("creditos", creditos)
                        fm.setdefault("créditos", creditos if creditos is not None else fm.get("creditos"))
                    if aprobado is not None:
                        fm.setdefault("aprobado", aprobado)
                    else:
                        fm.setdefault("aprobado", False)
                    if concentracion is not None:
                        fm.setdefault("concentracion", concentracion)
                    if prerrequisitos is not None:
                        fm.setdefault("prerrequisitos", prerrequisitos)
                    if semestre_ofrecido is not None:
                        fm.setdefault("semestreOfrecido", semestre_ofrecido)
                    fm.setdefault("semestre", sem_val)
                    fm.setdefault("año", year_val)
                    fm.setdefault("sección", fm.get("sección", 0))
                    fm.setdefault("notaObtenida", fm.get("notaObtenida", 0))
                    fm.setdefault("dg-publish", fm.get("dg-publish", True))

                    term_dir = (b / term_id).resolve()
                    term_dir.mkdir(parents=True, exist_ok=True)
                    if not term_dir.is_dir():
                        raise ValueError(f"No se pudo crear directorio de período: {term_dir}")

                    courses_root, has_courses = find_courses_root(term_dir)
                    if not has_courses:
                        courses_root = term_dir / COURSE_DIRS[0]
                        courses_root.mkdir(parents=True, exist_ok=True)

                    safe_sigla = re.sub(r"[^A-Za-z0-9._-]+", "_", sigla) or "curso"
                    md_path = (courses_root / f"{safe_sigla}.md").resolve()
                    if not str(md_path).startswith(str(term_dir)):
                        raise ValueError("Ruta de destino inválida")

                    try:
                        import yaml  # type: ignore

                        fm_text = yaml.safe_dump(fm, allow_unicode=True, sort_keys=False)
                    except Exception:
                        fm_text = jdump(fm, indent=2)

                    dataview_block = """```dataviewjs
let notas = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.frontmatter.notaObtenida
let pond = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.frontmatter.Ponderación
let sigla = dv.pages().where(b=>b.file.frontmatter.Curso === dv.current().file.name).file.link
let arr = []
let nf = 0
for(i=0;i<=notas.length-1;i++){
    arr.push([sigla[i],notas[i],pond[i]])
    nf = nf + notas[i]*pond[i]
}
nf = Math.round(nf*10)/10
dv.table([\"Evaluación\",\"Nota\",\"Ponderación\"],arr)
dv.paragraph(\"$$\\\\Huge{\\\\text{NFC}=\"+nf+\"}$$\")
```"""

                    md_body = f"---\n{fm_text}\n---\n\n{dataview_block}\n"
                    with lock:
                        md_path.write_text(md_body, encoding="utf-8")

                    return send(
                        self,
                        200,
                        "application/json; charset=utf-8",
                        jdump({"ok": True, "fileRel": rel(md_path, b)}).encode("utf-8"),
                    )
                except Exception as e:
                    return send(
                        self,
                        400,
                        "application/json; charset=utf-8",
                        jdump({"ok": False, "error": str(e)}).encode("utf-8"),
                    )

            return send(self, 404, "text/plain; charset=utf-8", b"404 Not Found")

        def api_get(self, path: str):
            if path == "/api/config":
                cfg = dict(
                    app_name=APP_NAME,
                    app_version=APP_VERSION,
                    max_credits=MAX_CREDITS,
                    soft_credits=SOFT_CREDITS,
                    term_code_by_sem=TERM_CODE,
                    supports_theme=True,
                    theme_values=["light", "dark"],
                    theme_default="light",
                )
                return send(self, 200, "application/json; charset=utf-8", jdump(cfg, indent=2).encode("utf-8"))

            if path == "/api/draft":
                return send(self, 200, "application/json; charset=utf-8", jdump(load_draft(b), indent=2).encode("utf-8"))

            if path == "/api/all":
                with lock:
                    terms, courses, debug = discover_all(b)
                payload = {"version": APP_VERSION, "debug": debug, "terms": terms, "courses": courses}
                return send(self, 200, "application/json; charset=utf-8", jdump(payload, indent=2).encode("utf-8"))

            return send(self, 404, "application/json; charset=utf-8", jdump({"error": "unknown api"}).encode("utf-8"))

    return H


def find_free_port(host="127.0.0.1", start=8787, attempts=80):
    import socket

    for p in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
                return p
            except OSError:
                pass
    raise RuntimeError("No se encontró un puerto libre.")


def main():
    b = basedir()
    ui = pick_ui_dir(b)
    port = find_free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_factory(b, ui))

    url = f"http://127.0.0.1:{port}/"
    print(f"[{APP_NAME} v{APP_VERSION}] Base dir: {b}")
    print(f"[{APP_NAME}] UI dir: {ui if ui else '(missing)'}")
    print(f"[{APP_NAME}] Servidor en: {url}")

    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print(f"[{APP_NAME}] Cerrado.")


if __name__ == "__main__":
    main()
