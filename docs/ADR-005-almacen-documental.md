# ADR-005 - Almacen documental M05

## Decision y alcance
Implementamos MongoDB para events y alerts, continuando la seleccion de M04.
Docker Compose ejecuta un servidor local autenticado, con volumen persistente e
imagen fijada por digest. PostgreSQL y todas sus pruebas anteriores permanecen.
No se ha desplegado AWS Academy. No se afirma alta disponibilidad, quorum,
transacciones entre documentos, rendimiento a escala ni cumplimiento de los
objetivos p95/RTO de M04: eso requiere otro experimento y un replica set.

## Contrato y validacion
mongo/init.js crea o actualiza validadores strict/error. Exige identificadores,
tipos BSON, fechas, enumeraciones, campos declarados y porcentajes entre 0 y 100.
Los eventos admiten hasta cinco minutos de adelanto; las alertas exigen fechas
coherentes con sus estados. Fechas invalidas y numeros no finitos se rechazan.
El driver ofrece validacion temprana; MongoDB sigue siendo la barrera final.
Las pruebas insertan y actualizan documentos invalidos directamente y exigen
codigo 121, ademas de comprobar que un documento valido si se guarda.
MongoDB no proporciona una clave foranea entre events y alerts. El CRUD es
independiente: borrar un evento puede dejar una alerta huerfana; no hay cascada
ni atomicidad entre ambas colecciones. Los fixtures si contienen referencias
coherentes. Esta limitacion no debe confundirse con integridad relacional.

## CRUD e idempotencia
createEvent/createAlert son altas estrictas: un duplicado da error 11000.
upsertEvent intenta insertar y deja al indice unico arbitrar reintentos
concurrentes. Ante duplicado compara el documento, excluyendo _id:
mismo contenido devuelve duplicate; contenido distinto devuelve conflict,
sin reemplazar lo guardado. El orden de claves de objetos no cambia igualdad.
La comparacion incluye ingested_at: el productor debe conservarlo al reintentar.
updateEvent/updateAlert validan y reemplazan el documento existente; no hacen
upsert. Repetir el mismo cambio no modifica el documento. No se garantiza
control optimista de versiones ante actualizaciones concurrentes.
Lectura ausente devuelve null; actualizacion ausente matchedCount=0;
borrado ausente deletedCount=0. Repetir un borrado no crea ni restaura nada.
Los seeds reemplazan solo sus IDs sinteticos conocidos; repetirlos restaura
esos fixtures sin borrar otros documentos ni duplicar los conocidos.
Las pruebas compartidas de base se ejecutan en serie para evitar que el seed
de una suite altere el estado que otra esta verificando; no se omiten pruebas.

## Consultas e indices
Q1: device_id, rango inclusivo observed_at, orden descendente y limite 1..100.
Indice idx_events_device_observed (device_id, observed_at DESC).
Q2: status=open, filtros opcionales device_id/severity, orden opened_at DESC.
Se conservan idx_alerts_status_device_severity y idx_alerts_status_opened.
El optimizador puede elegir cualquiera de esos dos segun filtros y datos;
un ordenamiento residual puede ser necesario con el primero. No se afirma
que todas las variantes tengan cobertura total o igual rendimiento.
artifacts/m05-queries.json registra Q1 y cuatro variantes Q2, indices del plan
ganador/ejecutado, etapas, filas, claves y documentos examinados. No usa hint;
rechaza COLLSCAN y exige resultados sobre los fixtures.
Nunca se acepta un indice que aparezca solamente en rejectedPlans.
Referencia: https://www.mongodb.com/docs/v7.0/reference/explain-results/

## Entorno y secretos
make setup genera contrasenas locales aleatorias en .env ignorado, prepara
PostgreSQL y MongoDB, aplica contratos y seeds. make verify repite la
preparacion, ejecuta suites reales, escanea Git con Gitleaks y genera reportes.
make run muestra consultas reales de ambos motores sin imprimir credenciales.
MONGO_USER/MONGO_PASSWORD son solo para inicializacion administrativa.
MONGO_APP_USER/MONGO_APP_PASSWORD autentican el CRUD con readWrite en cdrl,
sin root. Este rol no equivale a los cuatro roles especializados PostgreSQL;
la division M03 se conserva en PostgreSQL. readWrite aun permite operaciones
de DDL de colecciones: no se presenta como un rol minimo para produccion.
La base inicializada es cdrl; host y puerto pueden configurarse con variables.
No se versionan URI ni valores secretos; .env.example solo contiene nombres
y campos vacios. MongoDB se publica exclusivamente en loopback.
Para rotar la cuenta de aplicacion local: cambiar MONGO_APP_PASSWORD en el
.env ignorado, ejecutar node scripts/mongo.mjs up y reiniciar clientes.
El init actualiza esa cuenta usando las credenciales administrativas vigentes.
Cambiar solo MONGO_PASSWORD no rota el administrador de un volumen existente:
requiere actualizar el usuario en MongoDB con las credenciales anteriores.
No borrar volumen ni subir contrasenas para resolver una rotacion.
El escaneo no prueba ausencia absoluta de todos los secretos posibles.

## Pruebas y evidencia
Normal: CRUD de eventos/alertas y consultas con resultados conocidos.
Limites: porcentajes 0 y 100, ausencia, duplicados y reintentos simultaneos.
Fallo declarado: insercion/actualizacion invalida rechazada; datos guardados
permanecen intactos. Se prueban ademas filtros y limites invalidos.
Se mantienen las pruebas M01-M04 y las aportadas por ambos companeros.
evidence/m05-document-store.json es el manifiesto versionado.
evidence/m05-document-store-local.json es el resultado ejecutado con SHA real.
artifacts/m05-verify.json contiene pruebas, consultas y escaneo; CI publica
el log y JSON del commit exacto. El reporte versionado puede corresponder al
commit previo al que lo agrega; no se inventa un SHA autorreferencial.
La carpeta de entrega y el artefacto de Actions del tag usan el SHA final.

## Autoria
Francesco Romero: Compose, esquema, indices, fixtures, seed y pruebas directas
(commits ed9decb a e830e9e).
Jonathan / Radh117: driver, CRUD, consultas y pruebas (c6c141f).
Eddi Daga: revision, correcciones de integracion, concurrencia, cuenta de
aplicacion, evidencia de planes, pruebas complementarias, CI y cierre M05.
Se conserva la historia y no se reemplazan tags publicados.
