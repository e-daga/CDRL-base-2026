import fs from "node:fs";
import { withMongo } from "../src/mongo.mjs";
import { collectM07 } from "../src/m07-experiment.mjs";
fs.mkdirSync("artifacts", { recursive: true });
try {
  const result = await withMongo(collectM07);
  fs.writeFileSync("artifacts/m07-migration.json", JSON.stringify(result, null, 2) + "\n");
  console.log("M07: migracion real repetible, consumidor compatible y rollback exacto en fixture aislado.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  fs.writeFileSync("artifacts/m07-migration.json", JSON.stringify({ status: "failed", error: error.message }, null, 2) + "\n");
  throw error;
}
