import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rootDir } from "../src/config.mjs";
import { withMongo } from "../src/mongo.mjs";
import { inspectEventMigration, migrateEventsV1, rollbackEventMigration } from "../scripts/event-migration.mjs";

const FIXTURE = "m07_migration_fixture_" + randomUUID().replaceAll("-", "");
const JOURNAL = "m07_migration_journal_fixture_" + randomUUID().replaceAll("-", "");
const SCOPE = { source: "synthetic-m07" };

function fixtureEvents() {
  return [
    { event_id: "d7000000-0001-4000-8000-000000000001", device_id: "dev_m07_a", event_type: "temperature_c", observed_at: new Date("2026-10-12T08:00:00Z"), ingested_at: new Date("2026-10-12T08:00:02Z"), metric_value: 21.5, unit: "C", severity: "info", source: "synthetic-m07", payload: {} },
    { event_id: "d7000000-0002-4000-8000-000000000002", device_id: "dev_m07_a", event_type: "humidity_pct", observed_at: new Date("2026-10-12T09:00:00Z"), ingested_at: new Date("2026-10-12T09:00:02Z"), metric_value: 55, unit: "%", severity: "info", source: "synthetic-m07", payload: {} },
    { event_id: "d7000000-0003-4000-8000-000000000003", device_id: "dev_m07_a", event_type: "battery_pct", observed_at: new Date("2026-10-12T10:00:00Z"), ingested_at: new Date("2026-10-12T10:00:02Z"), metric_value: 0, unit: "%", severity: "warning", source: "synthetic-m07", payload: {} },
    { event_id: "d7000000-0004-4000-8000-000000000004", device_id: "dev_m07_a", event_type: "temperature_c", observed_at: new Date("2026-10-12T11:00:00Z"), ingested_at: new Date("2026-10-12T11:00:02Z"), metric_value: 41.2, unit: "C", severity: "critical", source: "synthetic-m07", payload: { threshold: 40 } },
    { event_id: "d7000000-0005-4000-8000-000000000005", schema_version: 2, firmware_version: "1.4.0", device_id: "dev_m07_a", event_type: "temperature_c", observed_at: new Date("2026-10-13T08:00:00Z"), ingested_at: new Date("2026-10-13T08:00:02Z"), metric_value: 22, unit: "C", severity: "info", source: "synthetic-m07", payload: {} }
  ];
}

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
  await withMongo(async (db) => {
    const events = await db.listCollections({ name: "events" }).next();
    assert.ok(events?.options?.validator, "events debe tener el validador del contrato.");
    await db.collection(FIXTURE).drop().catch(() => {});
    await db.collection(JOURNAL).drop().catch(() => {});
    await db.createCollection(FIXTURE, { validator: events.options.validator, validationLevel: "strict", validationAction: "error" });
    await db.collection(FIXTURE).createIndex({ event_id: 1 }, { unique: true });
  });
});

after(async () => {
  await withMongo(async (db) => {
    await db.collection(FIXTURE).drop().catch(() => {});
    await db.collection(JOURNAL).drop().catch(() => {});
  });
});

async function reset(db) {
  await db.collection(FIXTURE).deleteMany({});
  await db.collection(JOURNAL).deleteMany({});
  await db.collection(FIXTURE).insertMany(fixtureEvents());
}

const options = (runId, extra = {}) => ({
  collection: FIXTURE, journalCollection: JOURNAL, runId, batchSize: 2, ...extra
});

test("[M07 migration] inspección declara alcance, pendientes y lotes sin escribir", async () => {
  await withMongo(async (db) => {
    await reset(db);
    const report = await inspectEventMigration(db, SCOPE, { collection: FIXTURE, batchSize: 2 });
    assert.equal(report.pending, 4);
    assert.equal(report.batches, 2);
    assert.equal(await db.collection(JOURNAL).countDocuments({}), 0);
    await assert.rejects(inspectEventMigration(db, {}, { collection: FIXTURE }), /alcance.*explícito/i);
  });
});

test("[M07 migration] reanuda después de interrupción y la segunda ejecución no modifica nada", async () => {
  await withMongo(async (db) => {
    await reset(db);
    const originalDocs = await db.collection(FIXTURE).find({}).toArray();
    const originalByEventId = new Map(originalDocs.map((doc) => [doc.event_id, doc]));
    const runId = randomUUID();
    const interrupted = await migrateEventsV1(db, SCOPE, options(runId, { maxBatches: 1 }));
    assert.equal(interrupted.changed, 2);
    assert.equal(interrupted.remaining, 2);

    const resumed = await migrateEventsV1(db, SCOPE, options(runId));
    assert.equal(resumed.changed, 2);
    assert.equal(resumed.remaining, 0);
    const replay = await migrateEventsV1(db, SCOPE, options(runId));
    assert.equal(replay.changed, 0);
    assert.equal(replay.remaining, 0);

    const docs = await db.collection(FIXTURE).find({}).sort({ event_id: 1 }).toArray();
    assert.equal(docs.length, 5);
    assert.deepEqual(docs.slice(0, 4).map((doc) => doc.event_id), fixtureEvents().slice(0, 4).map((doc) => doc.event_id));
    assert.ok(docs.slice(0, 4).every((doc) => doc.schema_version === 2 && doc.firmware_version === null && doc.firmware_status === "unknown" && doc.migrated_from === 1));
    for (const doc of docs.slice(0, 4)) {
      const original = originalByEventId.get(doc.event_id);
      assert.equal(doc._id.toString(), original._id.toString());
      const { schema_version, firmware_version, firmware_status, migrated_from, ...preserved } = doc;
      assert.deepEqual(preserved, original, `${doc.event_id}: conservar campos originales`);
    }
    assert.deepEqual(docs[4], { ...fixtureEvents()[4], _id: docs[4]._id }, "un v2 nativo no se modifica");

    const journalRows = await db.collection(JOURNAL).find({ type: "document" }).toArray();
    assert.equal(journalRows.length, 4);
    for (const row of journalRows) {
      assert.deepEqual(Object.keys(row).sort(), ["_id", "after_sha256", "before_sha256", "created_at", "document_id", "event_id", "migration_id", "status", "type", "updated_at"].sort());
      assert.match(row.before_sha256, /^[a-f0-9]{64}$/);
      assert.match(row.after_sha256, /^[a-f0-9]{64}$/);
      assert.equal(row.status, "applied");
    }
  });
});

