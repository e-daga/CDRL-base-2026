import { withClient } from "../src/db.mjs";
import fs from "node:fs";
import { buildM04Report } from "../src/m04-decision.mjs";

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

console.log("Resumen CDRL M03 (conexion de solo lectura)");
console.log(JSON.stringify(summary, null, 2));
const matrix = JSON.parse(fs.readFileSync(new URL("../docs/m04-nosql-matrix.json", import.meta.url), "utf8"));
const report = buildM04Report(matrix);
console.log("M04: decision arquitectonica condicional; no es un benchmark de motores.");
console.log(JSON.stringify({ ranking: report.comparison.clasificacion, workload: report.workload, decision: report.decision, sensitivity: report.sensitivity }, null, 2));
