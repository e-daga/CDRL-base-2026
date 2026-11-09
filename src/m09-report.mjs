import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withMongo, acknowledgeAlertWithAudit, findEventsPage } from "./mongo.mjs";
import { withMongoAs, MONGO_ACCOUNTS, mongoAccount } from "./mongo-accounts.mjs";
import { remediateTemporaryPermission } from "./m09-remediation.mjs";

const normalizePrivileges = (items) => items.flatMap((p) => p.actions.map((a) => `${p.resource.db}:${p.resource.collection}:${a}`)).sort();

export async function collectM09() {
  const eventId = randomUUID(), alertId = randomUUID(), missingId = randomUUID();
  const operationIds = [randomUUID(), randomUUID(), randomUUID()];
  const device = `dev_m09_${randomUUID().replaceAll("-", "")}`;
  const actor = "synthetic:m09-operator";
  const event = { event_id: eventId, device_id: device, event_type: "temperature_c",
    observed_at: new Date(Date.now() - 60000), ingested_at: new Date(), metric_value: 20,
    unit: "C", severity: "info", source: "synthetic-m09-report", payload: {} };
  const alert = { alert_id: alertId, event_id: eventId, device_id: device,
    alert_type: "threshold", status: "open", severity: "warning",
    opened_at: new Date(Date.now() - 60000), acknowledged_at: null, resolved_at: null };
  let report;
  try {
    const accounts = [];
    for (const [name, declaration] of Object.entries(MONGO_ACCOUNTS)) {
      const auth = await withMongoAs(name, (db) => db.command({ connectionStatus: 1, showPrivileges: true }));
      assert.deepEqual(auth.authInfo.authenticatedUsers, [{ user: mongoAccount(name).user, db: "cdrl" }]);
      assert.deepEqual(auth.authInfo.authenticatedUserRoles, [{ role: declaration.role, db: "cdrl" }]);
      assert.deepEqual(normalizePrivileges(auth.authInfo.authenticatedUserPrivileges), normalizePrivileges(declaration.privileges));
      accounts.push({ account: name, role: declaration.role, privileges: auth.authInfo.authenticatedUserPrivileges });
    }
    await withMongoAs("ingest", (db) => db.collection("events").insertOne(event));
    await withMongoAs("operator", (db) => db.collection("alerts").insertOne(alert));
    const page = await withMongoAs("reader", (db) => findEventsPage(db, { deviceId: device, limit: 1 }));
    assert.equal(page.items[0].event_id, eventId);
    const acknowledge = (id, operationId) => withMongoAs("operator", (db) => acknowledgeAlertWithAudit(id, { db, operationId, actor }));
    const success = await acknowledge(alertId, operationIds[0]);
    assert.equal(success.status, "completed");
    const replay = await acknowledge(alertId, operationIds[0]);
    assert.equal(replay.replayed, true);
    const missing = await acknowledge(missingId, operationIds[1]);
    const conflict = await acknowledge(alertId, operationIds[2]);
    assert.equal(missing.status, "not_found");
    assert.equal(conflict.status, "conflict");

    const snapshot = () => withMongo(async (db) => ({
      event: await db.collection("events").findOne({ event_id: eventId }),
      alert: await db.collection("alerts").findOne({ alert_id: alertId }),
      audit: await db.collection("alert_audit").find({ operation_id: { $in: operationIds } }).sort({ operation_id: 1 }).toArray()
    }));
    const before = await snapshot();
    const denials = [];
    const probes = [
      ["reader", "events.insert", "events", (db) => db.collection("events").insertOne({ ...event, _id: undefined, event_id: randomUUID() })],
      ["reader", "events.update", "events", (db) => db.collection("events").updateOne({ event_id: eventId }, { $set: { metric_value: 99 } })],
      ["ingest", "alerts.read", "alerts", (db) => db.collection("alerts").findOne({ alert_id: alertId })],
      ["auditor", "events.read", "events", (db) => db.collection("events").findOne({ event_id: eventId })],
      ["reader", "audit.update", "alert_audit", (db) => db.collection("alert_audit").updateOne({ operation_id: operationIds[0] }, { $set: { actor: "synthetic:forged" } })],
      ["operator", "audit.delete", "alert_audit", (db) => db.collection("alert_audit").deleteOne({ operation_id: operationIds[0] })]
    ];
    for (const [account, action, resource, attempt] of probes) {
      await withMongoAs(account, async (db) => {
        await assert.rejects(attempt(db), { code: 13, codeName: "Unauthorized" });
      });
      denials.push({ actor: `synthetic:${account}`, action, resource, result: "denied", serverCode: 13, occurred_at: new Date() });
    }
    assert.deepEqual(await snapshot(), before, "Los intentos denegados no deben cambiar datos.");
    const auditRecords = await withMongoAs("auditor", (db) => db.collection("alert_audit")
      .find({ operation_id: { $in: operationIds } }, { projection: { _id: 0 } }).sort({ operation_id: 1 }).toArray());
    assert.equal(auditRecords.length, 3);
    for (const record of auditRecords) {
      assert.equal(record.actor, actor);
      assert.equal(record.action, "alert.acknowledged");
      assert.equal(record.resource.type, "alert");
      assert.equal(record.audit_status, "completed");
      assert.ok(["success", "denied"].includes(record.result));
    }
    report = { status: "passed", accounts, allowed: { ingest: true, reader: true, operator: true, auditor: true },
      deniedOperations: denials, dataUnchangedAfterDenials: true,
      audit: { records: auditRecords, replayedWithoutDuplicate: replay.replayed,
        scope: "alert acknowledgment flow; denials here are not_found/state_conflict, not database authorization failures",
        authorizationProbes: "The separate deniedOperations evidence records real server responses; it is not a general database audit log." },
      remediation: await remediateTemporaryPermission() };
  } finally {
    await withMongo(async (db) => {
      await db.collection("alert_audit").deleteMany({ operation_id: { $in: operationIds } });
      await db.collection("alerts").deleteOne({ alert_id: alertId, device_id: device });
      await db.collection("events").deleteMany({ device_id: device, source: event.source });
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: { $in: operationIds } }), 0);
      assert.equal(await db.collection("alerts").countDocuments({ alert_id: alertId }), 0);
      assert.equal(await db.collection("events").countDocuments({ device_id: device }), 0);
    });
  }
  return { ...report, fixtureCleanupVerified: true, generatedAt: new Date().toISOString() };
}
