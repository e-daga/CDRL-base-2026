// M09: cuentas MongoDB separadas por coleccion y operacion (privilegios minimos).
// mongo/init.js crea los mismos roles con estos privilegios; la matriz esta en
// docs/M09-permisos-mongo.md. Los secretos solo vienen de variables de entorno.
import "./config.mjs";
import { withMongo } from "./mongo.mjs";

const on = (collection, actions) => ({ resource: { db: "cdrl", collection }, actions });

export const MONGO_ACCOUNTS = {
  // Ingesta de telemetria: escribe eventos, no los borra ni ve alertas o auditoria.
  ingest: {
    env: "MONGO_INGEST", defaultUser: "cdrl_mongo_ingest", role: "cdrl_events_ingest",
    privileges: [on("events", ["find", "insert", "update"])]
  },
  // Consultas y paginacion: solo lectura de eventos y alertas.
  reader: {
    env: "MONGO_READER", defaultUser: "cdrl_mongo_reader", role: "cdrl_events_alerts_reader",
    privileges: [on("events", ["find"]), on("alerts", ["find"])]
  },
  // Operacion de alertas: abre y reconoce alertas y registra la auditoria del reconocimiento.
  // listCollections y createIndex los pide ensureAuditCollection en cada reconocimiento.
  operator: {
    env: "MONGO_OPERATOR", defaultUser: "cdrl_mongo_operator", role: "cdrl_alert_operator",
    privileges: [
      on("alerts", ["find", "insert", "update"]),
      on("alert_audit", ["find", "insert", "update", "createIndex"]),
      on("", ["listCollections"])
    ]
  },
  // Revision de auditoria: solo lectura de alert_audit.
  auditor: {
    env: "MONGO_AUDITOR", defaultUser: "cdrl_mongo_auditor", role: "cdrl_audit_reader",
    privileges: [on("alert_audit", ["find"])]
  }
};

// Codigo de MongoDB para una operacion sin permiso.
export const MONGO_UNAUTHORIZED = 13;

export function mongoAccount(name) {
  const account = MONGO_ACCOUNTS[name];
  if (!account) throw new Error(`Cuenta MongoDB desconocida: ${name}.`);
  const user = process.env[`${account.env}_USER`] || account.defaultUser;
  const password = process.env[`${account.env}_PASSWORD`];
  if (!password) throw new Error(`Falta ${account.env}_PASSWORD. Ejecutar make setup o configurar el entorno.`);
  return { user, password };
}

export function withMongoAs(name, work, options = {}) {
  return withMongo(work, { ...options, ...mongoAccount(name) });
}
