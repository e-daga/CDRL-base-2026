# M08 - Benchmark y comparacion de paginacion

Nota de integracion: las cifras siguientes describen la ejecucion inicial de
Jonathan (commit 2c4d34b). Las nuevas ejecuciones tienen sus propias muestras y
entorno en artifacts/m08-benchmark.json; consultar tambien ADR-008. El hash del
fixture ahora se obtiene antes de insertMany para excluir los _id aleatorios.

## Alcance y reproduccion

El benchmark compara la consulta por offset con la paginacion por cursor de
M08. Se ejecuta con `npm run benchmark:paging`; el script esta en
[`scripts/benchmark-paging.mjs`](../scripts/benchmark-paging.mjs) y escribe
las mediciones completas en [`artifacts/m08-benchmark.json`](../artifacts/m08-benchmark.json).
Requiere MongoDB disponible en `MONGO_HOST:MONGO_PORT` y las credenciales de
aplicacion ya configuradas en `.env` o en el entorno. No ejecuta `init`, `seed`
ni modifica la coleccion `events`.

El script crea una coleccion `m08_benchmark_<uuid>` por ejecucion, carga el
fixture, crea solo los dos indices necesarios, hace las consultas y los
`explain`, y elimina unicamente esa coleccion en un bloque `finally`. El JSON
guarda su nombre, SHA-256 del dataset y confirmacion de limpieza. La ejecucion
reportada se completo correctamente; despues se verifico que no quedara ninguna
coleccion `m08_benchmark_*`.

Fixture reproducible:

- Semilla PRNG: `20261101`.
- 40.000 documentos: 30.000 para `dev_bench_primary` y 10.000 repartidos entre
  cuatro dispositivos adicionales.
- Fechas entre `2025-01-01T00:00:00.000Z` y `2025-02-01T00:00:00.000Z`;
  timestamps repetidos por pares para ejercitar el desempate por `event_id`.
- SHA-256 logico del dataset: campo `fixture.generatedDocumentsSha256` en la ejecucion actual.

El filtro de ambas variantes es el mismo dispositivo y el mismo rango inclusivo
de `observed_at`. Ambas ordenan por `{ observed_at: -1, event_id: -1 }`, piden
51 documentos para entregar hasta 50 y usan `toEventView`. Para cada pagina se
comparan `hasMore` y el SHA-256 de los 50 items, antes y durante las mediciones.
Las 180 muestras conservadas en el JSON vuelven a verificar esos valores.

## Variantes: cambio exacto

| Variante | Consulta y plan |
| --- | --- |
| Baseline `baseline_skip` | Filtro comun, orden estable, `skip(pageIndex * 50)`, `limit(51)` y hint al indice previo `idx_events_device_observed` (`device_id, observed_at`). |
| Optimizada `optimized_cursor` | Filtro y orden comunes, sin `skip`; cursor de M08 que acota `observed_at` hasta la posicion y excluye lo ya entregado con el desempate `$or` de `observed_at`/`event_id`. No fuerza hint; MongoDB elige `idx_events_device_observed_id` (`device_id, observed_at, event_id`). |

El indice anterior no contiene `event_id`, por lo que no satisface el orden
estable completo y el plan baseline incluye `SORT`. El indice compuesto permite
resolver filtro y orden en el recorrido del indice, sin `SORT`. Esta comparacion
mide el cambio de la variante baseline M05 a la consulta optimizada completa
(cursor mas indice compuesto); no separa causalmente la mejora atribuible solo
a quitar `skip` de la atribuible al nuevo indice.

## Procedimiento de medicion

- Se registraron cinco calentamientos por variante y profundidad; no entran en
  las estadisticas.
- Se tomaron 30 mediciones reales por variante para cada pagina: 0, 100 y 400
  (offsets 0, 5.000 y 20.000). Total: 180 muestras, preservadas una por una
  en `samples`.
