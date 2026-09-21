import pg from "pg";
import { databaseConfig } from "./config.mjs";

export function createClient(role = "reader") {
  return new pg.Client(databaseConfig(role));
}

export async function withClient(work, role = "reader") {
  const client = createClient(role);
  await client.connect();
  try {
    if (role === "migrator") await client.query("SET ROLE role_migrator");
    return await work(client);
  } finally {
    await client.end();
  }
}
