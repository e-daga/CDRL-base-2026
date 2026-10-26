import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rootDir } from "../src/config.mjs";
import { withMongo, findEventsByDevice, createEvent, readEvent, updateEvent, deleteEvent } from "../src/mongo.mjs";
import {
  assertEventVersion, toEventView, toLegacyEventView, LEGACY_EVENT_FIELDS,
  countEventsBySchemaVersion, countEventsByFirmwareStatus
} from "../src/event-versions.mjs";

// Fixture aislado: copia el validador real de events en otra coleccion y no toca
// los eventos ni alertas de la aplicacion.
const FIXTURE = "m07_compat_fixture_" + randomUUID().replaceAll("-", "");
const fixtureDir = path.join(rootDir, "tests", "fixtures", "m07");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8"));
const fixtureEvents = () => readJson("events-legacy.json").map((doc) => ({
  ...doc, observed_at: new Date(doc.observed_at), ingested_at: new Date(doc.ingested_at)
}));
const expectedLegacy = readJson("legacy-consumer-expected.json");
const query = { deviceId: "dev_m07_a", from: "2026-10-12", to: "2026-10-14", limit: 10, collection: FIXTURE };

const UNKNOWN = { schema_version: 2, firmware_version: null, firmware_status: "unknown", migrated_from: 1 };

// Referencia minima de la migracion definida por el contrato. La migracion
// real (lotes, registro y rollback) es de Jonathan; esta solo sirve para
// llevar el fixture a los estados antes / durante / despues.
async function migrateV1(coll, limit) {
  const pending = await coll.find({ schema_version: { $exists: false } }).sort({ observed_at: 1 }).limit(limit).toArray();
  for (const doc of pending) {
    await coll.updateOne({ event_id: doc.event_id, schema_version: { $exists: false } }, { $set: UNKNOWN });
  }
  return pending.length;
}
async function rollbackV1(coll) {
  const unset = Object.fromEntries(Object.keys(UNKNOWN).map((key) => [key, ""]));
  return (await coll.updateMany({ migrated_from: 1, firmware_status: "unknown" }, { $unset: unset })).modifiedCount;
}

// Consumidor anterior (M05): exige exactamente los campos y tipos de M05 y
// calcula lo mismo que antes. Si la migracion le filtrara un campo nuevo, falla.
function legacyConsumer(rows) {
  for (const row of rows) {
    const { _id, ...fields } = row;
    assert.deepEqual(Object.keys(fields).sort(), [...LEGACY_EVENT_FIELDS].sort(), `${row.event_id}: forma distinta a M05`);
    assert.ok(row.observed_at instanceof Date && row.ingested_at instanceof Date);
    assert.equal(typeof row.metric_value, "number");
    for (const key of ["event_id", "device_id", "event_type", "unit", "severity", "source"]) assert.equal(typeof row[key], "string");
    assert.ok(row.payload && typeof row.payload === "object" && !Array.isArray(row.payload));
  }
  return {
    critical: rows.filter((row) => row.severity === "critical").length,
    rows: rows.map(({ event_id, event_type, observed_at, metric_value, unit, severity, payload }) => (
      { event_id, event_type, observed_at: observed_at.toISOString(), metric_value, unit, severity, payload }
    ))
  };
}
// Consumidor M06: usa la vista actual y decide por firmware_version, no por schema_version.
const m06Consumer = (rows) => rows.map(({ event_id, firmware_version, firmware_status }) => ({ event_id, firmware_version, firmware_status }));

const v1 = (overrides = {}) => ({
  event_id: randomUUID(), device_id: "dev_m07_test", event_type: "temperature_c",
  observed_at: new Date("2026-10-12T08:00:00Z"), ingested_at: new Date("2026-10-12T08:00:02Z"),
  metric_value: 21, unit: "C", severity: "info", source: "m07-test", payload: {}, ...overrides
});

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
  await withMongo(async (db) => {
    const [events] = await db.listCollections({ name: "events" }).toArray();
    assert.ok(events?.options?.validator, "events debe tener validador");
    await db.collection(FIXTURE).drop().catch(() => {});
    await db.createCollection(FIXTURE, { validator: events.options.validator, validationLevel: "strict", validationAction: "error" });
    await db.collection(FIXTURE).createIndex({ event_id: 1 }, { unique: true });
  });
});

after(async () => {
  await withMongo((db) => db.collection(FIXTURE).drop().catch(() => {}));
});

async function resetFixture(db) {
  await db.collection(FIXTURE).deleteMany({});
  await db.collection(FIXTURE).insertMany(fixtureEvents());
}

test("[M07][normal] el consumidor anterior recibe lo mismo antes, durante, despues y tras revertir", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const coll = db.collection(FIXTURE);
    const read = async () => legacyConsumer(await findEventsByDevice(db, { ...query, shape: "legacy" }));

    assert.deepEqual(await read(), expectedLegacy, "antes");
    assert.equal(await migrateV1(coll, 2), 2);
    assert.deepEqual(await read(), expectedLegacy, "durante");
    assert.equal(await migrateV1(coll, 100), 2);
    assert.deepEqual(await read(), expectedLegacy, "despues");
    assert.equal(await rollbackV1(coll), 4);
    assert.deepEqual(await read(), expectedLegacy, "tras rollback");
  });
});

