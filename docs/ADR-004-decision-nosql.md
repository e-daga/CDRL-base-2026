# ADR-004 - Decision arquitectonica NoSQL para eventos CDRL

## Estado y alcance

Aceptado como decision arquitectonica **condicional** para M04: elegir document
store (MongoDB) como candidato para la capa operativa de eventos y alertas.
No se migra PostgreSQL en este hito ni se afirma haber probado MongoDB,
Cassandra, Neo4j o S3. La consigna admite evidencia o hipotesis falsables.
Las veinte celdas de la matriz declaran hipotesis, metodo de comprobacion,
condicion de refutacion y fuentes oficiales de contexto.

PostgreSQL y sus roles siguen soportando la demostracion reproducible. Un
despliegue futuro necesitara validar las hipotesis y disenar la migracion;
no basta con que el calculo de M04 pase sus pruebas.

## Contexto y criterios

M01 define eventos con device_id, observed_at, event_type, severity y payload.
M02 agrega estados y alertas. Consultar eventos por dispositivo y alertas
abiertas tiene mas peso que recorrer relaciones profundas.
[Matriz ejecutable](m04-nosql-matrix.json) y [carga](M04-carga-y-consultas.md)
son los insumos de la decision.

Los pesos suman 100: Consultas 30, Escala 20, Consistencia 20, Costo 15 y
Fallos 15. Priorizamos resolver las consultas del producto, luego crecer y
conservar coherencia; costo y recuperacion siguen siendo requisitos, no
se descartan por tener menor peso.

Escala cualitativa: 5 = ajuste directo esperado; 4 = buen ajuste con
configuracion; 3 = coordinacion o costo adicional relevante; 2 = desajuste
importante; 1 = requiere otra capa para la funcion central. Las puntuaciones
son estimaciones del equipo, no latencias, precios ni calificaciones del
proveedor. Las fuentes explican mecanismos; no prueban que el objetivo del
workload se cumpla.

## Comparacion reproducible

Formula: suma(peso * puntuacion / 5), resultado sobre 100.

| Alternativa | Consultas | Escala | Consistencia | Costo | Fallos | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MongoDB, document | 5 | 4 | 4 | 3 | 4 | 83 |
| Cassandra, column | 4 | 5 | 3 | 3 | 5 | 80 |
| S3, object | 1 | 5 | 4 | 5 | 5 | 72 |
| Neo4j, graph | 2 | 2 | 4 | 2 | 3 | 51 |

Column significa familias de columnas (wide-column), no un archivo Parquet.
S3 se evalua como object store sin sumar silenciosamente otro motor de consulta.

## Consultas y modelo propuesto

Q1 devuelve hasta 100 eventos de un dispositivo, ordenados por observed_at y
con rango temporal; Q2 lista alertas abiertas, con filtros opcionales de
dispositivo y severidad. Rango temporal y severidad son requisitos propuestos
de M04, no filtros ya implementados por las funciones de M02.

Para MongoDB proponemos colecciones events y alerts. events conserva el contrato
y un indice (device_id, observed_at DESC); alerts copia device_id y severity
necesarios para Q2, con indice (status, device_id, severity). Las consultas
globales de alertas deben usar un indice cuyo prefijo sea status. La duplicacion
de campos exige definir como se actualizan, no elimina ese costo.

La [documentacion de indices compuestos](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/)
respalda el mecanismo. Que ambas consultas alcancen p95 <=100 ms con el volumen
supuesto sigue siendo una hipotesis; explain y carga deben comprobarlo.

## Escala

El escenario supone 100 dispositivos y 6 eventos por minuto: 10 eventos/s,
864000 eventos/dia, 25.92 millones por mes de 30 dias y 77.76 millones retenidos
90 dias. Con 1000 bytes/evento son 77.76 GB logicos, sin indices, replicas,
proyecciones, compresion o backups.

Proponemos comenzar la evaluacion de MongoDB con tres replicas, no agregar
sharding solo por tener telemetria. Probar 10 y 100 eventos/s durante 30 min
por escenario. Si se requiere particionar, evaluar distribucion por dispositivo,
dispositivos calientes y restricciones de indices unicos antes de elegir la
clave; no asegurar deduplicacion global con cualquier shard key.

La alternativa Cassandra particiona por (device_id, dia), para limitar el
crecimiento de cada particion. La [documentacion de modelado](https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/intro.html)
explica el enfoque orientado a consultas. Los umbrales de rendimiento no han
sido medidos en este repositorio.

## Consistencia

