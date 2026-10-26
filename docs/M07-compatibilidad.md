# M07 - Compatibilidad y contrato de versiones (Francesco)

Objetivo: definir el contrato para migrar los eventos v1 a v2 sin romper a los consumidores que ya existen, y dejar probado que esos consumidores leen lo mismo antes, durante y despues de la migracion. El script de migracion por lotes y su rollback los hace Jonathan sobre este contrato.

## Punto de partida (M06)

| | v1 (M05) | v2 (M06) |
| --- | --- | --- |
| `schema_version` | ausente | `2` |
| `firmware_version` | prohibido | obligatorio, `X.Y.Z` |

En M06 los dos formatos solo convivian: ningun v1 se reescribia. En M07 si se migran, y el problema es que de un v1 **no sabemos el firmware**.

## Como se representa el firmware desconocido

No se inventa una version (ni `"0.0.0"` ni la del firmware actual del dispositivo). Un v1 migrado queda asi:

```json
{ "...campos M05...": "",
  "schema_version": 2,
  "firmware_version": null,
  "firmware_status": "unknown",
  "migrated_from": 1 }
```

- `firmware_version: null`: el dato no existe. Es el mismo valor que la vista de M06 ya devolvia para un v1, asi que para los lectores de M06 no es un valor nuevo.
- `firmware_status: "unknown"`: dice explicitamente por que es null, para que nadie lo confunda con un error de carga.
- `migrated_from: 1`: marca que el documento salio de un v1. Es lo que usa el rollback para saber que revertir sin tocar los v2 que ya venian con firmware.

Se decidio no crear una `schema_version: 3`. Un migrado tiene los mismos campos que un v2, solo que un valor es desconocido. Con una v3, cada consulta tendria que conocer una version mas.

## Contrato definitivo de `events` (para Jonathan)

Un documento es valido si cumple **exactamente uno** de estos tres casos, ademas de todo el contrato de M05 (campos requeridos, `additionalProperties: false` y reglas `$expr`):

| Caso | `schema_version` | `firmware_version` | `firmware_status` | `migrated_from` |
| --- | --- | --- | --- | --- |
| v1 (M05, pendiente de migrar) | ausente | ausente | ausente | ausente |
| v2 reportado (nativo) | `2` | `"X.Y.Z"` | ausente o `"reported"` | ausente |
| v2 desconocido (migrado) | `2` | `null` | `"unknown"` (obligatorio) | `1` (obligatorio) |

### Campos que cambian

| Campo | M06 | M07 |
| --- | --- | --- |
| `firmware_version` | string `X.Y.Z` | string `X.Y.Z` **o `null`** (solo en migrados) |
| `firmware_status` | no existia | nuevo: `"reported"` o `"unknown"` |
| `migrated_from` | no existia | nuevo: solo `1` |
| resto | contrato M05 | sin cambios |

`firmware_status` es opcional en un v2 reportado para que los v2 ya escritos en M06 (`events-m06.json`, el fixture de recuperacion) sigan siendo validos sin reescribirlos. Ausente se lee como `"reported"`.

### Reglas para la migracion y el rollback

- **Migrar un v1:** filtrar por `{ event_id, schema_version: { $exists: false } }` y hacer `$set` de los cuatro campos **en la misma escritura**. Si se pone solo una parte, el validador lo rechaza (codigo 121) y el documento queda igual. El filtro con `$exists: false` hace que repetir la migracion no cambie nada.
- **Rollback:** `updateMany({ migrated_from: 1, firmware_status: "unknown" }, { $unset: { schema_version, firmware_version, firmware_status, migrated_from } })`. Deja el documento exactamente en su forma v1 y no toca los v2 reportados.
- Una escritura nueva de la aplicacion **no puede** crear un desconocido sin `migrated_from: 1`. Los dispositivos nuevos tienen que reportar firmware.
- El CRUD (`createEvent`, `updateEvent`, `upsertEvent`) ya valida esto con `assertEventVersion` antes de llegar al servidor. `updateEvent` sobre un migrado conserva los cuatro campos.

## Que recibe cada consumidor

### Consumidor anterior (M05)

Recibe **exactamente la forma de M05**: los mismos 10 campos (`event_id`, `device_id`, `event_type`, `observed_at`, `ingested_at`, `metric_value`, `unit`, `severity`, `source`, `payload`), con los mismos tipos (`Date` en las fechas, `number` en `metric_value`, objeto en `payload`), el mismo orden por `observed_at` descendente y los mismos resultados.

- Se lee con `findEventsByDevice(db, { ..., shape: "legacy" })` o con `toLegacyEventView(doc)`. Esa vista quita los cuatro campos de version.
- Si encuentra una `schema_version` desconocida, falla en vez de ocultarla.

