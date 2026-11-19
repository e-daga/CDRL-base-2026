# Reporte de operaciones CRUD y relación conceptual con HTTP

## Portada

- Alumno: [Nombre completo del alumno]
- Curso/Asignatura: [Nombre del curso]
- Fecha: 12 de noviembre de 2026
- Repositorio analizado: CDRL-base-2026

## 1. Introducción

El presente informe analiza las operaciones de acceso a datos implementadas en el repositorio real. El proyecto no expone endpoints HTTP ni servicios REST; por lo tanto, no existen respuestas HTTP reales dentro de la aplicación. Sin embargo, es posible relacionar cada operación CRUD con el método HTTP que correspondería si el sistema se expusiera como API REST, siempre como una relación conceptual y no como una implementación actual.

El objetivo es identificar:
- las funciones que crean, leen, actualizan y eliminan registros;
- los métodos de MongoDB utilizados (`insertOne`, `findOne`, `find`, `replaceOne`, `deleteOne`, entre otros);
- cómo se manejan validaciones y errores;
- qué devolverían las funciones en casos exitosos y fallidos;
- qué código HTTP sería coherente en una API REST futura.

## 2. Tabla de operaciones identificadas y ubicación en el código

| Operación | Función | Archivo | Método MongoDB | Propósito | Resultado exitoso |
|---|---|---|---|---|---|
| Crear evento | `createEvent` | `./src/mongo.mjs` | `insertOne` | Inserta un documento en `events` | Objeto con `acknowledged`, `insertedId`, `event_id`, `created: true` |
| Leer evento | `readEvent` | `./src/mongo.mjs` | `findOne` | Consulta un evento por `event_id` | Documento completo o `null` |
| Actualizar evento | `updateEvent` | `./src/mongo.mjs` | `readEvent` + `replaceOne` | Reemplaza el documento completo con cambios validados | Objeto con `matchedCount`, `modifiedCount`, `acknowledged` |
| Eliminar evento | `deleteEvent` | `./src/mongo.mjs` | `deleteOne` | Borra un evento por `event_id` | Objeto con `deletedCount`, `acknowledged` |
| Crear alerta | `createAlert` | `./src/mongo.mjs` | `insertOne` | Inserta un documento en `alerts` | Objeto con `acknowledged`, `insertedId`, `alert_id`, `created: true` |
| Leer alerta | `readAlert` | `./src/mongo.mjs` | `findOne` | Consulta una alerta por `alert_id` | Documento completo o `null` |
| Actualizar alerta | `updateAlert` | `./src/mongo.mjs` | `readAlert` + `replaceOne` | Reemplaza alerta con validación | Objeto con `matchedCount`, `modifiedCount`, `acknowledged` |
| Eliminar alerta | `deleteAlert` | `./src/mongo.mjs` | `deleteOne` | Borra una alerta por `alert_id` | Objeto con `deletedCount`, `acknowledged` |
| Consultar eventos por dispositivo | `findEventsByDevice` | `./src/mongo.mjs` | `find` + `sort` + `limit` + `toArray` | Consulta varios eventos filtrados por `device_id` y rango temporal | Arreglo de documentos mapeados |
| Consultar alertas abiertas | `findOpenAlerts` | `./src/mongo.mjs` | `find` + `sort` + `limit` + `toArray` | Consulta alertas abiertas con filtros específicos | Arreglo de alertas |

## 3. Análisis de las funciones y métodos de acceso a datos

### 3.1 `createEvent` (crear evento)

Ubicación: `./src/mongo.mjs`

```js
export async function createEvent(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para crear el evento.");
  const event = normalizeEventDocument(doc);
  const result = await db.collection("events").insertOne(event);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, event_id: event.event_id, created: true };
}
```

- Método usado: `insertOne()` sobre la colección `events`.
- Propósito: guardar un evento validado con estructura y campos correctos.
- Validación: la función `normalizeEventDocument()` valida tipo de documento, UUID, `device_id`, fechas, `metric_value`, `severity` y `payload` antes de insertarlo.
- Resultado exitoso: un objeto con `acknowledged: true`, `insertedId` y `event_id`, además de `created: true`.