test("[M07 migration] rollback revierte solo sus cambios y reporta modificaciones posteriores", async () => {
  await withMongo(async (db) => {
    await reset(db);
    const runId = randomUUID();
    await migrateEventsV1(db, SCOPE, options(runId));
    const events = db.collection(FIXTURE);
    const changedId = "d7000000-0002-4000-8000-000000000002";
    await events.updateOne({ event_id: changedId }, { $set: { metric_value: 56 } });
    const nativeBefore = await events.findOne({ event_id: "d7000000-0005-4000-8000-000000000005" });

    const report = await rollbackEventMigration(db, runId, { journalCollection: JOURNAL, batchSize: 2 });
    assert.equal(report.reverted, 3);
    assert.equal(report.conflicts, 1);
    const restored = await events.find({ schema_version: { $exists: false } }).toArray();
    assert.equal(restored.length, 3, "el documento en conflicto permanece migrado y no se sobrescribe");
    assert.equal((await events.findOne({ event_id: changedId })).metric_value, 56);
    assert.equal((await events.findOne({ event_id: changedId })).migrated_from, 1);
    assert.deepEqual(await events.findOne({ event_id: nativeBefore.event_id }), nativeBefore);

    const replay = await rollbackEventMigration(db, runId, { journalCollection: JOURNAL, batchSize: 2 });
    assert.equal(replay.reverted, 0);
    assert.equal(replay.conflicts, 0);
  });
});

test("[M07 migration] una escritura concurrente falla la comparación y no se sobrescribe", async () => {
  await withMongo(async (db) => {
    await reset(db);
    const runId = randomUUID();
    const events = db.collection(FIXTURE);
    let injected = false;
    const racingEvents = new Proxy(events, {
      get(target, key) {
        if (key === "updateOne") {
          return async (...args) => {
            if (!injected) {
              injected = true;
              await target.updateOne({ event_id: fixtureEvents()[0].event_id }, { $set: { metric_value: 24 } });
            }
            return target.updateOne(...args);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const racingDb = { collection(name) { return name === FIXTURE ? racingEvents : db.collection(name); } };
    const report = await migrateEventsV1(racingDb, SCOPE, options(runId));
    assert.equal(report.conflicts, 1);
    const raced = await events.findOne({ event_id: fixtureEvents()[0].event_id });
    assert.equal(raced.metric_value, 24);
    assert.equal(raced.schema_version, undefined);
  });
});

test("[M07 migration] dos corridas concurrentes no reclaman el mismo cambio ni se revierten entre sí", async () => {
  await withMongo(async (db) => {
    await reset(db);
    let arrivals = 0;
    let release;
    const bothReadCandidates = new Promise((resolve) => { release = resolve; });
    const events = db.collection(FIXTURE);
    const wrapCursor = (cursorTarget) => new Proxy(cursorTarget, {
      get(cursor, cursorKey) {
        if (cursorKey === "toArray") {
          return async () => {
            if (arrivals < 2) {
              arrivals += 1;
              if (arrivals === 2) release();
              await bothReadCandidates;
            }
            return cursor.toArray();
          };
        }
        const value = Reflect.get(cursor, cursorKey, cursor);
        if (typeof value !== "function") return value;
        return (...args) => {
          const result = value.apply(cursor, args);
          return result === cursor ? wrapCursor(cursor) : result;
        };
      }
    });
    const synchronizedEvents = new Proxy(events, {
      get(target, key) {
        if (key === "find") {
          return (...args) => wrapCursor(target.find(...args));
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const racingDb = { collection(name) { return name === FIXTURE ? synchronizedEvents : db.collection(name); } };
    const firstRun = randomUUID();
    const secondRun = randomUUID();
    const results = await Promise.all([
      migrateEventsV1(racingDb, SCOPE, options(firstRun)),
      migrateEventsV1(racingDb, SCOPE, options(secondRun))
    ]);
    assert.equal(results.reduce((sum, result) => sum + result.changed, 0), 4);
    assert.equal(results.reduce((sum, result) => sum + result.conflicts, 0), 4);
    const rollbacks = await Promise.all(results.map((result) => rollbackEventMigration(db, result.migration_id, { journalCollection: JOURNAL })));
    assert.deepEqual(rollbacks.map((report) => report.reverted), results.map((result) => result.changed));
    assert.equal(await events.countDocuments({ schema_version: { $exists: false } }), 4);
  });
});
