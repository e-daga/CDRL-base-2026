# CDRL-base-2026 - M01 contrato de datos

Entrega del hito M01 para **Cloud Data Reliability Lab (CDRL)**. El objetivo es dejar un contrato de datos de telemetria reproducible con PostgreSQL, migraciones, seed sintetico, pruebas automaticas y evidencia machine-readable.

## Como ejecutarlo

Requisitos locales:

- Node.js 20 o superior.
- Docker con Docker Compose.

Comandos de la entrega:

```bash
make setup
make verify
make run
```

`make setup` instala dependencias, levanta PostgreSQL, aplica migraciones y carga el seed.

`make verify` repite la preparacion, ejecuta las pruebas automaticas y genera `artifacts/m01-verify.json`.

`make run` imprime un resumen de dispositivos y eventos de telemetria.

## Que incluye M01

- Migracion relacional en `db/migrations/001_create_telemetry_contract.sql`.
- Seed sintetico idempotente en `db/seed/001_synthetic_telemetry.sql`.
- Pruebas automaticas en `tests/telemetry-contract.test.mjs`.
- ADR de la decision tecnica en `docs/ADR-001-contrato-telemetria-postgresql.md`.
- Evidencia solicitada en `evidence/m01-data-contract.json`.
- Resultado machine-readable en `artifacts/m01-verify.json`.

## Pruebas

La suite cubre:

- Caso normal: inserta un evento `temperature_c` valido.
- Caso limite 1: acepta `battery_pct` en 0.
- Caso limite 2: acepta `humidity_pct` en 100.
- Fallo declarado: rechaza `battery_pct` mayor a 100.

## Seguridad

No se guardan credenciales reales, tokens, datos personales ni cadenas de conexion privadas. `.env.example` contiene valores sinteticos solo para desarrollo local.
