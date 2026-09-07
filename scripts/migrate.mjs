import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withClient } from "../src/db.mjs";
import { rootDir } from "../src/config.mjs";

const migrationsDir = path.join(rootDir, "db", "migrations");

await withClient(async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const applied = await client.query(
      "select checksum from schema_migrations where version = $1",
      [version]
    );

    if (applied.rowCount > 0) {
      if (applied.rows[0].checksum !== checksum) {
        throw new Error(`Cambio el checksum de la migracion ya aplicada: ${file}`);
      }
      console.log(`omitida ${file}`);
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (version, checksum) values ($1, $2)",
        [version, checksum]
      );
      await client.query("commit");
      console.log(`aplicada ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
});
