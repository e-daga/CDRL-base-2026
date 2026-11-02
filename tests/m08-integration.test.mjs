import test from "node:test";
import assert from "node:assert/strict";
import { percentile, validateBenchmark } from "../src/m08-report.mjs";

// Deliberately synthetic unit-test samples, never exported as measured evidence.
function exampleReport() {
  const benchmark = {
    status: "completed",
    fixture: { isolated: true, applicationEventsModified: false, generatedDocumentsSha256: "a".repeat(64), documentCount: 200, targetDeviceDocuments: 150, otherDeviceDocuments: 50 },
    workload: { pageSize: 10, pageIndexes: [0, 1], measurementsPerVariantPerPage: 20, warmupPerVariantPerPage: 5, concurrency: 4, warmupMeasurementsIncludedInSamples: false },
    environment: { node: "test", mongodbDriver: "test", mongodbServer: "test", platform: "test", cpuModel: "test" },
    equivalentResults: { verified: true, pages: { 0: { digest: "b".repeat(64), hasMore: true }, 1: { digest: "c".repeat(64), hasMore: true } } },
    samples: [], summaries: { baseline_skip: {}, optimized_cursor: {} }, executionPlans: {}
  };
  for (const page of [0, 1]) {
    benchmark.executionPlans[page] = {};
    for (const variant of ["baseline_skip", "optimized_cursor"]) {
      const durations = Array.from({ length: 20 }, (_, i) => i + 1);
      // Optimized is deliberately slower: correctness must not depend on a speedup.
      if (variant === "optimized_cursor") durations.forEach((n, i) => { durations[i] = n * 2; });
      benchmark.samples.push(...durations.map((durationMs, i) => ({ variant, pageIndex: page, offset: page * 10, iteration: i + 1, durationMs, documentsReturned: 10, hasMore: true, resultSha256: benchmark.equivalentResults.pages[page].digest })));
      benchmark.summaries[variant][page] = { measurementCount: 20, p50Ms: percentile(durations, 0.5), p95Ms: Number(percentile(durations, 0.95).toFixed(5)) };
      const optimized = variant === "optimized_cursor";
      benchmark.executionPlans[page][optimized ? "optimized" : "baseline"] = {
        indexesUsed: [optimized ? "idx_events_device_observed_id" : "idx_events_device_observed"],
        stages: optimized ? ["IXSCAN", "FETCH", "LIMIT"] : ["IXSCAN", "SORT"], executionStats: { nReturned: 11 }
      };
    }
  }
  return { benchmark };
}

test("[M08][normal] evidencia coherente se acepta aunque la variante optimizada tarde mas", () => {
  assert.deepEqual(validateBenchmark(exampleReport()), { valid: true, sampleCount: 80, timingThresholdEnforced: false });
});

test("[M08][normal] percentiles tipo 7 se calculan de las muestras sin mutarlas", () => {
  const samples = [40, 10, 30, 20];
  assert.equal(percentile(samples, 0.5), 25);
  assert.equal(percentile(samples, 0.95), 38.5);
  assert.deepEqual(samples, [40, 10, 30, 20]);
});

test("[M08][boundary] una muestra, empates y extremos de percentil", () => {
  assert.equal(percentile([0], 0.95), 0);
  assert.equal(percentile([7, 7, 7], 0.95), 7);
  assert.equal(percentile([1, 9], 0), 1);
  assert.equal(percentile([1, 9], 1), 9);
});

test("[M08][boundary] no se calculan estadisticas sobre muestras vacias o invalidas", () => {
  for (const samples of [[], [NaN], [Infinity], [-1]]) assert.throws(() => percentile(samples, 0.95));
  for (const p of [-1, 2, NaN]) assert.throws(() => percentile([1], p));
});

test("[M08][declared failure] se rechazan evidencia incompleta, resultados distintos y percentiles falsos", () => {
  const corruptions = [
    (b) => b.samples.pop(),
    (b) => { b.samples[0].durationMs = NaN; },
    (b) => { b.samples[0].resultSha256 = "wrong"; },
    (b) => { b.summaries.baseline_skip[0].p95Ms = 0; },
    (b) => { b.executionPlans[1].optimized.indexesUsed = []; },
    (b) => { b.executionPlans[1].optimized.stages.push("SORT"); },
    (b) => { b.status = "failed"; }
  ];
  for (const corrupt of corruptions) {
    const report = exampleReport();
    corrupt(report.benchmark);
    assert.throws(() => validateBenchmark(report));
  }
});
