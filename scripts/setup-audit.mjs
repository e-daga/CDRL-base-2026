import { withMongo } from "../src/mongo.mjs";
import { ensureAuditCollection } from "../src/alert-audit.mjs";
await withMongo(ensureAuditCollection);
console.log("Coleccion e indices de auditoria preparados.");
