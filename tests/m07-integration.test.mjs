import test from "node:test";
import assert from "node:assert/strict";
import { withMongo } from "../src/mongo.mjs";
import { collectM07, withMigrationFixture, MIGRATION_SCOPE } from "../src/m07-experiment.mjs";
import { migrateEventsV1, rollbackEventMigration } from "../scripts/event-migration.mjs";

test("[M07][normal] migracion real conserva consumidor antes durante despues y rollback", async () => {
  await withMongo(async (db) => {
    const result = await collectM07(db);
    assert.equal(result.phases.length, 4);
    assert.equal(new Set(result.phases.map((p) => p.consumerSha256)).size, 1);
    assert.equal(result.beforeSha256, result.restoredSha256);
  });
});

test("[M07][boundary] alcance vacio de datos no cambia documentos ni inventa trabajo", async () => {
  await withMongo((db) => withMigrationFixture(db, async (options) => {
    const result = await migrateEventsV1(db, { source: "synthetic-missing" }, options);
    assert.equal(result.changed, 0);
    assert.equal(result.remaining, 0);
    assert.equal((await rollbackEventMigration(db, options.runId, options)).reverted, 0);
  }));
});

test("[M07][boundary] rollback repetido no oculta conflictos pendientes", async () => {
  await withMongo((db) => withMigrationFixture(db, async (options) => {
    await migrateEventsV1(db, MIGRATION_SCOPE, options);
    const events = db.collection(options.collection);
    const changed = await events.findOne({ migrated_from: 1 });
    await events.updateOne({ _id: changed._id }, { $set: { metric_value: 37 } });
    const first = await rollbackEventMigration(db, options.runId, options);
    const second = await rollbackEventMigration(db, options.runId, options);
    assert.equal(first.conflicts, 1);
    assert.equal(second.conflicts, 0);
    assert.equal(second.unresolved_conflicts, 1);
    assert.equal((await events.findOne({ _id: changed._id })).metric_value, 37);
    await assert.rejects(migrateEventsV1(db, MIGRATION_SCOPE, options), /inicio rollback/);
  }));
});

test("[M07][declared failure] recupera escritura aplicada antes de guardar estado del diario", async () => {
  await withMongo((db) => withMigrationFixture(db, async (options) => {
    let fail = true;
    const failingDb = {
      collection(name) {
        const real = db.collection(name);
        if (name !== options.journalCollection) return real;
        return new Proxy(real, {
          get(target, key) {
            if (key === "updateOne") return async (...args) => {
              if (fail && args[1]?.$set?.status === "applied") { fail = false; throw new Error("controlled journal interruption"); }
              return target.updateOne(...args);
            };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    };
    await assert.rejects(migrateEventsV1(failingDb, MIGRATION_SCOPE, options), /controlled journal interruption/);
    assert.equal(await db.collection(options.collection).countDocuments({ migrated_from: 1 }), 1);
    const resumed = await migrateEventsV1(db, MIGRATION_SCOPE, options);
    assert.equal(resumed.changed, 3);
    assert.equal(resumed.remaining, 0);
    assert.equal((await rollbackEventMigration(db, options.runId, options)).reverted, 4);
  }));
});

test("[M07][declared failure] requiere run-id y diario separado sin escribir", async () => {
  await withMongo((db) => withMigrationFixture(db, async (options) => {
    await assert.rejects(migrateEventsV1(db, MIGRATION_SCOPE, { ...options, runId: undefined }), /UUID/);
    await assert.rejects(migrateEventsV1(db, MIGRATION_SCOPE, { ...options, journalCollection: options.collection }), /separado/);
    assert.equal(await db.collection(options.journalCollection).countDocuments(), 0);
    assert.equal(await db.collection(options.collection).countDocuments({ schema_version: { $exists: false } }), 4);
  }));
});
