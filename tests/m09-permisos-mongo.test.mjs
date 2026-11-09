import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rootDir } from "../src/config.mjs";
import {
  withMongo, mongoUri, createEvent, readEvent, updateEvent, upsertEvent,
  findEventsByDevice, findEventsPage, findOpenAlerts, acknowledgeAlertWithAudit
} from "../src/mongo.mjs";
import { MONGO_ACCOUNTS, MONGO_UNAUTHORIZED, mongoAccount, withMongoAs } from "../src/mongo-accounts.mjs";

// Todo se ejecuta contra MongoDB real con cada cuenta. La cuenta de mantenimiento
// (MONGO_APP_USER) solo prepara y limpia los datos sinteticos y comprueba que no cambiaron.
const SOURCE = "synthetic-m09";
const DEVICE = "dev_m09_perm";
const ACCOUNTS = Object.keys(MONGO_ACCOUNTS);

const shell = 'exec mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const rootScript = (file, env = {}) =>
  execFileSync("docker", [
    "compose", "--profile", "mongo", "exec", "-T",
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "mongo", "sh", "-c", `${shell} ${file}`
  ], { cwd: rootDir, encoding: "utf8" });

const newEvent = (overrides = {}) => ({
  event_id: randomUUID(), device_id: DEVICE, event_type: "temperature_c",
  observed_at: new Date("2026-11-02T08:00:00Z"), ingested_at: new Date("2026-11-02T08:00:02Z"),
  metric_value: 21.5, unit: "C", severity: "info", source: SOURCE, payload: {}, ...overrides
});
const newAlert = (eventId) => ({
  alert_id: randomUUID(), event_id: eventId, device_id: DEVICE, alert_type: "threshold",
  status: "open", severity: "critical", opened_at: new Date("2026-11-02T08:01:00Z"), acknowledged_at: null, resolved_at: null
});

// Rechazo real del servidor: codigo 13 (Unauthorized), no una validacion de JavaScript.
const denied = (promise, label) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, MONGO_UNAUTHORIZED, `${label}: se esperaba Unauthorized y llego ${error.code} ${error.message}`);
    assert.equal(error.codeName, "Unauthorized", label);
    return true;
  }, label);

// Estado de los datos sinteticos visto por la cuenta de mantenimiento.
const snapshot = (db) => Promise.all([
  db.collection("events").find({ source: SOURCE }, { projection: { _id: 0 } }).sort({ event_id: 1 }).toArray(),
  db.collection("alerts").find({ device_id: DEVICE }, { projection: { _id: 0 } }).sort({ alert_id: 1 }).toArray(),
  db.collection("alert_audit").find({ actor: /^synthetic:m09/ }, { projection: { _id: 0 } }).sort({ operation_id: 1 }).toArray()
]).then(([events, alerts, audit]) => ({ events, alerts, audit }));

async function cleanup(db) {
  const alerts = await db.collection("alerts").find({ device_id: DEVICE }).toArray();
  await db.collection("alert_audit").deleteMany({ $or: [{ actor: /^synthetic:m09/ }, { alert_id: { $in: alerts.map((a) => a.alert_id) } }] });
  await db.collection("alerts").deleteMany({ device_id: DEVICE });
  await db.collection("events").deleteMany({ source: SOURCE });
}

// Prepara un evento, una alerta abierta y un registro de auditoria completado por el operador.
async function seedAudited() {
  const event = newEvent();
  const alert = newAlert(event.event_id);
  const operationId = randomUUID();
  await withMongo(async (db) => {
    await db.collection("events").insertOne({ ...event });
    await db.collection("alerts").insertOne({ ...alert });
  });
  const result = await withMongoAs("operator", (db) => acknowledgeAlertWithAudit(alert.alert_id, { db, operationId, actor: "synthetic:m09-operator" }));
  assert.equal(result.status, "completed");
  return { event, alert, operationId };
}

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/setup-audit.mjs"], { cwd: rootDir, stdio: "inherit" });
  await withMongo(cleanup);
});

after(async () => {
  await withMongo(cleanup);
});

