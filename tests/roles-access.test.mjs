import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { withClient } from "../src/db.mjs";
import { databaseConfig, serviceRoles } from "../src/config.mjs";

async function transaction(role, work) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try { return await work(client); } finally { await client.query("ROLLBACK"); }
  }, role);
}

const insertEvent = `INSERT INTO telemetry_events
  (event_id, device_id, event_type, observed_at, metric_value, unit)
  VALUES ($1, 'dev_lab_alpha', 'temperature_c', now(), 22, 'celsius')`;

for (const role of serviceRoles) {
  test(`[M03][normal] ${role} authenticates with its own non-admin account`, async () => {
    await withClient(async (client) => {
      const { rows: [identity] } = await client.query("SELECT session_user, current_user");
      assert.equal(identity.session_user, databaseConfig(role).user);
      assert.equal(identity.current_user, role === "migrator" ? "role_migrator" : databaseConfig(role).user);
      const { rows: [attributes] } = await client.query(`
        SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname = session_user
      `);
      assert.ok(Object.values(attributes).every((value) => value === false));
      const { rows } = await client.query(`
        SELECT parent.rolname FROM pg_auth_members m
        JOIN pg_roles parent ON parent.oid = m.roleid
        JOIN pg_roles member ON member.oid = m.member
        WHERE member.rolname = session_user
      `);
      assert.deepEqual(rows.map((row) => row.rolname), [`role_${role}`]);
    }, role);
  });
}

test("[M03][normal] writer inserts devices and telemetry", async () => {
  await transaction("writer", async (client) => {
    const device = await client.query(`INSERT INTO devices (device_id, external_ref, model, firmware_version)
      VALUES ('dev_m03_writer', 'M03-SYNTHETIC', 'test-sensor', '1')`);
    assert.equal(device.rowCount, 1);
    const event = await client.query(insertEvent, [crypto.randomUUID()]);
    assert.equal(event.rowCount, 1);
  });
});

test("[M03][normal] reader queries all four application tables", async () => {
  await withClient(async (client) => {
    for (const table of ["devices", "telemetry_events", "device_status", "telemetry_alerts"]) {
      assert.ok((await client.query(`SELECT * FROM ${table}`)).rowCount > 0);
    }
  }, "reader");
});

for (const battery of [0, 100]) {
  test(`[M03][boundary] writer upserts device status with battery ${battery}`, async () => {
    await transaction("writer", async (client) => {
      const result = await client.query(`
        INSERT INTO device_status (device_id, last_seen_at, battery_pct)
        VALUES ('dev_lab_beta', now(), $1)
        ON CONFLICT (device_id) DO UPDATE SET battery_pct = excluded.battery_pct
        RETURNING battery_pct
      `, [battery]);
      assert.equal(Number(result.rows[0].battery_pct), battery);
    });
  });
}

test("[M03][boundary] reader can query an empty result", async () => {
  await withClient(async (client) => {
    assert.deepEqual((await client.query("SELECT * FROM devices WHERE device_id = $1", ["dev_absent_m03"])).rows, []);
  }, "reader");
});

test("[M03][normal] operator opens acknowledges and resolves an alert", async () => {
  await transaction("operator", async (client) => {
    const id = crypto.randomUUID();
    await client.query(`INSERT INTO telemetry_alerts (alert_id, event_id, alert_type)
      VALUES ($1, '11111111-1111-4111-8111-111111111111', 'threshold')`, [id]);
    await client.query("UPDATE telemetry_alerts SET status = 'acknowledged', acknowledged_at = now() WHERE alert_id = $1", [id]);
    const result = await client.query(`UPDATE telemetry_alerts SET status = 'resolved', resolved_at = now()
      WHERE alert_id = $1 RETURNING status`, [id]);
    assert.equal(result.rows[0].status, "resolved");
  });
});

