import { MongoClient } from "mongodb";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^dev_[a-z0-9_]+$/;
export const EVENT_TYPES = ["temperature_c", "humidity_pct", "battery_pct", "signal_dbm"];
export const ALERT_TYPES = ["threshold", "connectivity", "data_quality"];
export const SEVERITIES = ["info", "warning", "critical"];
export const ALERT_STATUSES = ["open", "acknowledged", "resolved"];

export function mongoUri(options = {}) {
  const host = options.host ?? process.env.MONGO_HOST ?? "127.0.0.1";
  const port = options.port ?? process.env.MONGO_PORT ?? 27017;
  const db = options.db ?? process.env.MONGO_DB ?? "cdrl";
  const user = options.user ?? process.env.MONGO_USER;
  const password = options.password ?? process.env.MONGO_PASSWORD;
  const authSource = options.authSource ?? process.env.MONGO_AUTH_SOURCE ?? "admin";

  if (!user || !password) {
    return `mongodb://${host}:${port}/${db}`;
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  return `mongodb://${encodedUser}:${encodedPass}@${host}:${port}/${db}?authSource=${encodeURIComponent(authSource)}`;
}

export async function connectMongo(options = {}) {
  const uri = options.uri ?? mongoUri(options);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 5
  });
  await client.connect();
  return client;
}

export async function withMongo(work, options = {}) {
  const client = await connectMongo(options);
  try {
    const dbName = options.db ?? process.env.MONGO_DB ?? "cdrl";
    return await work(client.db(dbName), client);
  } finally {
    await client.close();
  }
}

function assertValidEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Evento inválido: debe ser un objeto.");
  if (!event.event_id || !UUID_RE.test(String(event.event_id))) {
    throw new Error("Evento inválido: event_id debe ser UUID válido.");
  }
  if (!event.device_id || !DEVICE_RE.test(String(event.device_id))) {
    throw new Error("Evento inválido: device_id no cumple el patrón dev_...");
  }
  if (!EVENT_TYPES.includes(event.event_type)) {
    throw new Error(`Evento inválido: event_type no permitido (${EVENT_TYPES.join(", ")}).`);
  }
  if (!(event.observed_at instanceof Date)) {
    throw new Error("Evento inválido: observed_at debe ser un Date.");
  }
  if (!(event.ingested_at instanceof Date)) {
    throw new Error("Evento inválido: ingested_at debe ser un Date.");
  }
  if (typeof event.metric_value !== "number" || Number.isNaN(event.metric_value)) {
    throw new Error("Evento inválido: metric_value debe ser un número.");
  }
  if (!event.unit || typeof event.unit !== "string" || !event.unit.trim()) {
    throw new Error("Evento inválido: unit requerido.");
  }
  if (!SEVERITIES.includes(event.severity)) {
    throw new Error(`Evento inválido: severity no permitido (${SEVERITIES.join(", ")}).`);
  }
  if (!event.source || typeof event.source !== "string" || !event.source.trim()) {
    throw new Error("Evento inválido: source requerido.");
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("Evento inválido: payload debe ser un objeto.");
  }
  if (event.observed_at > new Date(Date.now() + 5 * 60 * 1000)) {
    throw new Error("Evento inválido: observed_at no puede estar más de 5 minutos en el futuro.");
  }
  if (["battery_pct", "humidity_pct"].includes(event.event_type) && (event.metric_value < 0 || event.metric_value > 100)) {
    throw new Error("Evento inválido: battery_pct y humidity_pct deben estar entre 0 y 100.");
  }
}

