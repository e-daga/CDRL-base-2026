import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";
import { withMongo, createAlert, readAlert, acknowledgeAlertWithAudit } from "../src/mongo.mjs";

const AUDIT_COLLECTION = "alert_audit";

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
});

const alertFactory = () => ({
  alert_id: randomUUID(),
  event_id: randomUUID(),
  device_id: "dev_audit_test",
  alert_type: "threshold",
  status: "open",
  severity: "warning",
  opened_at: new Date(Date.now() - 60_000),
  acknowledged_at: null,
  resolved_at: null
});

const cleanup = async (db, alertId, operationId) => {
  await db.collection("alerts").deleteOne({ alert_id: alertId });
  await db.collection(AUDIT_COLLECTION).deleteOne({ operation_id: operationId });
};

test("[M06][normal] reconoce alerta y registra sólo campos permitidos", async () => {
  await withMongo(async (db) => {
    const alert = alertFactory();
    const operationId = randomUUID();
    const actor = "synthetic:operator-01";
    try {
      await createAlert(alert, { db });
      const result = await acknowledgeAlertWithAudit(alert.alert_id, { db, operationId, actor });
      const savedAlert = await readAlert(alert.alert_id, { db });
      const audit = await db.collection(AUDIT_COLLECTION).findOne({ operation_id: operationId });

      assert.equal(result.status, "completed");
      assert.equal(result.replayed, false);
      assert.equal(savedAlert.status, "acknowledged");
      assert.ok(savedAlert.acknowledged_at instanceof Date);
      assert.deepEqual(Object.keys(audit).filter((key) => key !== "_id").sort(), [
        "action", "actor", "alert_id", "audit_status", "changes", "occurred_at", "operation_id"
      ]);
      assert.equal(audit.action, "alert.acknowledged");
      assert.equal(audit.actor, actor);
      assert.deepEqual(audit.changes.status, { from: "open", to: "acknowledged" });
      assert.equal(audit.changes.acknowledged_at.getTime(), savedAlert.acknowledged_at.getTime());
      assert.equal(audit.audit_status, "completed");

      const info = await db.listCollections({ name: AUDIT_COLLECTION }).next();
      assert.equal(info.options.validationLevel, "strict");
      assert.equal(info.options.validationAction, "error");
      const indexes = await db.collection(AUDIT_COLLECTION).listIndexes().toArray();
      assert.ok(indexes.some((index) => index.name === "uq_alert_audit_operation_id" && index.unique));
      assert.ok(indexes.some((index) => index.name === "idx_alert_audit_alert_occurred"));
      await assert.rejects(
        db.collection(AUDIT_COLLECTION).insertOne({
          operation_id: randomUUID(), alert_id: alert.alert_id, action: "alert.acknowledged",
          occurred_at: new Date(), actor, changes: audit.changes, audit_status: "completed", payload: { secret: "no" }
        }),
        { code: 121 }
      );
    } finally {
      await cleanup(db, alert.alert_id, operationId);
    }
  });
});

test("[M06][retry] el mismo operation_id no repite ni duplica la operación", async () => {
  await withMongo(async (db) => {
    const alert = alertFactory();
    const operationId = randomUUID();
    const options = { db, operationId, actor: "synthetic:operator-02" };
    try {
      await createAlert(alert, { db });
      const first = await acknowledgeAlertWithAudit(alert.alert_id, options);
      const retry = await acknowledgeAlertWithAudit(alert.alert_id, options);
      assert.equal(first.status, "completed");
      assert.equal(retry.status, "completed");
      assert.equal(retry.replayed, true);
      assert.equal(await db.collection(AUDIT_COLLECTION).countDocuments({ operation_id: operationId }), 1);
    } finally {
      await cleanup(db, alert.alert_id, operationId);
    }
  });
});

test("[M06][missing] alerta inexistente no genera cambio ni auditoría", async () => {
  await withMongo(async (db) => {
    const alertId = randomUUID();
    const operationId = randomUUID();
    const result = await acknowledgeAlertWithAudit(alertId, {
      db, operationId, actor: "synthetic:operator-03"
    });
    assert.equal(result.status, "not_found");
    assert.equal(await db.collection(AUDIT_COLLECTION).countDocuments({ operation_id: operationId }), 0);
  });
});

test("[M06][controlled failure] deja auditoría pendiente y la completa al reintentar", async () => {
  await withMongo(async (db) => {
    const alert = alertFactory();
    const operationId = randomUUID();
    let failAuditCompletion = true;
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "collection") {
          return (name) => {
            const collection = target.collection(name);
            if (name !== AUDIT_COLLECTION) return collection;
            return new Proxy(collection, {
              get(collectionTarget, collectionProperty) {
                if (collectionProperty === "updateOne" && failAuditCompletion) {
                  return async () => {
                    failAuditCompletion = false;
                    throw new Error("fallo controlado de auditoría");
                  };
                }
                const value = Reflect.get(collectionTarget, collectionProperty, collectionTarget);
                return typeof value === "function" ? value.bind(collectionTarget) : value;
              }
            });
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    try {
      await createAlert(alert, { db });
      await assert.rejects(
        acknowledgeAlertWithAudit(alert.alert_id, {
          db: failingDb, operationId, actor: "synthetic:operator-04"
        }),
        (error) => error.code === "AUDIT_PENDING" && error.operationId === operationId
      );
      assert.equal((await readAlert(alert.alert_id, { db })).status, "acknowledged");
      assert.equal((await db.collection(AUDIT_COLLECTION).findOne({ operation_id: operationId })).audit_status, "pending");

      const retry = await acknowledgeAlertWithAudit(alert.alert_id, {
        db, operationId, actor: "synthetic:operator-04"
      });
      assert.equal(retry.status, "completed");
      assert.equal(await db.collection(AUDIT_COLLECTION).countDocuments({ operation_id: operationId, audit_status: "completed" }), 1);
    } finally {
      await cleanup(db, alert.alert_id, operationId);
    }
  });
});
