import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";
import { withMongo, createAlert, acknowledgeAlertWithAudit } from "../src/mongo.mjs";

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
});

test("[M06][declared failure] misma fecha no permite atribuir otra operacion", async () => {
  await withMongo(async (db) => {
    const id = randomUUID(), first = randomUUID(), second = randomUUID();
    const actor = "synthetic:m06-safety";
    try {
      await createAlert({ alert_id: id, event_id: randomUUID(), device_id: "dev_audit_safety",
        alert_type: "threshold", status: "open", severity: "info",
        opened_at: new Date(Date.now() - 60000) }, { db });
      await acknowledgeAlertWithAudit(id, { db, operationId: first, actor });
      const { _id, ...record } = await db.collection("alert_audit").findOne({ operation_id: first });
      await db.collection("alert_audit").insertOne({
        ...record, operation_id: second, result: "success",
        result_code: "alert_acknowledged", audit_status: "pending"
      });
      const denied = await acknowledgeAlertWithAudit(id, { db, operationId: second, actor });
      assert.equal(denied.status, "conflict");
      assert.equal(denied.result, "denied");
      const denialRecord = await db.collection("alert_audit").findOne({ operation_id: second });
      assert.equal(denialRecord.audit_status, "completed");
      assert.equal(denialRecord.result_code, "alert_state_conflict");
      assert.equal(Object.hasOwn(denialRecord, "changes"), false);
      assert.equal((await db.collection("alerts").findOne({ alert_id: id })).audit_operation_id, first);
      await assert.rejects(acknowledgeAlertWithAudit(id, { db, operationId: first, actor: "synthetic:other" }), /otra/);
    } finally {
      await db.collection("alerts").deleteOne({ alert_id: id });
      await db.collection("alert_audit").deleteMany({ operation_id: { $in: [first, second] } });
    }
  });
});

test("[M06][boundary] reintentos concurrentes guardan una sola auditoria", async () => {
  await withMongo(async (db) => {
    const id = randomUUID(), operationId = randomUUID();
    try {
      await createAlert({ alert_id: id, event_id: randomUUID(), device_id: "dev_audit_safety",
        alert_type: "threshold", status: "open", severity: "info",
        opened_at: new Date(Date.now() - 60000) }, { db });
      const results = await Promise.all(Array.from({ length: 4 }, () =>
        acknowledgeAlertWithAudit(id, { db, operationId, actor: "synthetic:concurrent" })));
      assert.ok(results.every((r) => r.status === "completed"));
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: operationId }), 1);
    } finally {
      await db.collection("alerts").deleteOne({ alert_id: id });
      await db.collection("alert_audit").deleteOne({ operation_id: operationId });
    }
  });
});
