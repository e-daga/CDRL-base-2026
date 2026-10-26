import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { findEventsByDevice } from "./mongo.mjs";
import { digest } from "./m06-recovery.mjs";
import { LEGACY_EVENT_FIELDS, toLegacyEventView } from "./event-versions.mjs";
import { inspectEventMigration, migrateEventsV1, rollbackEventMigration } from "../scripts/event-migration.mjs";

const load = (file) => JSON.parse(fs.readFileSync(new URL("../tests/fixtures/m07/" + file, import.meta.url), "utf8"));
export const migrationFixtures = () => load("events-legacy.json").map((d) => ({
  ...d, observed_at: new Date(d.observed_at), ingested_at: new Date(d.ingested_at)
}));
export const MIGRATION_SCOPE = { source: "synthetic-m07" };

export async function withMigrationFixture(db, work) {
  const suffix = randomUUID().replaceAll("-", "");
  const collection = "m07_delivery_" + suffix;
  const journalCollection = "m07_journal_" + suffix;
  const owned = [];
  try {
    const source = await db.listCollections({ name: "events" }).next();
    assert.ok(source?.options.validator, "Falta el contrato de events.");
    await db.createCollection(collection, { validator: source.options.validator, validationLevel: "strict", validationAction: "error" });
    owned.push(collection);
    await db.createCollection(journalCollection);
    owned.push(journalCollection);
    await db.collection(collection).createIndex({ event_id: 1 }, { unique: true });
    await db.collection(collection).insertMany(migrationFixtures());
    return await work({ collection, journalCollection, runId: randomUUID(), batchSize: 2 });
  } finally {
    // Drop only collections successfully created by this invocation.
    for (const name of owned.reverse()) await db.collection(name).drop();
  }
}

function legacyConsumer(rows) {
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).filter((key) => key !== "_id").sort(), [...LEGACY_EVENT_FIELDS].sort());
    assert.ok(row.observed_at instanceof Date && row.ingested_at instanceof Date);
    assert.equal(typeof row.metric_value, "number");
  }
  return {
    critical: rows.filter((r) => r.severity === "critical").length,
    rows: rows.map(({ event_id, event_type, observed_at, metric_value, unit, severity, payload }) =>
      ({ event_id, event_type, observed_at: observed_at.toISOString(), metric_value, unit, severity, payload }))
  };
}

export async function collectM07(db) {
  return withMigrationFixture(db, async (options) => {
    const started = performance.now();
    const collection = db.collection(options.collection);
    const readAll = () => collection.find({}).sort({ event_id: 1 }).toArray();
    const before = await readAll();
    const expected = load("legacy-consumer-expected.json");
    const phases = [];
    const checkConsumer = async (phase) => {
      const rows = await findEventsByDevice(db, { collection: options.collection, shape: "legacy",
        deviceId: "dev_m07_a", from: "2026-10-12", to: "2026-10-14", limit: 100 });
      const consumed = legacyConsumer(rows);
      assert.deepEqual(consumed, expected, phase);
      assert.deepEqual((await readAll()).map(toLegacyEventView), before.map(toLegacyEventView), "Campos e IDs conservados: " + phase);
      phases.push({ phase, documents: rows.length, consumerSha256: digest(consumed), legacyCompatible: true,
        v1: await collection.countDocuments({ schema_version: { $exists: false } }),
        v2: await collection.countDocuments({ schema_version: 2 }) });
    };
    await checkConsumer("before");
    const inspection = await inspectEventMigration(db, MIGRATION_SCOPE, options);
    assert.equal(inspection.pending, 4);
    assert.equal(await db.collection(options.journalCollection).countDocuments(), 0);
    const partial = await migrateEventsV1(db, MIGRATION_SCOPE, { ...options, maxBatches: 1 });
    assert.equal(partial.changed, 2);
    assert.equal(partial.remaining, 2);
    await checkConsumer("during");
    const resumed = await migrateEventsV1(db, MIGRATION_SCOPE, options);
    assert.equal(resumed.changed, 2);
    assert.equal(resumed.remaining, 0);
    const migrated = await readAll();
    await checkConsumer("after");
    const repeated = await migrateEventsV1(db, MIGRATION_SCOPE, options);
    assert.equal(repeated.changed, 0);
    assert.deepEqual(await readAll(), migrated);
    const rolledBack = await rollbackEventMigration(db, options.runId, options);
    assert.equal(rolledBack.reverted, 4);
    assert.equal(rolledBack.unresolved_conflicts, 0);
    assert.deepEqual(await readAll(), before, "Rollback exacto de documentos, tipos e IDs.");
    await checkConsumer("rollback");
    const rollbackRepeated = await rollbackEventMigration(db, options.runId, options);
    assert.equal(rollbackRepeated.reverted, 0);
    assert.deepEqual(await readAll(), before);
    return {
      status: "passed", scope: "Six synthetic documents in per-run isolated collections; not application events.",
      phases, inspection, partial, resumed, repeated, rolledBack, rollbackRepeated,
      beforeSha256: digest(before), restoredSha256: digest(await readAll()),
      originalDocuments: before.length, nativeV2Unchanged: 2, differencesAfterRollback: 0,
      elapsedMs: performance.now() - started,
      limitations: ["No cross-document transaction", "Legacy consumers must request shape=legacy", "Timings are fixture measurements, not production latency"],
      fixtureCleanup: "Owned temporary collections removed before the report returns."
    };
  });
}
