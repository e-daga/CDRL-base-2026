# ADR-008: Paginacion estable y rendimiento medido

## Contexto y decision

M08 corresponde a Semana 09. Conservamos MongoDB y los contratos M05-M07.
Para eventos por dispositivo/rango usamos findEventsPage, orden descendente
observed_at, event_id e indice idx_events_device_observed_id que antepone
device_id. event_id es unico. findEventsByDevice y sus consumidores no cambian.
Se mantienen los indices anteriores para no alterar los contratos previos.

La pagina pide limit + 1, entrega hasta limit y devuelve un cursor de la ultima
fila si queda otra. El cursor contiene version, fecha, UUID y huella de filtros.
Un cursor mal formado o de otro filtro se rechaza. La huella no es firma ni
control de acceso. Se admiten vistas current/legacy. No se ofrece retroceso.

## Estabilidad y consistencia

Las inserciones no desplazan las posiciones: cada pagina continua despues de la
ultima clave entregada. La prueba inserta eventos nuevos, antiguos y empatados
entre paginas y verifica que cada original aparece exactamente una vez.
Inserciones antes del cursor se ven al reiniciar; las posteriores pueden aparecer
en el recorrido actual. No hay snapshot. La garantia presupone que los originales
no se borran ni cambian fecha, dispositivo o identificador. Para una exportacion
congelada haria falta otra estrategia. Muchos empates pueden aumentar las claves
leidas: los presupuestos observados en fixtures no son una cota universal.

## Linea base y medicion

scripts/benchmark-paging.mjs usa la implementacion real, una coleccion UUID
exclusiva y 40.000 documentos sinteticos con semilla 20261101. Se calcula el hash
ANTES de insertMany, que agrega _id aleatorios: identifica los datos logicos
reproducibles. Se elimina solo la coleccion propia en finally y no se escribe en
events. Un error de limpieza impide aprobar.

Comparamos skip/offset con hint al indice anterior frente a cursor sin hint con
el indice compuesto. Filtro, orden, tamano y contenido de respuesta son iguales:
se comparan sus hashes y hasMore en cada muestra. La linea base incorpora el
mismo desempate para comparar resultados identicos.

Paginas 0, 100 y 400, de 50 eventos; cinco calentamientos por variante/pagina,
30 muestras por variante/pagina (180 total), concurrencia 4. Las tareas se mezclan
con semilla fija. Los tiempos incluyen consulta y conversion, no hash de respuesta.
p50/p95 usan interpolacion tipo 7 sobre muestras conservadas. Cada variante/pagina
incluye explain executionStats: plan, indices, filas, claves y documentos leidos.

Los cursores profundos se obtienen recorriendo paginas PREVIAMENTE, fuera del
cronometro: se mide continuar desde una posicion conocida, no saltar a una pagina
arbitraria. No se mide construir indices ni cargar datos. Las variantes comparten
concurrencia y pueden interferir entre si. No se evalua cache fria.

## Evidencia y resultados

La ejecucion actual esta en artifacts/m08-benchmark.json. La de make verify queda
incluida en artifacts/m08-verify.json y evidencia local. make run repite el benchmark
con nuevas muestras sin reescribir la evidencia de verify. Los resultados iniciales
de Jonathan permanecen como referencia historica en docs/M08-benchmark-comparacion.md.

El validador recalcula percentiles y comprueba cantidad/identidad de muestras,
equivalencia, entorno e indices reales. Los ejemplos de tests unitarios nunca se
exportan como mediciones. Un test acepta deliberadamente una variante mas lenta:
no se impone un porcentaje de mejora. Consultar hardware, versiones, volumen,
concurrencia y planes junto con los tiempos; no son una promesa de produccion.
Los recursos registrados son del cliente, no cuotas del contenedor. Estas no se
miden. Docker Compose es el entorno validado; no se afirma haber validado AWS.

### Medicion de integracion comprobada

make verify del commit ffb1cb49afd620646a6566f52881e06ab4c1a3d7:
[Actions 41381152493](https://github.com/e-daga/CDRL-base-2026/actions/runs/41381152493).
169 pruebas aprobadas (12 M08), cero fallidas/omitidas/pendientes y cero hallazgos
del escaner. 180 muestras. Tiempos en ms, 30 muestras por variante/pagina:

| Pagina | Baseline p50 | Baseline p95 | Cursor p50 | Cursor p95 |
| --- | ---: | ---: | ---: | ---: |
| 0 | 37.10340 | 45.34359 | 2.91392 | 6.66822 |
| 100 | 37.33966 | 54.84428 | 2.58470 | 5.68814 |
| 400 | 52.20340 | 71.48761 | 2.80320 | 4.87185 |

Entorno Linux x64, Node 20.20.2, MongoDB 7.0.43, driver 7.7.0, cuatro CPU
logicos visibles, 16.760.344.576 bytes de RAM del host visible. Cache calentada,
concurrencia 4. Las nuevas ejecuciones del tag tienen tiempos propios.
El hash logico 9bb43a5e90f289437a71cc3024284d3c31b9439b015fcbf96fa28b12cd61a3ab
coincidio entre esta ejecucion de GitHub y la ejecucion local en Windows.

## Trade-off y alternativa descartada

Elegimos cursor para un recorrido secuencial resistente a inserciones. El indice
adicional ocupa espacio y debe actualizarse al escribir. Se mantienen dos indices
solapados por compatibilidad. collStats reporta tamanos si hay permiso; no se mide
latencia de escritura. Retirar el indice antiguo requiere revisar Q1/M05 despues.

Se descarta offset como estrategia principal: las inserciones desplazan paginas y
skip recorre filas previas. Offset permite elegir un numero de pagina sin guardar
cursores. La comparacion cambia indice y paginacion juntos: no separa causalmente
sus efectos. 40.000 documentos no demuestran escala a millones ni un SLA.

## Verificacion y fallo declarado

make setup configura bases, validadores e indices sin borrar volumenes. make verify
corre todas las suites anteriores y M08; exige normal/dos limites/fallo declarado,
benchmark y escaneo de secretos, sin fail, skipped ni todo. make run conserva demos
anteriores y repite el benchmark.

Casos: recorrido normal e indice sin SORT; empates, vacio, ultima pagina exacta e
inserciones entre paginas; cursor invalido rechazado sin escritura. Se rechazan
muestras faltantes, valores no finitos, hashes divergentes, percentiles falsos e
indices ausentes. Un error de verify sobreescribe resultados M08 como failed.
Las pruebas usan colecciones unicas y solo eliminan las que han creado.

## Entrega y autoria

Francesco: 46e8ad0, 54c0502, 2187aca, consulta/indice/pruebas/documentacion.
Jonathan (Radh117): 2c4d34b, benchmark y comparacion.
Eddi: revision, integracion y cierre con asistencia de Codex. Se conservan los
commits originales, sin reasignar autoria ni deshabilitar pruebas.

Manifiesto: evidence/m08-pagination-performance.json. Evidencia ejecutada:
evidence/m08-pagination-performance-local.json, con SHA real y pruebas. Los reportes
versionados identifican el commit probado; no se incrusta un SHA en su propio commit.
La ejecucion final y Actions del tag week-09-final identifican el SHA final.
No se reemplazan tags publicados ni se reescribe historia.