### 3.2 `readEvent` (leer evento)

```js
export async function readEvent(eventId, options = {}) {
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para leer el evento.");
  return db.collection("events").findOne({ event_id: eventId });
}
```

- Método usado: `findOne()`.
- Propósito: buscar un documento exacto por `event_id`.
- Comportamiento: si existe, devuelve el documento completo; si no existe, devuelve `null`.
- Esto es equivalente, conceptualmente, a un `GET` sobre un recurso identificado.

### 3.3 `updateEvent` (actualizar evento)

```js
export async function updateEvent(eventId, changes, options = {}) {
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para actualizar el evento.");
  const current = await readEvent(eventId, { db });
  if (!current) {
    return { matchedCount: 0, modifiedCount: 0, acknowledged: true, event_id: eventId };
  }
  const updateDoc = { ...changes };
  if (updateDoc.event_id && updateDoc.event_id !== eventId) {
    throw new Error("No se puede mover un evento a otro event_id.");
  }
  delete updateDoc._id;
  const normalized = normalizeEventDocument({ ...current, ...updateDoc });
  const result = await db.collection("events").replaceOne({ event_id: eventId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, event_id: eventId };
}
```

- Métodos usados: `readEvent()` y `replaceOne()`.
- Propósito: recuperar un evento existente, combinarlo con cambios, validarlo y reemplazar el documento completo.
- Manejo de inexistentes: si el evento no existe, retorna `{ matchedCount: 0, modifiedCount: 0, ... }`.
- Validación: rechaza cambios inválidos usando `normalizeEventDocument()` y validaciones de campos.

### 3.4 `deleteEvent` (eliminar evento)

```js
export async function deleteEvent(eventId, options = {}) {
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para borrar el evento.");
  const result = await db.collection("events").deleteOne({ event_id: eventId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}
```

- Método usado: `deleteOne()`.
- Propósito: eliminar solo el documento que coincide con `event_id`.
- Si no existe, devuelve `deletedCount: 0`.

### 3.5 `createAlert`, `readAlert`, `updateAlert`, `deleteAlert`

Estos siguen la misma lógica que los eventos, pero para la colección `alerts`.

```js
export async function createAlert(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para crear la alerta.");
  const alert = normalizeAlertDocument(doc);
  const result = await db.collection("alerts").insertOne(alert);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, alert_id: alert.alert_id, created: true };
}
```

```js
export async function readAlert(alertId, options = {}) {
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para leer la alerta.");
  return db.collection("alerts").findOne({ alert_id: alertId });
}
```

```js
export async function updateAlert(alertId, changes, options = {}) {
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para actualizar la alerta.");
  const updateDoc = { ...changes };
  if (updateDoc.alert_id && updateDoc.alert_id !== alertId) {
    throw new Error("No se puede mover una alerta a otro alert_id.");
  }
  delete updateDoc._id;
  const current = await readAlert(alertId, { db });
  if (!current) return { matchedCount: 0, modifiedCount: 0, acknowledged: true, alert_id: alertId };
  const normalized = normalizeAlertDocument({ ...current, ...updateDoc });
  const result = await db.collection("alerts").replaceOne({ alert_id: alertId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, alert_id: alertId };
}
```

```js
export async function deleteAlert(alertId, options = {}) {
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para borrar la alerta.");
  const result = await db.collection("alerts").deleteOne({ alert_id: alertId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}
```

### 3.6 Consultas de lectura múltiples (`findEventsByDevice`)

```js
export async function findEventsByDevice(db, { deviceId, from, to, limit = 50, shape = "current", collection = "events" } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para consultar eventos.");
  validateLimit(limit);
  if (!Object.hasOwn(EVENT_VIEWS, shape)) throw new Error(`shape invalido (${Object.keys(EVENT_VIEWS).join(", ")}).`);
  const filter = eventRangeFilter({ deviceId, from, to });
  const rows = await db.collection(collection).find(filter).sort({ observed_at: -1 }).limit(limit).toArray();
  return rows.map(EVENT_VIEWS[shape]);
}
```

