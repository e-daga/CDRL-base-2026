# M09 - Permisos MongoDB y pruebas de acceso (Francesco)

Objetivo: que cada responsabilidad use su propia cuenta MongoDB con privilegios minimos por coleccion y operacion, y demostrar con conexiones reales que MongoDB **rechaza** lo que no esta permitido sin cambiar datos.

## Cuentas

| Cuenta (default) | Variables de entorno | Rol MongoDB | Para que sirve |
| --- | --- | --- | --- |
| `cdrl_mongo` | `MONGO_USER`, `MONGO_PASSWORD` | `root` (admin) | **Solo** administracion: `mongo/init.js` y `seed.js` dentro del contenedor. La aplicacion nunca la usa. |
| `cdrl_app` | `MONGO_APP_USER`, `MONGO_APP_PASSWORD` | `readWrite` en `cdrl` | Mantenimiento: esquema, migraciones (M07), fixtures y limpieza de pruebas. Como `migrator` en PostgreSQL. No gestiona usuarios ni roles. |
| `cdrl_mongo_ingest` | `MONGO_INGEST_USER`, `MONGO_INGEST_PASSWORD` | `cdrl_events_ingest` | Ingesta de telemetria. |
| `cdrl_mongo_reader` | `MONGO_READER_USER`, `MONGO_READER_PASSWORD` | `cdrl_events_alerts_reader` | Consultas Q1/Q2 y paginacion (M08). |
| `cdrl_mongo_operator` | `MONGO_OPERATOR_USER`, `MONGO_OPERATOR_PASSWORD` | `cdrl_alert_operator` | Abrir y reconocer alertas con auditoria (M06). |
| `cdrl_mongo_auditor` | `MONGO_AUDITOR_USER`, `MONGO_AUDITOR_PASSWORD` | `cdrl_audit_reader` | Revisar la auditoria. |

Cada cuenta tiene un solo rol, definido solo sobre la base `cdrl` y sin herencia de otros roles. Ninguna puede crear usuarios, darse roles, listar usuarios ni borrar la base.

## Matriz de permisos

`OK` = permitido; `-` = MongoDB lo rechaza con `Unauthorized` (codigo 13).

| Cuenta | `events` | `alerts` | `alert_audit` |
| --- | --- | --- | --- |
| ingest | leer, insertar, actualizar | - | - |
| reader | leer | leer | - |
| operator | - | leer, insertar, actualizar | leer, insertar, actualizar (*) |
| auditor | - | - | leer |
| app (mantenimiento) | todo | todo | todo |

Ninguna cuenta de servicio puede **borrar** documentos ni colecciones. Ademas:

- `operator` conserva `listCollections` en `cdrl` para comprobar el validador antes de reconocer una alerta. La integracion retira `createIndex`: los indices se crean solo en setup y la prueba comprueba que el operador ya no puede crearlos.
- (*) `operator` necesita `update` en `alert_audit` para pasar el registro de `pending` a `completed`. MongoDB no limita privilegios por campo; ver limites.

La definicion esta en dos lugares que deben coincidir: `src/mongo-accounts.mjs` (la usan las pruebas y la aplicacion) y `mongo/init.js` (crea los roles). La prueba `[M09][boundary] cada cuenta tiene exactamente los privilegios declarados` compara lo que MongoDB reporta (`connectionStatus` con `showPrivileges`) contra `src/mongo-accounts.mjs`, asi que una diferencia falla.

## Secretos y configuracion

- `make setup` -> `scripts/mongo.mjs` genera un secreto aleatorio distinto por cuenta (32 bytes) en `.env`, que esta en `.gitignore`. Si la variable ya existe en el entorno (CI, Learner Lab), se usa esa y no se escribe. Los secretos no se imprimen.
- `.env.example` solo trae los nombres de usuario, con todas las contrasenas vacias.
- `docker-compose.yml` pasa las variables al contenedor y `mongo/init.js` crea o actualiza roles y usuarios. Es repetible: `updateRole` reemplaza los privilegios, asi que repetir `init` deja exactamente los declarados y no borra datos.
- Un `.env` anterior a M09 se completa solo: `make setup` agrega las 8 variables nuevas sin tocar las demas.
- Las consultas normales de `run.mjs` usan `withMongoAs("reader", trabajo)` y la demo M09 usa cada cuenta segun su responsabilidad. `withMongo` sigue reservado en los experimentos y pruebas a preparacion, migracion y limpieza; no es la cuenta que demuestra los permisos de servicio. Nunca se usa root para CRUD de servicio. La URI se arma solo en memoria.

## Pruebas (`tests/m09-permisos-mongo.test.mjs`)

Todas se conectan a MongoDB con la cuenta real. Un rechazo se da por bueno solo si el **servidor** responde `code: 13` y `codeName: "Unauthorized"`; no se simula en JavaScript. Despues de los intentos rechazados, la cuenta de mantenimiento lee `events`, `alerts` y `alert_audit` y compara con el estado anterior: **ningun intento cambio datos**. Dispositivo, source y actor incluyen un UUID por ejecucion: la limpieza no elimina fixtures de otros procesos.

