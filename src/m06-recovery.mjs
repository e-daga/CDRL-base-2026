import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BSON } from "mongodb";
import { acknowledgeAlertWithAudit } from "./alert-audit.mjs";
import { countEventsBySchemaVersion } from "./event-versions.mjs";

export const RECOVERY_COLLECTION = "m06_recovery_fixture";
export const recoveryFixture = () => ({
  _id: "m06-recovery-only",
  event_id: "d0000000-0000-4000-8000-000000000006",
  device_id: "dev_m06_recovery", event_type: "battery_pct",
  observed_at: new Date("2026-10-01T08:00:00Z"),
  ingested_at: new Date("2026-10-01T08:00:02Z"),
  metric_value: 42, unit: "%", severity: "info",
  source: "synthetic-recovery-m06", payload: {},
  schema_version: 2, firmware_version: "1.4.0"
});
const ordered = (value) => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  return value;
};
export const digest = (doc) => createHash("sha256").update(JSON.stringify(ordered(BSON.EJSON.serialize(doc, { relaxed: false })))).digest("hex");

export async function prepareRecovery(db) {
  const original = await db.listCollections({ name: "events" }).next();
  assert.ok(original?.options.validator, "Preparar el contrato de events primero.");
  const existing = await db.listCollections({ name: RECOVERY_COLLECTION }).next();
  if (!existing) {
    await db.createCollection(RECOVERY_COLLECTION, {
      validator: original.options.validator, validationLevel: "strict", validationAction: "error"
    });
  } else {
    assert.deepEqual(existing.options.validator, original.options.validator, "Coleccion aislada con contrato incompatible.");
  }
  const collection = db.collection(RECOVERY_COLLECTION);
  const docs = await collection.find({}).toArray();
  assert.ok(docs.length <= 1 && docs.every((d) => digest(d) === digest(recoveryFixture())), "Se encontraron datos ajenos: no se modifica la coleccion.");
  return collection;
}

export async function backupFixture(db) {
  const doc = await db.collection(RECOVERY_COLLECTION).findOne({ _id: recoveryFixture()._id });
  assert.ok(doc, "Fixture ausente: no se genera un respaldo vacio.");
  assert.equal(digest(doc), digest(recoveryFixture()), "Solo se respalda el fixture sintetico permitido.");
  return {
    format: "cdrl-m06-fixture-v1", collection: RECOVERY_COLLECTION,
    sha256: digest(doc), document: BSON.EJSON.serialize(doc, { relaxed: false })
  };
}

export async function restoreFixture(db, backup) {
  assert.equal(backup?.format, "cdrl-m06-fixture-v1", "Formato de respaldo invalido.");
  assert.equal(backup.collection, RECOVERY_COLLECTION, "Destino no permitido.");
  const doc = BSON.EJSON.deserialize(backup.document);
  assert.equal(digest(doc), backup.sha256, "Checksum invalido.");
  assert.equal(digest(doc), digest(recoveryFixture()), "Contenido no autorizado.");
  const collection = await prepareRecovery(db);
  const current = await collection.findOne({ _id: doc._id });
  if (current) return { restored: 0, alreadyPresent: true };
  try { await collection.insertOne(doc); }
  catch (error) {
    if (error.code !== 11000 || digest(await collection.findOne({ _id: doc._id })) !== backup.sha256) throw error;
    return { restored: 0, alreadyPresent: true };
  }
  return { restored: 1, alreadyPresent: false };
}

export async function recoveryExperiment(db, persistBackup) {
  const collection = await prepareRecovery(db);
  if (!await collection.findOne({ _id: recoveryFixture()._id })) await collection.insertOne(recoveryFixture());
  const backup = await backupFixture(db);
  // Persist before fault injection; a failed backup must never delete the fixture.
  const persisted = persistBackup ? await persistBackup(backup) : backup;
  assert.deepEqual(persisted, backup, "El respaldo releido no coincide; no se borra el fixture.");
  const start = performance.now();
  const deleted = await collection.deleteOne({ _id: recoveryFixture()._id, source: "synthetic-recovery-m06" });
  assert.equal(deleted.deletedCount, 1);
  const missingAfterFailure = await collection.countDocuments({ _id: recoveryFixture()._id });
  assert.equal(missingAfterFailure, 0);
  const result = await restoreFixture(db, persisted);
  const recovered = await collection.findOne({ _id: recoveryFixture()._id });
  const recoveredHash = digest(recovered);
  assert.equal(recoveredHash, backup.sha256);
  const recoveryMs = performance.now() - start;
  const replay = await restoreFixture(db, backup);
  assert.equal(replay.restored, 0);
  return {
    status: "passed", failure: "controlled deletion of one isolated synthetic document",
    collection: RECOVERY_COLLECTION, expected: 1, missingAfterFailure,
    recovered: result.restored, lostDocuments: 0, differences: 0,
    recoveryMs, originalSha256: backup.sha256, recoveredSha256: recoveredHash,
    repeatedRestore: replay,
    scope: "Includes deletion, absence check, restore and read-back; not full database RTO/RPO."
  };
}

export async function collectM06(db, persistBackup) {
  const evolution = await countEventsBySchemaVersion(db, { source: { $in: ["synthetic-seed", "synthetic-seed-m06"] } });
  assert.deepEqual(evolution, { v1: 8, v2: 3 });
  const alertId = randomUUID();
  const operationId = randomUUID();
  let audit;
  try {
    await db.collection("alerts").insertOne({
      alert_id: alertId, event_id: randomUUID(), device_id: "dev_m06_demo",
      alert_type: "threshold", status: "open", severity: "warning",
      opened_at: new Date(Date.now() - 60000), acknowledged_at: null, resolved_at: null
    });
    await acknowledgeAlertWithAudit(alertId, { db, operationId, actor: "synthetic:m06-demo" });
    const { _id, ...record } = await db.collection("alert_audit").findOne({ operation_id: operationId });
    assert.equal(record.audit_status, "completed");
    audit = record;
  } finally {
    await db.collection("alerts").deleteOne({ alert_id: alertId });
    await db.collection("alert_audit").deleteOne({ operation_id: operationId });
  }
  return { evolution, audit, recovery: await recoveryExperiment(db, persistBackup) };
}
