import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";
import { summarizeExplain } from "../src/m05-report.mjs";
import { withMongo, createEvent, readEvent, updateEvent, deleteEvent, upsertEvent, createAlert, readAlert, updateAlert, deleteAlert, findEventsByDevice, findOpenAlerts, explainQuery } from "../src/mongo.mjs";

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
});

const eventFactory = (overrides = {}) => ({
  event_id: randomUUID(),
  device_id: "dev_sensor_01",
  event_type: "temperature_c",
  observed_at: new Date(Date.now() - 60_000),
  ingested_at: new Date(Date.now()),
  metric_value: 21.5,
  unit: "C",
  severity: "info",
  source: "node-tests",
  payload: { source: "crud" },
  ...overrides
});

const alertFactory = (overrides = {}) => ({
  alert_id: randomUUID(),
  event_id: randomUUID(),
  device_id: "dev_sensor_01",
  alert_type: "threshold",
  status: "open",
  severity: "warning",
  opened_at: new Date(Date.now() - 60_000),
  acknowledged_at: null,
  resolved_at: null,
  ...overrides
});

test("CRUD normal de eventos", async () => {
  await withMongo(async (db) => {
    const event = eventFactory();

    const created = await createEvent(event, { db });
    assert.equal(created.created, true);
    assert.equal(created.event_id, event.event_id);

    const read = await readEvent(event.event_id, { db });
    assert.equal(read.event_id, event.event_id);
    assert.equal(read.device_id, event.device_id);

    const updated = await updateEvent(event.event_id, { metric_value: 24.2, payload: { source: "update" } }, { db });
    assert.equal(updated.matchedCount, 1);
    assert.equal(updated.modifiedCount, 1);

    const after = await readEvent(event.event_id, { db });
    assert.equal(after.metric_value, 24.2);
    assert.deepEqual(after.payload, { source: "update" });

    const deleted = await deleteEvent(event.event_id, { db });
    assert.equal(deleted.deletedCount, 1);
    assert.equal(await readEvent(event.event_id, { db }), null);
  });
});

test("CRUD normal de alertas", async () => {
  await withMongo(async (db) => {
    const alert = alertFactory();

    const created = await createAlert(alert, { db });
    assert.equal(created.created, true);
    assert.equal(created.alert_id, alert.alert_id);

    const read = await readAlert(alert.alert_id, { db });
    assert.equal(read.alert_id, alert.alert_id);

    const updated = await updateAlert(alert.alert_id, { status: "acknowledged", acknowledged_at: new Date(Date.now() - 30_000) }, { db });
    assert.equal(updated.matchedCount, 1);

    const after = await readAlert(alert.alert_id, { db });
    assert.equal(after.status, "acknowledged");
    assert.ok(after.acknowledged_at instanceof Date);

    const deleted = await deleteAlert(alert.alert_id, { db });
    assert.equal(deleted.deletedCount, 1);
    assert.equal(await readAlert(alert.alert_id, { db }), null);
  });
});

test("idempotencia de eventos: duplicado no crea otro y reutilizar id con datos distintos da conflicto explícito", async () => {
  await withMongo(async (db) => {
    const event = eventFactory({ device_id: "dev_sensor_02", event_type: "humidity_pct", metric_value: 42, payload: { sample: 1 } });

    const first = await upsertEvent(event, { db });
    assert.equal(first.action, "created");

    const second = await upsertEvent({ ...event }, { db });
    assert.equal(second.action, "duplicate");
    assert.equal(second.created, false);
    assert.equal(second.matchedExisting, true);

    const third = await upsertEvent({ ...event, metric_value: 43, payload: { sample: 2 } }, { db });
    assert.equal(third.action, "conflict");
    assert.equal(third.conflict, true);
    assert.equal(third.event_id, event.event_id);

    const count = await db.collection("events").countDocuments({ event_id: event.event_id });
    assert.equal(count, 1);
    await deleteEvent(event.event_id, { db });
  });
});

test("lecturas, borrados y actualizaciones sobre documentos inexistentes devuelven resultados explícitos", async () => {
  await withMongo(async (db) => {
    const missingEvent = await readEvent("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingEvent, null);

    const missingUpdate = await updateEvent("00000000-0000-4000-8000-000000000090", { metric_value: 18 }, { db });
    assert.equal(missingUpdate.matchedCount, 0);

    const missingDelete = await deleteEvent("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingDelete.deletedCount, 0);

    const missingAlert = await readAlert("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingAlert, null);

    const missingAlertUpdate = await updateAlert("00000000-0000-4000-8000-000000000090", { status: "resolved" }, { db });
    assert.equal(missingAlertUpdate.matchedCount, 0);

    const missingAlertDelete = await deleteAlert("00000000-0000-4000-8000-000000000090", { db });
    assert.equal(missingAlertDelete.deletedCount, 0);
  });
});

test("cronograma de Q1 y Q2 con explain executionStats usan los índices esperados", async () => {
  await withMongo(async (db) => {
    const start = new Date("2026-09-20T00:00:00.000Z");
    const end = new Date("2026-09-23T00:00:00.000Z");

    const q1 = await explainQuery(db, "events", { device_id: "dev_sensor_01", observed_at: { $gte: start, $lte: end } }, { observed_at: -1 }, 10);
    const q1Json = JSON.stringify(summarizeExplain(q1));
    assert.match(q1Json, /IXSCAN/);
    assert.match(q1Json, /idx_events_device_observed/);
    assert.ok(q1.executionStats.totalDocsExamined >= 0);

    const q2 = await explainQuery(db, "alerts", { status: "open", device_id: "dev_sensor_01", severity: "critical" }, { opened_at: -1 }, 10);
    const q2Json = JSON.stringify(summarizeExplain(q2));
    assert.match(q2Json, /IXSCAN/);
    assert.match(q2Json, /idx_alerts_status_device_severity|idx_alerts_status_opened/);
    assert.ok(q2.executionStats.totalDocsExamined >= 0);

    const events = await findEventsByDevice(db, { deviceId: "dev_sensor_01", from: start, to: end, limit: 10 });
    assert.ok(Array.isArray(events));
    assert.ok(events.every((event) => event.device_id === "dev_sensor_01"));
    assert.ok(events.every((event) => event.observed_at >= start && event.observed_at <= end));

    const alerts = await findOpenAlerts(db, { deviceId: "dev_sensor_01", severity: "critical", limit: 10 });
    assert.ok(Array.isArray(alerts));
    assert.ok(alerts.every((alert) => alert.status === "open"));
    assert.ok(alerts.every((alert) => alert.device_id === "dev_sensor_01"));
  });
});

test("actualizaciones inválidas son rechazadas por validación del esquema", async () => {
  await withMongo(async (db) => {
    const validEvent = eventFactory({ device_id: "dev_sensor_02", event_type: "signal_dbm", metric_value: -65, source: "invalid-update" });
    const created = await createEvent(validEvent, { db });
    assert.equal(created.created, true);

    await assert.rejects(() => updateEvent(validEvent.event_id, { metric_value: "no-es-numero" }, { db }), /metric_value|Evento inválido/);

    const validAlert = alertFactory({ device_id: "dev_sensor_02", severity: "warning", event_id: validEvent.event_id });
    const createdAlert = await createAlert(validAlert, { db });
    assert.equal(createdAlert.created, true);
    await assert.rejects(() => updateAlert(validAlert.alert_id, { severity: "fatal" }, { db }), /severity|Alerta inválida/);

    await deleteEvent(validEvent.event_id, { db });
    await deleteAlert(validAlert.alert_id, { db });
  });
});