function assertValidAlert(alert) {
  if (!alert || typeof alert !== "object") throw new Error("Alerta inválida: debe ser un objeto.");
  if (!alert.alert_id || !UUID_RE.test(String(alert.alert_id))) {
    throw new Error("Alerta inválida: alert_id debe ser UUID válido.");
  }
  if (!alert.event_id || !UUID_RE.test(String(alert.event_id))) {
    throw new Error("Alerta inválida: event_id debe ser UUID válido.");
  }
  if (!alert.device_id || !DEVICE_RE.test(String(alert.device_id))) {
    throw new Error("Alerta inválida: device_id no cumple el patrón dev_...");
  }
  if (!ALERT_TYPES.includes(alert.alert_type)) {
    throw new Error(`Alerta inválida: alert_type no permitido (${ALERT_TYPES.join(", ")}).`);
  }
  if (!ALERT_STATUSES.includes(alert.status)) {
    throw new Error(`Alerta inválida: status no permitido (${ALERT_STATUSES.join(", ")}).`);
  }
  if (!SEVERITIES.includes(alert.severity)) {
    throw new Error(`Alerta inválida: severity no permitido (${SEVERITIES.join(", ")}).`);
  }
  if (!(alert.opened_at instanceof Date)) {
    throw new Error("Alerta inválida: opened_at debe ser un Date.");
  }
  if (alert.acknowledged_at !== null && !(alert.acknowledged_at instanceof Date)) {
    throw new Error("Alerta inválida: acknowledged_at debe ser Date o null.");
  }
  if (alert.resolved_at !== null && !(alert.resolved_at instanceof Date)) {
    throw new Error("Alerta inválida: resolved_at debe ser Date o null.");
  }

  if (alert.status !== "open" && !(alert.acknowledged_at instanceof Date)) {
    throw new Error("Alerta inválida: acknowledged_at requerido para estados no abiertos.");
  }
  if (alert.status === "resolved" && !(alert.resolved_at instanceof Date)) {
    throw new Error("Alerta inválida: resolved_at requerido en estado resolved.");
  }
  if (alert.acknowledged_at instanceof Date && alert.acknowledged_at < alert.opened_at) {
    throw new Error("Alerta inválida: acknowledged_at no puede ser anterior a opened_at.");
  }
  const referenceDate = alert.acknowledged_at instanceof Date ? alert.acknowledged_at : alert.opened_at;
  if (alert.resolved_at instanceof Date && alert.resolved_at < referenceDate) {
    throw new Error("Alerta inválida: resolved_at no puede ser anterior a acknowledged_at/opened_at.");
  }
}

function cloneWithoutObjectId(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const { _id, ...rest } = doc;
  return rest;
}

export function normalizeEventDocument(event) {
  if (!event) return event;
  const normalized = { ...event };
  if (normalized.observed_at && typeof normalized.observed_at === "string") normalized.observed_at = new Date(normalized.observed_at);
  if (normalized.ingested_at && typeof normalized.ingested_at === "string") normalized.ingested_at = new Date(normalized.ingested_at);
  if (normalized.payload === undefined) normalized.payload = {};
  assertValidEvent(normalized);
  return normalized;
}

export function normalizeAlertDocument(alert) {
  if (!alert) return alert;
  const normalized = { ...alert };
  if (normalized.opened_at && typeof normalized.opened_at === "string") normalized.opened_at = new Date(normalized.opened_at);
  if (normalized.acknowledged_at && typeof normalized.acknowledged_at === "string") normalized.acknowledged_at = new Date(normalized.acknowledged_at);
  if (normalized.resolved_at && typeof normalized.resolved_at === "string") normalized.resolved_at = new Date(normalized.resolved_at);
  if (normalized.acknowledged_at === undefined || normalized.acknowledged_at === null) normalized.acknowledged_at = null;
  if (normalized.resolved_at === undefined || normalized.resolved_at === null) normalized.resolved_at = null;
  assertValidAlert(normalized);
  return normalized;
}

export async function createEvent(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para crear el evento.");
  const event = normalizeEventDocument(doc);
  const result = await db.collection("events").insertOne(event);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, event_id: event.event_id, created: true };
}

export async function readEvent(eventId, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para leer el evento.");
  return db.collection("events").findOne({ event_id: eventId });
}

