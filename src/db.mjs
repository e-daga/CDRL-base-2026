import pg from "pg";
import { dbConfig } from "./config.mjs";

export function createClient() {
  return new pg.Client(dbConfig);
}

export async function withClient(work) {
  const client = createClient();
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
