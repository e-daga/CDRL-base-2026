import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const envPath = path.join(rootDir, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
export const serviceRoles = ["migrator", "writer", "reader", "operator"];

export function databaseConfig(role = "reader") {
  if (role !== "bootstrap" && !serviceRoles.includes(role)) throw new Error(`Rol desconocido: ${role}`);
  const prefix = role === "bootstrap" ? "POSTGRES" : role.toUpperCase();
  const password = process.env[`${prefix}_PASSWORD`];
  if (!password) throw new Error(`Falta ${prefix}_PASSWORD. Ejecutar make setup o configurar el entorno.`);
  const sslEnabled = process.env.POSTGRES_SSL === "true";
  if (process.env.CDRL_DATABASE_MODE === "external" && !sslEnabled) {
    throw new Error("El modo external requiere POSTGRES_SSL=true y un certificado confiable.");
  }
  const caPath = process.env.POSTGRES_SSL_CA_FILE;
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "cdrl",
    user: process.env[`${prefix}_USER`] || (role === "bootstrap" ? "cdrl_dev" : `cdrl_${role}`),
    password,
    ssl: sslEnabled ? { rejectUnauthorized: true, ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}) } : false,
    connectionTimeoutMillis: 5000,
    application_name: `cdrl_${role}`
  };
}

export { rootDir };