test("[M09][normal] ingest crea, lee y actualiza eventos con el CRUD existente", async () => {
  const event = newEvent();
  try {
    await withMongoAs("ingest", async (db) => {
      assert.equal((await createEvent(event, { db })).created, true);
      assert.equal((await upsertEvent(event, { db })).action, "duplicate");
      await updateEvent(event.event_id, { severity: "warning" }, { db });
      assert.equal((await readEvent(event.event_id, { db })).severity, "warning");
    });
    await withMongo(async (db) => assert.equal((await readEvent(event.event_id, { db })).severity, "warning"));
  } finally {
    await withMongo(cleanup);
  }
});

test("[M09][normal] reader consulta eventos y alertas con Q1, la paginacion y Q2", async () => {
  await withMongoAs("reader", async (db) => {
    const q1 = await findEventsByDevice(db, { deviceId: "dev_sensor_01", from: "2026-09-20", to: "2026-09-23", limit: 10 });
    assert.ok(q1.length > 0);
    const page = await findEventsPage(db, { deviceId: "dev_sensor_01", from: "2026-09-20", to: "2026-09-23", limit: 2 });
    assert.equal(page.items.length, 2);
    assert.ok(Array.isArray(await findOpenAlerts(db, { limit: 10 })));
  });
});

test("[M09][normal] operator reconoce una alerta con auditoria y auditor la puede leer", async () => {
  try {
    const { alert, operationId } = await seedAudited();
    const record = await withMongoAs("auditor", (db) => db.collection("alert_audit").findOne({ operation_id: operationId }));
    assert.equal(record.alert_id, alert.alert_id);
    assert.equal(record.audit_status, "completed");
    assert.equal(record.actor, "synthetic:m09-operator");
    assert.deepEqual(record.resource, { type: "alert", id: alert.alert_id });
    assert.equal(record.result, "success");
    assert.equal(record.result_code, "alert_acknowledged");
    const stored = await withMongoAs("operator", (db) => db.collection("alerts").findOne({ alert_id: alert.alert_id }));
    assert.equal(stored.status, "acknowledged");
    assert.equal(stored.audit_operation_id, operationId);
  } finally {
    await withMongo(cleanup);
  }
});

const privilegeSet = (privileges) => privileges
  .filter((p) => p.resource.db === "cdrl")
  .flatMap((p) => p.actions.map((action) => `${p.resource.collection || "*"}:${action}`))
  .sort();

test("[M09][boundary] cada cuenta tiene exactamente los privilegios declarados y ninguno administrativo", async () => {
  for (const name of ACCOUNTS) {
    const status = await withMongoAs(name, (db) => db.command({ connectionStatus: 1, showPrivileges: true }));
    const { authenticatedUsers, authenticatedUserRoles, authenticatedUserPrivileges } = status.authInfo;
    assert.deepEqual(authenticatedUsers.map((u) => `${u.user}@${u.db}`), [`${mongoAccount(name).user}@cdrl`], name);
    assert.deepEqual(authenticatedUserRoles.map((r) => `${r.role}@${r.db}`), [`${MONGO_ACCOUNTS[name].role}@cdrl`], name);
    assert.deepEqual(privilegeSet(authenticatedUserPrivileges), privilegeSet(MONGO_ACCOUNTS[name].privileges), name);
    assert.ok(authenticatedUserPrivileges.every((p) => p.resource.db === "cdrl" && !p.resource.cluster), `${name} no tiene privilegios fuera de cdrl`);
  }
});

test("[M09][boundary] repetir init conserva datos, roles y privilegios", async () => {
  const counts = () => withMongo(async (db) => Object.fromEntries(await Promise.all(
    ["events", "alerts", "alert_audit"].map(async (name) => [name, await db.collection(name).countDocuments()])
  )));
  const before = await counts();
  rootScript("/mongo/init.js");
  rootScript("/mongo/init.js");
  assert.deepEqual(await counts(), before);
  for (const name of ACCOUNTS) {
    const status = await withMongoAs(name, (db) => db.command({ connectionStatus: 1, showPrivileges: true }));
    assert.deepEqual(privilegeSet(status.authInfo.authenticatedUserPrivileges), privilegeSet(MONGO_ACCOUNTS[name].privileges), name);
  }
});

