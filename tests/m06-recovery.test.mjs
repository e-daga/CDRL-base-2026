import test from "node:test";
import assert from "node:assert/strict";
import { withMongo } from "../src/mongo.mjs";
import { prepareRecovery, recoveryFixture, recoveryExperiment, backupFixture, restoreFixture, RECOVERY_COLLECTION } from "../src/m06-recovery.mjs";

test("[M06][normal] recupera un fixture completo y mide el resultado", async () => {
  await withMongo(async (db) => {
    const result = await recoveryExperiment(db);
    assert.equal(result.recovered, 1);
    assert.equal(result.differences, 0);
    assert.equal(result.originalSha256, result.recoveredSha256);
    assert.ok(result.recoveryMs >= 0 && Number.isFinite(result.recoveryMs));
  });
});

test("[M06][boundary] repetir restauracion no duplica el fixture", async () => {
  await withMongo(async (db) => {
    await recoveryExperiment(db);
    const backup = await backupFixture(db);
    assert.deepEqual(await restoreFixture(db, backup), { restored: 0, alreadyPresent: true });
    assert.equal(await db.collection(RECOVERY_COLLECTION).countDocuments(), 1);
  });
});

test("[M06][boundary] fixture ausente no produce respaldo vacio", async () => {
  await withMongo(async (db) => {
    await recoveryExperiment(db);
    const backup = await backupFixture(db);
    await db.collection(RECOVERY_COLLECTION).deleteOne({ _id: recoveryFixture()._id });
    try { await assert.rejects(backupFixture(db), /ausente/); }
    finally { await restoreFixture(db, backup); }
  });
});

test("[M06][declared failure] respaldo corrupto o destino ajeno no modifica datos", async () => {
  await withMongo(async (db) => {
    await recoveryExperiment(db);
    const backup = await backupFixture(db);
    const corrupt = structuredClone(backup);
    corrupt.document.unit = "corrupted";
    await assert.rejects(restoreFixture(db, corrupt), /Checksum/);
    await assert.rejects(restoreFixture(db, { ...backup, collection: "events" }), /Destino/);
    assert.deepEqual(await backupFixture(db), backup);
  });
});

test("[M06][declared failure] error al persistir respaldo impide borrar el fixture", async () => {
  await withMongo(async (db) => {
    await assert.rejects(recoveryExperiment(db, async () => { throw new Error("backup unavailable"); }), /backup unavailable/);
    assert.equal(await db.collection(RECOVERY_COLLECTION).countDocuments(), 1);
    await backupFixture(db);
  });
});

test("[M06][declared failure] datos ajenos en coleccion aislada bloquean experimento", async () => {
  await withMongo(async (db) => {
    const collection = await prepareRecovery(db);
    const alien = { ...recoveryFixture(), _id: "m06-test-foreign", event_id: "d0000000-0000-4000-8000-000000000007" };
    await collection.insertOne(alien);
    try {
      await assert.rejects(recoveryExperiment(db), /datos ajenos/);
      assert.ok(await collection.findOne({ _id: alien._id }));
    } finally { await collection.deleteOne({ _id: alien._id }); }
  });
});