### Consumidor M06 (vista actual)

`findEventsByDevice` (por defecto `shape: "current"`) / `toEventView` devuelve los campos de M05 mas `schema_version`, `firmware_version` y, nuevo, `firmware_status`.

- `firmware_version` y `firmware_status` dan lo mismo antes y despues de migrar: `null` / `"unknown"` para un v1 o un migrado, y `"X.Y.Z"` / `"reported"` para un v2 nativo.
- **Unico cambio visible:** en un migrado, `schema_version` pasa de `1` a `2`. Por eso un consumidor M06 tiene que decidir si hay firmware mirando `firmware_version !== null` (o `firmware_status`), no `schema_version === 2`.

## Validadores

- `mongo/init.js`: el `$jsonSchema` de `events` admite los tres casos de la tabla con un `anyOf`. Se conservan todas las reglas de M05 y M06. `init.js` ya usa `collMod` si la coleccion existe, asi que el validador nuevo se aplica a un volumen existente con `make setup`, sin borrar datos.
- `src/event-versions.mjs`: `assertEventVersion` aplica las mismas reglas del lado de la aplicacion. Ademas: `firmwareStatus`, `toLegacyEventView`, `countEventsByFirmwareStatus` (avance de la migracion: `v1`, `unknown`, `reported`) y `countEventsBySchemaVersion`, que ahora acepta otra coleccion.
- Ninguna validacion anterior se quito: siguen rechazados `schema_version` 3, `"2"` y `1` explicito, un v2 sin firmware, el firmware mal formado, un v1 con firmware, los campos no declarados, etc. Las pruebas de M06 no se modificaron.

## Fixtures y pruebas (`tests/m07-compatibilidad.test.mjs`)

Fixtures sinteticos en `tests/fixtures/m07/`:

- `events-legacy.json`: 4 v1 (incluye `battery_pct` en 0 y una alerta critica con `payload`) y 2 v2 reportados (uno sin `firmware_status`, como los de M06, y otro con `"reported"`).
- `legacy-consumer-expected.json`: lo que tiene que calcular el consumidor anterior. Es la misma respuesta en todas las fases.

Las pruebas copian el validador real de `events` en una coleccion aislada (`m07_compat_fixture`) y la borran al final, igual que la recuperacion de M06: no tocan los eventos ni las alertas de la aplicacion. La migracion que usan es una referencia minima del contrato. La real es la de Jonathan.

- **normal:** el consumidor anterior obtiene exactamente `legacy-consumer-expected.json` **antes**, **durante** (2 de 4 migrados), **despues** y **tras el rollback**. El consumidor M06 obtiene el mismo `firmware_version` / `firmware_status` en todas las fases.
- **boundary:** una migracion parcial deja convivir v1, desconocidos y reportados con conteos correctos y sin cambiar el orden de Q1. Repetir la migracion no cambia ningun documento ni toca los v2 de M06. El CRUD actualiza un migrado sin perder la marca de desconocido.
- **declared failure:** el validador **y** `assertEventVersion` rechazan 10 estados invalidos (null sin estado o sin `migrated_from`, conocido marcado `unknown`, `migrated_from` 2, estado inventado, texto vacio, v1 con campos nuevos, etc.). La vista legada falla ante una version desconocida. Una migracion a medias o que inventa `"0.0.0"` sobre un migrado se rechaza y el documento queda igual.

Esto prueba lo que **lee** el consumidor, no solo que MongoDB acepte los formatos.

## Limites

- Un migrado se queda con el firmware desconocido para siempre. Si mas adelante se consigue el dato real, habria que pasarlo a reportado en una escritura explicita (quitar `migrated_from`, poner la version y `"reported"`). No hay ningun proceso que lo adivine.
- El validador no puede detectar una version inventada que tenga formato valido (por ejemplo, alguien que escribe `"1.0.0"` como v2 reportado sin conocerlo). Eso depende de que la migracion use siempre `null`. Solo se rechaza `"0.0.0"` u otro valor cuando viene junto con `migrated_from`.
- `firmware_status` ausente en un v2 se interpreta como `"reported"`. Es una regla implicita, aceptada para no reescribir los v2 de M06.
- Los consumidores M06 que deciden por `schema_version === 2` en vez de `firmware_version` veran migrados con firmware `null`. Esta documentado arriba y lo cubre la prueba del consumidor M06.
- Solo se versiona `events`. `alerts` sigue como en M05/M06.
- Las pruebas usan 6 eventos sinteticos. No se midio el tiempo ni el costo de migrar una base grande. Los lotes y el registro de avance son parte de la migracion de Jonathan.
- La integracion con `verify.mjs`, el workflow, los artifacts y la evidencia de la entrega M07 no forma parte de esta parte.