export async function updateEvent(eventId, changes, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para actualizar el evento.");
  const current = await readEvent(eventId, { db });
  if (!current) {
    return { matchedCount: 0, modifiedCount: 0, acknowledged: true, event_id: eventId };
  }
  const updateDoc = { ...changes };
  if (updateDoc.event_id && updateDoc.event_id !== eventId) {
    throw new Error("No se puede mover un evento a otro event_id.");
  }
  delete updateDoc._id;
  const normalized = normalizeEventDocument({ ...current, ...updateDoc });
  const result = await db.collection("events").replaceOne({ event_id: eventId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, event_id: eventId };
}

export async function deleteEvent(eventId, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para borrar el evento.");
  const result = await db.collection("events").deleteOne({ event_id: eventId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}

export async function upsertEvent(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para upsert del evento.");
  const event = normalizeEventDocument(doc);
  const existing = await db.collection("events").findOne({ event_id: event.event_id });

  if (!existing) {
    const result = await db.collection("events").insertOne(event);
    return { action: "created", created: true, acknowledged: result.acknowledged, event_id: event.event_id, insertedId: result.insertedId };
  }

  const existingCanonical = JSON.stringify(existing);
  const incomingCanonical = JSON.stringify({ ...existing, ...cloneWithoutObjectId(event) });
  if (existingCanonical === incomingCanonical) {
    return { action: "duplicate", created: false, updated: false, event_id: event.event_id, matchedExisting: true };
  }

  return {
    action: "conflict",
    created: false,
    updated: false,
    event_id: event.event_id,
    conflict: true,
    existing: cloneWithoutObjectId(existing),
    incoming: cloneWithoutObjectId(event),
    message: "El event_id ya existe con datos distintos; no se crea una nueva fila."
  };
}

export async function createAlert(doc, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para crear la alerta.");
  const alert = normalizeAlertDocument(doc);
  const result = await db.collection("alerts").insertOne(alert);
  return { acknowledged: result.acknowledged, insertedId: result.insertedId, alert_id: alert.alert_id, created: true };
}

export async function readAlert(alertId, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para leer la alerta.");
  return db.collection("alerts").findOne({ alert_id: alertId });
}

export async function updateAlert(alertId, changes, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para actualizar la alerta.");
  const updateDoc = { ...changes };
  if (updateDoc.alert_id && updateDoc.alert_id !== alertId) {
    throw new Error("No se puede mover una alerta a otro alert_id.");
  }
  delete updateDoc._id;
  const current = await readAlert(alertId, { db });
  if (!current) return { matchedCount: 0, modifiedCount: 0, acknowledged: true, alert_id: alertId };
  const normalized = normalizeAlertDocument({ ...current, ...updateDoc });
  const result = await db.collection("alerts").replaceOne({ alert_id: alertId }, normalized, { upsert: false });
  return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, acknowledged: result.acknowledged, alert_id: alertId };
}

export async function deleteAlert(alertId, options = {}) {
  const db = options.db ?? (options.client ? options.client.db(options.dbName ?? "cdrl") : null);
  if (!db) throw new Error("Se requiere una base de datos MongoDB para borrar la alerta.");
  const result = await db.collection("alerts").deleteOne({ alert_id: alertId });
  return { deletedCount: result.deletedCount, acknowledged: result.acknowledged };
}

export async function findEventsByDevice(db, { deviceId, from, to, limit = 50 } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para consultar eventos.");
  const filter = { device_id: deviceId };
  if (from || to) {
    filter.observed_at = {};
    if (from) filter.observed_at.$gte = new Date(from);
    if (to) filter.observed_at.$lte = new Date(to);
  }
  return db.collection("events").find(filter).sort({ observed_at: -1 }).limit(limit).toArray();
}

export async function findOpenAlerts(db, { deviceId, severity, limit = 50 } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para consultar alertas.");
  const filter = { status: "open" };
  if (deviceId) filter.device_id = deviceId;
  if (severity) filter.severity = severity;
  return db.collection("alerts").find(filter).sort({ opened_at: -1 }).limit(limit).toArray();
}

export async function explainQuery(db, collectionName, query, sort = {}, limit = 0) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para explicar la consulta.");
  const collection = db.collection(collectionName);
  const cursor = collection.find(query).sort(sort).limit(limit);
  return cursor.explain("executionStats");
}