Para la lectura de escrituras propias en MongoDB proponemos sesiones causales
con readConcern majority y writeConcern majority. Leer del primario por si solo
no expresa toda la garantia deseada. Las [garantias documentadas](https://www.mongodb.com/docs/manual/core/causal-consistency-read-write-concerns/)
son para esas condiciones; no implican disponibilidad cuando falta quorum.

La idempotencia requiere identificador event_id unico y manejo explicito de
duplicados. Una alerta y su evento no se vuelven atomicos solo por usar
documentos: usar una transaccion si la aplicacion necesita ambos cambios
atomicos, o una proyeccion con reconciliacion y retraso documentado. Probar
reintentos e interrupciones entre escrituras antes de activar la migracion.

Cassandra ofrece niveles configurables. RF=3 y LOCAL_QUORUM para lectura y
escritura en un DC no equivalen a atomicidad entre todas las proyecciones.
El [modelo de replicacion y consistencia](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
sirve de referencia para disenar esa prueba, no para afirmar que siempre
ofrece lecturas viejas.

S3 tiene [consistencia fuerte por objeto](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html),
pero eso no convierte dos objetos evento/alerta en una transaccion. Por eso
su puntuacion de consultas es distinta de su puntuacion de consistencia.

## Costo

Usamos us-east-1 como region de referencia y 2026-09-27 como fecha del escenario.
1000 USD/mes es un presupuesto **supuesto para evaluar**, no una cotizacion ni
un gasto autorizado. No hay una tarifa mensual medida en los artefactos.

Cotizar todos con la misma retencion, carga y objetivos de recuperacion:
computo/servicio, discos e indices, replicas, backups, peticiones, transferencia
y esfuerzo operativo. Consultar las calculadoras de [MongoDB](https://www.mongodb.com/pricing)
y [S3](https://aws.amazon.com/s3/pricing/) y las ofertas equivalentes de Neo4j
y EC2 antes de tomar una decision de despliegue. Las cifras iniciales de
tiers sirven solo de dimensionamiento tentativo; hay que verificar HA y capacidad.

Con un evento por objeto S3 hay 25.92M PUT/mes, no 5M requests totales.
Ademas hay 2.592M consultas de aplicacion por mes bajo el supuesto de 1/s:
cada consulta puede necesitar varios GET/LIST. Si agrupamos eventos en lotes,
cambian PUT, bytes leidos y latencia; hay que recalcularlo y no comparar
directamente una consulta SQL con una peticion S3.

Si la cotizacion completa supera el presupuesto o un candidato no cumple
las consultas, se revisa la decision aunque su score ponderado sea alto.

## Fallos y recuperacion

Distinguir perdida de un nodo, perdida de quorum y perdida regional.
El objetivo propuesto para un nodo es recuperar servicio en <=30 s sin perder
eventos confirmados. Reintentos limitados con backoff y event_id idempotente
evitan duplicados; ante incertidumbre no se debe confirmar exito inventado.

Con MongoDB, si falta mayoria se aceptan errores explicitos de disponibilidad.
Con Cassandra RF=3, un nodo perdido y una particion sin quorum son escenarios
diferentes. No se exige cero timeouts durante una transicion, sino recuperacion
y verificacion de escrituras confirmadas. Para grafos, evaluar una topologia
HA real segun la [arquitectura de Neo4j](https://neo4j.com/docs/operations-manual/current/clustering/introduction/);
no asumir que cualquier plan comercial tiene las mismas replicas.

Para fallo regional se propone por separado restaurar copias con RTO <=1 h
y RPO <=24 h. Son objetivos pendientes de una prueba de restauracion y de su
cotizacion; ni replica set ni alta durabilidad de objetos sustituyen esa prueba.
El objetivo de disponibilidad del escenario es 99.9%, distinto de durabilidad.

## Alternativa descartada y sensibilidad

Descartamos Cassandra como primera implementacion operativa porque Q2 necesita
otra proyeccion y mas coordinacion para reflejar estado/alertas coherentes.
No se descarta por incapacidad general: gana si la prioridad cambia hacia
ingesta y distribucion.

El script transfiere 10 puntos de peso de consultas a escala sin alterar
scores: Cassandra obtiene 82 y MongoDB 81. Con transferencia de 7.5 hay empate
a 81.5. Por eso la ventaja inicial de tres puntos es pequena y la decision
es sensible a los requisitos. Un empate exige revision humana, no seleccionar
el primer nombre alfabetico como ganador.

S3 queda como candidato de archivo historico, no como unica base operativa.
Neo4j se reconsideraria si aparecen recorridos de multiples saltos como
consulta central. No se agregan esas consultas solo para justificar una tecnologia.

## Verificacion y limites

make verify conserva M01-M03 y ejecuta las pruebas de calculo de Jonathan mas
la integracion M04: ranking conocido, cero peso, empate, sensibilidad, volumen,
cuatro familias y rechazos por datos incompletos. Compara seleccion de evidencia
con matriz y exige los apartados del ADR. Ningun test se omite para aprobar.

El resultado automatico passed significa que el contrato y los calculos pasan,
no que las hipotesis operativas fueron comprobadas. El reporte registra
nosqlEnginesExecuted=false, cloudDeployed=false y pricesQuoted=false.
Docker Compose es el entorno de regresion validado; no se desplego AWS Academy.

## Autoria

Francesco: matriz y carga originales (01b774c). Jonathan/Radh117: comparador,
fixtures y seis pruebas (e19cd84). Eddi: revision de supuestos y consistencia,
ADR, integracion de evidencia/CI y cierre. Se mantienen los commits originales.
