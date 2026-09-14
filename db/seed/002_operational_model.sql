INSERT INTO device_status (device_id, status, last_seen_at, battery_pct, updated_at)
VALUES
  ('dev_lab_alpha', 'online', '2026-09-01T10:16:00Z', 87.00, '2026-09-01T10:16:00Z'),
  ('dev_lab_beta', 'maintenance', '2026-09-01T10:17:00Z', 0.00, '2026-09-01T10:17:00Z')
ON CONFLICT (device_id) DO UPDATE SET
  status = EXCLUDED.status,
  last_seen_at = EXCLUDED.last_seen_at,
  battery_pct = EXCLUDED.battery_pct,
  updated_at = EXCLUDED.updated_at;

INSERT INTO telemetry_alerts (
  alert_id, event_id, alert_type, status, opened_at
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  'threshold',
  'open',
  '2026-09-01T10:17:00Z'
)
ON CONFLICT (alert_id) DO UPDATE SET
  event_id = EXCLUDED.event_id,
  alert_type = EXCLUDED.alert_type,
  status = EXCLUDED.status,
  opened_at = EXCLUDED.opened_at,
  acknowledged_at = EXCLUDED.acknowledged_at,
  resolved_at = EXCLUDED.resolved_at;