- Métodos usados: `find()`, `sort()`, `limit()`, `toArray()`.
- Propósito: recuperar varios eventos de un dispositivo dentro de un rango de fechas.
- Validaciones: `deviceId`, `limit` y rango temporal.
- Si `from > to` o datos inválidos, se lanza un error.

## 4. Tratamiento de validaciones, errores y registros inexistentes

### 4.1 Validaciones del esquema

La validación se realiza principalmente en `normalizeEventDocument()` y `normalizeAlertDocument()`, en `./src/mongo.mjs`.

Ejemplo de validación de evento:

```js
function assertValidEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Evento inválido: debe ser un objeto.");
  if (!event.event_id || !UUID_RE.test(String(event.event_id))) {
    throw new Error("Evento inválido: event_id debe ser UUID válido.");
  }
  if (!event.device_id || !DEVICE_RE.test(String(event.device_id))) {
    throw new Error("Evento inválido: device_id no cumple el patrón dev_...");
  }
  if (!EVENT_TYPES.includes(event.event_type)) {
    throw new Error(`Evento inválido: event_type no permitido (${EVENT_TYPES.join(", ")}).`);
  }
  if (!(event.observed_at instanceof Date) || !Number.isFinite(event.observed_at.getTime())) {
    throw new Error("Evento inválido: observed_at debe ser un Date.");
  }
  if (typeof event.metric_value !== "number" || !Number.isFinite(event.metric_value)) {
    throw new Error("Evento inválido: metric_value debe ser un número.");
  }
}
```

Esto significa que la aplicación no acepta registros mal formados ni datos inconsistentes antes de persistirlos.

### 4.2 Manejo de registros inexistentes

En `readEvent` y `readAlert`, si la búsqueda no encuentra ninguna coincidencia, el valor devuelto es `null`.

En `updateEvent` y `updateAlert`:

```js
if (!current) {
  return { matchedCount: 0, modifiedCount: 0, acknowledged: true, event_id: eventId };
}
```

Esto evita una excepción y devuelve un resultado explícito: el documento no existe, pero la operación se manejó sin romper el flujo.

En `deleteEvent` y `deleteAlert`:

```js
const result = await db.collection("events").deleteOne({ event_id: eventId });
return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
```

Si no existe, `deletedCount` será `0`.

### 4.3 Errores de tipo/método/UUID

Ejemplos:
- `Identificador invalido.`
- `deviceId invalido.`
- `Rango temporal invertido.`
- `cursor invalido` en paginación.
- `No se puede mover un evento a otro event_id.`

Todos estos errores se manejan con `throw new Error(...)` y no se convierten automáticamente a códigos HTTP, porque el proyecto no implementa HTTP.

## 5. Relación conceptual con métodos y códigos HTTP

La relación con HTTP es conceptual. El repositorio no expone endpoints reales, así que la siguiente tabla indica cómo podría mapearse si se implementara una API REST.

