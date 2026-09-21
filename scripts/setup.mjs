import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { rootDir, envPath } from "../src/config.mjs";

const node = (script, ...args) => execFileSync(process.execPath, [script, ...args], { cwd: rootDir, stdio: "inherit" });
node("scripts/prepare-env.mjs");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
if ((process.env.CDRL_DATABASE_MODE || "local") === "local") {
  execFileSync("docker", ["compose", "up", "-d", "postgres"], { cwd: rootDir, stdio: "inherit" });
}
node("scripts/wait-for-postgres.mjs");
node("scripts/migrate.mjs", "--bootstrap");
node("scripts/create_service_users.mjs");
node("scripts/migrate.mjs");
node("scripts/seed.mjs");
