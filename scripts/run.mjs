import { withClient } from "../src/db.mjs";

const summary = await withClient(async (client) => {
  const counts = await client.query(`
    select
      (select count(*)::int from devices) as devices,
      (select count(*)::int from telemetry_events) as telemetry_events,
      (select count(*)::int from device_status) as device_status,
      (select count(*)::int from telemetry_alerts) as telemetry_alerts
  `);

  const events = await client.query(`
    select device_id, event_type, observed_at, metric_value, unit, severity
    from telemetry_events
    order by observed_at asc
  `);

  return { counts: counts.rows[0], events: events.rows };
});

console.log("Resumen del modelo operativo CDRL M02");
console.log(JSON.stringify(summary, null, 2));
