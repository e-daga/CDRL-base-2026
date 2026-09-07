CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  device_id text PRIMARY KEY,
  external_ref text NOT NULL UNIQUE,
  model text NOT NULL,
  firmware_version text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_device_id_format CHECK (device_id ~ '^dev_[a-z0-9_]+$')
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id uuid PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices(device_id),
  event_type text NOT NULL,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  metric_value numeric(12,4) NOT NULL,
  unit text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  source text NOT NULL DEFAULT 'synthetic-seed',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT telemetry_events_type_allowed CHECK (
    event_type IN ('temperature_c', 'humidity_pct', 'battery_pct', 'signal_dbm')
  ),
  CONSTRAINT telemetry_events_severity_allowed CHECK (
    severity IN ('info', 'warning', 'critical')
  ),
  CONSTRAINT telemetry_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT telemetry_events_observed_not_too_future CHECK (
    observed_at <= now() + interval '5 minutes'
  ),
  CONSTRAINT telemetry_events_battery_range CHECK (
    event_type <> 'battery_pct' OR metric_value BETWEEN 0 AND 100
  ),
  CONSTRAINT telemetry_events_humidity_range CHECK (
    event_type <> 'humidity_pct' OR metric_value BETWEEN 0 AND 100
  )
);

CREATE INDEX IF NOT EXISTS telemetry_events_device_observed_idx
  ON telemetry_events (device_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_events_type_observed_idx
  ON telemetry_events (event_type, observed_at DESC);
