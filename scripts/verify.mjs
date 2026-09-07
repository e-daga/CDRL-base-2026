import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withClient } from "../src/db.mjs";
import { rootDir } from "../src/config.mjs";

const requiredFiles = [
  ".env.example",
  "Makefile",
  "docker-compose.yml",
  "package.json",
  "package-lock.json",
  "db/migrations/001_create_telemetry_contract.sql",
  "db/seed/001_synthetic_telemetry.sql",
  "evidence/m01-data-contract.json",
  ".github/workflows/cdrl-feedback.yml"
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(rootDir, file)));
if (missing.length > 0) {
  throw new Error(`Faltan archivos requeridos: ${missing.join(", ")}`);
}

const testsDir = path.join(rootDir, "tests");
const testFiles = fs.readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

const testSource = testFiles
  .map((file) => fs.readFileSync(path.join(testsDir, file), "utf8"))
  .join("\n");
const testCaseCount = (testSource.match(/\btest\s*\(/g) ?? []).length;

if (testFiles.length === 0 || testCaseCount < 4) {
  throw new Error("La verificacion M01 requiere al menos 4 pruebas automaticas reales.");
}

if (!/declared failure|fallo declarado/i.test(testSource)) {
  throw new Error("La suite debe declarar explicitamente un caso de fallo.");
}

function gitValue(args, fallback) {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

const dbSummary = await withClient(async (client) => {
  const tables = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('devices', 'telemetry_events', 'schema_migrations')
    order by table_name
  `);

  const counts = await client.query(`
    select
      (select count(*)::int from devices) as devices,
      (select count(*)::int from telemetry_events) as telemetry_events,
      (select count(*)::int from schema_migrations) as migrations
  `);

  return {
    tables: tables.rows.map((row) => row.table_name),
    counts: counts.rows[0],
    nodeTestFiles: testFiles,
    nodeTestCases: testCaseCount
  };
});

const expectedTables = ["devices", "schema_migrations", "telemetry_events"];
for (const table of expectedTables) {
  if (!dbSummary.tables.includes(table)) {
    throw new Error(`Falta la tabla requerida: ${table}`);
  }
}

if (dbSummary.counts.devices < 2 || dbSummary.counts.telemetry_events < 3) {
  throw new Error("El seed debe dejar al menos 2 dispositivos y 3 eventos de telemetria.");
}

const artifact = {
  assignmentId: "m01-data-contract",
  status: "passed",
  generatedAt: new Date().toISOString(),
  git: {
    commitSha: gitValue(["rev-parse", "HEAD"], "uncommitted"),
    workingTreeStatus: gitValue(["status", "--short"], "not-a-git-repository")
  },
  commands: [
    "make setup",
    "make verify",
    "make run"
  ],
  database: dbSummary,
  automatedChecks: {
    normalCase: "temperature_c aceptado",
    boundaryCases: [
      "battery_pct acepta 0",
      "humidity_pct acepta 100"
    ],
    declaredFailure: "battery_pct mayor a 100 se rechaza por constraint"
  }
};

fs.mkdirSync(path.join(rootDir, "artifacts"), { recursive: true });
fs.writeFileSync(
  path.join(rootDir, "artifacts", "m01-verify.json"),
  `${JSON.stringify(artifact, null, 2)}\n`
);

console.log("Verificacion de scripts M01 completada");
console.log(JSON.stringify(artifact, null, 2));
