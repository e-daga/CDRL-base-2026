import assert from "node:assert/strict";
import { test } from "node:test";
import { withClient } from "../src/db.mjs";

async function hasTablePrivilege(role, table, privilege) {
  return withClient(async (client) => {
    const result = await client.query(
      "select has_table_privilege($1, $2, $3) as allowed",
      [role, `public.${table}`, privilege]
    );
    return result.rows[0].allowed;
  });
}

test("role_writer can insert telemetry events", async () => {
  assert.equal(await hasTablePrivilege("role_writer", "telemetry_events", "INSERT"), true);
});

test("role_reader can read telemetry events", async () => {
  assert.equal(await hasTablePrivilege("role_reader", "telemetry_events", "SELECT"), true);
});

test("role_operator can update alerts", async () => {
  assert.equal(await hasTablePrivilege("role_operator", "telemetry_alerts", "UPDATE"), true);
});

test("role_writer cannot read telemetry events", async () => {
  assert.equal(await hasTablePrivilege("role_writer", "telemetry_events", "SELECT"), false);
});

test("role_reader cannot insert telemetry events", async () => {
  assert.equal(await hasTablePrivilege("role_reader", "telemetry_events", "INSERT"), false);
});

test("role_operator cannot read telemetry events", async () => {
  assert.equal(await hasTablePrivilege("role_operator", "telemetry_events", "SELECT"), false);
});
