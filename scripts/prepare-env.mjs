import crypto from "node:crypto";
import fs from "node:fs";
import { envPath, databaseConfig, serviceRoles } from "../src/config.mjs";

const mode = process.env.CDRL_DATABASE_MODE || "local";
if (!["local", "external"].includes(mode)) throw new Error("CDRL_DATABASE_MODE debe ser local o external.");
if (mode === "local" && !fs.existsSync(envPath)) {
  const values = {
    CDRL_DATABASE_MODE: "local",
    POSTGRES_HOST: process.env.POSTGRES_HOST || "localhost",
    POSTGRES_PORT: process.env.POSTGRES_PORT || "5432",
    POSTGRES_DB: process.env.POSTGRES_DB || "cdrl",
    POSTGRES_USER: process.env.POSTGRES_USER || "cdrl_dev"
  };
  for (const role of ["bootstrap", ...serviceRoles]) {
    const prefix = role === "bootstrap" ? "POSTGRES" : role.toUpperCase();
    if (role !== "bootstrap") values[`${prefix}_USER`] = process.env[`${prefix}_USER`] || `cdrl_${role}`;
    // Injected secrets stay in the environment; only generated local ones are saved.
    if (!process.env[`${prefix}_PASSWORD`]) values[`${prefix}_PASSWORD`] = crypto.randomBytes(32).toString("hex");
  }
  for (const value of Object.values(values)) {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) throw new Error("Usar variables de entorno para valores especiales.");
  }
  fs.writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  process.loadEnvFile(envPath);
  console.log("Entorno local generado en .env (ignorado por Git; secretos no impresos).");
}
const accounts = ["bootstrap", ...serviceRoles].map((role) => databaseConfig(role));
if (new Set(accounts.map((config) => config.user)).size !== accounts.length) {
  throw new Error("Cada responsabilidad requiere una cuenta diferente.");
}
if (new Set(accounts.map((config) => config.password)).size !== accounts.length) {
  throw new Error("Las cuentas requieren contrasenas independientes.");
}
console.log(`Configuracion ${mode} validada.`);
