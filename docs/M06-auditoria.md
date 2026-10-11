# M06 - Auditoría de operaciones sobre alertas

## Alcance

`acknowledgeAlertWithAudit(alert_id, { db, operationId, actor })` ejecuta una
transición concreta de `alerts.status: open` a `acknowledged`. `operationId`
es un UUID estable que el llamador conserva en cada reintento; `actor` debe
ser un identificador sintético como `synthetic:operator-01`. Una alerta que
no existe devuelve `status: "not_found"`; una alerta cuyo estado ya no es
`open` devuelve `status: "conflict"`.

No se modificó `mongo/init.js`: la colección `alert_audit` se crea desde la
operación con validador estricto y se le crean sus índices. Así este cambio no
requiere alterar el init compartido. El usuario de aplicación debe conservar
el permiso `readWrite` en `cdrl`, que permite crear la colección e índices.

## Documento auditado

La colección sólo acepta los campos autorizados:

| Campo | Contenido |
| --- | --- |
| `operation_id` | UUID idempotente de la operación |
| `alert_id` | Identificador de la alerta afectada |
| `action` | `alert.acknowledged` |
| `occurred_at` | Fecha BSON usada para el cambio |
| `actor` | Identificador sintético `synthetic:<identificador>` |
| `changes.status` | Transición `open` → `acknowledged` |
| `changes.acknowledged_at` | Fecha escrita en la alerta |
| `audit_status` | `pending` o `completed` |

El validador rechaza propiedades adicionales, incluidos documentos fuente,
payloads, variables de entorno, credenciales y cadenas de conexión. El índice
único `uq_alert_audit_operation_id` impide duplicar registros por reintentos.
`idx_alert_audit_alert_occurred` facilita consultar el historial de una
alerta por fecha.

## Orden de escrituras y fallos

MongoDB standalone no hace atómicas escrituras en `alerts` y `alert_audit`;
no se usan transacciones ni se afirma atomicidad entre colecciones. El flujo
guarda primero una intención `pending` en `alert_audit`, actualiza la alerta
con filtro condicional `status: "open"` y finalmente cambia la intención a
`completed`.

- Si no se puede crear o insertar la intención, la alerta no se actualiza.
- Si el cambio en la alerta se guarda, pero falla o queda sin confirmar la
  confirmación de auditoría, la función lanza `AuditPendingError`
  (`code: "AUDIT_PENDING"`) con el mismo `operationId`. No es un éxito
  completo. La escritura final puede haber quedado aplicada pese a perderse
  su respuesta; por eso el reintento consulta el estado real antes de decidir.
- Reintentar con el mismo `operationId`, `alert_id` y actor reutiliza la fecha
  y la intención guardadas. Si la alerta ya tiene ese estado y fecha, se
  completa la auditoría sin volver a cambiarla. Si el estado no concuerda, la
  función falla explícitamente y no atribuye el cambio a esa operación.
- Un `operationId` ya usado con otro `alert_id` o actor es un conflicto y no
  puede reutilizarse. El registro pendiente requiere intervención si un error
  persistente o una operación concurrente impide reconciliarlo.
- Tras completarse ambas escrituras, repetir la llamada devuelve
  `status: "completed", replayed: true`; no crea otro registro.

El identificador de operación debe persistirse del lado del llamador hasta
obtener el resultado final. Un error de red puede dejar incierto si MongoDB
aplicó la última escritura; por eso se consulta y reconcilia al reintentar en
vez de declarar éxito con base únicamente en una respuesta perdida.

## Pruebas

`tests/m06-auditoria.test.mjs` ejecuta integración contra MongoDB real:

- transición normal, campos permitidos, validador e índices;
- reintento idempotente y unicidad del registro;
- alerta inexistente sin cambio ni auditoría;
- fallo controlado al finalizar auditoría: verifica alerta actualizada,
  auditoría `pending`, error explícito y resolución al reintentar.
