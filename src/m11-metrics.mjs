import { performance } from "node:perf_hooks";

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PERMANENT_ERROR_NAMES = new Set([
  "TypeError", "RangeError", "ValidationError", "ConflictError",
  "ContentConflictError", "AuthorizationError", "PermissionError",
  "ForbiddenError"
]);
const PERMANENT_ERROR_CODES = new Set([
  13, 121, 11000, 11001, "VALIDATION_ERROR", "PERMISSION_DENIED",
  "CONTENT_CONFLICT", "CONFLICT", "DUPLICATE_KEY"
]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "EAI_AGAIN"
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function isPermanentError(error) {
  const name = error?.name;
  const codeName = error?.codeName;
  const status = error?.status ?? error?.statusCode;
  return PERMANENT_ERROR_NAMES.has(name)
    || PERMANENT_ERROR_CODES.has(error?.code)
    || ["unauthorized", "documentvalidationfailure", "duplicatekey", "contentconflict"]
      .includes(typeof codeName === "string" ? codeName.toLowerCase() : "")
    || [400, 401, 403, 409, 422].includes(status);
}

function isTransientError(error) {
  if (error?.retryable === true || error?.transient === true) return true;
  if (TRANSIENT_ERROR_CODES.has(error?.code)) return true;
  if (TRANSIENT_HTTP_STATUSES.has(error?.status ?? error?.statusCode)) return true;
  if (["MongoNetworkError", "MongoServerSelectionError", "MongoNetworkTimeoutError"]
    .includes(error?.name)) return true;
  return Array.isArray(error?.errorLabels)
    && error.errorLabels.some((label) => ["RetryableWriteError", "TransientTransactionError"].includes(label));
}

export class OperationTimeoutError extends Error {
  constructor(operation, attempt, timeoutMs) {
    super(`La operacion ${operation} supero el timeout de ${timeoutMs} ms en el intento ${attempt}.`);
    this.name = "OperationTimeoutError";
    this.operation = operation;
    this.attempt = attempt;
    this.timeoutMs = timeoutMs;
  }
}

export class RetryExhaustedError extends Error {
  constructor(operation, attempts, maxAttempts, cause) {
    super(`Se agotaron los ${maxAttempts} intentos permitidos para la operacion ${operation}.`, { cause });
    this.name = "RetryExhaustedError";
    this.operation = operation;
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }
}

async function executeAttempt(operation, name, attempt, timeoutMs) {
  const controller = new AbortController();
  const pending = Promise.resolve().then(() => operation(attempt, { signal: controller.signal }));
  if (timeoutMs === 0) return pending;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const outcome = await Promise.race([
    pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    timeout
  ]);
  clearTimeout(timer);

  if (outcome.timedOut) {
    const error = new OperationTimeoutError(name, attempt, timeoutMs);
    controller.abort(error);
    throw error;
  }
  if (Object.hasOwn(outcome, "error")) throw outcome.error;
  return outcome.value;
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
    timeoutMs = 0,
    maxAttempts = 3,
    delayMs = 0,
    backoffFactor = 2,
    maxDelayMs = 30000,
    sleep = defaultSleep,
    shouldRetry = isTransientError
  } = {}) {
    assertLabel(name, "name");
    if (typeof operation !== "function") throw new TypeError("operation debe ser una funcion.");
    assertInteger(timeoutMs, "timeoutMs", 0);
    assertInteger(maxAttempts, "maxAttempts", 1);
    assertInteger(delayMs, "delayMs", 0);
    if (typeof backoffFactor !== "number" || !Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new RangeError("backoffFactor debe ser un numero finito mayor o igual a 1.");
    }
    assertInteger(maxDelayMs, "maxDelayMs", 0);
    if (typeof sleep !== "function") throw new TypeError("sleep debe ser una funcion.");
    if (typeof shouldRetry !== "function") throw new TypeError("shouldRetry debe ser una funcion.");

    const startedAt = now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const value = await executeAttempt(operation, name, attempts, timeoutMs);
        record({ name, status: "success", attempts, latency_ms: now() - startedAt });
        return value;
      } catch (error) {
        if (error instanceof OperationTimeoutError) {
          record({
            name,
            status: "failed",
            attempts,
            latency_ms: now() - startedAt,
            error_type: safeErrorType(error)
          });
          throw error;
        }
        if (isPermanentError(error) || !shouldRetry(error, attempts)) {
          record({
            name,
            status: "failed",
            attempts,
            latency_ms: now() - startedAt,
            error_type: safeErrorType(error)
          });
          throw error;
        }
        if (attempts >= maxAttempts) {
          record({
            name,
            status: "failed",
            attempts,
            latency_ms: now() - startedAt,
            error_type: safeErrorType(error)
          });
          throw new RetryExhaustedError(name, attempts, maxAttempts, error);
        }
        const waitMs = Math.min(delayMs * backoffFactor ** (attempts - 1), maxDelayMs);
        if (waitMs > 0) await sleep(waitMs);
      }
    }
  }

  return { runOperation, summarize, reset };
}
