# M06 - Auditoría de operaciones sobre alertas

## Alcance

`acknowledgeAlertWithAudit(alert_id, { db, operationId, actor })` instrumenta
una transición de `alerts.status: open` a `acknowledged`. Registra los
reconocimientos exitosos y las denegaciones por alerta inexistente o estado
incompatible. El actor debe ser sintético, por ejemplo
`synthetic:operator-01`; `operationId` es un UUID estable para reintentos.

La auditoría se genera desde esta aplicación y sólo cubre este flujo
instrumentado. **No captura automáticamente** consultas ni escrituras hechas
por acceso directo a MongoDB, por otros clientes o por rutas que no invoquen
esta función. No se guardan contraseñas, tokens, cadenas de conexión,
documentos completos ni errores crudos.

## Documento auditado

La colección `alert_audit` aplica un validador estricto y sólo admite estos
campos:

| Campo | Contenido |
| --- | --- |
| `operation_id` | UUID idempotente de la operación |
| `actor` | Identificador sintético `synthetic:<identificador>` |
| `action` | `alert.acknowledged` |
| `resource` | Tipo `alert` e identificador UUID del recurso |
| `result` | `success` o `denied` |
| `result_code` | `alert_acknowledged`, `alert_not_found` o `alert_state_conflict` |
| `current_status` | Estado observado, sólo en una denegación por conflicto |
| `occurred_at` | Fecha BSON de la operación |
| `changes` | Sólo para éxito: estado `open` → `acknowledged` y su fecha |
| `audit_status` | `pending` o `completed`, estado de persistencia/reconciliación |

`alert_id` se conserva junto a `resource` para compatibilidad con los registros
M06 existentes. El validador también permite leer esos registros anteriores;
los registros nuevos tienen `resource`, `result` y `result_code`. El índice
único `uq_alert_audit_operation_id` evita duplicados por reintento.

## Persistencia y errores

MongoDB standalone no hace atómicas escrituras en `alerts` y `alert_audit`;
no se usan transacciones ni se afirma atomicidad entre colecciones. Para un
éxito, el flujo inserta una intención `pending`, aplica el cambio condicional y
marca el registro `completed`. Una denegación se inserta como `completed` y
no cambia la alerta.

- Si falla la inserción de auditoría, la función lanza `AuditWriteError`
  (`code: AUDIT_WRITE_FAILED`) y no devuelve un resultado de éxito o denegación
  auditada. El mensaje no incluye el error crudo.
- Si la alerta cambió, pero no se pudo completar la auditoría, se lanza
  `AuditPendingError` (`code: AUDIT_PENDING`). No se informa un éxito completo;
  se debe reintentar con el mismo `operationId`.
- Si el estado cambió concurrentemente y el reconocimiento no se aplicó, se
  confirma primero la denegación en auditoría. Si no se puede guardar esa
  denegación, la función lanza `AuditPendingError` en vez de devolver `conflict`.
- Repetir una operación completada devuelve su resultado previo sin duplicar
  el registro. Un `operationId` asociado a otra alerta o actor se rechaza.

`mongo/init.js` actualiza el validador para admitir el formato nuevo y los
registros M06 anteriores. La cuenta y privilegios de aplicación de M09 no se
amplían.

## Pruebas

`tests/m06-auditoria.test.mjs` y `tests/m06-audit-safety.test.mjs` cubren:

- campos permitidos, actor sintético, fecha, recurso, resultado y ausencia de
  datos sensibles;
- registro de éxito y denegaciones por recurso inexistente o conflicto;
- reintentos idempotentes, unicidad y validación estricta;
- fallo simulado de escritura: no se devuelve un resultado auditado si no se
  guardó el documento;
- fallo al cerrar una intención: queda `pending`, se informa el error y se
  reconcilia al reintentar.
