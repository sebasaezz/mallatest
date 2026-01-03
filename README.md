# Sistema de Mallas

Aplicación para gestionar mallas curriculares organizadas por carpetas semestrales (`AAAA-S`). Cada curso se define en un archivo Markdown amigable con Obsidian: el código lee su _frontmatter_ y genera una malla navegable en una web autohosteada. El proyecto es compatible con PyInstaller para crear un ejecutable que abre directamente la malla en el navegador.

## Características principales

- Visualización interactiva de la malla por semestres (incluye verano `TAV`).
- **Click y dependencias:** al seleccionar un curso se resaltan los cursos que desbloquea.
- **Modo borrador:** mover cursos con _drag & drop_ y recibir alertas por semestres no ofrecidos, correquisitos o prerrequisitos faltantes.
- Añadir nuevos semestres desde la UI (sugiere el siguiente período no verano).
- Codificación de color según la categoría del curso (MScB, Major, Minor, FI, OFG, extra).
- Sistema de notificaciones para estados y alertas.
- Botón (no funcional) para crear curso al activar el modo borrador.

### Próximas mejoras

- Crear curso desde la UI en modo borrador.
- Eliminar cursos en borrador.
- Exportar curso a disco (para integrarlo a Obsidian o guardar localmente).
- Eliminar cursos desde disco.
- Menús de curso al hacer segundo click (marcar aprobado, editar _frontmatter_).
- Crear nuevas categorías desde la UI con selector de color y persistencia en disco.

## Estructura de carpetas

```
<raíz>/
  malla_app.py          # Servidor local y lógica de descubrimiento
  mallas_app/           # UI (index.html, app.js, styles.css)
  malla_draft.json      # Estado de borrador (se genera automáticamente)
  2024-1/               # Semestres en formato AAAA-S (0=Verano, 1=I, 2=P)
    Cursos/             # Carpetas de cursos; si no existe se recorre el semestre completo
      INF-101.md
      ...
```

Los semestres se detectan por nombre de carpeta `AAAA-S`. Los cursos se buscan dentro de `Cursos` o `,Cursos`; si no se encuentran, se indexan todos los `.md` del semestre.

## Formato de cursos (frontmatter)

Ejemplo básico para un curso compatible con Obsidian:

```markdown
---
sigla: INF-101
nombre: Programación I
creditos: 10
aprobado: false
concentracion: FI        # MScB, M, m, FI, OFG, ex
prerrequisitos: [MAT-100]
semestreOfrecido: [1, 2] # Opcional: semestres donde se ofrece
---

Descripción libre en Markdown.
```

Campos disponibles:

- `sigla`, `nombre`, `creditos`, `aprobado` (bool).
- `concentracion`/`concentración` (categoría usada para color).
- `prerrequisitos`: lista o string separado por comas (se ignora `NT`).
- `semestreOfrecido`: lista con semestres donde se dicta.

## Ejecución local

Requisitos:

- Python 3.10+.
- Dependencias estándar de la biblioteca; PyYAML es opcional (mejora el _parsing_ de frontmatter).

Pasos:

1. Ubica `malla_app.py` en la raíz que contiene las carpetas semestrales.
2. Ejecuta:

   ```bash
   python malla_app.py
   ```

3. El servidor levanta en un puerto local libre y abre el navegador automáticamente.

### Binario con PyInstaller

El script está preparado para empaquetarse; un flujo típico es:

```bash
pyinstaller --onefile malla_app.py
./dist/malla_app
```

Coloca el ejecutable junto a las carpetas de semestres y `mallas_app/`. Si la UI falta, el sistema mostrará una página de respaldo simple.

## Modo borrador y persistencia

- El estado (posiciones de cursos, términos personalizados, advertencias ignoradas) se guarda en `malla_draft.json` en la raíz.
- Los botones de guardar/restablecer borrador se habilitan al activar el modo borrador.
- El botón inferior de “crear curso” está presente, pero aún no implementa la acción.

## API local (para referencias)

- `GET /api/config`: Configuración general (versión, límites de créditos, temas).
- `GET /api/all`: Términos, cursos y datos de depuración.
- `GET /api/draft` / `POST /api/draft`: Leer/guardar estado de borrador.

## Contribuciones

1. Mantén el formato de carpetas `AAAA-S` y los archivos `.md` con _frontmatter_ válido.
2. Asegúrate de que `mallas_app/` se incluya junto al ejecutable para la experiencia completa.
3. Prueba el modo borrador para verificar advertencias y color _coding_ antes de empaquetar.
