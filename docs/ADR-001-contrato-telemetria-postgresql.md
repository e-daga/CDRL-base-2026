# ADR-001 - Contrato de datos de telemetria en PostgreSQL

## Estado

Aceptado para M01.

## Contexto

El hito M01 pide un contrato de datos reproducible para telemetria. La entrega debe poder ejecutarse en un entorno cloud cuando AWS Academy Learner Lab este disponible, pero tambien debe funcionar de forma local con Docker Compose.

El contrato necesita cubrir datos de dispositivos y eventos de medicion. Tambien debe declarar reglas verificables para casos normales, casos limite y un fallo esperado.

## Decision

Usamos PostgreSQL como base relacional. El entorno local se levanta con Docker Compose y la aplicacion se ejecuta con Node.js para aplicar migraciones, cargar seed sintetico, correr pruebas y generar evidencia machine-readable.

El modelo se divide en dos tablas principales:

- `devices`: catalogo de dispositivos con identificador tecnico, referencia externa sintetica, modelo y version de firmware.
- `telemetry_events`: eventos de telemetria asociados a un dispositivo, con tipo de evento, fecha observada, valor numerico, unidad, severidad, fuente y payload JSON.

Las reglas principales del contrato estan en la migracion:

- `event_type` solo acepta `temperature_c`, `humidity_pct`, `battery_pct` y `signal_dbm`.
- `severity` solo acepta `info`, `warning` y `critical`.
- `payload` debe ser un objeto JSON.
- `observed_at` no puede estar mas de 5 minutos en el futuro.
- `battery_pct` y `humidity_pct` deben estar entre 0 y 100.

La migracion es idempotente y se registra en `schema_migrations` con checksum para detectar cambios sobre una migracion ya aplicada. El seed tambien es idempotente porque usa `ON CONFLICT`.

## Alternativas consideradas

- Guardar eventos como archivos JSON: se descarto porque no comprueba restricciones relacionales ni llaves foraneas.
- Usar una base no relacional local: se descarto para M01 porque el objetivo pide una base relacional compatible con cloud.
- Aplicar SQL manualmente: se descarto porque no deja un flujo reproducible para `make setup` y `make verify`.

## Consecuencias

El contrato queda comprobable por CI y por ejecucion local. Si se cambia una migracion ya aplicada, el checksum falla y obliga a crear una migracion nueva. Esto evita cambios silenciosos en el contrato.

La entrega no guarda credenciales reales. Los valores de `.env.example` son sinteticos para desarrollo local.