| Operación real | Método HTTP conceptual | Códigos HTTP propuestos | Justificación |
|---|---|---|---|
| Consultar un evento (`readEvent`) | `GET /events/:event_id` | `200` si existe; `404` si no existe; `400` si el UUID es inválido | `GET` es el método estándar para consultar un recurso existente. `404` expresa ausencia del recurso y `400` valida IDs mal formados. |
| Consultar varios eventos (`findEventsByDevice`) | `GET /devices/:deviceId/events` | `200` si la consulta devuelve resultados; `400` si el rango es inválido; `404` si el dispositivo no tiene registros | `GET` devuelve colecciones o listas. `400` por parámetros inválidos; `404` podría corresponder a recurso faltante. |
| Crear evento (`createEvent`) | `POST /events` | `201` si se crea; `400` si los datos son inválidos; `500` si falla la base de datos | `POST` representa la creación de un nuevo recurso. `201 Created` es el estándar para creación exitosa. |
| Actualizar evento (`updateEvent`) | `PUT /events/:event_id` o `PATCH /events/:event_id` | `200` si se actualiza; `404` si no existe; `400` si se envían datos inválidos; `500` si hay error del sistema | `PUT` reemplaza el recurso; `PATCH` actualiza parcialmente. Si el recurso no existe, `404` es más apropiado. |
| Eliminar evento (`deleteEvent`) | `DELETE /events/:event_id` | `204` si se elimina con éxito; `404` si no existe; `400` si el identificador es inválido; `500` si falla la BD | `204 No Content` es estándar para eliminación exitosa sin cuerpo. `404` representa ausencia del recurso. |
| Crear alerta (`createAlert`) | `POST /alerts` | `201` si se crea; `400` si es inválida; `500` si falla la base de datos | Mismo patrón que creación de eventos. |
| Leer alerta (`readAlert`) | `GET /alerts/:alert_id` | `200` si existe; `404` si no existe; `400` si el ID es inválido | Consulta de un recurso puntual. |
| Actualizar alerta (`updateAlert`) | `PATCH /alerts/:alert_id` | `200` si se actualiza; `404` si no existe; `400` si la actualización es inválida | El código HTTP depende de si la actualización sustituye o modifica parcialmente el recurso. |
| Eliminar alerta (`deleteAlert`) | `DELETE /alerts/:alert_id` | `204` si se elimina; `404` si no hay registro; `500` si falla el sistema | `DELETE` estándar para borrado. |

### Nota importante
Los códigos HTTP anteriores son solo propuestos para una API REST conceptual. En el proyecto real, los resultados que devuelve MongoDB son objetos JavaScript (`{ acknowledged: true, deletedCount: 0, matchedCount: 1, ... }`) y errores `throw new Error(...)`; no hay HTTP real ni respuestas de servidor.

## 6. Capturas del código fuente y resultados de ejecución

### Captura 1 — Funciones CRUD principales en `./src/mongo.mjs`

```js
export async function createEvent(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para crear el evento.");
  const event = normalizeEventDocument(doc);
  const result = await db.collection("events").insertOne(event);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, event_id: event.event_id, created: true };
}

export async function readEvent(eventId, options = {}) {
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) throw new Error("Identificador invalido.");
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para leer el evento.");
  return db.collection("events").findOne({ event_id: eventId });
}

export async function updateEvent(eventId, changes, options = {}) {
  const current = await readEvent(eventId, { db });
  if (!current) {
    return { matchedCount: 0, modifiedCount: 0, acknowledged: true, event_id: eventId };
  }
  const normalized = normalizeEventDocument({ ...current, ...updateDoc });
  const result = await db.collection("events").replaceOne({ event_id: eventId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, event_id: eventId };
}

export async function deleteEvent(eventId, options = {}) {
  const result = await db.collection("events").deleteOne({ event_id: eventId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}
```

Descripción: esta captura demuestra la implementación real de la lógica CRUD para eventos dentro del repositorio. Muestra los métodos de persistencia y validación antes de cada operación.

### Captura 2 — Funciones CRUD para alertas

```js
export async function createAlert(doc, options = {}) {
  const alert = normalizeAlertDocument(doc);
  const result = await db.collection("alerts").insertOne(alert);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, alert_id: alert.alert_id, created: true };
}

export async function readAlert(alertId, options = {}) {
  return db.collection("alerts").findOne({ alert_id: alertId });
}

export async function updateAlert(alertId, changes, options = {}) {
  const current = await readAlert(alertId, { db });
  if (!current) return { matchedCount: 0, modifiedCount: 0, acknowledged: true, alert_id: alertId };
  const result = await db.collection("alerts").replaceOne({ alert_id: alertId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, alert_id: alertId };
}

export async function deleteAlert(alertId, options = {}) {
  const result = await db.collection("alerts").deleteOne({ alert_id: alertId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}
```

Descripción: muestra la versión equivalente para alertas y confirma que el patrón CRUD se repite para ambos tipos de documentos.

### Captura 3 — Métodos de MongoDB utilizados

```js
const result = await db.collection("events").insertOne(event);
return db.collection("events").findOne({ event_id: eventId });
const result = await db.collection("events").replaceOne({ event_id: eventId }, normalized, { upsert: false });
const result = await db.collection("events").deleteOne({ event_id: eventId });

const rows = await db.collection(collection).find(filter).sort({ observed_at: -1 }).limit(limit).toArray();
```

