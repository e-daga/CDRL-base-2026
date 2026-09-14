import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withClient } from "../src/db.mjs";
import { findOpenAlerts, findTelemetryByDevice } from "../src/operational-queries.mjs";

const testDeviceId = "dev_test_operational";
const testAlertId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";

before(async () => {
  await withClient(async (client) => {
    await client.query(`
      insert into devices (device_id, external_ref, model, firmware_version)
      values ($1, 'TEST-OPERATIONAL-001', 'operational-test-sensor', '0.0.1')
      on conflict (device_id) do update set
        external_ref = excluded.external_ref,
        model = excluded.model,
        firmware_version = excluded.firmware_version
    `, [testDeviceId]);
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query("delete from telemetry_events where device_id = $1", [testDeviceId]);
    await client.query("delete from devices where device_id = $1", [testDeviceId]);
  });
});

test("normal case: parameterized telemetry query returns device events", async () => {
  await withClient(async (client) => {
    const rows = await findTelemetryByDevice(client, "dev_lab_alpha", 10);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.device_id === "dev_lab_alpha"));
  });
});

test("empty case: unknown device returns empty parameterized results", async () => {
  await withClient(async (client) => {
    assert.deepEqual(await findTelemetryByDevice(client, "dev_missing", 10), []);
    assert.deepEqual(await findOpenAlerts(client, "dev_missing"), []);
  });
});

test("boundary case: telemetry limit returns at most one row", async () => {
  await withClient(async (client) => {
    const rows = await findTelemetryByDevice(client, "dev_lab_alpha", 1);
    assert.ok(rows.length <= 1);
  });
});

test("boundary case: device status accepts maintenance with battery 0", async () => {
  await withClient(async (client) => {
    await client.query(`
      insert into device_status (device_id, status, last_seen_at, battery_pct)
      values ($1, 'maintenance', now(), 0)
      on conflict (device_id) do update set
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        battery_pct = excluded.battery_pct,
        updated_at = now()
    `, [testDeviceId]);
    const result = await client.query(
      "select status, battery_pct from device_status where device_id = $1", [testDeviceId]
    );
    assert.equal(result.rows[0].status, "maintenance");
    assert.equal(result.rows[0].battery_pct, "0.00");
  });
});

test("declared failure: device status rejects battery above 100", async () => {
  await assert.rejects(
    () => withClient((client) => client.query(
      "insert into device_status (device_id, status, last_seen_at, battery_pct) values ($1, 'online', now(), 101)",
      [testDeviceId]
    )),
    /device_status_battery_range/
  );
});

test("declared failure: resolved alert requires acknowledgement", async () => {
  await assert.rejects(
    () => withClient((client) => client.query(`
      insert into telemetry_alerts (alert_id, event_id, alert_type, status)
      values ($1, '11111111-1111-4111-8111-111111111111', 'threshold', 'resolved')
    `, [testAlertId])),
    /telemetry_alerts_ack_required|telemetry_alerts_resolution_required/
  );
});