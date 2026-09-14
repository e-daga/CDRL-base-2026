export async function findTelemetryByDevice(client, deviceId, limit = 50) {
  const result = await client.query(
    `
      select event_id, device_id, event_type, observed_at, metric_value, unit, severity
      from telemetry_events
      where device_id = $1
      order by observed_at desc
      limit $2::int
    `,
    [deviceId, limit]
  );
  return result.rows;
}

export async function findOpenAlerts(client, deviceId) {
  const result = await client.query(
    `
      select a.alert_id, a.event_id, a.alert_type, a.status, a.opened_at
      from telemetry_alerts a
      join telemetry_events e on e.event_id = a.event_id
      where e.device_id = $1 and a.status = 'open'
      order by a.opened_at desc
    `,
    [deviceId]
  );
  return result.rows;
}