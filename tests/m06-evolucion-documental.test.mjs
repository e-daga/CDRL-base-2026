import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rootDir } from "../src/config.mjs";
import { withMongo, findEventsByDevice, readEvent, deleteEvent } from "../src/mongo.mjs";
import { eventSchemaVersion, assertEventVersion, toEventView, countEventsBySchemaVersion } from "../src/event-versions.mjs";

const shell = 'exec mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const rootScript = (file) =>
  execFileSync("docker", ["compose", "--profile", "mongo", "exec", "-T", "mongo", "sh", "-c", `${shell} ${file}`], { cwd: rootDir, encoding: "utf8" });

const v1 = (overrides = {}) => ({
  event_id: randomUUID(), device_id: "dev_m06_test", event_type: "temperature_c",
  observed_at: new Date("2026-10-06T08:00:00Z"), ingested_at: new Date("2026-10-06T08:00:02Z"),
  metric_value: 21, unit: "C", severity: "info", source: "m06-test", payload: {}, ...overrides
});
const v2 = (overrides = {}) => v1({ schema_version: 2, firmware_version: "1.4.0", ...overrides });
const without = (doc, key) => { const copy = { ...doc }; delete copy[key]; return copy; };

before(() => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
});

test("[M06][normal] la consulta por dispositivo lee v1 y v2 con la misma forma", async () => {
  await withMongo(async (db) => {
    const rows = await findEventsByDevice(db, { deviceId: "dev_sensor_04", from: "2026-10-05", to: "2026-10-07", limit: 10 });
    assert.deepEqual(rows.map((r) => r.event_id), [
      "c1b2c3d4-0004-4000-8000-000000000004", "c1b2c3d4-0003-4000-8000-000000000003",
      "c1b2c3d4-0002-4000-8000-000000000002", "c1b2c3d4-0001-4000-8000-000000000001"
    ]);
    assert.deepEqual(rows.map((r) => r.schema_version), [2, 2, 1, 1]);
    assert.deepEqual(rows.map((r) => r.firmware_version), ["1.4.0", "1.4.0", null, null]);
    for (const row of rows) {
      for (const key of ["event_id", "device_id", "event_type", "observed_at", "metric_value", "unit", "severity", "schema_version", "firmware_version"]) {
        assert.ok(key in row, `${row.event_id} sin ${key}`);
      }
    }
  });
});

test("[M06][normal] el validador acepta un v1 nuevo y un v2 nuevo", async () => {
  await withMongo(async (db) => {
    const docs = [v1(), v2()];
    try {
      for (const doc of docs) await db.collection("events").insertOne(doc);
      assert.equal((await readEvent(docs[0].event_id, { db })).schema_version, undefined);
      assert.equal((await readEvent(docs[1].event_id, { db })).schema_version, 2);
    } finally {
      for (const doc of docs) await deleteEvent(doc.event_id, { db });
    }
  });
});

test("[M06][boundary] los documentos de M05 se leen como v1 sin reescribirse", async () => {
  await withMongo(async (db) => {
    const rows = await findEventsByDevice(db, { deviceId: "dev_sensor_01", from: "2026-09-20", to: "2026-09-23", limit: 10 });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.schema_version === 1 && r.firmware_version === null));
    const stored = await db.collection("events").find({ device_id: "dev_sensor_01" }).toArray();
    assert.ok(stored.every((d) => !("schema_version" in d) && !("firmware_version" in d)), "la lectura no debe migrar lo almacenado");
    const counts = await countEventsBySchemaVersion(db, { source: { $in: ["synthetic-seed", "synthetic-seed-m06"] } });
    assert.deepEqual(counts, { v1: 8, v2: 3 });
  });
});

test("[M06][boundary] la vista no muta el documento original", () => {
  const doc = v1();
  const view = toEventView(doc);
  assert.equal(view.schema_version, 1);
  assert.equal(view.firmware_version, null);
  assert.ok(!("schema_version" in doc) && !("firmware_version" in doc));
  assert.equal(assertEventVersion(v2()), 2);
});

const rejected = {
  "schema_version desconocida (3)": v2({ schema_version: 3 }),
  "schema_version como texto": v2({ schema_version: "2" }),
  "schema_version 1 explicita": v1({ schema_version: 1 }),
  "v2 sin firmware_version": without(v2(), "firmware_version"),
  "v2 con firmware_version mal formado": v2({ firmware_version: "v1.4" }),
  "v1 con firmware_version": v1({ firmware_version: "1.4.0" }),
  "v2 incompleto (sin device_id)": without(v2(), "device_id"),
  "v2 con campo no declarado": v2({ location: "lab" })
};
for (const [name, doc] of Object.entries(rejected)) {
  test(`[M06][declared failure] events rechaza: ${name}`, async () => {
    await withMongo(async (db) => {
      try {
        await assert.rejects(db.collection("events").insertOne(doc), { code: 121 });
      } finally {
        await db.collection("events").deleteOne({ event_id: doc.event_id });
      }
    });
  });
}

test("[M06][declared failure] las reglas de version tambien fallan en la aplicacion", () => {
  assert.throws(() => eventSchemaVersion(v2({ schema_version: 3 })), /desconocida/);
  assert.throws(() => assertEventVersion(without(v2(), "firmware_version")), /firmware_version/);
  assert.throws(() => assertEventVersion(v1({ firmware_version: "1.0.0" })), /firmware_version/);
});

test("[M06][declared failure] subir un v1 a una version invalida no cambia el documento", async () => {
  await withMongo(async (db) => {
    const doc = v1();
    try {
      await db.collection("events").insertOne(doc);
      await assert.rejects(db.collection("events").updateOne({ event_id: doc.event_id }, { $set: { schema_version: 2 } }), { code: 121 });
      await assert.rejects(db.collection("events").updateOne({ event_id: doc.event_id }, { $set: { schema_version: 3, firmware_version: "1.0.0" } }), { code: 121 });
      const stored = await readEvent(doc.event_id, { db });
      assert.ok(!("schema_version" in stored) && !("firmware_version" in stored));
    } finally {
      await deleteEvent(doc.event_id, { db });
    }
  });
});

test("[M06][boundary] init repetido sobre el volumen existente conserva datos y reglas", async () => {
  await withMongo(async (db) => {
    const before = await countEventsBySchemaVersion(db);
    rootScript("/mongo/init.js");
    rootScript("/mongo/init.js");
    rootScript("/mongo/seed.js");
    assert.deepEqual(await countEventsBySchemaVersion(db), before);
    const ok = v2();
    try {
      await db.collection("events").insertOne(ok);
      await assert.rejects(db.collection("events").insertOne(v2({ schema_version: 3 })), { code: 121 });
    } finally {
      await deleteEvent(ok.event_id, { db });
    }
  });
});
