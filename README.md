# Sistema de Mallas

Aplicación local para **visualizar y planificar una malla curricular** a partir de un *vault* de **Obsidian** (archivos Markdown con *frontmatter* YAML). El backend en **Python** descubre semestres y cursos desde el filesystem, expone una **API local** y sirve una UI web (HTML/JS/CSS) compatible con **PyInstaller**.

---

## Cómo funciona (visión general)

1. **Descubrimiento en disco (Python)**

   * El script `malla_app.py` busca carpetas de semestre con nombre `AAAA-S` (ej. `2024-1`).
   * Dentro de cada semestre intenta usar `,Cursos` o `Cursos` como carpeta raíz de cursos. Si no existe, recorre el semestre completo.
   * Cada curso es un `.md` cuyo *frontmatter* se parsea para construir el catálogo (`sigla`, `nombre`, `créditos`, etc.).

2. **Servidor local + API**

   * `malla_app.py` levanta un servidor HTTP en `127.0.0.1` en un puerto libre.
   * Sirve la UI desde `mallas_app/` (o desde `_internal/mallas_app/` si viene empaquetado).
   * Expone endpoints `/api/*` para que la UI cargue datos y guarde el borrador.

3. **UI (JavaScript) y borrador persistente**

   * La UI consume `GET /api/all` para obtener `terms` y `courses`.
   * El “modo borrador” permite reordenar cursos sin tocar los Markdown reales.
   * Ese estado se guarda en `malla_draft.json` mediante `POST /api/draft`.

---

## Características principales

* **Visualización interactiva** de la malla por semestres (incluye verano).
* **Unlock view:** al hacer click en un curso se resalta y parpadean los cursos que desbloquea (transitivamente).
* **Modo borrador:** mover cursos con *drag & drop* y recibir alertas por:

  * semestres no ofrecidos,
  * correquisitos,
  * prerrequisitos faltantes,
  * sobrecarga de créditos.
* **Semestres futuros:** añadir nuevos períodos desde la UI.
* **Color coding** según `concentracion`/`concentración`.
* **Toasts** arriba a la derecha para info/warns.

### Estado del botón “crear curso”

El botón “crear curso” puede existir en la UI, pero la acción de crear cursos temporales y materializarlos al filesystem está en roadmap (ver más abajo).

---

## Estructura de carpetas

```
<raíz>/
  malla_app.py          # Servidor local y lógica de descubrimiento
  mallas_app/           # UI (index.html, app.js, styles.css, modules/*)
  malla_draft.json      # Estado de borrador (se genera automáticamente)
  2024-1/               # Semestres en formato AAAA-S (0=Verano, 1=I, 2=P)
    Cursos/             # Cursos; si no existe se recorre el semestre completo
      INF-101.md
      ...
```

* Semestres: se detectan por patrón `AAAA-S`.
* Cursos: se buscan en `,Cursos` o `Cursos` (case-insensitive). Si no existen, se indexan todos los `.md` del semestre.

---

## Formato de cursos (frontmatter)

Ejemplo compatible con Obsidian:

```markdown
---
sigla: INF-101
nombre: Programación I
creditos: 10
aprobado: false
concentracion: FI        # MScB, M, m, FI, OFG, ex
prerrequisitos: [MAT-100]
semestreOfrecido: [I, P] # Opcional: períodos donde se ofrece (I/P/V)
---

Descripción libre en Markdown.
```

Campos usados por el backend:

* `sigla`, `nombre`, `creditos`/`créditos`, `aprobado`.
* `concentracion`/`concentración`.
* `prerrequisitos`: lista o string separado por comas (se ignora `NT`).
* `semestreOfrecido`: lista (valores típicos: `I`, `P`, `V`).

> Nota: el backend soporta parseo con PyYAML (si está instalado). Si no, usa un parser mínimo compatible con `key: value` y listas `- item`.

---

## Borrador y persistencia (`malla_draft.json`)

El borrador se guarda en la raíz como `malla_draft.json` y contiene, entre otros:

* `placements`: ubicación de cursos por `term_id`.
* `term_order`: orden de semestres en UI.
* `custom_terms`: semestres creados desde la UI.
* `ignored_warnings`: warnings ignorados (persistentes).

Este archivo se crea automáticamente cuando se guarda por primera vez.

---

## API local

* `GET /api/config`: configuración general (versión, límites de créditos, tema).
* `GET /api/all`: términos, cursos y datos de depuración.
* `GET /api/draft` / `POST /api/draft`: leer/guardar estado de borrador.

---

## Ejecución local

Requisitos:

* Python 3.10+.
* Dependencias estándar (PyYAML opcional).

Pasos:

1. Ubica `malla_app.py` en la raíz que contiene las carpetas `AAAA-S`.

2. Ejecuta:

   ```bash
   python malla_app.py
   ```

3. Se abrirá el navegador con la UI en un puerto local libre.

---

## PyInstaller

El proyecto está diseñado para empaquetarse con PyInstaller. Asegúrate de incluir la carpeta `mallas_app/` junto al ejecutable (o dentro de `_internal/`). Si la UI no se encuentra, el servidor mostrará una página de respaldo.

Ejemplo típico:

```bash
pyinstaller --onefile malla_app.py
./dist/malla_app
```

---

## Roadmap (v1.0.0)

* Crear cursos temporales desde la UI (solo en borrador).
* Eliminar cursos temporales.
* Materializar cursos temporales al filesystem (crear carpetas/Markdown reales).
* Menú contextual de curso (aprobar, editar frontmatter).
* Categorías dinámicas con color y persistencia.

---

## Contribuciones

1. Mantén el formato `AAAA-S` y archivos `.md` con *frontmatter* válido.
2. Incluye `mallas_app/` junto al ejecutable para la experiencia completa.
3. Verifica modo borrador (warnings + colores) antes de empaquetar.
