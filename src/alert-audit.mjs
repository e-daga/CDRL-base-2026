import { isDeepStrictEqual } from "node:util";

const AUDIT_COLLECTION = "alert_audit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_RE = /^synthetic:[a-z0-9][a-z0-9._-]{0,63}$/;
const RESULT_CODES = ["alert_acknowledged", "alert_not_found", "alert_state_conflict"];
const AUDIT_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["operation_id", "alert_id", "action", "occurred_at", "actor", "audit_status"],
    properties: {
      _id: {},
      operation_id: { bsonType: "string", pattern: UUID_RE.source },
      alert_id: { bsonType: "string", pattern: UUID_RE.source },
      resource: {
        bsonType: "object",
        additionalProperties: false,
        required: ["type", "id"],
        properties: {
          type: { enum: ["alert"] },
          id: { bsonType: "string", pattern: UUID_RE.source }
        }
      },
      action: { enum: ["alert.acknowledged"] },
      occurred_at: { bsonType: "date" },
      actor: { bsonType: "string", pattern: ACTOR_RE.source },
      result: { enum: ["success", "denied"] },
      result_code: { enum: RESULT_CODES },
      current_status: { enum: ["acknowledged", "resolved"] },
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
    },
    anyOf: [
      {
        required: ["changes"],
        not: {
          anyOf: [
            { required: ["resource"] }, { required: ["result"] },
            { required: ["result_code"] }, { required: ["current_status"] }
          ]
        }
      },
      {
        required: ["resource", "result", "result_code"],
        anyOf: [
          {
            required: ["changes"],
            properties: {
              result: { enum: ["success"] },
              result_code: { enum: ["alert_acknowledged"] }
            }
          },
          {
            not: { required: ["changes"] },
            anyOf: [
              {
                properties: {
                  result: { enum: ["denied"] },
                  result_code: { enum: ["alert_not_found"] },
                  audit_status: { enum: ["completed"] }
                },
                not: { required: ["current_status"] }
              },
              {
                required: ["current_status"],
                properties: {
                  result: { enum: ["denied"] },
                  result_code: { enum: ["alert_state_conflict"] },
                  current_status: { enum: ["acknowledged", "resolved"] },
                  audit_status: { enum: ["completed"] }
                }
              }
            ]
          }
        ]
      }
    ]
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

export class AuditWriteError extends Error {
  constructor(operationId) {
    super("No se pudo confirmar la escritura de auditoría; la operación no se reportó como auditada.");
    this.name = "AuditWriteError";
    this.code = "AUDIT_WRITE_FAILED";
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
  if (
    record.alert_id !== alertId ||
    (record.resource && (record.resource.type !== "alert" || record.resource.id !== alertId)) ||
    record.action !== "alert.acknowledged" ||
    record.actor !== actor
  ) {
    throw new Error("operation_id ya está asociado a otra operación; no se aplicó ningún cambio.");
  }
}

function resultFromRecord(record, replayed) {
  if (record.result === "denied") {
    return {
      status: record.result_code === "alert_not_found" ? "not_found" : "conflict",
      result: "denied",
      replayed,
      operation_id: record.operation_id,
      alert_id: record.alert_id,
      ...(record.current_status ? { current_status: record.current_status } : {})
    };
  }
  return {
    status: "completed",
    result: "success",
    replayed,
    operation_id: record.operation_id,
    alert_id: record.alert_id
  };
}

async function saveDenied(audit, record) {
  try {
    await audit.insertOne(record);
    return { record, replayed: false };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await audit.findOne({ operation_id: record.operation_id });
      if (existing) {
        assertSameOperation(existing, record.alert_id, record.actor);
        if (existing.audit_status === "completed") return { record: existing, replayed: true };
      }
    }
    throw new AuditWriteError(record.operation_id);
  }
}

function deniedRecord(alertId, operationId, actor, resultCode, currentStatus, occurredAt = new Date()) {
  return {
    operation_id: operationId,
    alert_id: alertId,
    resource: { type: "alert", id: alertId },
    action: "alert.acknowledged",
    occurred_at: occurredAt,
    actor,
    result: "denied",
    result_code: resultCode,
    ...(currentStatus ? { current_status: currentStatus } : {}),
    audit_status: "completed"
  };
}