- **normal:** `ingest` usa `createEvent`, `upsertEvent`, `updateEvent` y `readEvent`. `reader` usa Q1, `findEventsPage` y Q2. `operator` reconoce una alerta con `acknowledgeAlertWithAudit` y `auditor` lee el registro `completed`.
- **boundary:** privilegios exactos de cada cuenta segun MongoDB; repetir `init.js` dos veces conserva conteos, roles y privilegios; los secretos vienen del entorno (`.env` sin versionar, `.env.example` sin contrasenas, un usuario y un secreto distintos por cuenta, la URI de la aplicacion no usa la cuenta root, ningun secreto escrito en `src/`, `scripts/` ni `tests/`).
- **remediation:** `tests/m09-permisos-mongo.test.mjs` crea una cuenta, un rol y una coleccion temporales aislados. Primero demuestra que la cuenta puede borrar un documento por un permiso excesivo; luego retira solo `remove` y comprueba que MongoDB lo rechaza (codigo 13), mientras `find` e `insert` siguen funcionando. La prueba limpia la cuenta, el rol y la coleccion incluso si falla. No cambia ni amplía los privilegios de `cdrl_app` ni de las cuentas reales de servicio.
- **declared failure:**
  - Lecturas rechazadas: `ingest` en alertas y auditoria, `reader` en auditoria, `operator` en eventos, `auditor` en eventos y alertas.
  - Escrituras rechazadas sin cambios: `reader` inserta, actualiza o borra; `ingest` borra eventos o inserta alertas; `operator` escribe eventos o borra alertas; `auditor` escribe.
  - Auditoria: `ingest`, `reader` y `auditor` no pueden actualizar, borrar, vaciar, eliminar ni falsificar un registro. `operator` no puede borrarlo, vaciar la coleccion ni eliminarla. El registro queda identico.
  - Administracion: ninguna cuenta (ni `cdrl_app`) puede crear usuarios, darse `readWrite`, listar usuarios ni borrar la base. Una contrasena equivocada no autentica (codigo 18).

La auditoria de M06 escribe en `alert_audit` con los privilegios `operator`
ya declarados; `src/mongo-accounts.mjs` y la matriz de permisos no se amplian
para esta entrega. La auditoria desde la aplicación cubre solo las operaciones
que pasan por el flujo instrumentado, no cualquier acceso directo a MongoDB.

## Para Jonathan: como conectarse

```js
import { withMongoAs, mongoAccount, MONGO_ACCOUNTS } from "../src/mongo-accounts.mjs";

// Lectura de eventos y alertas (por ejemplo, el benchmark de M08):
await withMongoAs("reader", (db) => findEventsPage(db, { deviceId, limit: 50 }));

// Reconocer una alerta con auditoria:
await withMongoAs("operator", (db) => acknowledgeAlertWithAudit(alertId, { db, operationId, actor: "synthetic:..." }));
```

- Cuentas: `ingest`, `reader`, `operator` y `auditor` (tabla de arriba). Usuario y contrasena salen de `MONGO_<CUENTA>_USER` / `MONGO_<CUENTA>_PASSWORD`; `mongoAccount("reader")` devuelve `{ user, password }`.
- Si falta el secreto, el error dice exactamente que variable falta. Se arregla con `make setup`.
- Para preparar o limpiar fixtures usa `withMongo` (cuenta de mantenimiento), no una cuenta de servicio: por diseno, las de servicio no pueden borrar.
- Un rechazo de permisos llega como `MongoServerError` con `code === 13` (`MONGO_UNAUTHORIZED`).
- Con un `.env` de antes de M09, corre `make setup` una vez para generar las cuentas.

## Limites

- **`operator` puede actualizar `alert_audit`.** El flujo de M06 cierra la auditoria con un `update` (`pending` -> `completed`), y MongoDB no permite restringir privilegios por campo. El validador limita la forma del documento, pero no impide que `operator` cambie, por ejemplo, el `actor` de un registro. Para evitarlo habria que cambiar la auditoria a solo insercion (un registro por estado) o pasarla por una funcion del servidor. Queda como correccion pendiente.
- `cdrl_app` (mantenimiento) sigue con `readWrite` en toda la base, incluida auditoria, para migraciones y fixtures. No es administradora, pero puede borrar registros. En un despliegue real sus secretos deben quedar fuera del proceso de servicio. La entrega es un entorno de laboratorio que tambien ejecuta mantenimiento.
- `operator` solo conserva `listCollections` para revisar el validador; `createIndex` se retiro y esta prohibicion se prueba.
- No hay TLS en el entorno local de Docker. Para un despliegue externo hace falta TLS, como ya se documento para PostgreSQL en M03.
- No se probo AWS ni rotacion de secretos de MongoDB. Para rotar uno: cambiar la variable y repetir `make setup` (`init.js` hace `updateUser` con el secreto nuevo).
- La integracion final de verify, run, workflow y entrega se documenta en ADR-009.
