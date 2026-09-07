import fs from "node:fs";
import path from "node:path";
import { withClient } from "../src/db.mjs";
import { rootDir } from "../src/config.mjs";

const seedDir = path.join(rootDir, "db", "seed");

await withClient(async (client) => {
  const files = fs.readdirSync(seedDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(seedDir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("commit");
      console.log(`seed ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
});
