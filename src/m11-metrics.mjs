import { performance } from "node:perf_hooks";

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertLabel(value, field) {
  if (typeof value !== "string" || !LABEL.test(value)) {
    throw new TypeError(`${field} debe ser una etiqueta corta (letras, numeros, . _ : -).`);
  }
  return value;
}

function assertInteger(value, field, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${field} debe ser un entero mayor o igual a ${min}.`);
  }
  return value;
}

// Solo se conserva la clase del error. Nunca el mensaje, la pila ni sus propiedades,
// porque podrian incluir secretos, cadenas de conexion o texto crudo del driver.
function safeErrorType(error) {
  const name = error?.name;
  return typeof name === "string" && ERROR_TYPE.test(name) ? name : "Error";
}

const round = (value) => Math.round(value * 1000) / 1000;

export function createMetricsRecorder({ now = () => performance.now() } = {}) {
  const records = [];

  function record(entry) {
    records.push(Object.freeze(entry));
  }

  function summarize() {
    const succeeded = records.filter((item) => item.status === "success");
    const failed = records.filter((item) => item.status === "failed");
    const latencies = records.map((item) => item.latency_ms);
    const totalLatency = latencies.reduce((sum, value) => sum + value, 0);
    const attempts = records.reduce((sum, item) => sum + item.attempts, 0);
    const retried = records.filter((item) => item.attempts > 1).length;
    return {
      schema: "m11-flow-metrics/v1",
      operations: {
        total: records.length,
        successful: succeeded.length,
        failed: failed.length,
        retried
      },
      attempts: {
        total: attempts,
        max_per_operation: records.reduce((max, item) => Math.max(max, item.attempts), 0)
      },
      latency_ms: {
        total: round(totalLatency),
        min: records.length ? round(Math.min(...latencies)) : 0,
        max: records.length ? round(Math.max(...latencies)) : 0,
        average: records.length ? round(totalLatency / records.length) : 0
      },
      by_operation: records.map((item) => ({
        name: item.name,
        status: item.status,
        attempts: item.attempts,
        latency_ms: round(item.latency_ms),
        ...(item.status === "failed" ? { error_type: item.error_type } : {})
      }))
    };
  }

  function reset() {
    records.length = 0;
  }

  // Una operacion cuenta una sola vez, sin importar cuantos intentos necesite.
  // La latencia abarca desde el primer intento hasta el resultado final e incluye las esperas.
  async function runOperation(name, operation, {
    maxAttempts = 3,
    delayMs = 0,
    sleep = defaultSleep,
    shouldRetry = () => true
  } = {}) {
    assertLabel(name, "name");
    if (typeof operation !== "function") throw new TypeError("operation debe ser una funcion.");
    assertInteger(maxAttempts, "maxAttempts", 1);
    assertInteger(delayMs, "delayMs", 0);

    const startedAt = now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const value = await operation(attempts);
        record({ name, status: "success", attempts, latency_ms: now() - startedAt });
        return value;
      } catch (error) {
        const exhausted = attempts >= maxAttempts;
        if (exhausted || !shouldRetry(error, attempts)) {
          record({
            name,
            status: "failed",
            attempts,
            latency_ms: now() - startedAt,
            error_type: safeErrorType(error)
          });
          throw error;
        }
        if (delayMs > 0) await sleep(delayMs * attempts);
      }
    }
  }

  return { runOperation, summarize, reset };
}