Descripción: aquí se evidencian los métodos reales empleados por la base de datos: `insertOne`, `findOne`, `replaceOne`, `deleteOne`, `find`, `sort`, `limit`, `toArray`.

### Captura 4 — Prueba de funcionamiento CRUD exitoso

```js
test("CRUD normal de eventos", async () => {
  await withMongo(async (db) => {
    const event = eventFactory();

    const created = await createEvent(event, { db });
    assert.equal(created.created, true);
    assert.equal(created.event_id, event.event_id);

    const read = await readEvent(event.event_id, { db });
    assert.equal(read.event_id, event.event_id);

    const updated = await updateEvent(event.event_id, { metric_value: 24.2, payload: { source: "update" } }, { db });
    assert.equal(updated.matchedCount, 1);
    assert.equal(updated.modifiedCount, 1);

    const after = await readEvent(event.event_id, { db });
    assert.equal(after.metric_value, 24.2);

    const deleted = await deleteEvent(event.event_id, { db });
    assert.equal(deleted.deletedCount, 1);
    assert.equal(await readEvent(event.event_id, { db }), null);
  });
});
```

Descripción: esta prueba demuestra un flujo completo de creación, lectura, actualización y eliminación, con validación del resultado esperado.

### Captura 5 — Prueba de casos de error y documentos inexistentes

```js
test("lecturas, borrados y actualizaciones sobre documentos inexistentes devuelven resultados explícitos", async () => {
  await withMongo(async (db) => {
    const missingEvent = await readEvent("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingEvent, null);

    const missingUpdate = await updateEvent("00000000-0000-4000-8000-000000000090", { metric_value: 18 }, { db });
    assert.equal(missingUpdate.matchedCount, 0);

    const missingDelete = await deleteEvent("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingDelete.deletedCount, 0);
  });
});
```

Descripción: muestra un caso real donde no hay documento y cómo la función devuelve resultados explícitos, en lugar de romper el flujo con excepción.

### Captura 6 — Prueba de validación inválida

```js
test("actualizaciones inválidas son rechazadas por validación del esquema", async () => {
  await withMongo(async (db) => {
    const validEvent = eventFactory({ device_id: "dev_sensor_02", event_type: "signal_dbm", metric_value: -65, source: "invalid-update" });
    const created = await createEvent(validEvent, { db });
    assert.equal(created.created, true);

    await assert.rejects(() => updateEvent(validEvent.event_id, { metric_value: "no-es-numero" }, { db }), /metric_value|Evento inválido/);
  });
});
```

Descripción: presenta la validación del esquema y cómo la aplicación rechaza datos inválidos lanzando errores del tipo `Error`.

## 7. Conclusión

El repositorio analizado implementa operaciones CRUD reales sobre MongoDB, pero no expone servicios HTTP ni endpoints REST. Las funciones `createEvent`, `readEvent`, `updateEvent`, `deleteEvent` y sus análogas para alertas se encargan de interactuar directamente con la base de datos usando métodos del driver MongoDB como `insertOne`, `findOne`, `replaceOne` y `deleteOne`.

La diferencia crucial entre acceder directamente a una base de datos y utilizar una API REST es la capa de abstracción:
- Acceso directo a BD: el código invoca métodos del cliente de MongoDB y devuelve objetos JavaScript o errores en el backend local.
- API REST: el cliente hace peticiones HTTP (`GET`, `POST`, `PUT`, `DELETE`), y el servidor responde con códigos de estado HTTP como `200`, `201`, `204`, `400`, `404` y `500`.

En otras palabras, este repositorio realiza operaciones de persistencia y consulta, pero no expone dichas operaciones como HTTP. Por eso, la relación con métodos y códigos HTTP debe entenderse como una proyección conceptual del diseño, no como una implementación real del proyecto.

## 8. Referencias del código analizado

- `./src/mongo.mjs`
- `./tests/m05-crud-consultas.test.mjs`

Estos son los archivos reales sobre los que se fundamenta el análisis del presente reporte.