test("[M07][normal] el consumidor M06 conserva firmware_version y firmware_status en todas las fases", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const coll = db.collection(FIXTURE);
    const read = () => findEventsByDevice(db, query);
    const expected = m06Consumer(await read());
    assert.deepEqual(expected.map((r) => r.firmware_version), ["2.0.1", "1.4.0", null, null, null, null]);
    assert.deepEqual(expected.map((r) => r.firmware_status), ["reported", "reported", "unknown", "unknown", "unknown", "unknown"]);
    assert.deepEqual((await read()).map((r) => r.schema_version), [2, 2, 1, 1, 1, 1]);

    await migrateV1(coll, 2);
    assert.deepEqual(m06Consumer(await read()), expected, "durante");
    await migrateV1(coll, 100);
    const afterRows = await read();
    assert.deepEqual(m06Consumer(afterRows), expected, "despues");
    // Unico cambio declarado para el consumidor M06: schema_version de los migrados pasa de 1 a 2.
    assert.deepEqual(afterRows.map((r) => r.schema_version), [2, 2, 2, 2, 2, 2]);
  });
});

test("[M07][boundary] durante la migracion conviven v1 pendientes, v2 desconocidos y v2 reportados", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const coll = db.collection(FIXTURE);
    await migrateV1(coll, 1);
    assert.deepEqual(await countEventsByFirmwareStatus(db, {}, { collection: FIXTURE }), { reported: 2, unknown: 1, v1: 3 });
    assert.deepEqual(await countEventsBySchemaVersion(db, {}, { collection: FIXTURE }), { v1: 3, v2: 3 });
    const stored = await coll.findOne({ event_id: "d7000000-0001-4000-8000-000000000001" });
    assert.equal(stored.firmware_version, null, "se guarda null, no una version inventada");
    assert.equal(stored.firmware_status, "unknown");
    assert.equal(stored.migrated_from, 1);
    const ids = (await findEventsByDevice(db, query)).map((r) => r.event_id);
    assert.deepEqual(ids, expectedLegacy.rows.map((r) => r.event_id), "el orden de Q1 no cambia");
  });
});

test("[M07][boundary] repetir la migracion no cambia nada y no toca los v2 reportados", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const coll = db.collection(FIXTURE);
    await migrateV1(coll, 100);
    const snapshot = await coll.find({}).sort({ event_id: 1 }).toArray();
    assert.equal(await migrateV1(coll, 100), 0);
    assert.deepEqual(await coll.find({}).sort({ event_id: 1 }).toArray(), snapshot);
    const reported = await coll.findOne({ event_id: "d7000000-0005-4000-8000-000000000005" });
    assert.ok(!("firmware_status" in reported) && !("migrated_from" in reported), "un v2 de M06 queda como estaba");
    assert.equal(toEventView(reported).firmware_status, "reported");
  });
});

test("[M07][boundary] el CRUD lee y actualiza un evento migrado sin perder la marca de desconocido", async () => {
  await withMongo(async (db) => {
    const doc = v1(UNKNOWN);
    try {
      await createEvent(doc, { db });
      await updateEvent(doc.event_id, { severity: "warning" }, { db });
      const stored = await readEvent(doc.event_id, { db });
      assert.equal(stored.severity, "warning");
      assert.equal(stored.firmware_version, null);
      assert.equal(stored.firmware_status, "unknown");
      assert.equal(stored.migrated_from, 1);
      assert.deepEqual(Object.keys(toLegacyEventView(stored)).filter((k) => k !== "_id").sort(), [...LEGACY_EVENT_FIELDS].sort());
    } finally {
      await deleteEvent(doc.event_id, { db });
    }
  });
});

const rejected = {
  "null sin firmware_status": v1({ schema_version: 2, firmware_version: null, migrated_from: 1 }),
  "null sin migrated_from": v1({ schema_version: 2, firmware_version: null, firmware_status: "unknown" }),
  "null con firmware_status reported": v1({ ...UNKNOWN, firmware_status: "reported" }),
  "firmware conocido marcado unknown": v1({ schema_version: 2, firmware_version: "1.4.0", firmware_status: "unknown" }),
  "firmware conocido con migrated_from": v1({ schema_version: 2, firmware_version: "1.4.0", migrated_from: 1 }),
  "migrated_from distinto de 1": v1({ ...UNKNOWN, migrated_from: 2 }),
  "firmware_status inventado": v1({ ...UNKNOWN, firmware_status: "legacy" }),
  "firmware como texto vacio": v1({ ...UNKNOWN, firmware_version: "" }),
  "v1 con firmware_status": v1({ firmware_status: "unknown" }),
  "v1 con migrated_from": v1({ migrated_from: 1 })
};
for (const [name, doc] of Object.entries(rejected)) {
  test(`[M07][declared failure] events rechaza: ${name}`, async () => {
    await withMongo(async (db) => {
      try {
        await assert.rejects(db.collection("events").insertOne(doc), { code: 121 });
      } finally {
        await db.collection("events").deleteOne({ event_id: doc.event_id });
      }
    });
    assert.throws(() => assertEventVersion(doc), /Evento invalido/);
  });
}

test("[M07][declared failure] la vista legada no oculta una version desconocida", () => {
  assert.throws(() => toLegacyEventView(v1({ schema_version: 3 })), /desconocida/);
  assert.throws(() => toEventView(v1({ schema_version: "2" })), /desconocida/);
});

test("[M07][declared failure] una migracion que deja un estado invalido se rechaza y el documento queda igual", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const coll = db.collection(FIXTURE);
    const id = "d7000000-0002-4000-8000-000000000002";
    const original = await coll.findOne({ event_id: id });
    await assert.rejects(coll.updateOne({ event_id: id }, { $set: { schema_version: 2, firmware_version: null } }), { code: 121 });
    await assert.rejects(coll.updateOne({ event_id: id }, { $set: { ...UNKNOWN, firmware_version: "0.0.0" } }), { code: 121 });
    assert.deepEqual(await coll.findOne({ event_id: id }), original);
    await assert.rejects(findEventsByDevice(db, { ...query, shape: "m05" }), /shape invalido/);
  });
});
