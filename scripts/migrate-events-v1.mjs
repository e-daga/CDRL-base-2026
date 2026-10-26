import { withMongo } from "../src/mongo.mjs";
import { inspectEventMigration, migrateEventsV1, rollbackEventMigration } from "./event-migration.mjs";

function usage(output = console.error) {
  output(`Uso:
  node scripts/migrate-events-v1.mjs inspect (--source <valor> | --device-id <valor> | --event-id <uuid>) [selectores...] [--batch-size 100]
  node scripts/migrate-events-v1.mjs migrate (--source <valor> | --device-id <valor> | --event-id <uuid>) [selectores...] --run-id <uuid> [--batch-size 100]
  node scripts/migrate-events-v1.mjs rollback --run-id <uuid> [--batch-size 100]

El alcance de inspect/migrate debe incluir al menos un selector exacto. El mismo run-id reanuda.`);
}

function parseArgs(args) {
  const [action, ...rest] = args;
  const options = {};
  const allowedOptions = new Set(["--source", "--device-id", "--event-id", "--run-id", "--batch-size"]);
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!allowedOptions.has(key) || !rest[i + 1]) {
      throw new Error(`Opción inválida o sin valor: ${key}`);
    }
    if (options[key]) throw new Error(`Opción repetida: ${key}`);
    options[key] = rest[i + 1];
    i += 1;
  }
  const batchSize = options["--batch-size"] === undefined ? 100 : Number(options["--batch-size"]);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("--batch-size debe ser un entero positivo.");

  const scope = Object.fromEntries([
    ["--source", "source"],
    ["--device-id", "device_id"],
    ["--event-id", "event_id"]
  ].filter(([flag]) => options[flag] !== undefined).map(([flag, field]) => [field, options[flag]]));
  if (action === "inspect" && (!Object.keys(scope).length || options["--run-id"])) throw new Error("inspect requiere un selector de alcance y no acepta --run-id.");
  if (action === "migrate" && (!Object.keys(scope).length || !options["--run-id"])) throw new Error("migrate requiere un selector de alcance y --run-id explícitos.");
  if (action === "rollback" && (!options["--run-id"] || Object.keys(scope).length)) throw new Error("rollback requiere --run-id y no acepta selectores.");
  if (!["inspect", "migrate", "rollback"].includes(action)) throw new Error("Acción desconocida.");
  return { action, scope, runId: options["--run-id"], batchSize };
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  usage(console.log);
} else if (args.length === 0) {
  usage();
  process.exitCode = 1;
} else try {
  const { action, scope, runId, batchSize } = parseArgs(args);
  const report = await withMongo((db) => {
    if (action === "inspect") return inspectEventMigration(db, scope, { batchSize });
    if (action === "migrate") return migrateEventsV1(db, scope, { runId, batchSize });
    return rollbackEventMigration(db, runId, { batchSize });
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
