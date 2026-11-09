const dbc = db.getSiblingDB("cdrl");
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const DEVICE = "^dev_[a-z0-9_]+$";
const SEVERITY = ["info", "warning", "critical"];
const FIRMWARE = "^[0-9]+\\.[0-9]+\\.[0-9]+$";
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
      payload: { bsonType: "object" },
      // M06: sin schema_version el documento es v1; v2 exige firmware_version.
      // M07: firmware desconocido = null + firmware_status "unknown" + migrated_from 1.
      schema_version: { enum: [2] },
      firmware_version: { bsonType: ["string", "null"], pattern: FIRMWARE },
      firmware_status: { enum: ["reported", "unknown"] },
      migrated_from: { enum: [1] }
    },
    anyOf: [
      { not: { anyOf: [{ required: ["schema_version"] }, { required: ["firmware_version"] }, { required: ["firmware_status"] }, { required: ["migrated_from"] }] } },
      { required: ["schema_version", "firmware_version"], properties: { firmware_version: { bsonType: "string" }, firmware_status: { enum: ["reported"] } }, not: { required: ["migrated_from"] } },
      { required: ["schema_version", "firmware_version", "firmware_status", "migrated_from"], properties: { firmware_version: { bsonType: "null" }, firmware_status: { enum: ["unknown"] } } }
    ]
  },
  $expr: { $and: [
    { $lte: ["$observed_at", { $dateAdd: { startDate: "$$NOW", unit: "minute", amount: 5 } }] },
    { $or: [
      { $not: [{ $in: ["$event_type", ["battery_pct", "humidity_pct"]] }] },
      { $and: [{ $gte: ["$metric_value", 0] }, { $lte: ["$metric_value", 100] }] }
    ] }
  ] }
});

// Refresh only the previously owned synthetic recovery collection after schema evolution.
if (dbc.getCollectionNames().includes("m06_recovery_fixture")) {
  const fixture = dbc.getCollection("m06_recovery_fixture");
  if (fixture.countDocuments({}) > 1 || fixture.countDocuments({
    $nor: [{ _id: "m06-recovery-only", source: "synthetic-recovery-m06" }]
  }) !== 0) throw new Error("Datos ajenos en fixture M06; no se cambia su contrato.");
  ensure("m06_recovery_fixture", dbc.getCollectionInfos({ name: "events" })[0].options.validator);
}

ensure("alerts", {
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required: ["alert_id", "event_id", "device_id", "alert_type", "status", "severity", "opened_at"],
    properties: {
      _id: {},
      alert_id: { bsonType: "string", pattern: UUID },
      audit_operation_id: { bsonType: "string", pattern: UUID },
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
// M08: paginacion por cursor (device_id + rango, orden observed_at desc, event_id desc).
dbc.events.createIndex({ device_id: 1, observed_at: -1, event_id: -1 }, { name: "idx_events_device_observed_id" });
dbc.alerts.createIndex({ alert_id: 1 }, { unique: true, name: "uq_alerts_alert_id" });
dbc.alerts.createIndex({ event_id: 1 }, { unique: true, name: "uq_alerts_event_id" });
dbc.alerts.createIndex({ status: 1, device_id: 1, severity: 1 }, { name: "idx_alerts_status_device_severity" });
dbc.alerts.createIndex({ status: 1, opened_at: -1 }, { name: "idx_alerts_status_opened" });
const ensureUser = (user, pwd, roles) => {
  if (!user || !pwd) throw new Error("Falta configurar la cuenta MongoDB " + (user || "sin nombre") + ".");
  if (dbc.getUser(user)) dbc.updateUser(user, { pwd, roles });
  else dbc.createUser({ user, pwd, roles });
};
// Cuenta de esquema, migraciones y fixtures (como migrator en PostgreSQL). No es administradora:
// no gestiona usuarios ni roles. La cuenta root solo se usa aqui, dentro del contenedor.
ensureUser(process.env.MONGO_APP_USER, process.env.MONGO_APP_PASSWORD, [{ role: "readWrite", db: "cdrl" }]);

// M09: roles por coleccion y operacion. Mantener igual que src/mongo-accounts.mjs.
const on = (collection, actions) => ({ resource: { db: "cdrl", collection: collection }, actions: actions });
const accounts = [
  ["MONGO_INGEST", "cdrl_mongo_ingest", "cdrl_events_ingest", [on("events", ["find", "insert", "update"])]],
  ["MONGO_READER", "cdrl_mongo_reader", "cdrl_events_alerts_reader", [on("events", ["find"]), on("alerts", ["find"])]],
  ["MONGO_OPERATOR", "cdrl_mongo_operator", "cdrl_alert_operator", [
    on("alerts", ["find", "insert", "update"]),
    on("alert_audit", ["find", "insert", "update", "createIndex"]),
    on("", ["listCollections"])
  ]],
  ["MONGO_AUDITOR", "cdrl_mongo_auditor", "cdrl_audit_reader", [on("alert_audit", ["find"])]]
];
for (const [env, defaultUser, role, privileges] of accounts) {
  // updateRole reemplaza los privilegios: repetir init deja exactamente los declarados.
  if (dbc.getRole(role)) dbc.updateRole(role, { privileges: privileges, roles: [] });
  else dbc.createRole({ role: role, privileges: privileges, roles: [] });
  ensureUser(process.env[env + "_USER"] || defaultUser, process.env[env + "_PASSWORD"], [{ role: role, db: "cdrl" }]);
}
print("init OK");
