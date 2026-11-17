import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetricsRecorder } from "../src/m11-metrics.mjs";

// Reloj y espera simulados: la latencia sale de la ejecucion real del flujo,
// pero no depende de la velocidad de la computadora.
function fakeTime() {
  let current = 1000;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    sleep: async (ms) => { current += ms; }
  };
}

test("[M11][metrics] successful operation records one success with one attempt", async () => {
  const time = fakeTime();
  const metrics = createMetricsRecorder({ now: time.now });
  const result = await metrics.runOperation("read_events", async () => {
    time.advance(40);
    return "ok";
  }, { sleep: time.sleep });

  assert.equal(result, "ok");
  const summary = metrics.summarize();
  assert.deepEqual(summary.operations, { total: 1, successful: 1, failed: 0, retried: 0 });
  assert.equal(summary.attempts.total, 1);
  assert.equal(summary.latency_ms.total, 40);
  assert.deepEqual(summary.by_operation, [
    { name: "read_events", status: "success", attempts: 1, latency_ms: 40 }
  ]);
});

test("[M11][metrics] failed operation exhausts retries and is recorded once as failed", async () => {
  const time = fakeTime();
  const metrics = createMetricsRecorder({ now: time.now });
  let calls = 0;
  await assert.rejects(
    metrics.runOperation("write_alert", async () => {
      calls += 1;
      time.advance(10);
      throw new TypeError("fallo simulado");
    }, { maxAttempts: 3, delayMs: 100, sleep: time.sleep }),
    { name: "TypeError" }
  );

  assert.equal(calls, 3);
  const summary = metrics.summarize();
  assert.deepEqual(summary.operations, { total: 1, successful: 0, failed: 1, retried: 1 });
  assert.equal(summary.attempts.total, 3);
  assert.equal(summary.by_operation[0].status, "failed");
  assert.equal(summary.by_operation[0].attempts, 3);
  assert.equal(summary.by_operation[0].error_type, "TypeError");
  assert.ok(summary.latency_ms.total >= 3 * 10, "la latencia debe incluir el trabajo de cada intento");
});

test("[M11][metrics] operation that recovers on the third attempt counts as one success with three attempts", async () => {
  const time = fakeTime();
  const metrics = createMetricsRecorder({ now: time.now });
  const delayMs = 50;
  await metrics.runOperation("sync_device", async (attempt) => {
    time.advance(5);
    if (attempt < 3) throw new Error("fallo transitorio");
    return attempt;
  }, { maxAttempts: 5, delayMs, sleep: time.sleep });

  const summary = metrics.summarize();
  assert.deepEqual(summary.operations, { total: 1, successful: 1, failed: 0, retried: 1 });
  assert.equal(summary.attempts.total, 3);
  assert.equal(summary.by_operation[0].attempts, 3);
  // Latencia total = 3 intentos de trabajo + las esperas entre intentos.
  const waits = delayMs * 1 + delayMs * 2;
  assert.equal(summary.latency_ms.total, 3 * 5 + waits);
  assert.ok(summary.latency_ms.total > waits, "la latencia contempla las esperas");
});

test("[M11][metrics] non-retryable errors stop immediately and are recorded as failed", async () => {
  const metrics = createMetricsRecorder();
  let calls = 0;
  await assert.rejects(metrics.runOperation("bad_input", async () => {
    calls += 1;
    throw new RangeError("entrada invalida");
  }, { maxAttempts: 4, shouldRetry: () => false }));

  assert.equal(calls, 1);
  const summary = metrics.summarize();
  assert.equal(summary.by_operation[0].attempts, 1);
  assert.equal(summary.operations.failed, 1);
});

test("[M11][metrics] real clock records a valid latency without asserting an exact duration", async () => {
  const metrics = createMetricsRecorder();
  await metrics.runOperation("real_clock", async (attempt) => {
    if (attempt < 2) throw new Error("fallo transitorio");
    return true;
  }, { maxAttempts: 2, delayMs: 1 });

  const { latency_ms: latency, attempts } = metrics.summarize();
  assert.equal(attempts.total, 2);
  assert.ok(Number.isFinite(latency.total) && latency.total >= 0);
  assert.ok(latency.max >= latency.min);
});

test("[M11][metrics] summary aggregates several operations and is JSON-serializable", async () => {
  const time = fakeTime();
  const metrics = createMetricsRecorder({ now: time.now });
  await metrics.runOperation("ok_op", async () => { time.advance(20); });
  await metrics.runOperation("retry_op", async (attempt) => {
    time.advance(10);
    if (attempt === 1) throw new Error("x");
  }, { delayMs: 30, sleep: time.sleep });
  await assert.rejects(metrics.runOperation("fail_op", async () => {
    time.advance(10);
    throw new Error("x");
  }, { maxAttempts: 2, sleep: time.sleep }));

  const summary = metrics.summarize();
  assert.deepEqual(summary.operations, { total: 3, successful: 2, failed: 1, retried: 2 });
  assert.equal(summary.attempts.total, 1 + 2 + 2);
  assert.equal(summary.attempts.max_per_operation, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);

  metrics.reset();
  assert.equal(metrics.summarize().operations.total, 0);
});

test("[M11][metrics] summary never exposes secrets, connection strings or raw error text", async () => {
  const metrics = createMetricsRecorder();
  const secret = "mongodb://user:Sup3rS3cret@10.0.0.5:27017/cdrl";
  const error = new Error(`connect failed ${secret}`);
  error.stack = `Error: ${secret}\n    at secret.js:1`;
  error.password = "Sup3rS3cret";
  await assert.rejects(metrics.runOperation("db_call", async () => { throw error; }, { maxAttempts: 2 }));

  const serialized = JSON.stringify(metrics.summarize());
  assert.ok(!serialized.includes("Sup3rS3cret"));
  assert.ok(!serialized.includes("mongodb://"));
  assert.ok(!serialized.includes("connect failed"));
  assert.ok(!serialized.includes("secret.js"));
  assert.equal(metrics.summarize().by_operation[0].error_type, "Error");
});

test("[M11][metrics] invalid names and options are rejected", async () => {
  const metrics = createMetricsRecorder();
  const ok = async () => true;
  await assert.rejects(metrics.runOperation("mongodb://user:pass@host", ok), { name: "TypeError" });
  await assert.rejects(metrics.runOperation("op", "no-funcion"), { name: "TypeError" });
  await assert.rejects(metrics.runOperation("op", ok, { maxAttempts: 0 }), { name: "RangeError" });
  await assert.rejects(metrics.runOperation("op", ok, { delayMs: -1 }), { name: "RangeError" });
  assert.equal(metrics.summarize().operations.total, 0);
});
