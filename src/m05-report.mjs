import assert from "node:assert/strict";
import { explainQuery } from "./mongo.mjs";

export function summarizeExplain(explain) {
  const stages = new Set();
  const indexes = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.stage) stages.add(node.stage);
    if (node.indexName) indexes.add(node.indexName);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  // Rejected plans are deliberately excluded.
  visit(explain.queryPlanner.winningPlan);
  visit(explain.executionStats.executionStages);
  return {
    stages: [...stages], indexes: [...indexes],
    executionSuccess: explain.executionStats.executionSuccess,
    nReturned: explain.executionStats.nReturned,
    totalKeysExamined: explain.executionStats.totalKeysExamined,
    totalDocsExamined: explain.executionStats.totalDocsExamined,
    executionTimeMillis: explain.executionStats.executionTimeMillis
  };
}

export async function collectM05(db) {
  const cases = [
    ["Q1", "events", { device_id: "dev_sensor_01", observed_at: { $gte: new Date("2026-09-20"), $lte: new Date("2026-09-23") } }, { observed_at: -1 }, ["idx_events_device_observed"]],
    ["Q2-global", "alerts", { status: "open" }, { opened_at: -1 }, ["idx_alerts_status_opened", "idx_alerts_status_device_severity"]],
    ["Q2-device", "alerts", { status: "open", device_id: "dev_sensor_01" }, { opened_at: -1 }, ["idx_alerts_status_opened", "idx_alerts_status_device_severity"]],
    ["Q2-severity", "alerts", { status: "open", severity: "critical" }, { opened_at: -1 }, ["idx_alerts_status_opened", "idx_alerts_status_device_severity"]],
    ["Q2-device-severity", "alerts", { status: "open", device_id: "dev_sensor_01", severity: "critical" }, { opened_at: -1 }, ["idx_alerts_status_opened", "idx_alerts_status_device_severity"]]
  ];
  const queries = [];
  for (const [name, collection, filter, sort, allowed] of cases) {
    const plan = summarizeExplain(await explainQuery(db, collection, filter, sort, 100));
    assert.equal(plan.executionSuccess, true);
    assert.ok(plan.nReturned > 0, name + ": requiere fixtures con resultados.");
    assert.ok(!plan.stages.includes("COLLSCAN"), name + ": escaneo completo inesperado.");
    assert.ok(plan.indexes.some((index) => allowed.includes(index)), name + ": falta indice declarado en plan ganador.");
    queries.push({ name, collection, filter, sort, limit: 100, hinted: false, ...plan });
  }
  const collections = {};
  for (const name of ["events", "alerts"]) {
    collections[name] = { count: await db.collection(name).countDocuments(), indexes: await db.collection(name).listIndexes().toArray() };
  }
  const auth = await db.command({ connectionStatus: 1 });
  assert.ok(auth.authInfo.authenticatedUserRoles.some((role) => role.role === "readWrite" && role.db === "cdrl"));
  assert.ok(!auth.authInfo.authenticatedUserRoles.some((role) => role.role === "root"));
  return {
    engine: "MongoDB", collections, queries,
    applicationRoles: auth.authInfo.authenticatedUserRoles,
    limitations: ["Local standalone; no replica-set failover or cross-document transactions measured.", "Small synthetic fixtures; not a production latency or scale benchmark.", "Event/alert references are not foreign keys; independent CRUD may leave orphan alerts."]
  };
}
