// M06: versiones del documento de evento en MongoDB.
// v1 = documento de M05, sin schema_version. v2 = schema_version: 2 + firmware_version.
// M07: un v1 migrado pasa a v2 con firmware desconocido (firmware_version: null,
// firmware_status: "unknown", migrated_from: 1). No se inventa una version de firmware.
// Las mismas reglas las aplica el validador de mongo/init.js.

export const EVENT_SCHEMA_VERSIONS = [1, 2];
export const CURRENT_EVENT_SCHEMA_VERSION = 2;
export const FIRMWARE_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const FIRMWARE_STATUSES = ["reported", "unknown"];
// Campos que agrega la evolucion; el consumidor anterior (M05) no los conoce.
export const VERSION_FIELDS = ["schema_version", "firmware_version", "firmware_status", "migrated_from"];
// Contrato M05 que recibe el consumidor anterior: mismos campos y tipos.
export const LEGACY_EVENT_FIELDS = ["event_id", "device_id", "event_type", "observed_at", "ingested_at", "metric_value", "unit", "severity", "source", "payload"];

const has = (doc, key) => Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;

export function eventSchemaVersion(doc) {
  if (!doc || typeof doc !== "object") throw new Error("Evento invalido: debe ser un objeto.");
  if (!has(doc, "schema_version")) return 1;
  if (doc.schema_version === 2) return 2;
  throw new Error(`Evento invalido: schema_version desconocida (${JSON.stringify(doc.schema_version)}).`);
}

export function assertEventVersion(doc) {
  const version = eventSchemaVersion(doc);
  if (version === 1) {
    const extra = VERSION_FIELDS.filter((key) => has(doc, key));
    if (extra.length) throw new Error(`Evento invalido: ${extra.join(", ")} solo existe en schema_version 2.`);
    return 1;
  }
  if (!has(doc, "firmware_version")) {
    throw new Error("Evento invalido: schema_version 2 exige firmware_version (X.Y.Z o null si es desconocido).");
  }
  if (doc.firmware_version === null) {
    // Desconocido: solo lo produce la migracion de un v1, nunca una escritura nueva.
    if (doc.firmware_status !== "unknown" || doc.migrated_from !== 1) {
      throw new Error("Evento invalido: firmware_version null exige firmware_status \"unknown\" y migrated_from 1.");
    }
    return 2;
  }
  if (typeof doc.firmware_version !== "string" || !FIRMWARE_RE.test(doc.firmware_version)) {
    throw new Error("Evento invalido: schema_version 2 exige firmware_version con formato X.Y.Z.");
  }
  // firmware_status ausente = "reported": asi siguen validos los v2 escritos en M06.
  if (has(doc, "firmware_status") && doc.firmware_status !== "reported") {
    throw new Error("Evento invalido: con firmware_version conocido, firmware_status solo puede ser \"reported\".");
  }
  if (has(doc, "migrated_from")) {
    throw new Error("Evento invalido: migrated_from solo existe cuando firmware_version es desconocido.");
  }
  return 2;
}

export function firmwareStatus(doc) {
  if (eventSchemaVersion(doc) === 1 || doc.firmware_version === null) return "unknown";
  return doc.firmware_status ?? "reported";
}

// Vista de lectura comun a ambas versiones. Devuelve un objeto nuevo:
// no modifica el documento recibido ni lo que esta almacenado.
export function toEventView(doc) {
  if (!doc) return doc;
  return { ...doc, schema_version: eventSchemaVersion(doc), firmware_version: doc.firmware_version ?? null, firmware_status: firmwareStatus(doc) };
}

// M07: vista del consumidor anterior. Quita los campos de version y deja la
// forma de M05, igual antes, durante y despues de la migracion. Una version
// desconocida falla en vez de ocultarse.
export function toLegacyEventView(doc) {
  if (!doc) return doc;
  eventSchemaVersion(doc);
  const legacy = { ...doc };
  for (const key of VERSION_FIELDS) delete legacy[key];
  return legacy;
}

export async function countEventsBySchemaVersion(db, filter = {}, { collection = "events" } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para contar versiones.");
  const rows = await db.collection(collection).aggregate([
    { $match: filter },
    { $group: { _id: { $ifNull: ["$schema_version", 1] }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [`v${row._id}`, row.count]));
}

// M07: avance de la migracion. "v1" pendientes, "unknown" migrados, "reported" nativos v2.
export async function countEventsByFirmwareStatus(db, filter = {}, { collection = "events" } = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para contar el estado de firmware.");
  const rows = await db.collection(collection).aggregate([
    { $match: filter },
    { $group: { _id: { $cond: [{ $eq: [{ $ifNull: ["$schema_version", 1] }, 1] }, "v1", { $ifNull: ["$firmware_status", "reported"] }] }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}
