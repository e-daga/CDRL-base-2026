import { isDeepStrictEqual } from "node:util";

const AUDIT_COLLECTION = "alert_audit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_RE = /^synthetic:[a-z0-9][a-z0-9._-]{0,63}$/;
const AUDIT_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["operation_id", "alert_id", "action", "occurred_at", "actor", "changes", "audit_status"],
    properties: {
      _id: {},
      operation_id: { bsonType: "string", pattern: UUID_RE.source },
      alert_id: { bsonType: "string", pattern: UUID_RE.source },
      action: { enum: ["alert.acknowledged"] },
      occurred_at: { bsonType: "date" },
      actor: { bsonType: "string", pattern: ACTOR_RE.source },
      changes: {
        bsonType: "object",
        additionalProperties: false,
        required: ["status", "acknowledged_at"],
        properties: {
          status: {
            bsonType: "object",
            additionalProperties: false,
            required: ["from", "to"],
            properties: {
              from: { enum: ["open"] },
              to: { enum: ["acknowledged"] }
            }
          },
          acknowledged_at: { bsonType: "date" }
        }
      },
      audit_status: { enum: ["pending", "completed"] }
    }
  }
};

export class AuditPendingError extends Error {
  constructor(operationId, message, cause) {
    super(message, { cause });
    this.name = "AuditPendingError";
    this.code = "AUDIT_PENDING";
    this.operationId = operationId;
  }
}

export async function ensureAuditCollection(db) {
  let collections = await db.listCollections({ name: AUDIT_COLLECTION }).toArray();
  if (collections.length === 0) {
    try {
      await db.createCollection(AUDIT_COLLECTION, {
        validator: AUDIT_VALIDATOR,
        validationLevel: "strict",
        validationAction: "error"
      });
    } catch (error) {
      if (error.code !== 48) throw error;
      collections = await db.listCollections({ name: AUDIT_COLLECTION }).toArray();
      if (collections.length === 0) throw error;
    }
    collections = await db.listCollections({ name: AUDIT_COLLECTION }).toArray();
  }

  const options = collections[0].options;
  if (
    options.validationLevel !== "strict" ||
    options.validationAction !== "error" ||
    !isDeepStrictEqual(options.validator, AUDIT_VALIDATOR)
  ) {
    throw new Error("La colección alert_audit ya existe con un validador incompatible; requiere revisión explícita.");
  }

  const collection = db.collection(AUDIT_COLLECTION);
  await collection.createIndex({ operation_id: 1 }, { unique: true, name: "uq_alert_audit_operation_id" });
  await collection.createIndex(
    { alert_id: 1, occurred_at: -1 },
    { name: "idx_alert_audit_alert_occurred" }
  );
  return collection;
}

function assertRequest(alertId, operationId, actor) {
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) throw new Error("alert_id debe ser un UUID válido.");
  if (typeof operationId !== "string" || !UUID_RE.test(operationId)) throw new Error("operation_id debe ser un UUID válido.");
  if (typeof actor !== "string" || !ACTOR_RE.test(actor)) {
    throw new Error("actor debe ser sintético y cumplir el patrón synthetic:<identificador>.");
  }
}

function assertSameOperation(record, alertId, actor) {
  if (record.alert_id !== alertId || record.action !== "alert.acknowledged" || record.actor !== actor) {
    throw new Error("operation_id ya está asociado a otra operación; no se aplicó ningún cambio.");
  }
}

export async function acknowledgeAlertWithAudit(alertId, { db, operationId, actor } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para auditar la alerta.");
  assertRequest(alertId, operationId, actor);

  const audit = await ensureAuditCollection(db);
  let record = await audit.findOne({ operation_id: operationId });
  if (record) {
    assertSameOperation(record, alertId, actor);
    if (record.audit_status === "completed") {
      return { status: "completed", replayed: true, operation_id: operationId, alert_id: alertId };
    }
  } else {
    const current = await db.collection("alerts").findOne({ alert_id: alertId });
    if (!current) return { status: "not_found", operation_id: operationId, alert_id: alertId };
    if (current.status !== "open") {
      // Another retry may have inserted the intention since our first lookup.
      const concurrent = await audit.findOne({ operation_id: operationId });
      if (concurrent) {
        assertSameOperation(concurrent, alertId, actor);
        return acknowledgeAlertWithAudit(alertId, { db, operationId, actor });
      }
      return { status: "conflict", operation_id: operationId, alert_id: alertId, current_status: current.status };
    }

    const occurredAt = new Date();
    record = {
      operation_id: operationId,
      alert_id: alertId,
      action: "alert.acknowledged",
      occurred_at: occurredAt,
      actor,
      changes: {
        status: { from: "open", to: "acknowledged" },
        acknowledged_at: occurredAt
      },
      audit_status: "pending"
    };
    try {
      await audit.insertOne(record);
    } catch (error) {
      if (error.code !== 11000) throw error;
      record = await audit.findOne({ operation_id: operationId });
      if (!record) throw error;
      assertSameOperation(record, alertId, actor);
      if (record.audit_status === "completed") {
        return { status: "completed", replayed: true, operation_id: operationId, alert_id: alertId };
      }
    }
  }

  try {
    const result = await db.collection("alerts").updateOne(
      { alert_id: alertId, status: "open" },
      { $set: { status: "acknowledged", acknowledged_at: record.occurred_at, audit_operation_id: operationId } }
    );
    if (result.matchedCount === 0) {
      const current = await db.collection("alerts").findOne({ alert_id: alertId });
      const isRetryAfterAppliedChange =
        current?.status === "acknowledged" &&
        current.audit_operation_id === operationId &&
        current.acknowledged_at instanceof Date &&
        current.acknowledged_at.getTime() === record.occurred_at.getTime();
      if (!isRetryAfterAppliedChange) {
        throw new Error("El estado de la alerta cambió antes de aplicar la operación.");
      }
    }
  } catch (error) {
    if (error instanceof AuditPendingError) throw error;
    throw new AuditPendingError(
      operationId,
      "La operación tiene una intención de auditoría pendiente; reintente con el mismo operation_id.",
      error
    );
  }

  try {
    const result = await audit.updateOne(
      { operation_id: operationId, audit_status: "pending" },
      { $set: { audit_status: "completed" } }
    );
    if (result.matchedCount === 0) {
      const completed = await audit.findOne({ operation_id: operationId, audit_status: "completed" });
      if (!completed) throw new Error("No se pudo confirmar el registro de auditoría.");
    }
  } catch (error) {
    throw new AuditPendingError(
      operationId,
      "La alerta pudo quedar actualizada, pero no se pudo confirmar el cierre de auditoría; reintente con el mismo operation_id.",
      error
    );
  }

  return { status: "completed", replayed: false, operation_id: operationId, alert_id: alertId };
}
