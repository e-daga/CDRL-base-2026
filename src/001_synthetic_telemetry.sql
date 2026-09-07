INSERT INTO devices (device_id, external_ref, model, firmware_version, registered_at)
VALUES
  ('dev_lab_alpha', 'LAB-A-001', 'cdrl-sensor-a', '1.0.0', '2026-09-01T10:00:00Z'),
  ('dev_lab_beta', 'LAB-B-001', 'cdrl-sensor-b', '1.1.0', '2026-09-01T10:05:00Z')
ON CONFLICT (device_id) DO UPDATE SET
  external_ref = EXCLUDED.external_ref,
  model = EXCLUDED.model,
  firmware_version = EXCLUDED.firmware_version;

INSERT INTO telemetry_events (
  event_id,
  device_id,
  event_type,
  observed_at,
  metric_value,
  unit,
  severity,
  source,
  payload
)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'dev_lab_alpha',
    'temperature_c',
    '2026-09-01T10:15:00Z',
    22.4500,
    'celsius',
    'info',
    'synthetic-seed',
    '{"room":"lab-01","sample":1}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'dev_lab_alpha',
    'battery_pct',
    '2026-09-01T10:16:00Z',
    87.0000,
    'percent',
    'info',
    'synthetic-seed',
    '{"room":"lab-01","sample":2}'::jsonb
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'dev_lab_beta',
    'humidity_pct',
    '2026-09-01T10:17:00Z',
    46.2500,
    'percent',
    'info',
    'synthetic-seed',
    '{"room":"lab-02","sample":3}'::jsonb
  )
ON CONFLICT (event_id) DO UPDATE SET
  device_id = EXCLUDED.device_id,
  event_type = EXCLUDED.event_type,
  observed_at = EXCLUDED.observed_at,
  metric_value = EXCLUDED.metric_value,
  unit = EXCLUDED.unit,
  severity = EXCLUDED.severity,
  source = EXCLUDED.source,
  payload = EXCLUDED.payload;
