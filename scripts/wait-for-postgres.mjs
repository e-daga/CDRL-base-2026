import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "../src/db.mjs";

const maxAttempts = Number(process.env.POSTGRES_WAIT_ATTEMPTS ?? 30);

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const client = createClient();
  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    console.log("PostgreSQL listo");
    process.exit(0);
  } catch (error) {
    try {
      await client.end();
    } catch {
      // La conexion puede fallar mientras el contenedor termina de arrancar.
    }

    if (attempt === maxAttempts) {
      console.error("PostgreSQL no estuvo listo a tiempo");
      console.error(error.message);
      process.exit(1);
    }

    await sleep(1000);
  }
}
