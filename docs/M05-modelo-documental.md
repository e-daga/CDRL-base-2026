# M05 - Modelo documental (MongoDB)

MongoDB 7 corre junto a PostgreSQL en Docker Compose bajo el profile `mongo`; no reemplaza ni modifica PostgreSQL.

## Levantar

    node scripts/mongo.mjs up      # genera MONGO_* en .env, levanta, crea colecciones e indices y siembra
    node scripts/mongo.mjs init    # solo validacion e indices (repetible)
    node scripts/mongo.mjs seed    # solo fixtures (upsert, no duplica)
    node scripts/mongo.mjs down

Las credenciales viven en `.env` (ignorado por Git); `.env.example` solo trae nombres sin secretos.

## Pruebas

    node --test tests/mongo-validation.test.mjs

Insertan documentos invalidos directamente en MongoDB y comprueban que los rechaza (codigo 121) o que el indice unico lo bloquea (11000).

## Coleccion events (contrato M01)

Requeridos: event_id (uuid string), device_id (`^dev_[a-z0-9_]+$`), event_type (temperature_c | humidity_pct | battery_pct | signal_dbm), observed_at (date), ingested_at (date), metric_value (number), unit, severity (info | warning | critical), source, payload (objeto).
Reglas: observed_at no mas de 5 min en el futuro; battery_pct y humidity_pct entre 0 y 100; sin campos extra. A diferencia de SQL, Mongo no tiene DEFAULT: la aplicacion debe enviar ingested_at, severity, source y payload.

## Coleccion alerts (contrato M02 + ADR-004)

Requeridos: alert_id, event_id, device_id, severity (copiados del evento para Q2), alert_type (threshold | connectivity | data_quality), status (open | acknowledged | resolved), opened_at. Opcionales: acknowledged_at, resolved_at (date o null).
Reglas: status distinto de open exige acknowledged_at; resolved exige resolved_at; acknowledged_at >= opened_at; resolved_at >= acknowledged_at (o opened_at). La app debe mantener device_id y severity sincronizados con el evento.

## Indices

| Coleccion | Indice | Uso |
| --- | --- | --- |
| events | uq_events_event_id (unico) | idempotencia |
| events | idx_events_device_observed (device_id, observed_at desc) | Q1 eventos por dispositivo y rango de fechas |
| events | idx_events_type_observed (event_type, observed_at desc) | consultas por tipo |
| alerts | uq_alerts_alert_id, uq_alerts_event_id (unicos) | un alerta por evento |
| alerts | idx_alerts_status_device_severity (status, device_id, severity) | Q2 alertas abiertas con filtros |
| alerts | idx_alerts_status_opened (status, opened_at desc) | alertas abiertas recientes |