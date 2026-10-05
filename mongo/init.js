const dbc = db.getSiblingDB("cdrl");
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const DEVICE = "^dev_[a-z0-9_]+$";
const SEVERITY = ["info", "warning", "critical"];
const isDate = (f) => ({ $eq: [{ $type: "$" + f }, "date"] });

const ensure = (name, validator) => {
  const opts = { validator, validationLevel: "strict", validationAction: "error" };
  if (dbc.getCollectionNames().includes(name)) {
    const result = dbc.runCommand({ collMod: name, ...opts });
    if (result.ok !== 1) throw new Error("No se pudo actualizar el validador de " + name);
  }
  else dbc.createCollection(name, opts);
};

ensure("events", {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["event_id", "device_id", "event_type", "observed_at", "ingested_at", "metric_value", "unit", "severity", "source", "payload"],
    properties: {
      _id: {},
      event_id: { bsonType: "string", pattern: UUID },
      device_id: { bsonType: "string", pattern: DEVICE },
      event_type: { enum: ["temperature_c", "humidity_pct", "battery_pct", "signal_dbm"] },
      observed_at: { bsonType: "date" },
      ingested_at: { bsonType: "date" },
      metric_value: { bsonType: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
      unit: { bsonType: "string", minLength: 1 },
      severity: { enum: SEVERITY },
      source: { bsonType: "string", minLength: 1 },
      payload: { bsonType: "object" }
    }
  },
  $expr: { $and: [
    { $lte: ["$observed_at", { $dateAdd: { startDate: "$$NOW", unit: "minute", amount: 5 } }] },
    { $or: [
      { $not: [{ $in: ["$event_type", ["battery_pct", "humidity_pct"]] }] },
      { $and: [{ $gte: ["$metric_value", 0] }, { $lte: ["$metric_value", 100] }] }
    ] }
  ] }
});

ensure("alerts", {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["alert_id", "event_id", "device_id", "alert_type", "status", "severity", "opened_at"],
    properties: {
      _id: {},
      alert_id: { bsonType: "string", pattern: UUID },
      event_id: { bsonType: "string", pattern: UUID },
      device_id: { bsonType: "string", pattern: DEVICE },
      alert_type: { enum: ["threshold", "connectivity", "data_quality"] },
      status: { enum: ["open", "acknowledged", "resolved"] },
      severity: { enum: SEVERITY },
      opened_at: { bsonType: "date" },
      acknowledged_at: { bsonType: ["date", "null"] },
      resolved_at: { bsonType: ["date", "null"] }
    }
  },
  $expr: { $and: [
    { $or: [{ $eq: ["$status", "open"] }, isDate("acknowledged_at")] },
    { $or: [{ $ne: ["$status", "resolved"] }, isDate("resolved_at")] },
    { $or: [{ $not: [isDate("acknowledged_at")] }, { $gte: ["$acknowledged_at", "$opened_at"] }] },
    { $or: [{ $not: [isDate("resolved_at")] }, { $gte: ["$resolved_at", { $cond: [isDate("acknowledged_at"), "$acknowledged_at", "$opened_at"] }] }] }
  ] }
});

dbc.events.createIndex({ event_id: 1 }, { unique: true, name: "uq_events_event_id" });
dbc.events.createIndex({ device_id: 1, observed_at: -1 }, { name: "idx_events_device_observed" });
dbc.events.createIndex({ event_type: 1, observed_at: -1 }, { name: "idx_events_type_observed" });
dbc.alerts.createIndex({ alert_id: 1 }, { unique: true, name: "uq_alerts_alert_id" });
dbc.alerts.createIndex({ event_id: 1 }, { unique: true, name: "uq_alerts_event_id" });
dbc.alerts.createIndex({ status: 1, device_id: 1, severity: 1 }, { name: "idx_alerts_status_device_severity" });
dbc.alerts.createIndex({ status: 1, opened_at: -1 }, { name: "idx_alerts_status_opened" });
const appUser = process.env.MONGO_APP_USER;
const appPassword = process.env.MONGO_APP_PASSWORD;
if (!appUser || !appPassword) throw new Error("Falta configurar cuenta MongoDB de aplicacion.");
const userOptions = { pwd: appPassword, roles: [{ role: "readWrite", db: "cdrl" }] };
if (dbc.getUser(appUser)) dbc.updateUser(appUser, userOptions);
else dbc.createUser({ user: appUser, ...userOptions });
print("init OK");
