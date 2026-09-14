# ADR-002 - Modelo relacional operativo del CDRL

## Estado

Aceptado para M02.

## Contexto

El CDRL necesita operar sobre el contrato de telemetria de M01: consultar eventos por dispositivo, conocer el estado actual de cada dispositivo y distinguir alertas abiertas. Las relaciones deben impedir estados imposibles y las consultas deben recibir parametros, no concatenar valores de usuario.

## Decision

Se agregan dos tablas relacionadas:

- `device_status` tiene una fila por dispositivo y usa `device_id` como clave primaria y foranea con borrado en cascada. `status` solo permite `online`, `offline` o `maintenance`; `battery_pct` queda entre 0 y 100; un dispositivo offline no puede tener un `last_seen_at` posterior a `updated_at`.
- `telemetry_alerts` relaciona como maximo una alerta con cada evento mediante una clave foranea y una restriccion `UNIQUE`. Sus estados son `open`, `acknowledged` y `resolved`; los estados no abiertos exigen reconocimiento y los resueltos exigen `resolved_at`, manteniendo el orden temporal.

Las consultas `findTelemetryByDevice` y `findOpenAlerts` usan placeholders PostgreSQL (`$1`, `$2`) y devuelven listas vacias para un dispositivo inexistente. La migracion y el seed son idempotentes; el runner registra checksum para detectar cambios silenciosos.

## Verificacion

La suite cubre un caso normal, un caso vacio, el limite de `limit`, el limite inferior de bateria y dos fallos declarados por constraint. `make setup`, `make verify` y `make run` son los comandos de entrega. El seed contiene solo datos sinteticos y no incluye secretos.

## Consecuencias

El modelo mantiene integridad referencial y hace visibles las invariantes operativas en PostgreSQL. La consulta parametrizada evita interpolacion SQL. La consistencia temporal requiere que los clientes envien timestamps validos y que las actualizaciones de una alerta respeten su ciclo de vida.