test("[M09][remediation] revocar permiso excesivo conserva las operaciones permitidas", async () => {
  const suffix = randomUUID().replaceAll("-", "");
  const user = `m09_test_${suffix}`;
  const password = randomUUID();
  const role = `m09_test_${suffix}`;
  const collection = `m09_test_${suffix}`;
  const env = {
    M09_TEST_USER: user,
    M09_TEST_PASSWORD: password,
    M09_TEST_ROLE: role,
    M09_TEST_COLLECTION: collection
  };
  const accountOptions = { user, password, authSource: "cdrl" };

  try {
    rootScript("/mongo/m09-permission-remediation.js", { ...env, M09_TEST_MODE: "setup" });
    await withMongo(async (db) => {
      await db.collection(collection).insertOne({ _id: "before-remediation" });
      assert.equal((await db.collection(collection).deleteOne({ _id: "before-remediation" })).deletedCount, 1);
    }, accountOptions);

    rootScript("/mongo/m09-permission-remediation.js", { ...env, M09_TEST_MODE: "revoke" });
    await withMongo(async (db) => {
      await db.collection(collection).insertOne({ _id: "allowed-after-remediation" });
      assert.equal((await db.collection(collection).findOne({ _id: "allowed-after-remediation" }))._id,
        "allowed-after-remediation");
      await denied(db.collection(collection).deleteOne({ _id: "allowed-after-remediation" }), "delete revocado");
      assert.equal(await db.collection(collection).countDocuments({ _id: "allowed-after-remediation" }), 1);
    }, accountOptions);
  } finally {
    rootScript("/mongo/m09-permission-remediation.js", { ...env, M09_TEST_MODE: "cleanup" });
  }
});

test("[M09][boundary] los secretos vienen del entorno, son distintos y no estan en el repositorio", () => {
  const tracked = execFileSync("git", ["ls-files", ".env"], { cwd: rootDir, encoding: "utf8" }).trim();
  assert.equal(tracked, "", ".env no debe estar versionado");
  const example = fs.readFileSync(path.join(rootDir, ".env.example"), "utf8");
  for (const line of example.split(/\r?\n/).filter((l) => /^MONGO_\w*PASSWORD=/.test(l))) {
    assert.match(line, /=$/, `${line.split("=")[0]} no debe tener valor en .env.example`);
  }
  const accounts = ACCOUNTS.map(mongoAccount);
  const users = [process.env.MONGO_USER, process.env.MONGO_APP_USER, ...accounts.map((a) => a.user)];
  const passwords = [process.env.MONGO_PASSWORD, process.env.MONGO_APP_PASSWORD, ...accounts.map((a) => a.password)];
  assert.equal(new Set(users).size, users.length, "una cuenta por responsabilidad");
  assert.equal(new Set(passwords).size, passwords.length, "un secreto por cuenta");
  // La aplicacion se conecta con su cuenta, nunca con la administradora (root).
  assert.ok(!decodeURIComponent(new URL(mongoUri()).username).includes(process.env.MONGO_USER));
  const source = ["src", "scripts", "tests"].flatMap((dir) => fs.readdirSync(path.join(rootDir, dir))
    .filter((file) => file.endsWith(".mjs")).map((file) => fs.readFileSync(path.join(rootDir, dir, file), "utf8")));
  for (const password of passwords) assert.ok(!source.some((text) => text.includes(password)), "ningun secreto escrito en el codigo");
});

test("[M09][declared failure] lecturas fuera de su coleccion se rechazan", async () => {
  try {
    await seedAudited();
    const reads = [
      ["ingest", "alerts"], ["ingest", "alert_audit"],
      ["reader", "alert_audit"],
      ["operator", "events"],
      ["auditor", "events"], ["auditor", "alerts"]
    ];
    for (const [name, collection] of reads) {
      await withMongoAs(name, (db) => denied(db.collection(collection).findOne({}), `${name} lee ${collection}`));
    }
  } finally {
    await withMongo(cleanup);
  }
});

