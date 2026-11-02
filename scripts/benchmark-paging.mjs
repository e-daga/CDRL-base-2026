import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rootDir } from "../src/config.mjs";
import { eventsPageQuery, findEventsPage, withMongo } from "../src/mongo.mjs";
import { toEventView } from "../src/event-versions.mjs";
import { percentile, validateBenchmark } from "../src/m08-report.mjs";

const SEED = 20261101;
const TARGET_DOCUMENTS = 30_000;
const OTHER_DOCUMENTS = 10_000;
const PAGE_SIZE = 50;
const PAGE_DEPTHS = [0, 100, 400];
const WARMUP_PER_VARIANT = 5;
const MEASUREMENTS_PER_VARIANT = 30;
const CONCURRENCY = 4;
const DEVICE_ID = "dev_bench_primary";
const FROM = "2025-01-01T00:00:00.000Z";
const TO = "2025-02-01T00:00:00.000Z";
const BASELINE_INDEX = "idx_events_device_observed";
const OPTIMIZED_INDEX = "idx_events_device_observed_id";
const OUTPUT_PATH = path.join(rootDir, "artifacts", "m08-benchmark.json");
const SORT = { observed_at: -1, event_id: -1 };

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticEvents() {
  const random = seededRandom(SEED);
  const start = Date.parse(FROM);
  const span = Date.parse(TO) - start;
  const events = [];
  for (let sequence = 1; sequence <= TARGET_DOCUMENTS + OTHER_DOCUMENTS; sequence += 1) {
    const isTarget = sequence <= TARGET_DOCUMENTS;
    const localSequence = isTarget ? sequence : sequence - TARGET_DOCUMENTS;
    const device = isTarget ? DEVICE_ID : `dev_bench_other_${((localSequence - 1) % 4) + 1}`;
    const deviceDocumentCount = isTarget ? TARGET_DOCUMENTS : OTHER_DOCUMENTS;
    const timestampGroup = Math.floor((localSequence - 1) / 2);
    const timestampGroupCount = Math.ceil(deviceDocumentCount / 2);
    const observedAt = new Date(start + Math.floor((timestampGroup * span) / timestampGroupCount));
    const eventType = ["temperature_c", "humidity_pct", "battery_pct", "signal_dbm"][Math.floor(random() * 4)];
    const metricValue = eventType === "humidity_pct" || eventType === "battery_pct"
      ? Number((random() * 100).toFixed(3))
      : Number((random() * 100 - 30).toFixed(3));
    events.push({
      event_id: `e8080000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      device_id: device,
      event_type: eventType,
      observed_at: observedAt,
      ingested_at: new Date(observedAt.getTime() + 1000),
      metric_value: metricValue,
      unit: eventType === "temperature_c" ? "C" : eventType === "signal_dbm" ? "dBm" : "%",
      severity: ["info", "warning", "critical"][Math.floor(random() * 3)],
      source: "synthetic-benchmark-m08",
      payload: { sequence, sample: Number(random().toFixed(8)) }
    });
  }
  return events;
}

function digest(items) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function summarizePlan(explain) {
  const indexes = new Set();
  const stages = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.stage === "string") stages.add(value.stage);
    if (typeof value.indexName === "string") indexes.add(value.indexName);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(explain.queryPlanner.winningPlan);
  visit(explain.executionStats.executionStages);
  return {
    indexesUsed: [...indexes].sort(),
    stages: [...stages].sort(),
    winningPlan: explain.queryPlanner.winningPlan,
    executionStats: {
      nReturned: explain.executionStats.nReturned,
      totalKeysExamined: explain.executionStats.totalKeysExamined,
      totalDocsExamined: explain.executionStats.totalDocsExamined,
      executionTimeMillis: explain.executionStats.executionTimeMillis,
      executionStages: explain.executionStats.executionStages
    }
  };
}

function gitMetadata() {
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    worktreeChangesBeforeRun: execFileSync("git", ["status", "--short"], { cwd: rootDir, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean)
  };
}

function environmentMetadata(mongoVersion, driverVersion, resourcesAtStart) {
  return {
    node: process.version,
    mongodbDriver: driverVersion,
    mongodbServer: mongoVersion,
    platform: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytesAtStart: resourcesAtStart.freeMemoryBytes,
    processMemoryBytesAtStart: resourcesAtStart.processMemoryBytes,
    processMemoryBytesAtEnd: process.memoryUsage().rss
  };
}

function stableShuffle(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function baselinePage(collection, pageIndex) {
  const filter = { device_id: DEVICE_ID, observed_at: { $gte: new Date(FROM), $lte: new Date(TO) } };
  const rows = await collection.find(filter)
    .sort(SORT)
    .skip(pageIndex * PAGE_SIZE)
    .limit(PAGE_SIZE + 1)
    .hint(BASELINE_INDEX)
    .toArray();
  const hasMore = rows.length > PAGE_SIZE;
  return { items: rows.slice(0, PAGE_SIZE).map(toEventView), hasMore };
}

async function optimizedPage(db, pageIndex, cursors) {
  const page = await findEventsPage(db, {
    deviceId: DEVICE_ID,
    from: FROM,
    to: TO,
    cursor: cursors[pageIndex],
    limit: PAGE_SIZE,
    collection: cursors.collection
  });
  return { items: page.items, hasMore: page.has_more };
}

async function createCursorAtPage(db, collectionName, pageIndex) {
  let cursor = null;
  for (let index = 0; index < pageIndex; index += 1) {
    const page = await findEventsPage(db, {
      deviceId: DEVICE_ID,
      from: FROM,
      to: TO,
      cursor,
      limit: PAGE_SIZE,
      collection: collectionName
    });
    if (!page.has_more || !page.next_cursor) throw new Error(`La pagina ${pageIndex} no existe en el fixture.`);
    cursor = page.next_cursor;
  }
  return cursor;
}

async function executionPlan(collection, db, pageIndex, cursor) {
  const filter = { device_id: DEVICE_ID, observed_at: { $gte: new Date(FROM), $lte: new Date(TO) } };
  const baseline = summarizePlan(await collection.find(filter)
    .sort(SORT)
    .skip(pageIndex * PAGE_SIZE)
    .limit(PAGE_SIZE + 1)
    .hint(BASELINE_INDEX)
    .explain("executionStats"));
  const optimizedQuery = eventsPageQuery({ deviceId: DEVICE_ID, from: FROM, to: TO, cursor });
  const optimized = summarizePlan(await db.collection(collection.collectionName)
    .find(optimizedQuery.filter)
    .sort(optimizedQuery.sort)
    .limit(PAGE_SIZE + 1)
    .explain("executionStats"));
  if (!baseline.indexesUsed.includes(BASELINE_INDEX)) throw new Error(`El plan baseline no utilizó ${BASELINE_INDEX}.`);
  if (!optimized.indexesUsed.includes(OPTIMIZED_INDEX)) throw new Error(`El plan optimizado no utilizó ${OPTIMIZED_INDEX}.`);
  return { baseline, optimized };
}

async function collectOptionalStats(db, collectionName) {
  try {
    const stats = await db.command({ collStats: collectionName, scale: 1 });
    return {
      available: true,
      documentCount: stats.count,
      dataSizeBytes: stats.size,
      storageSizeBytes: stats.storageSize,
      totalIndexSizeBytes: stats.totalIndexSize,
      indexSizesBytes: stats.indexSizes
    };
  } catch (error) {
    return { available: false, reason: error.codeName ?? error.message };
  }
}

async function runBenchmark(db) {
  const collectionName = `m08_benchmark_${randomUUID().replaceAll("-", "")}`;
  const resourcesAtStart = {
    freeMemoryBytes: os.freemem(),
    processMemoryBytes: process.memoryUsage().rss
  };
  let collectionCreated = false;
  try {
    await db.createCollection(collectionName);
    collectionCreated = true;
    const collection = db.collection(collectionName);
    const events = makeSyntheticEvents();
    // insertMany adds random _id values to input objects; hash the seeded data first.
    const fixtureSha256 = digest(events);
    for (let offset = 0; offset < events.length; offset += 1000) {
      await collection.insertMany(events.slice(offset, offset + 1000), { ordered: true });
    }
    await collection.createIndex({ device_id: 1, observed_at: -1 }, { name: BASELINE_INDEX });
    await collection.createIndex({ device_id: 1, observed_at: -1, event_id: -1 }, { name: OPTIMIZED_INDEX });

    const serverInfo = await db.admin().command({ buildInfo: 1 });
    const driverPackage = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "mongodb", "package.json"), "utf8"));
    const cursors = { collection: collectionName };
    for (const pageIndex of PAGE_DEPTHS) cursors[pageIndex] = await createCursorAtPage(db, collectionName, pageIndex);

    const baseline = {};
    const optimized = {};
    for (const pageIndex of PAGE_DEPTHS) {
      const expectedBaseline = await baselinePage(collection, pageIndex);
      const expectedOptimized = await optimizedPage(db, pageIndex, cursors);
      const baselineDigest = digest(expectedBaseline.items);
      const optimizedDigest = digest(expectedOptimized.items);
      if (baselineDigest !== optimizedDigest || expectedBaseline.hasMore !== expectedOptimized.hasMore) {
        throw new Error(`Resultados no equivalentes en la pagina ${pageIndex}.`);
      }
      baseline[pageIndex] = { digest: baselineDigest, hasMore: expectedBaseline.hasMore };
      optimized[pageIndex] = { digest: optimizedDigest, hasMore: expectedOptimized.hasMore };
    }

    const plans = {};
    for (const pageIndex of PAGE_DEPTHS) {
      plans[pageIndex] = await executionPlan(collection, db, pageIndex, cursors[pageIndex]);
    }

    for (const pageIndex of PAGE_DEPTHS) {
      for (let iteration = 0; iteration < WARMUP_PER_VARIANT; iteration += 1) {
        await baselinePage(collection, pageIndex);
        await optimizedPage(db, pageIndex, cursors);
      }
    }

    const tasks = [];
    for (const pageIndex of PAGE_DEPTHS) {
      for (let iteration = 0; iteration < MEASUREMENTS_PER_VARIANT; iteration += 1) {
        tasks.push({ variant: "baseline_skip", pageIndex, iteration });
        tasks.push({ variant: "optimized_cursor", pageIndex, iteration });
      }
    }
    stableShuffle(tasks, seededRandom(SEED ^ 0x6d08));
    const samples = [];
    for (let offset = 0; offset < tasks.length; offset += CONCURRENCY) {
      const batch = tasks.slice(offset, offset + CONCURRENCY);
      const results = await Promise.all(batch.map(async (task) => {
        const startedAt = performance.now();
        const result = task.variant === "baseline_skip"
          ? await baselinePage(collection, task.pageIndex)
          : await optimizedPage(db, task.pageIndex, cursors);
        const durationMs = performance.now() - startedAt;
        const resultDigest = digest(result.items);
        const expected = baseline[task.pageIndex];
        if (resultDigest !== expected.digest || result.hasMore !== expected.hasMore) {
          throw new Error(`Resultado divergente en ${task.variant}, pagina ${task.pageIndex}, muestra ${task.iteration}.`);
        }
        return {
          variant: task.variant,
          pageIndex: task.pageIndex,
          offset: task.pageIndex * PAGE_SIZE,
          iteration: task.iteration + 1,
          durationMs: Number(durationMs.toFixed(5)),
          documentsReturned: result.items.length,
          hasMore: result.hasMore,
          resultSha256: resultDigest
        };
      }));
      samples.push(...results);
    }

    const summaries = {};
    for (const variant of ["baseline_skip", "optimized_cursor"]) {
      summaries[variant] = {};
      for (const pageIndex of PAGE_DEPTHS) {
        const durations = samples
          .filter((sample) => sample.variant === variant && sample.pageIndex === pageIndex)
          .map((sample) => sample.durationMs);
        summaries[variant][pageIndex] = {
          measurementCount: durations.length,
          p50Ms: Number(percentile(durations, 0.5).toFixed(5)),
          p95Ms: Number(percentile(durations, 0.95).toFixed(5)),
          minMs: Number(Math.min(...durations).toFixed(5)),
          maxMs: Number(Math.max(...durations).toFixed(5))
        };
      }
    }

    const comparisons = PAGE_DEPTHS.map((pageIndex) => {
      const before = summaries.baseline_skip[pageIndex];
      const after = summaries.optimized_cursor[pageIndex];
      return {
        pageIndex,
        offset: pageIndex * PAGE_SIZE,
        p50ChangePercent: Number((((after.p50Ms / before.p50Ms) - 1) * 100).toFixed(2)),
        p95ChangePercent: Number((((after.p95Ms / before.p95Ms) - 1) * 100).toFixed(2))
      };
    });

    const indexes = await collection.listIndexes().toArray();
    const count = await collection.countDocuments({});
    const collectionStats = await collectOptionalStats(db, collectionName);
    const result = {
      benchmark: {
        name: "M08 cursor pagination vs offset pagination",
        status: "completed",
        seed: SEED,
        fixture: {
          collectionName,
          isolated: true,
          applicationEventsModified: false,
          documentCount: count,
          targetDevice: DEVICE_ID,
          targetDeviceDocuments: TARGET_DOCUMENTS,
          otherDeviceDocuments: OTHER_DOCUMENTS,
          generatedDocumentsSha256: fixtureSha256,
          dateRangeInclusive: { from: FROM, to: TO }
        },
        workload: {
          pageSize: PAGE_SIZE,
          pageIndexes: PAGE_DEPTHS,
          offsets: PAGE_DEPTHS.map((pageIndex) => pageIndex * PAGE_SIZE),
          warmupPerVariantPerPage: WARMUP_PER_VARIANT,
          measurementsPerVariantPerPage: MEASUREMENTS_PER_VARIANT,
          concurrency: CONCURRENCY,
          elapsedTiming: "performance.now() alrededor de la consulta y el mapeo de resultados; sin comparacion/hash",
          percentileMethod: "Interpolacion lineal (tipo 7, indice (n-1)*p)",
          schedule: "Muestras mezcladas con PRNG y semilla fija; lotes de concurrencia constante",
          cursorPreparationIncludedInTiming: false,
          cursorPreparation: "Recorrido previo hasta cada pagina; se mide continuar desde un cursor conocido, no acceso aleatorio.",
          warmupMeasurementsIncludedInSamples: false
        },
        variants: {
          baseline_skip: {
            description: "Filtro device_id + observed_at entre FROM/TO; sort observed_at desc y event_id desc; skip(pageIndex * pageSize); limit(pageSize + 1); hint del indice anterior.",
            indexHint: BASELINE_INDEX,
            cursorPredicate: false
          },
          optimized_cursor: {
            description: "Mismo filtro/orden/limite; cursor M08 con observed_at <= cursor.at y desempate $or por observed_at/event_id; sin skip y sin hint.",
            indexHint: null,
            cursorPredicate: true
          }
        },
        equivalentResults: {
          verified: true,
          checks: "SHA-256 de los items normalizados mediante toEventView y hasMore coincidentes para cada pagina y cada muestra.",
          pages: baseline
        },
        environment: {
          ...environmentMetadata(serverInfo.version, driverPackage.version, resourcesAtStart),
          mongoConnectionPoolMaxSize: 5,
          mongoServerMemoryStats: "No consultado: benchmark no requiere privilegio serverStatus; recursos del host local quedan registrados."
        },
        collectionStats,
        indexes: indexes.map(({ name, key, unique }) => ({ name, key, unique: Boolean(unique) })),
        executionPlans: plans,
        summaries,
        comparisons,
        samples
      },
      generatedAt: new Date().toISOString(),
      git: gitMetadata(),
      cleanup: "Coleccion sintetica de esta ejecucion eliminada tras recopilar la evidencia."
    };
    return result;
  } finally {
    if (collectionCreated) await db.collection(collectionName).drop();
  }
}

fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
try {
  const report = await withMongo(runBenchmark);
  validateBenchmark(report);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Benchmark M08 generado: ${path.relative(rootDir, OUTPUT_PATH)}`);
  for (const row of report.benchmark.comparisons) {
    console.log(`pagina ${row.pageIndex} (offset ${row.offset}): p50 ${row.p50ChangePercent}% / p95 ${row.p95ChangePercent}% (optimizado vs baseline)`);
  }
} catch (error) {
  const failure = {
    assignmentId: "m08-benchmark-comparacion",
    status: "failed",
    generatedAt: new Date().toISOString(),
    error: error.message,
    note: "No se incluyen tiempos ni resultados sinteticos; no hubo benchmark completo."
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(failure, null, 2)}\n`);
  throw error;
}
