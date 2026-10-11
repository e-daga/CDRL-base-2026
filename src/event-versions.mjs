// M06: versiones del documento de evento en MongoDB.
// v1 = documento de M05, sin schema_version. v2 = schema_version: 2 + firmware_version.
// Las mismas reglas las aplica el validador de mongo/init.js.

export const EVENT_SCHEMA_VERSIONS = [1, 2];
export const CURRENT_EVENT_SCHEMA_VERSION = 2;
export const FIRMWARE_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const has = (doc, key) => Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;

export function eventSchemaVersion(doc) {
  if (!doc || typeof doc !== "object") throw new Error("Evento invalido: debe ser un objeto.");
  if (!has(doc, "schema_version")) return 1;
  if (doc.schema_version === 2) return 2;
  throw new Error(`Evento invalido: schema_version desconocida (${JSON.stringify(doc.schema_version)}).`);
}

export function assertEventVersion(doc) {
  const version = eventSchemaVersion(doc);
  if (version === 1 && has(doc, "firmware_version")) {
    throw new Error("Evento invalido: firmware_version solo existe en schema_version 2.");
  }
  if (version === 2 && (typeof doc.firmware_version !== "string" || !FIRMWARE_RE.test(doc.firmware_version))) {
    throw new Error("Evento invalido: schema_version 2 exige firmware_version con formato X.Y.Z.");
  }
  return version;
}

// Vista de lectura comun a ambas versiones. Devuelve un objeto nuevo:
// no modifica el documento recibido ni lo que esta almacenado.
export function toEventView(doc) {
  if (!doc) return doc;
  return { ...doc, schema_version: eventSchemaVersion(doc), firmware_version: doc.firmware_version ?? null };
}

export async function countEventsBySchemaVersion(db, filter = {}) {
  if (!db) throw new Error("Se requiere una base de datos MongoDB para contar versiones.");
  const rows = await db.collection("events").aggregate([
    { $match: filter },
    { $group: { _id: { $ifNull: ["$schema_version", 1] }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [`v${row._id}`, row.count]));
}
