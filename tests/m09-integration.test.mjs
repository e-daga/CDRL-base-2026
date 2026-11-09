import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withMongo, acknowledgeAlertWithAudit } from "../src/mongo.mjs";
import { withMongoAs } from "../src/mongo-accounts.mjs";
import { collectM09 } from "../src/m09-report.mjs";

const fixture = async (work) => {
  const alertId = randomUUID(), operationId = randomUUID();
  try {
    await withMongoAs("operator", (db) => db.collection("alerts").insertOne({
      alert_id: alertId, event_id: randomUUID(), device_id: "dev_m09_integration",
      alert_type: "threshold", status: "open", severity: "warning", opened_at: new Date(Date.now() - 60000)
    }));
    await work(alertId, operationId);
  } finally {
    await withMongo((db) => db.collection("alerts").deleteOne({ alert_id: alertId }));
    await withMongo((db) => db.collection("alert_audit").deleteOne({ operation_id: operationId }));
  }
};

test("[M09][normal] evidencia real integra permisos, auditoria y remediacion sin dejar fixtures", async () => {
  const report = await collectM09();
  assert.equal(report.status, "passed");
  assert.equal(report.accounts.length, 4);
  assert.equal(report.deniedOperations.length, 6);
  assert.ok(report.deniedOperations.every((r) => r.serverCode === 13 && r.actor && r.action && r.resource && r.result === "denied"));
  assert.equal(report.audit.records.filter((r) => r.result === "success").length, 1);
  assert.equal(report.audit.records.filter((r) => r.result === "denied").length, 2);
  assert.equal(report.remediation.before.deleted, 1);
  assert.equal(report.remediation.after.deleteDeniedCode, 13);
  assert.equal(report.remediation.after.retained, 1);
  assert.equal(report.remediation.cleanupCompleted, true);
  assert.equal(report.fixtureCleanupVerified, true);
});

test("[M09][boundary] denegacion por recurso inexistente es idempotente con la cuenta operator", async () => {
  await fixture(async (_, operationId) => {
    const missingId = randomUUID();
    await withMongoAs("operator", async (db) => {
      const options = { db, operationId, actor: "synthetic:m09-retry" };
      assert.equal((await acknowledgeAlertWithAudit(missingId, options)).result, "denied");
      assert.equal((await acknowledgeAlertWithAudit(missingId, options)).replayed, true);
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: operationId }), 1);
    });
  });
});

test("[M09][boundary] actor mal formado y operation_id ajeno no alteran auditoria", async () => {
  await fixture(async (alertId, operationId) => {
    await withMongoAs("operator", async (db) => {
      for (const actor of ["personal@example.invalid", "synthetic:actor\nforged", "synthetic:" + "x".repeat(65)]) {
        await assert.rejects(acknowledgeAlertWithAudit(alertId, { db, operationId, actor }), /actor/);
      }
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: operationId }), 0);
      await acknowledgeAlertWithAudit(alertId, { db, operationId, actor: "synthetic:m09-owner" });
      const before = await db.collection("alert_audit").findOne({ operation_id: operationId });
      await assert.rejects(acknowledgeAlertWithAudit(alertId, { db, operationId, actor: "synthetic:m09-other" }), /otra/);
      assert.deepEqual(await db.collection("alert_audit").findOne({ operation_id: operationId }), before);
    });
  });
});

test("[M09][declared failure] error al cerrar auditoria no filtra causa ni informa exito, y permite recuperar", async () => {
  await fixture(async (alertId, operationId) => {
    await withMongoAs("operator", async (db) => {
      const broken = new Proxy(db, {
        get(target, key) {
          if (key === "collection") return (name) => {
            const collection = target.collection(name);
            if (name !== "alert_audit") return collection;
            return new Proxy(collection, {
              get(c, property) {
                if (property === "updateOne") return async () => { throw new Error("synthetic-sensitive-canary"); };
                const value = Reflect.get(c, property, c);
                return typeof value === "function" ? value.bind(c) : value;
              }
            });
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const options = { operationId, actor: "synthetic:m09-failure" };
      await assert.rejects(acknowledgeAlertWithAudit(alertId, { ...options, db: broken }), (error) => {
        assert.equal(error.code, "AUDIT_PENDING");
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes("synthetic-sensitive-canary"));
        return true;
      });
      assert.equal((await db.collection("alert_audit").findOne({ operation_id: operationId })).audit_status, "pending");
      const result = await acknowledgeAlertWithAudit(alertId, { ...options, db });
      assert.equal(result.status, "completed");
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: operationId, audit_status: "completed" }), 1);
    });
  });
});

test("[M09][declared failure] reader no puede usar el flujo de operador para escalar permisos", async () => {
  await fixture(async (alertId, operationId) => {
    await withMongoAs("reader", (db) => assert.rejects(
      acknowledgeAlertWithAudit(alertId, { db, operationId, actor: "synthetic:m09-reader" }),
      { code: 13, codeName: "Unauthorized" }
    ));
    await withMongo(async (db) => {
      assert.equal((await db.collection("alerts").findOne({ alert_id: alertId })).status, "open");
      assert.equal(await db.collection("alert_audit").countDocuments({ operation_id: operationId }), 0);
    });
  });
});
