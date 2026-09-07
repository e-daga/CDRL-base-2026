import { withClient } from "../src/db.mjs";

const summary = await withClient(async (client) => {
  const counts = await client.query(`
    select
      (select count(*)::int from devices) as devices,
      (select count(*)::int from telemetry_events) as telemetry_events
  `);

  const events = await client.query(`
    select device_id, event_type, observed_at, metric_value, unit, severity
    from telemetry_events
    order by observed_at asc
  `);

  return { counts: counts.rows[0], events: events.rows };
});

console.log("Resumen del contrato de telemetria M01");
console.log(JSON.stringify(summary, null, 2));
