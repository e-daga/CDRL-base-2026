# M06 - Evolucion de documentos y consultas (Francesco)

Objetivo: que el documento de `events` pueda cambiar sin romper los documentos que ya estan guardados desde M05.

## Version nueva del evento

| | v1 (M05) | v2 (M06) |
| --- | --- | --- |
| `schema_version` | **ausente** | `2` (numero) |
| `firmware_version` | **prohibido** | **obligatorio**, texto `X.Y.Z` (`^[0-9]+\.[0-9]+\.[0-9]+$`) |
| Resto de campos | contrato M05 | igual que v1, mismas reglas |

Para que sirve `firmware_version`: guarda la version del firmware del sensor que produjo la lectura. Con eso se puede saber si una anomalia (por ejemplo, la temperatura critica de `dev_sensor_04` en los fixtures) empezo despues de una actualizacion de firmware, o comparar lecturas de dispositivos con firmware distinto. En v1 no se puede saber.

## Estrategia: coexistencia sin migracion

- Los documentos que ya existen **no se reescriben**. Un documento sin `schema_version` es v1.
- Los documentos nuevos que traen firmware se escriben como v2.
- No existe `schema_version: 1` explicito. Si se aceptara, v1 tendria dos formas distintas de escribirse y habria que tratar las dos en cada consulta. Por eso v1 se reconoce solo por la ausencia del campo.
- Cualquier otro valor (`3`, `"2"`, `1`, etc.) se rechaza.

## Validador (`mongo/init.js`)

Al `$jsonSchema` de `events` se le agregan `schema_version` (`enum: [2]`) y `firmware_version` (string con patron), y la regla que los une:

    anyOf: [
      { not: { anyOf: [{ required: ["schema_version"] }, { required: ["firmware_version"] }] } },  // v1: ninguno de los dos
      { required: ["schema_version", "firmware_version"] }                                        // v2: los dos
    ]

Se mantienen `additionalProperties: false`, los campos requeridos y las reglas `$expr` de M05, asi que un v2 incompleto o con campos extra tambien falla (codigo 121).

**Base nueva y volumen existente:** `init.js` ya usaba `collMod` cuando la coleccion existe, entonces el validador nuevo se aplica igual en los dos casos. `collMod` no revalida lo guardado, y de todas formas los documentos de M05 cumplen la regla v1. Lo probe en los dos escenarios:
1. Volumen con el estado de M05 (init y seed de `main`, 6 eventos), despues `node scripts/setup.mjs` con M06: no perdio datos, los 6 eventos siguen como v1 y la suite completa paso.
2. Volumen nuevo (`docker compose down -v`, despues `setup` + `verify`): 118 pruebas, M03/M04/M05 PASSED.

## Consultas (`src/event-versions.mjs`, `src/mongo.mjs`)

- `toEventView(doc)` devuelve un objeto **nuevo** con `schema_version` (1 o 2) y `firmware_version` (`null` en v1). No escribe en MongoDB ni modifica el objeto recibido.
- `findEventsByDevice` (Q1) devuelve los resultados a traves de `toEventView`, asi que v1 y v2 salen con la misma forma. El filtro y el indice `idx_events_device_observed` no cambian.
- `countEventsBySchemaVersion(db, filtro)` cuenta los eventos por version (`{ v1, v2 }`) y trata como v1 a los que no tienen el campo.
- `eventSchemaVersion` y `assertEventVersion` aplican del lado de la aplicacion las mismas reglas que el validador.

## Fixtures

`mongo/fixtures/events-m06.json` (nuevo, los fixtures de M05 no se tocan) tiene 2 eventos v1 y 3 v2 en `dev_sensor_04` y `dev_sensor_05`, con fechas de octubre de 2026. Los puse fuera del rango y de los dispositivos de Q1 de M05 para no cambiar los resultados que esperan esas pruebas. `seed.js` los carga con el mismo upsert por `event_id`, asi que repetir el seed no duplica nada.

## Pruebas (`tests/m06-evolucion-documental.test.mjs`, 15 casos)

- **normal:** Q1 lee v1 y v2 de `dev_sensor_04` con la misma forma; el validador acepta un v1 nuevo y un v2 nuevo.
- **boundary:** los eventos de M05 se leen como v1 y siguen guardados sin `schema_version`; la vista no muta el original; correr `init` dos veces y `seed` sobre el volumen existente conserva los conteos y las reglas.
- **declared failure:** se rechaza `schema_version` 3, `"2"` o `1`; v2 sin firmware o con firmware mal formado; v1 con firmware; v2 sin `device_id`; v2 con un campo no declarado; un `updateOne` que intenta cambiar de version a un v1 sin completar los campos (el documento queda igual).

## Para Jonathan (CRUD)

Campos y reglas que tiene que respetar el CRUD:

- v1: igual que M05, **sin** `schema_version` ni `firmware_version`.
- v2: `schema_version: 2` (numero) + `firmware_version: "X.Y.Z"`, mas todos los campos de M05.
- Antes de insertar o actualizar se puede llamar a `assertEventVersion(doc)` (exportado en `src/event-versions.mjs`) para fallar con un mensaje claro antes de llegar al servidor. Hoy `normalizeEventDocument` no revisa versiones y el rechazo llega del validador (codigo 121).
- `readEvent` devuelve el documento tal como esta guardado. Si se le pasa `toEventView`, `updateEvent` volveria a escribir un `schema_version: 1`, y el validador lo rechazaria. Por eso la vista se aplica solo en las consultas de lectura.
- Para pasar un evento de v1 a v2 hay que poner los dos campos en la misma escritura.

## Limitaciones

- No hay migracion de los v1: quedan para siempre sin firmware (`null` en la vista). Si en algun momento se quiere completar ese dato, haria falta una migracion explicita y registrada, no una conversion silenciosa al leer.
- Solo se versiona `events`; `alerts` sigue igual que en M05.
- Si mas adelante aparece una v3, cada consulta tiene que conocerla. `toEventView` falla con un error si encuentra una version desconocida en vez de inventarle una forma.
- El validador acepta `2` como int, long o double (`2.0`), porque MongoDB los compara como iguales en `enum`; `2.5` se rechaza. Lo comprobe a mano con mongosh.
- `countEventsBySchemaVersion` usa `$ifNull` en una agregacion, sin indice propio. Con datos chicos alcanza, pero no se midio a escala.
- La integracion con `verify.mjs`, el workflow y la evidencia de la entrega M06 no forma parte de esta parte.
