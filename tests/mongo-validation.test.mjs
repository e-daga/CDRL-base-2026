import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const shell = 'exec mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const run = (js) =>
  execFileSync("docker", ["compose", "--profile", "mongo", "exec", "-T", "mongo", "sh", "-c", shell], { input: js, encoding: "utf8" }).trim();
const last = (out) => out.split("\n").pop().replace(/^\w+>\s*/, "").trim();

const attempt = (coll, doc) =>
  last(run(`const d = db.getSiblingDB("cdrl"); try { d.${coll}.insertOne(EJSON.deserialize(${JSON.stringify(doc)})); print("ACCEPTED"); } catch (e) { print("REJECTED:" + e.code); }`));
const remove = (coll, key, value) => run(`db.getSiblingDB("cdrl").${coll}.deleteOne({ ${key}: "${value}" })`);
const iso = (ms = 0) => ({ $date: new Date(Date.now() + ms).toISOString() });

const event = (o = {}) => ({
  event_id: randomUUID(), device_id: "dev_test_01", event_type: "temperature_c",
  observed_at: iso(-60000), ingested_at: iso(), metric_value: 20, unit: "C",
  severity: "info", source: "test", payload: {}, ...o
});
const alert = (o = {}) => ({
  alert_id: randomUUID(), event_id: randomUUID(), device_id: "dev_test_01",
  alert_type: "threshold", status: "open", severity: "warning", opened_at: iso(-60000),
  acknowledged_at: null, resolved_at: null, ...o
});

before(() => { run('load("/mongo/seed.js")'); });

test("control: documentos validos si se aceptan", () => {
  const e = event(); const a = alert();
  assert.equal(attempt("events", e), "ACCEPTED");
  assert.equal(attempt("alerts", a), "ACCEPTED");
  remove("events", "event_id", e.event_id); remove("alerts", "alert_id", a.alert_id);
});

const badEvents = {
  "sin device_id": (() => { const e = event(); delete e.device_id; return e; })(),
  "device_id con formato invalido": event({ device_id: "sensor-1" }),
  "event_type no permitido": event({ event_type: "pressure" }),
  "severity no permitida": event({ severity: "fatal" }),
  "payload no es objeto": event({ payload: [1, 2] }),
  "metric_value como texto": event({ metric_value: "alto" }),
  "campo no declarado": event({ extra: 1 }),
  "battery_pct > 100": event({ event_type: "battery_pct", metric_value: 150 }),
  "humidity_pct < 0": event({ event_type: "humidity_pct", metric_value: -1 }),
  "observed_at en el futuro (> 5 min)": event({ observed_at: iso(3600000) })
};
for (const [name, doc] of Object.entries(badEvents)) {
  test(`events rechaza: ${name}`, () => assert.equal(attempt("events", doc), "REJECTED:121"));
}

const badAlerts = {
  "status no permitido": alert({ status: "closed" }),
  "alert_type no permitido": alert({ alert_type: "otro" }),
  "severity no permitida": alert({ severity: "alta" }),
  "acknowledged sin acknowledged_at": alert({ status: "acknowledged" }),
  "resolved sin resolved_at": alert({ status: "resolved", acknowledged_at: iso(-30000) }),
  "resolved_at anterior a opened_at": alert({ status: "resolved", acknowledged_at: iso(-30000), resolved_at: iso(-120000) })
};
for (const [name, doc] of Object.entries(badAlerts)) {
  test(`alerts rechaza: ${name}`, () => assert.equal(attempt("alerts", doc), "REJECTED:121"));
}

test("indice unico: event_id duplicado", () =>
  assert.equal(attempt("events", event({ event_id: "a1b2c3d4-0001-4000-8000-000000000001" })), "REJECTED:11000"));
test("indice unico: alert_id duplicado", () =>
  assert.equal(attempt("alerts", alert({ alert_id: "b1b2c3d4-0001-4000-8000-000000000001" })), "REJECTED:11000"));

test("indices esperados existen", () => {
  const names = (c) => JSON.parse(last(run(`print(JSON.stringify(db.getSiblingDB("cdrl").${c}.getIndexes().map(i => i.name)))`)));
  for (const n of ["uq_events_event_id", "idx_events_device_observed"]) assert.ok(names("events").includes(n), n);
  for (const n of ["uq_alerts_alert_id", "idx_alerts_status_device_severity"]) assert.ok(names("alerts").includes(n), n);
});

test("seed repetido no duplica", () => {
  const count = () => last(run('print(db.getSiblingDB("cdrl").events.countDocuments({}) + "/" + db.getSiblingDB("cdrl").alerts.countDocuments({}))'));
  const before = count();
  run('load("/mongo/seed.js")'); run('load("/mongo/seed.js")');
  assert.equal(count(), before);
});