import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { withClient } from "../src/db.mjs";
import { rootDir, envPath } from "../src/config.mjs";
import { scanSecrets } from "./scan-secrets.mjs";

const write = (file, data) => fs.writeFileSync(path.join(rootDir, file), JSON.stringify(data, null, 2) + "\n");
const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
const run = (file, ...args) => {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: rootDir, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Fallo ${file} (exit ${result.status ?? "no iniciado"}).`);
};
fs.mkdirSync(path.join(rootDir, "artifacts"), { recursive: true });
let stage = "required-files";
try {
  const required = [
    ".env.example", "Makefile", "docker-compose.yml", "package.json", "package-lock.json",
    "db/migrations/001_create_telemetry_contract.sql", "db/migrations/002_create_operational_model.sql",
    "db/migrations/003_create_roles_and_privileges.sql", "db/migrations/004_enforce_role_ownership.sql",
    "db/seed/001_synthetic_telemetry.sql", "db/seed/002_operational_model.sql",
    "tests/telemetry-contract.test.mjs", "tests/operational-model.test.mjs",
    "tests/roles-access.test.mjs", "tests/secret-rotation.test.mjs",
    "evidence/m01-data-contract.json", "evidence/m02-relational-model.json", "evidence/m03-roles-secrets.json",
    "docs/ADR-003-roles-y-secretos.md", "docs/M03-rotacion-secretos.md", ".github/workflows/cdrl-feedback.yml"
  ];
  for (const file of required) assert.ok(fs.existsSync(path.join(rootDir, file)), `Falta ${file}`);
  const evidence = JSON.parse(fs.readFileSync(path.join(rootDir, "evidence/m03-roles-secrets.json"), "utf8"));
  assert.equal(evidence.assignmentId, "m03-roles-secrets");
  assert.equal(evidence.tag, "week-03-final");
  assert.equal(evidence.results.machineReadableArtifact, "artifacts/m03-verify.json");

  stage = "setup";
  run("scripts/setup.mjs");
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

  stage = "tests";
  const testReportPath = path.join(rootDir, "artifacts/m03-tests.json");
  if (fs.existsSync(testReportPath)) fs.unlinkSync(testReportPath);
  run("scripts/test.mjs", "--report");
  const tests = JSON.parse(fs.readFileSync(testReportPath, "utf8"));
  assert.ok(tests.total > 0 && tests.passed === tests.total, "Todas las pruebas deben pasar.");
  assert.equal(tests.failed + tests.skipped + tests.todo, 0, "No se admiten pruebas fallidas, omitidas ni pendientes.");
  for (const file of ["telemetry-contract", "operational-model", "roles-access", "secret-rotation"]) {
    assert.ok(tests.cases.some((item) => item.file === `tests/${file}.test.mjs`), `Suite sin ejecutar: ${file}`);
  }
  const m03 = tests.cases.filter((item) => item.name.startsWith("[M03]"));
  const denied = m03.filter((item) => item.name.includes("[denied]"));
  const boundaries = m03.filter((item) => item.name.includes("[boundary]"));
  assert.ok(denied.length >= 3, "Se requieren al menos tres rechazos reales.");
  assert.ok(boundaries.length >= 2, "Se requieren dos limites M03.");
  assert.ok(m03.some((item) => item.name.includes("[normal]")));
  assert.ok(m03.some((item) => item.name.includes("[declared failure]")));
  assert.ok(m03.some((item) => item.name.includes("[rotation]")));

  stage = "secrets";
  const secrets = scanSecrets();

  stage = "database";
  const database = await withClient(async (client) => {
    const { rows: [counts] } = await client.query(`SELECT
      (SELECT count(*)::int FROM devices) AS devices,
      (SELECT count(*)::int FROM telemetry_events) AS telemetry_events,
      (SELECT count(*)::int FROM device_status) AS device_status,
      (SELECT count(*)::int FROM telemetry_alerts) AS telemetry_alerts,
      (SELECT count(*)::int FROM schema_migrations) AS migrations`);
    const { rows: migrations } = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const { rows: owners } = await client.query(`
      SELECT tablename, tableowner FROM pg_tables
      WHERE schemaname = 'public' ORDER BY tablename
    `);
    assert.ok(counts.devices >= 2 && counts.telemetry_events >= 3 && counts.device_status >= 2 && counts.telemetry_alerts >= 1);
    assert.ok(counts.migrations >= 4);
    assert.ok(owners.every((table) => table.tableowner === "role_migrator"), "El migrador debe ser propietario.");
    return { engine: "PostgreSQL", counts, migrations, owners };
  }, "migrator");

  const base = {
    status: "passed", generatedAt: new Date().toISOString(),
    git: { commitSha: git("rev-parse", "HEAD"), workingTreeStatus: git("status", "--short") },
    commands: ["make setup", "make verify", "make run"],
    database
  };
  const artifact = {
    assignmentId: "m03-roles-secrets", ...base, tests,
    accessControl: {
      serviceRoles: ["migrator", "writer", "reader", "operator"],
      separateLogins: true, nonAdminServiceAccounts: true,
      negativeTests: denied.length, expectedDenialSqlState: "42501",
      boundaryTests: boundaries.length, credentialRotationTested: true
    },
    secrets,
    environment: {
      mode: process.env.CDRL_DATABASE_MODE || "local",
      awsValidated: false,
      note: "Docker Compose es el entorno validado. AWS requiere un Learner Lab habilitado y autorizacion del entorno."
    }
  };
  write("artifacts/m03-verify.json", artifact);
  write("artifacts/m01-verify.json", { assignmentId: "m01-data-contract", ...base, tests: tests.cases.filter((item) => item.file === "tests/telemetry-contract.test.mjs") });
  write("artifacts/m02-verify.json", { assignmentId: "m02-relational-model", ...base, tests: tests.cases.filter((item) => item.file === "tests/operational-model.test.mjs") });
  write("evidence/m03-roles-secrets-local.json", { ...evidence, status: "passed", commitSha: base.git.commitSha, generatedAt: base.generatedAt, verification: artifact });
  console.log(`M03 PASSED: ${tests.passed} pruebas, ${denied.length} accesos denegados, ${secrets.findings.length} secretos detectados.`);
  console.log(`SHA verificado: ${base.git.commitSha}`);
  console.log("Artefacto: artifacts/m03-verify.json");
  console.log("Evidencia ejecutada: evidence/m03-roles-secrets-local.json");
} catch (error) {
  const failure = { assignmentId: "m03-roles-secrets", status: "failed", generatedAt: new Date().toISOString(), stage, error: error.message };
  write("artifacts/m03-verify.json", failure);
  write("evidence/m03-roles-secrets-local.json", failure);
  console.error(`M03 FAILED (${stage}): ${error.message}`);
  process.exitCode = 1;
}
