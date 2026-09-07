import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withClient } from "../src/db.mjs";

const testEventIds = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"
];

before(async () => {
  await withClient(async (client) => {
    await client.query(`
      insert into devices (device_id, external_ref, model, firmware_version)
      values ('dev_test_contract', 'TEST-CONTRACT-001', 'contract-test-sensor', '0.0.1')
      on conflict (device_id) do update set
        external_ref = excluded.external_ref,
        model = excluded.model,
        firmware_version = excluded.firmware_version
    `);
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query("delete from telemetry_events where event_id = any($1::uuid[])", [testEventIds]);
    await client.query("delete from devices where device_id = 'dev_test_contract'");
  });
});

test("normal case: accepts a temperature telemetry event", async () => {
  await withClient(async (client) => {
    await client.query(
      `
        insert into telemetry_events (
          event_id, device_id, event_type, observed_at, metric_value, unit, severity, source, payload
        )
        values ($1, 'dev_test_contract', 'temperature_c', now(), 21.7500, 'celsius', 'info', 'automated-test', '{"case":"normal"}')
      `,
      [testEventIds[0]]
    );

    const result = await client.query(
      "select event_type, metric_value, unit from telemetry_events where event_id = $1",
      [testEventIds[0]]
    );

    assert.equal(result.rows[0].event_type, "temperature_c");
    assert.equal(result.rows[0].metric_value, "21.7500");
    assert.equal(result.rows[0].unit, "celsius");
  });
});

test("boundary case: accepts battery_pct lower bound 0", async () => {
  await withClient(async (client) => {
    await client.query(
      `
        insert into telemetry_events (
          event_id, device_id, event_type, observed_at, metric_value, unit, severity, source, payload
        )
        values ($1, 'dev_test_contract', 'battery_pct', now(), 0.0000, 'percent', 'warning', 'automated-test', '{"case":"battery-lower-bound"}')
      `,
      [testEventIds[1]]
    );

    const result = await client.query(
      "select metric_value from telemetry_events where event_id = $1",
      [testEventIds[1]]
    );

    assert.equal(result.rows[0].metric_value, "0.0000");
  });
});

test("boundary case: accepts humidity_pct upper bound 100", async () => {
  await withClient(async (client) => {
    await client.query(
      `
        insert into telemetry_events (
          event_id, device_id, event_type, observed_at, metric_value, unit, severity, source, payload
        )
        values ($1, 'dev_test_contract', 'humidity_pct', now(), 100.0000, 'percent', 'critical', 'automated-test', '{"case":"humidity-upper-bound"}')
      `,
      [testEventIds[2]]
    );

    const result = await client.query(
      "select metric_value from telemetry_events where event_id = $1",
      [testEventIds[2]]
    );

    assert.equal(result.rows[0].metric_value, "100.0000");
  });
});

test("declared failure: rejects battery_pct above 100", async () => {
  await assert.rejects(
    () => withClient(async (client) => {
      await client.query(
        `
          insert into telemetry_events (
            event_id, device_id, event_type, observed_at, metric_value, unit, severity, source, payload
          )
          values ($1, 'dev_test_contract', 'battery_pct', now(), 101.0000, 'percent', 'critical', 'automated-test', '{"case":"declared-failure"}')
        `,
        [testEventIds[3]]
      );
    }),
    /telemetry_events_battery_range/
  );
});
