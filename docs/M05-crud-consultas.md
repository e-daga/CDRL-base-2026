# M05 - CRUD, consultas y pruebas MongoDB

## Alcance

La base documental dejada por Francesco ya define las colecciones `events` y `alerts`, con validadores JSON Schema y los índices necesarios para consultar por dispositivo, rango temporal y alertas abiertas. Este módulo implementa la capa de acceso y las pruebas de integración reales contra MongoDB.

## Operaciones CRUD

### `events`

- Crear un evento válido: `insertOne`/`createEvent` devuelve `created: true` y un `event_id` persistente.
- Leer un evento por `event_id`: devuelve el documento o `null` si no existe.
- Actualizar un evento existente: devuelve `matchedCount` y `modifiedCount` y persiste los cambios.
- Borrar un evento por `event_id`: devuelve `deletedCount`.
- Si el `event_id` ya existe con el mismo contenido, el resultado debe ser `action: "duplicate"` y no se crea un documento nuevo.
- Si el mismo `event_id` se reutiliza con datos distintos, el resultado debe ser explícito: `action: "conflict"` junto con `conflict: true` y ambos documentos de comparación.

### `alerts`

- Crear una alerta válida: devuelve `created: true` con `alert_id` persistente.
- Leer una alerta por `alert_id`: devuelve el documento o `null`.
- Actualizar una alerta: devuelve `matchedCount` y `modifiedCount`. Las transiciones de estado deben respetar validación del esquema.
- Borrar una alerta: devuelve `deletedCount`.

## Consultas de negocio

### Q1 - eventos por dispositivo, rango temporal y orden por `observed_at`

Consulta esperada:

```js
findEventsByDevice(db, {
  deviceId: "dev_sensor_01",
  from: new Date("2026-09-20T00:00:00.000Z"),
  to: new Date("2026-09-23T00:00:00.000Z"),
  limit: 10
});
```

Resultado esperado:

- Solo devuelve documentos del `device_id` indicado.
- Filtra por `observed_at` en el rango declarado.
- Ordena por `observed_at` descendente.
- Respeta el límite solicitado.
- `explain("executionStats")` debe reportar `IXSCAN` con `idx_events_device_observed`.

### Q2 - alertas abiertas con filtros opcionales

Consulta esperada:

```js
findOpenAlerts(db, {
  deviceId: "dev_sensor_01",
  severity: "critical",
  limit: 10
});
```

Resultado esperado:

- Solo documentos con `status: "open"`.
- Si `deviceId` se define, aplica filtro en `device_id`.
- Si `severity` se define, aplica filtro en `severity`.
- Ordena por `opened_at` descendente.
- `explain("executionStats")` debe usar `IXSCAN` con `idx_alerts_status_device_severity` o `idx_alerts_status_opened` según el filtro concreto.

## Idempotencia

La regla de negocio es:

1. Si llega el mismo evento con el mismo `event_id` y el mismo contenido, el sistema no crea otro registro.
2. Si llega el mismo `event_id` con contenido distinto, la operación devuelve una respuesta explícita (`action: "conflict"`) y no duplica la entidad.

Esto evita inconsistencias sin ocultar el problema.

## Resultados esperados por operación

| Operación | Resultado esperado |
| --- | --- |
| `createEvent` con evento válido | `created: true`, documento insertado |
| `readEvent` existente | Documento completo con `event_id` |
| `readEvent` inexistente | `null` |
| `updateEvent` existente | `matchedCount: 1`, `modifiedCount: 1` |
| `updateEvent` inexistente | `matchedCount: 0` |
| `deleteEvent` existente | `deletedCount: 1` |
| `deleteEvent` inexistente | `deletedCount: 0` |
| `upsertEvent` duplicado | `action: "duplicate"` |
| `upsertEvent` con mismo id y datos distintos | `action: "conflict"` |
| `createAlert` válida | `created: true` |
| `readAlert` inexistente | `null` |
| `updateAlert` inválida | error de validación o rechazo del esquema |

## Pruebas ejecutadas contra MongoDB real

La suite de integración corre contra Docker Compose con el perfil `mongo`, sin mocks ni base simulada. Entre los casos comprobados se encuentran:

- CRUD normal de eventos.
- CRUD normal de alertas.
- Duplicados por `event_id`.
- Reuso de un `event_id` con contenido distinto.
- Documentos inexistentes.
- Actualizaciones inválidas.
- `explain("executionStats")` para Q1 y Q2.

## Índices verificados con `executionStats`

Se comprueba el plan real de ejecución, no sólo que el índice exista:

- `events`: `idx_events_device_observed` para Q1.
- `alerts`: `idx_alerts_status_device_severity` para filtros por `status`, `device_id` y `severity`, y `idx_alerts_status_opened` para alertas abiertas recientes.

La prueba exige que la respuesta de `explain("executionStats")` incluya `IXSCAN` y el nombre del índice esperado.
