import assert from "node:assert/strict";

export function percentile(samples, fraction) {
  assert.ok(samples.length > 0, "No hay muestras.");
  assert.ok(samples.every((n) => Number.isFinite(n) && n >= 0), "Duracion invalida.");
  assert.ok(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1, "Percentil invalido.");
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function validateBenchmark(report) {
  const b = report.benchmark;
  assert.equal(b?.status, "completed", "Benchmark incompleto.");
  assert.equal(b.equivalentResults.verified, true);
  assert.equal(b.fixture.isolated, true);
  assert.equal(b.fixture.applicationEventsModified, false);
  assert.match(b.fixture.generatedDocumentsSha256, /^[a-f0-9]{64}$/);
  assert.equal(b.fixture.documentCount, b.fixture.targetDeviceDocuments + b.fixture.otherDeviceDocuments);
  const w = b.workload;
  assert.ok(Number.isInteger(w.measurementsPerVariantPerPage) && w.measurementsPerVariantPerPage >= 20);
  assert.ok(w.pageIndexes.includes(0) && w.pageIndexes.some((p) => p > 0));
  assert.ok(w.warmupPerVariantPerPage > 0 && w.concurrency > 0);
  assert.equal(w.warmupMeasurementsIncludedInSamples, false);
  assert.equal(b.samples.length, 2 * w.pageIndexes.length * w.measurementsPerVariantPerPage);
  for (const key of ["node", "mongodbDriver", "mongodbServer", "platform", "cpuModel"]) {
    assert.ok(typeof b.environment[key] === "string" && b.environment[key].length > 0, `Falta entorno ${key}`);
  }
  for (const page of w.pageIndexes) {
    for (const variant of ["baseline_skip", "optimized_cursor"]) {
      const samples = b.samples.filter((s) => s.variant === variant && s.pageIndex === page);
      assert.equal(samples.length, w.measurementsPerVariantPerPage, "Muestra incompleta.");
      assert.deepEqual(samples.map((s) => s.iteration).sort((a, c) => a - c), Array.from({ length: samples.length }, (_, i) => i + 1));
      const expected = b.equivalentResults.pages[page];
      for (const s of samples) {
        assert.equal(s.resultSha256, expected.digest, "Resultados no equivalentes.");
        assert.equal(s.hasMore, expected.hasMore);
        assert.equal(s.documentsReturned, w.pageSize);
        assert.equal(s.offset, page * w.pageSize);
      }
      const durations = samples.map((s) => s.durationMs);
      const summary = b.summaries[variant][page];
      assert.equal(summary.measurementCount, samples.length);
      for (const [key, fraction] of [["p50Ms", 0.5], ["p95Ms", 0.95]]) {
        assert.equal(summary[key], Number(percentile(durations, fraction).toFixed(5)), `Percentil incorrecto: ${key}`);
      }
      const plan = b.executionPlans[page][variant === "baseline_skip" ? "baseline" : "optimized"];
      const index = variant === "baseline_skip" ? "idx_events_device_observed" : "idx_events_device_observed_id";
      assert.ok(plan.indexesUsed.includes(index), `No usa ${index}`);
      assert.equal(plan.executionStats.nReturned, w.pageSize + 1);
      if (variant === "optimized_cursor") assert.ok(!plan.stages.includes("SORT"), "Ordenamiento en memoria.");
    }
  }
  return { valid: true, sampleCount: b.samples.length, timingThresholdEnforced: false };
}