test("[M03][normal] migrator creates alters and drops tables, including existing objects", async () => {
  await transaction("migrator", async (client) => {
    await client.query("CREATE TABLE m03_ddl_probe (id integer PRIMARY KEY)");
    await client.query("ALTER TABLE m03_ddl_probe ADD COLUMN label text");
    await client.query("ALTER TABLE devices ADD COLUMN m03_probe text");
    await client.query("DROP TABLE m03_ddl_probe");
  });
});

test("[M03][boundary] future migrator tables inherit read-only access", async () => {
  await withClient((client) => client.query("CREATE TABLE m03_future_probe (id integer)"), "migrator");
  try {
    await withClient(async (client) => {
      assert.equal((await client.query("SELECT * FROM m03_future_probe")).rowCount, 0);
      await assert.rejects(client.query("INSERT INTO m03_future_probe VALUES (1)"), { code: "42501" });
    }, "reader");
  } finally {
    await withClient((client) => client.query("DROP TABLE m03_future_probe"), "migrator");
  }
});

const denied = [
  ["writer", "cannot read telemetry", "SELECT * FROM telemetry_events"],
  ["reader", "cannot insert telemetry", insertEvent, [crypto.randomUUID()]],
  ["operator", "cannot read telemetry", "SELECT * FROM telemetry_events"],
  ["writer", "cannot update raw telemetry", "UPDATE telemetry_events SET unit = 'changed'"],
  ["writer", "cannot manage alerts", "UPDATE telemetry_alerts SET status = 'open'"],
  ["reader", "cannot update device status", "UPDATE device_status SET status = 'offline'"],
  ["operator", "cannot update device status", "UPDATE device_status SET status = 'offline'"],
  ["writer", "cannot delete telemetry", "DELETE FROM telemetry_events"],
  ["reader", "cannot delete devices", "DELETE FROM devices"],
  ["operator", "cannot delete alerts", "DELETE FROM telemetry_alerts"]
];
for (const role of ["writer", "reader", "operator"]) {
  denied.push(
    [role, "cannot create application tables", "CREATE TABLE m03_forbidden (id integer)"],
    [role, "cannot alter existing tables", "ALTER TABLE devices ADD COLUMN forbidden integer"],
    [role, "cannot truncate telemetry", "TRUNCATE telemetry_events CASCADE"],
    [role, "cannot read migration metadata", "SELECT * FROM schema_migrations"],
    [role, "cannot escalate to migrator", "SET ROLE role_migrator"],
    [role, "cannot create login roles", "CREATE ROLE m03_forbidden_role"],
    [role, "cannot create temporary tables", "CREATE TEMP TABLE m03_forbidden_temp (id integer)"]
  );
}
for (const [role, name, sql, values] of denied) {
  test(`[M03][declared failure][denied] ${role} ${name} (42501)`, async () => {
    await transaction(role, async (client) => {
      await assert.rejects(client.query(sql, values), { code: "42501" });
    });
  });
}

test("[M03][normal] complete effective table permission matrix matches the declaration", async () => {
  const matrix = {
    writer: { devices: ["INSERT"], telemetry_events: ["INSERT"], device_status: ["SELECT", "INSERT", "UPDATE"] },
    reader: Object.fromEntries(["devices", "telemetry_events", "device_status", "telemetry_alerts"].map((table) => [table, ["SELECT"]])),
    operator: { telemetry_alerts: ["SELECT", "INSERT", "UPDATE"] }
  };
  for (const role of ["writer", "reader", "operator"]) {
    await withClient(async (client) => {
      for (const table of ["devices", "telemetry_events", "device_status", "telemetry_alerts", "schema_migrations"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const { rows: [result] } = await client.query("SELECT has_table_privilege(current_user, $1, $2) AS allowed", [table, privilege]);
          assert.equal(result.allowed, (matrix[role][table] || []).includes(privilege), `${role} ${table} ${privilege}`);
        }
      }
    }, role);
  }
});
