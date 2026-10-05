import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withMongo, upsertEvent, readEvent, deleteEvent, updateEvent, findEventsByDevice, findOpenAlerts } from "../src/mongo.mjs";
import { collectM05, summarizeExplain } from "../src/m05-report.mjs";

const event = (overrides = {}) => ({
  event_id: randomUUID(), device_id: "dev_m05_integration", event_type: "battery_pct",
  observed_at: new Date("2026-09-20"), ingested_at: new Date("2026-09-20"),
  metric_value: 50, unit: "%", severity: "info", source: "m05-test", payload: {}, ...overrides
});

test("[M05][normal] Q1 y las cuatro variantes Q2 ejecutan indices declarados", async () => {
  await withMongo(async (db) => {
    const report = await collectM05(db);
    assert.equal(report.queries.length, 5);
    const rows = await findEventsByDevice(db, { deviceId: "dev_sensor_01", from: "2026-09-20", to: "2026-09-23", limit: 1 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, "a1b2c3d4-0006-4000-8000-000000000006");
    const alerts = await findOpenAlerts(db, { deviceId: "dev_sensor_01", severity: "critical" });
    assert.ok(alerts.length > 0);
    assert.ok(alerts.every((a) => a.status === "open" && a.severity === "critical"));
  });
});

for (const value of [0, 100]) {
  test("[M05][boundary] porcentaje " + value + " aceptado directamente", async () => {
    await withMongo(async (db) => {
      const doc = event({ metric_value: value });
      try {
        await db.collection("events").insertOne(doc);
        assert.equal((await readEvent(doc.event_id, { db })).metric_value, value);
      } finally { await deleteEvent(doc.event_id, { db }); }
    });
  });
}

test("[M05][boundary] reintentos concurrentes y orden de claves no duplican", async () => {
  await withMongo(async (db) => {
    const doc = event({ payload: { a: 1, b: 2 } });
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => upsertEvent({ ...doc }, { db })));
      assert.equal(results.filter((r) => r.action === "created").length, 1);
      assert.equal(results.filter((r) => r.action === "duplicate").length, 7);
      assert.equal((await upsertEvent({ ...doc, payload: { b: 2, a: 1 } }, { db })).action, "duplicate");
      assert.equal((await upsertEvent({ ...doc, metric_value: 51 }, { db })).action, "conflict");
      assert.equal((await readEvent(doc.event_id, { db })).metric_value, 50);
      assert.equal(await db.collection("events").countDocuments({ event_id: doc.event_id }), 1);
      await updateEvent(doc.event_id, { metric_value: 60 }, { db });
      assert.equal((await updateEvent(doc.event_id, { metric_value: 60 }, { db })).modifiedCount, 0);
      assert.equal((await deleteEvent(doc.event_id, { db })).deletedCount, 1);
      assert.equal((await deleteEvent(doc.event_id, { db })).deletedCount, 0);
    } finally { await deleteEvent(doc.event_id, { db }); }
  });
});

test("[M05][declared failure] actualizacion directa invalida no modifica el documento", async () => {
  await withMongo(async (db) => {
    const doc = event();
    try {
      await db.collection("events").insertOne(doc);
      await assert.rejects(db.collection("events").updateOne({ event_id: doc.event_id }, { $set: { metric_value: 101 } }), { code: 121 });
      assert.equal((await readEvent(doc.event_id, { db })).metric_value, 50);
    } finally { await deleteEvent(doc.event_id, { db }); }
  });
});

test("[M05][declared failure] limites, fechas y filtros invalidos son rechazados", async () => {
  await withMongo(async (db) => {
    for (const limit of [0, -1, 101, 1.5]) {
      await assert.rejects(findEventsByDevice(db, { deviceId: "dev_sensor_01", limit }), /limit/);
    }
    await assert.rejects(findEventsByDevice(db, { deviceId: "dev_sensor_01", from: "no-date" }), /temporal/);
    await assert.rejects(findEventsByDevice(db, { deviceId: "dev_sensor_01", from: "2026-09-23", to: "2026-09-20" }), /invertido/);
    await assert.rejects(findOpenAlerts(db, { deviceId: { $ne: null } }), /deviceId/);
    await assert.rejects(deleteEvent({ $ne: null }, { db }), /Identificador/);
    await assert.rejects(upsertEvent(event({ observed_at: new Date("invalid") }), { db }), /observed_at/);
    await assert.rejects(upsertEvent(event({ metric_value: Infinity }), { db }), /metric_value/);
  });
});

test("[M05][declared failure] un indice solo en rejectedPlans no cuenta", () => {
  const plan = summarizeExplain({
    queryPlanner: { winningPlan: { stage: "COLLSCAN" }, rejectedPlans: [{ stage: "IXSCAN", indexName: "fake" }] },
    executionStats: { executionStages: { stage: "COLLSCAN" }, executionSuccess: true, nReturned: 1 }
  });
  assert.deepEqual(plan.indexes, []);
  assert.ok(plan.stages.includes("COLLSCAN"));
});