test("[M09][declared failure] escrituras sin permiso se rechazan y no cambian datos", async () => {
  try {
    const { event, alert } = await seedAudited();
    const before = await withMongo(snapshot);
    const attempts = {
      reader: [
        (db) => db.collection("events").insertOne(newEvent()),
        (db) => db.collection("events").updateOne({ event_id: event.event_id }, { $set: { severity: "critical" } }),
        (db) => db.collection("alerts").updateOne({ alert_id: alert.alert_id }, { $set: { status: "resolved", resolved_at: new Date() } }),
        (db) => db.collection("events").deleteOne({ event_id: event.event_id })
      ],
      ingest: [
        (db) => db.collection("events").deleteOne({ event_id: event.event_id }),
        (db) => db.collection("events").deleteMany({ source: SOURCE }),
        (db) => db.collection("alerts").insertOne(newAlert(randomUUID()))
      ],
      operator: [
        (db) => db.collection("events").insertOne(newEvent()),
        (db) => db.collection("events").updateOne({ event_id: event.event_id }, { $set: { severity: "critical" } }),
        (db) => db.collection("alerts").deleteOne({ alert_id: alert.alert_id })
      ],
      auditor: [
        (db) => db.collection("alerts").updateOne({ alert_id: alert.alert_id }, { $set: { severity: "info" } }),
        (db) => db.collection("events").insertOne(newEvent())
      ]
    };
    for (const [name, list] of Object.entries(attempts)) {
      await withMongoAs(name, async (db) => {
        for (const [i, attempt] of list.entries()) await denied(attempt(db), `${name} escritura ${i + 1}`);
      });
    }
    assert.deepEqual(await withMongo(snapshot), before, "los intentos rechazados no cambian datos");
  } finally {
    await withMongo(cleanup);
  }
});

test("[M09][declared failure] nadie fuera del flujo puede modificar ni borrar la auditoria", async () => {
  try {
    const { operationId } = await seedAudited();
    const before = await withMongo(snapshot);
    const forgedAlertId = randomUUID();
    const forged = {
      operation_id: randomUUID(),
      alert_id: forgedAlertId,
      resource: { type: "alert", id: forgedAlertId },
      action: "alert.acknowledged",
      occurred_at: new Date(),
      actor: "synthetic:m09-forged",
      result: "success",
      result_code: "alert_acknowledged",
      changes: { status: { from: "open", to: "acknowledged" }, acknowledged_at: new Date() },
      audit_status: "completed"
    };
    const tamper = {
      update: (db) => db.collection("alert_audit").updateOne({ operation_id: operationId }, { $set: { actor: "synthetic:m09-otro" } }),
      deleteOne: (db) => db.collection("alert_audit").deleteOne({ operation_id: operationId }),
      deleteMany: (db) => db.collection("alert_audit").deleteMany({}),
      drop: (db) => db.collection("alert_audit").drop(),
      insert: (db) => db.collection("alert_audit").insertOne({ ...forged })
    };
    for (const name of ["ingest", "reader", "auditor"]) {
      await withMongoAs(name, async (db) => {
        for (const [action, attempt] of Object.entries(tamper)) await denied(attempt(db), `${name} ${action} auditoria`);
      });
    }
    // operator escribe la auditoria del reconocimiento, pero no la borra ni la elimina.
    await withMongoAs("operator", async (db) => {
      for (const action of ["deleteOne", "deleteMany", "drop"]) await denied(tamper[action](db), `operator ${action} auditoria`);
    });
    assert.deepEqual(await withMongo(snapshot), before, "la auditoria queda igual");
  } finally {
    await withMongo(cleanup);
  }
});

test("[M09][declared failure] las cuentas no pueden administrar usuarios, roles ni la base", async () => {
  for (const name of ACCOUNTS) {
    await withMongoAs(name, async (db) => {
      await denied(db.command({ createUser: `m09_intruso_${name}`, pwd: randomUUID(), roles: [{ role: "readWrite", db: "cdrl" }] }), `${name} createUser`);
      await denied(db.command({ grantRolesToUser: mongoAccount(name).user, roles: [{ role: "readWrite", db: "cdrl" }] }), `${name} se da readWrite`);
      await denied(db.command({ usersInfo: 1 }), `${name} lista usuarios`);
      await denied(db.dropDatabase(), `${name} dropDatabase`);
    });
  }
  // La cuenta de mantenimiento tampoco es administradora.
  await withMongo((db) => denied(db.command({ createUser: "m09_intruso_app", pwd: randomUUID(), roles: [] }), "app createUser"));
  // Una contrasena equivocada no autentica.
  await assert.rejects(withMongo(() => {}, { user: mongoAccount("reader").user, password: "incorrecta" }), { code: 18 });
});
