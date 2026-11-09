import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "./config.mjs";
import { withMongo } from "./mongo.mjs";

export async function remediateTemporaryPermission() {
  const name = `m09_test_${randomUUID().replaceAll("-", "")}`;
  const password = randomBytes(32).toString("hex");
  const environment = {
    M09_TEST_USER: name, M09_TEST_ROLE: name, M09_TEST_COLLECTION: name,
    M09_TEST_PASSWORD: password
  };
  const run = (mode) => {
    const env = { ...process.env, ...environment, M09_TEST_MODE: mode };
    const names = [...Object.keys(environment), "M09_TEST_MODE"];
    try {
      // Pass env names only: exec errors must not contain the temporary password.
      execFileSync("docker", ["compose", "--profile", "mongo", "exec", "-T",
        ...names.flatMap((key) => ["-e", key]), "mongo", "sh", "-c",
        'exec mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin /mongo/m09-permission-remediation.js'
      ], { cwd: rootDir, env, stdio: "pipe", timeout: 60000 });
    } catch {
      throw new Error(`No se completo la fase ${mode} de remediacion temporal; secretos omitidos.`);
    }
  };
  let report;
  try {
    run("setup");
    const options = { user: name, password, authSource: "cdrl" };
    const before = await withMongo(async (db) => {
      await db.collection(name).insertOne({ _id: "before" });
      return (await db.collection(name).deleteOne({ _id: "before" })).deletedCount;
    }, options);
    assert.equal(before, 1);
    run("revoke");
    const after = await withMongo(async (db) => {
      await db.collection(name).insertOne({ _id: "after" });
      await assert.rejects(db.collection(name).deleteOne({ _id: "after" }), { code: 13, codeName: "Unauthorized" });
      const retained = await db.collection(name).countDocuments({ _id: "after" });
      assert.equal(retained, 1);
      return { deleteDeniedCode: 13, insertAllowed: true, findAllowed: true, retained };
    }, options);
    report = { status: "passed", collection: name, scope: "temporary role, account and synthetic collection only", before: { deleted: before, removeAllowed: true }, after, reconnectAfterRevocation: true };
  } finally {
    run("cleanup");
  }
  // Cleanup success is also checked through an independent administrative read.
  await withMongo(async (db) => assert.equal((await db.listCollections({ name }).toArray()).length, 0));
  return { ...report, cleanupCompleted: true };
}
