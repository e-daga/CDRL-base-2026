import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { withClient } from "../src/db.mjs";
import { databaseConfig } from "../src/config.mjs";
import { rotateDatabasePassword } from "../src/secret-rotation.mjs";

test("[M03][rotation] new credential works, old login and existing session are revoked", async () => {
  const user = "m03_rotation_" + crypto.randomBytes(6).toString("hex");
  const oldPassword = crypto.randomBytes(32).toString("hex");
  const nextPassword = crypto.randomBytes(32).toString("hex");
  const connect = (password) => new pg.Client({ ...databaseConfig("reader"), user, password });
  await withClient(async (admin) => {
    await admin.query(`CREATE ROLE ${pg.escapeIdentifier(user)} LOGIN PASSWORD ${pg.escapeLiteral(oldPassword)}`);
    await admin.query(`GRANT role_reader TO ${pg.escapeIdentifier(user)}`);
    const oldSession = connect(oldPassword);
    oldSession.on("error", () => {});
    try {
      await oldSession.connect();
      const { rows: [backend] } = await oldSession.query("SELECT pg_backend_pid() AS pid");
      await rotateDatabasePassword(admin, user, nextPassword);
      const fresh = connect(nextPassword);
      try {
        await fresh.connect();
        assert.ok((await fresh.query("SELECT * FROM devices")).rowCount >= 2);
      } finally { await fresh.end(); }
      const stale = connect(oldPassword);
      try { await assert.rejects(stale.connect(), { code: "28P01" }); }
      finally { await stale.end(); }
      const { rows: [active] } = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1", [backend.pid]);
      assert.equal(active.count, 0);
    } finally {
      await oldSession.end();
      await admin.query(`DROP ROLE ${pg.escapeIdentifier(user)}`);
    }
  }, "bootstrap");
});