export async function acknowledgeAlertWithAudit(alertId, { db, operationId, actor } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para auditar la alerta.");
  assertRequest(alertId, operationId, actor);

  const audit = await ensureAuditCollection(db);
  let record = await audit.findOne({ operation_id: operationId });
  if (record) {
    assertSameOperation(record, alertId, actor);
    if (record.audit_status === "completed") {
      return resultFromRecord(record, true);
    }
  } else {
    const current = await db.collection("alerts").findOne({ alert_id: alertId });
    if (!current) {
      const saved = await saveDenied(audit, deniedRecord(alertId, operationId, actor, "alert_not_found"));
      return resultFromRecord(saved.record, saved.replayed);
    }
    if (current.status !== "open") {
      // Another retry may have inserted the intention since our first lookup.
      const concurrent = await audit.findOne({ operation_id: operationId });
      if (concurrent) {
        assertSameOperation(concurrent, alertId, actor);
        return acknowledgeAlertWithAudit(alertId, { db, operationId, actor });
      }
      const saved = await saveDenied(
        audit,
        deniedRecord(alertId, operationId, actor, "alert_state_conflict", current.status)
      );
      return resultFromRecord(saved.record, saved.replayed);
    }

    const occurredAt = new Date();
    record = {
      operation_id: operationId,
      alert_id: alertId,
      resource: { type: "alert", id: alertId },
      action: "alert.acknowledged",
      occurred_at: occurredAt,
      actor,
      result: "success",
      result_code: "alert_acknowledged",
      changes: {
        status: { from: "open", to: "acknowledged" },
        acknowledged_at: occurredAt
      },
      audit_status: "pending"
    };
    try {
      await audit.insertOne(record);
    } catch (error) {
      if (error.code !== 11000) throw new AuditWriteError(operationId);
      record = await audit.findOne({ operation_id: operationId });
      if (!record) throw new AuditWriteError(operationId);
      assertSameOperation(record, alertId, actor);
      if (record.audit_status === "completed") {
        return resultFromRecord(record, true);
      }
    }
  }

  let appliedChange = false;
  let denialCode = "alert_state_conflict";
  let currentStatus;
  try {
    const result = await db.collection("alerts").updateOne(
      { alert_id: alertId, status: "open" },
      { $set: { status: "acknowledged", acknowledged_at: record.occurred_at, audit_operation_id: operationId } }
    );
    appliedChange = result.matchedCount > 0;
    if (result.matchedCount === 0) {
      const current = await db.collection("alerts").findOne({ alert_id: alertId });
      const isRetryAfterAppliedChange =
        current?.status === "acknowledged" &&
        current.audit_operation_id === operationId &&
        current.acknowledged_at instanceof Date &&
        current.acknowledged_at.getTime() === record.occurred_at.getTime();
      if (isRetryAfterAppliedChange) appliedChange = true;
      else if (!current) denialCode = "alert_not_found";
      else if (current.status === "open") {
        throw new AuditPendingError(
          operationId,
          "El estado de la alerta quedó incierto; reintente con el mismo operation_id."
        );
      } else currentStatus = current.status;
    }
  } catch (error) {
    if (error instanceof AuditPendingError) throw error;
    throw new AuditPendingError(
      operationId,
      "La operación tiene una intención de auditoría pendiente; reintente con el mismo operation_id.",
      error
    );
  }

  if (!appliedChange) {
    try {
      const result = await audit.updateOne(
        { operation_id: operationId, audit_status: "pending" },
        {
          $set: {
            result: "denied",
            result_code: denialCode,
            audit_status: "completed",
            ...(currentStatus ? { current_status: currentStatus } : {})
          },
          $unset: {
            changes: "",
            ...(currentStatus ? {} : { current_status: "" })
          }
        }
      );
      if (result.matchedCount === 0) {
        const denied = await audit.findOne({
          operation_id: operationId,
          result: "denied",
          result_code: denialCode,
          audit_status: "completed"
        });
        if (!denied) throw new Error("No se pudo confirmar la denegación en auditoría.");
      }
    } catch (error) {
      throw new AuditPendingError(
        operationId,
        "No se pudo confirmar la denegación en auditoría; reintente con el mismo operation_id.",
        error
      );
    }
    return resultFromRecord({
      ...record,
      result: "denied",
      result_code: denialCode,
      ...(currentStatus ? { current_status: currentStatus } : {}),
      audit_status: "completed"
    }, false);
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

  return resultFromRecord({ ...record, audit_status: "completed" }, false);
}