- Concurrencia fija de cuatro consultas, lotes mezclados por un PRNG con semilla
  fija. El pool del cliente tiene maximo cinco conexiones.
- Cada duracion usa `performance.now()` alrededor de la consulta y el mapeo de
  resultados; no incluye la comparacion ni el calculo del hash. p50 y p95 se
  calculan de esas muestras con interpolacion lineal tipo 7,
  `posicion = (n - 1) * p`.
- `explain("executionStats")` se obtuvo para ambas variantes en cada profundidad.
  El JSON conserva el plan ganador, las etapas, indices, claves y documentos
  examinados, `nReturned` y el tiempo que informa `explain`.

## Resultados observados

Tiempos en milisegundos. Cambio porcentual compara optimizada con baseline; un
valor negativo significa menor tiempo en esta ejecucion.

| Pagina (offset) | Mediciones por variante | Baseline p50 / p95 | Cursor p50 / p95 | Cambio p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 0 (0) | 30 | 36.94270 / 46.30204 | 3.25395 / 12.11699 | -91.19% / -73.83% |
| 100 (5.000) | 30 | 39.61320 / 46.91598 | 3.28935 / 9.90195 | -91.70% / -78.89% |
| 400 (20.000) | 30 | 51.52470 / 60.26182 | 3.29020 / 9.86459 | -93.61% / -83.63% |

| Pagina | Plan baseline: indice, etapas, claves/docs examinados | Plan cursor: indice, etapas, claves/docs examinados |
| --- | --- | --- |
| 0 | `idx_events_device_observed`; `IXSCAN -> FETCH -> SORT`; 30.000 / 30.000 | `idx_events_device_observed_id`; `IXSCAN -> FETCH -> LIMIT`; 51 / 51 |
| 100 | `idx_events_device_observed`; `IXSCAN -> FETCH -> SORT -> SKIP`; 30.000 / 30.000 | `idx_events_device_observed_id`; `IXSCAN -> FETCH -> LIMIT`; 53 / 53 |
| 400 | `idx_events_device_observed`; `IXSCAN -> FETCH -> SORT -> SKIP`; 30.000 / 30.000 | `idx_events_device_observed_id`; `IXSCAN -> FETCH -> LIMIT`; 53 / 53 |

Cada plan devuelve 51 documentos para saber si hay una pagina siguiente; la
respuesta entrega 50. El cursor revisa dos documentos adicionales en las
paginas profundas de este fixture con timestamps empatados. La medicion no
muestra un SORT en los planes optimizados.

## Entorno y limitaciones

Ejecucion en Windows `10.0.26200` x64, Node `v22.14.0`, driver MongoDB `7.7.0`
y MongoDB Server `7.0.43`. Host: Intel Core i9-14900HX, 32 CPU logicos y
33.949.417.216 bytes de memoria total. El proceso registro 12.076.576.768 bytes
libres al inicio; su RSS fue 58.880.000 bytes al inicio y 141.045.760 al final.
El pool configurado fue de cinco conexiones. No se consulto `serverStatus`, por
lo que no hay medicion de recursos ni cuotas del contenedor MongoDB; se reportan
los recursos visibles del host.

Este es un benchmark local con un unico fixture sintetico, cache calentada y
sin carga concurrente de la aplicacion. El baseline fuerza el indice anterior,
mientras que la variante optimizada deja al planificador elegir. El baseline
tambien necesita ordenar en memoria para conservar exactamente el mismo
desempate por `event_id`; por ello, el resultado refleja conjuntamente ese
trabajo y el costo del offset. Los tiempos no representan latencia de
produccion, y no garantizan la misma proporcion con otros volumenes, datos,
versiones, hardware, cache o carga. Los porcentajes son los medidos, no un
criterio obligatorio de aprobacion.

Repetir `npm run benchmark:paging` genera nuevas muestras y un nuevo nombre de
coleccion; la semilla, volumen, paginas y parametros de carga permanecen fijos.
