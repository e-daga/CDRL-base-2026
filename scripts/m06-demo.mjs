import fs from "node:fs";
import { withMongo } from "../src/mongo.mjs";
import { collectM06 } from "../src/m06-recovery.mjs";
fs.mkdirSync("artifacts", { recursive: true });
const report = await withMongo((db) => collectM06(db, async (backup) => {
  fs.writeFileSync("artifacts/m06-fixture-backup.json", JSON.stringify(backup, null, 2) + "\n");
  return JSON.parse(fs.readFileSync("artifacts/m06-fixture-backup.json", "utf8"));
}));
fs.writeFileSync("artifacts/m06-recovery.json", JSON.stringify(report, null, 2) + "\n");
console.log("M06: coexistencia, auditoria y recuperacion aislada realmente ejecutadas.");
console.log(JSON.stringify(report, null, 2));
