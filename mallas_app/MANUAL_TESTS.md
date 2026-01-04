## Pruebas manuales

Escenario recomendado con el servidor corriendo (`python malla_app.py`) y la UI abierta.

1. **Crear curso temporal sin sigla -> autogenera `TMP-*`:**
   - Activar modo borrador.
   - Presionar `+` en un período y dejar la sigla vacía.
   - Ingresar un nombre y créditos positivos.
   - Confirmar que aparece en la columna con sigla `TMP-00X`.

2. **Persistencia en `malla_draft.json`:**
   - Tras crear el curso, presionar **Guardar borrador**.
   - Verificar en la raíz que `malla_draft.json` contiene el curso dentro de `temp_courses` y su `course_id` en `placements`.

3. **Reconstrucción después de recargar:**
   - Pulsar **Recargar** en la UI o refrescar el navegador.
   - Confirmar que el curso temporal reaparece en el mismo período sin duplicados.
