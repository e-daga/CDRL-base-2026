# M07 - Migración de eventos v1 y rollback

## Alcance y contrato

El comando migra documentos `events` que no tienen `schema_version` al contrato
acordado en [M07-compatibilidad.md](./M07-compatibilidad.md): agrega
`schema_version: 2`, `firmware_version: null`, `firmware_status: "unknown"` y
`migrated_from: 1`. No crea documentos, no cambia `_id`, `event_id` ni los
campos preexistentes. Los documentos v2 nativos no se seleccionan.

El alcance es obligatorio y exacto: se admite uno o más de `source`,
`device_id` y `event_id`, cada uno con un valor de texto no vacío. No se acepta
un filtro vacío, operadores MongoDB ni seleccionar otra colección. El tamaño
de lote predeterminado es 100.

## Comandos

`inspect` es el modo de inspección/dry-run. Solo cuenta v1 pendientes, calcula
cuántos lotes serían necesarios y no crea el diario ni escribe documentos:

```powershell
npm run migrate:events:v1 -- inspect --source synthetic-seed --batch-size 100
```

Para ejecutar, especificar un UUID nuevo y conservarlo para cualquier
reanudación:

```powershell
npm run migrate:events:v1 -- migrate --source synthetic-seed --run-id 8e0f0a70-8e2f-4f66-9eb8-329b780d2de6 --batch-size 100
```

Si el proceso se interrumpe, repetir exactamente el comando con el mismo
`run-id`, alcance y colección. El procesamiento vuelve a consultar los v1
pendientes; las entradas aplicadas no se vuelven a escribir. No se necesita
guardar un cursor en el cliente.

Rollback por migración:

```powershell
npm run migrate:events:v1 -- rollback --run-id 8e0f0a70-8e2f-4f66-9eb8-329b780d2de6 --batch-size 100
```

El comando imprime un resumen JSON sin incluir documentos ni payloads. Los
conflictos devuelven código de salida `2`; los errores operativos se imprimen y
devuelven código distinto de cero.

## Diario, idempotencia y conflictos

La colección `event_migration_journal` registra el alcance como SHA-256 y, por
cada documento que la migración seleccionó, solamente `_id`, `event_id`,
identificador de corrida, estado y SHA-256 del estado anterior y del estado
migrado. Un reclamo por documento evita que dos corridas se atribuyan el mismo
cambio. No guarda copias, payloads, secretos ni documentos completos. El
estado `pending` se registra antes de escribir; así, una interrupción entre el
registro y la actualización se puede reconciliar al reanudar.

Cada actualización compara atómicamente el documento completo leído con su
estado esperado. Si cambió desde la lectura, la migración no lo sobrescribe y
registra un conflicto. Antes de revertir, se exige que el hash actual coincida
con el estado exacto que dejó esa corrida. Si hubo una modificación posterior
o concurrente, el documento queda intacto y se informa el conflicto. No hay
modo de forzar la reversión: el conflicto requiere revisión explícita.

El rollback quita solo los cuatro campos añadidos por la migración, y solo a
documentos registrados por ese `run-id`. Verifica el hash restaurado; no usa
`updateMany` amplio, no toca los v2 preexistentes y repetirlo no vuelve a
modificar documentos ya revertidos.

## Verificación

Las pruebas `tests/m07-migracion.test.mjs` usan eventos sintéticos en una
colección con el validador real de `events` y un diario de fixture separado.
Prueban inspección sin escrituras, alcance requerido, migración por lotes,
interrupción y reanudación con el mismo UUID, segunda ejecución sin cambios,
conservación de ids y de un v2 nativo, rollback, modificación posterior,
escritura concurrente detectada por la comparación atómica y dos corridas
simultáneas que no se revierten los cambios entre sí. Los datos de fixture son
descartados al finalizar; las pruebas no modifican los eventos ni las alertas
de la aplicación.

Para ejecutar las pruebas M07:

```powershell
node --test --test-concurrency=1 tests/m07-migracion.test.mjs tests/m07-compatibilidad.test.mjs
```

Última verificación local: 22 pruebas aprobadas, 0 fallidas. La corrida usó
fixtures sintéticos y colecciones temporales aisladas.
La inspección local `--source synthetic-seed --batch-size 100` fue de solo
lectura: reportó 6 v1 pendientes en 1 lote.

## Restricciones operativas

- La aplicación MongoDB necesita permisos `readWrite` en `cdrl`, incluido
  permiso para crear y actualizar `event_migration_journal`.
- Antes de migrar, ejecutar `inspect` con el mismo alcance exacto. Revisar el
  conteo, disponibilidad de espacio y política de respaldo del entorno.
- Mantener el `run-id`, el diario y la misma base durante toda la operación.
  No borrar el diario mientras haya migraciones que puedan reanudarse o
  revertirse.
- El tamaño de lote limita cuántos documentos se leen y procesan por ciclo;
  las escrituras siguen siendo atómicas por documento, no hay transacción global. Una
  interrupción puede dejar un conjunto parcial, que se reanuda con el mismo
  identificador.
- Toda modificación posterior de un documento migrado, incluso una
  actualización legítima de la aplicación, impide su rollback automático.
- El diario contiene identificadores y hashes para revertir, no una copia de
  seguridad recuperable. No reemplaza el respaldo operacional de la base.
- La evidencia de pruebas usa exclusivamente datos sintéticos. No se debe
  exportar el diario ni imprimir documentos de usuarios como respaldo o
  resultado del experimento.
