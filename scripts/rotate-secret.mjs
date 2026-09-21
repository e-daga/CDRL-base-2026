import crypto from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import { databaseConfig, envPath, serviceRoles } from "../src/config.mjs";
import { withClient } from "../src/db.mjs";
import { rotateDatabasePassword } from "../src/secret-rotation.mjs";

const role = process.argv[2];
if (!serviceRoles.includes(role)) throw new Error("Uso: npm run rotate:secret -- writer|reader|operator|migrator");
const config = databaseConfig(role);
const external = process.env.CDRL_DATABASE_MODE === "external";
const nextPassword = external ? process.env.CDRL_NEXT_PASSWORD : crypto.randomBytes(32).toString("hex");
if (!nextPassword || nextPassword.length < 24 || nextPassword === config.password) {
  throw new Error("Usar una credencial nueva de al menos 24 caracteres; external requiere CDRL_NEXT_PASSWORD.");
}
const key = role.toUpperCase() + "_PASSWORD";
let updatedEnv;
if (!external) {
  const content = fs.readFileSync(envPath, "utf8");
  const pattern = new RegExp("^" + key + "=.*$", "m");
  if (!pattern.test(content)) throw new Error("La credencial no esta administrada por .env local; rotarla mediante el gestor del entorno.");
  updatedEnv = content.replace(pattern, key + "=" + nextPassword);
  // Prepare the protected file before changing the database credential.
  fs.writeFileSync(envPath + ".rotation", updatedEnv, { mode: 0o600 });
}
await withClient((admin) => rotateDatabasePassword(admin, config.user, nextPassword), "bootstrap");
if (!external) fs.renameSync(envPath + ".rotation", envPath);
const fresh = new pg.Client({ ...config, password: nextPassword });
try { await fresh.connect(); await fresh.query("SELECT 1"); } finally { await fresh.end(); }
const old = new pg.Client(config);
try { await assert.rejects(old.connect(), { code: "28P01" }); } finally { await old.end(); }
console.log("Rotacion verificada: nueva credencial aceptada; anterior rechazada; sesiones anteriores revocadas.");
if (external) console.log("Actualizar el secreto activo del servicio y reiniciarlo antes de reanudar trafico.");
