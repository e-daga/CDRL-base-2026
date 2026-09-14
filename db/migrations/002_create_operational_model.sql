CREATE TABLE IF NOT EXISTS device_status (
	device_id text PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
	status text NOT NULL DEFAULT 'online',
	last_seen_at timestamptz NOT NULL,
	battery_pct numeric(5,2),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT device_status_status_allowed CHECK (
		status IN ('online', 'offline', 'maintenance')
	),
	CONSTRAINT device_status_battery_range CHECK (
		battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100
	),
	CONSTRAINT device_status_offline_seen CHECK (
		status <> 'offline' OR last_seen_at <= updated_at
	)
);

CREATE TABLE IF NOT EXISTS telemetry_alerts (
	alert_id uuid PRIMARY KEY,
	event_id uuid NOT NULL UNIQUE REFERENCES telemetry_events(event_id) ON DELETE CASCADE,
	alert_type text NOT NULL,
	status text NOT NULL DEFAULT 'open',
	opened_at timestamptz NOT NULL DEFAULT now(),
	acknowledged_at timestamptz,
	resolved_at timestamptz,
	CONSTRAINT telemetry_alerts_type_allowed CHECK (
		alert_type IN ('threshold', 'connectivity', 'data_quality')
	),
	CONSTRAINT telemetry_alerts_status_allowed CHECK (
		status IN ('open', 'acknowledged', 'resolved')
	),
	CONSTRAINT telemetry_alerts_timestamps_ordered CHECK (
		acknowledged_at IS NULL OR acknowledged_at >= opened_at
	),
	CONSTRAINT telemetry_alerts_ack_required CHECK (
		status = 'open' OR acknowledged_at IS NOT NULL
	),
	CONSTRAINT telemetry_alerts_resolution_required CHECK (
		status <> 'resolved' OR resolved_at IS NOT NULL
	),
	CONSTRAINT telemetry_alerts_resolution_ordered CHECK (
		resolved_at IS NULL OR resolved_at >= COALESCE(acknowledged_at, opened_at)
	)
);

CREATE INDEX IF NOT EXISTS device_status_status_idx
	ON device_status (status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_alerts_status_idx
	ON telemetry_alerts (status, opened_at DESC);
