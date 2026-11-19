# M11: timeout, reintentos y metricas

`createMetricsRecorder().runOperation(name, operation, options)` ejecuta una
operacion y registra un resultado por flujo, incluyendo intentos y latencia.
La operacion recibe el numero de intento y `{ signal }` como segundo argumento.
Si vence `timeoutMs`, el signal se aborta y se rechaza con
`OperationTimeoutError`. El callback debe respetar el signal para cancelar su
trabajo; abortarlo no garantiza que el driver o la operacion se haya detenido.
Por esa razon, un timeout es terminal y no se inicia otro intento en ese flujo.

## Opciones

| Opcion | Valor por defecto | Funcion |
| --- | --- | --- |
| `timeoutMs` | `0` | Limite de cada intento; `0` desactiva el timeout. |
| `maxAttempts` | `3` | Maximo total de intentos, incluido el inicial. |
| `delayMs` | `0` | Espera base antes del segundo intento. |
| `backoffFactor` | `2` | Multiplicador exponencial de cada espera. |
| `maxDelayMs` | `30000` | Limite de cada espera entre intentos. |
| `sleep` | espera real | Funcion de espera inyectable para pruebas. |
| `shouldRetry` | errores transitorios conocidos | Predicado adicional para reintentar. |

La espera previa al intento `n` es `min(delayMs * backoffFactor ** (n - 2),
maxDelayMs)`. Las esperas solo ocurren entre intentos. Se reintentan errores
transitorios identificables (por ejemplo fallos de red, etiquetas MongoDB
reintentables y HTTP 408/425/429/5xx indicados por el clasificador). Los errores
de validacion, permisos y conflicto (incluidos MongoDB 13, 121 y 11000, y HTTP
400/401/403/409/422) nunca se reintentan, aunque `shouldRetry` devuelva `true`.
Los errores sin clasificar no se reintentan automaticamente.

Cuando se alcanza `maxAttempts`, la promesa rechaza con
`RetryExhaustedError`, que incluye `attempts`, `maxAttempts` y el ultimo error en
`cause`. El resumen de metricas conserva el error tipado de forma segura, sin
mensaje, stack ni propiedades potencialmente sensibles.

## Ejemplo

```js
await metrics.runOperation("sync_events", async (_attempt, { signal }) => {
  return syncEvents({ signal });
}, {
  timeoutMs: 5000,
  maxAttempts: 4,
  delayMs: 100,
  backoffFactor: 2,
  maxDelayMs: 1000
});
```

Pruebas: `node --test tests/m11-metrics.test.mjs`.
