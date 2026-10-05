# CDRL-base-2026 - M05 almacen documental

## Entrega actual M05

MongoDB implementa eventos y alertas con validacion del servidor, indices,
CRUD y reintentos idempotentes. PostgreSQL y las pruebas M01-M04 se conservan.
Requisitos: Docker Compose, Node.js 20.19 o superior y GNU Make.

Ejecutar `make setup && make verify && make run`. En PowerShell, ejecutar
cada comando en una linea y comprobar que termine sin errores.
El setup genera secretos locales en `.env` ignorado, inicializa ambos motores
y carga fixtures sinteticos. No compartir ese archivo ni cadenas de conexion.
Los clientes MongoDB usan una cuenta de aplicacion separada del administrador.
Las suites se ejecutan en serie, sin omitir ni desactivar pruebas.

- [Reporte, alcance y limitaciones M05](docs/ADR-005-almacen-documental.md).
- [Modelo documental de Francesco](docs/M05-modelo-documental.md).
- [CRUD y consultas de Jonathan](docs/M05-crud-consultas.md).
- [Manifiesto de evidencia](evidence/m05-document-store.json).
- Reportes ejecutados: `artifacts/m05-verify.json`, `artifacts/m05-queries.json`
  y `evidence/m05-document-store-local.json`.
- Entrega: URL del repo, `week-05-final`, SHA del commit, salida de
  `make verify` y evidencia ejecutada. Actions publica los JSON y el log
  del SHA exacto; el manifiesto no inventa un SHA antes de crear el commit.

Q1 y cuatro variantes Q2 se verifican con planes ganadores reales, sin hint.
Es una implementacion local con datos pequenos, no una prueba de escala,
alta disponibilidad o despliegue AWS.

## Antecedente M04

M04 compara document (MongoDB), graph (Neo4j), column (Cassandra) y object
(S3) con una matriz ponderada reproducible. MongoDB obtiene 83/100 frente
a Cassandra 80/100; la seleccion es condicional y cambia si escala recibe
mas peso. No se afirma haber ejecutado benchmarks de esos motores.

## Entrega anterior M04

Ejecutar `make setup && make verify && make run`. Se conservan las pruebas
de M01-M03 y se agregan las de decision NoSQL; fallos, skips y TODOs impiden
aprobar. `npm run compare:nosql` permite revisar solo el calculo, sin levantar
otro motor. El comando `make run` muestra datos del respaldo PostgreSQL y
la clasificacion M04, sus supuestos y sensibilidad.

- [ADR de la seleccion y alternativa descartada](docs/ADR-004-decision-nosql.md).
- [Carga y consultas](docs/M04-carga-y-consultas.md).
- [Matriz con veinte hipotesis falsables y fuentes](docs/m04-nosql-matrix.json).
- `artifacts/m04-comparison.json`: calculo y sensibilidad.
- `artifacts/m04-verify.json`: pruebas, revision, comparacion y secretos.
- `evidence/m04-nosql-decision.json`: manifiesto versionado.
- `evidence/m04-nosql-decision-local.json`: evidencia ejecutada con SHA exacto.

Entregar URL, tag `week-04-final`, SHA de `git rev-parse week-04-final^{commit}`,
salida `artifacts/m04-verify.log` y evidencia ejecutada. Actions adjunta el
paquete `m04-delivery-SHA` del tag. Los reportes versionados son instantaneas
del commit indicado en su interior; el paquete del tag corresponde al SHA final.
Los objetivos de rendimiento y costo son hipotesis, no resultados medidos.

## Base conservada M01-M03

Proyecto de equipo Cloud Data Reliability Lab. Conserva M01 (contrato de
telemetria), M02 (modelo operativo) y agrega M03 (roles separados y secretos).

## Ejecutar la entrega

Requisitos: Git, Node.js 20.12 o superior, npm, GNU Make y Docker con Compose.
Docker Desktop debe estar iniciado en Windows. La primera ejecucion necesita
Internet para npm y las imagenes de PostgreSQL y Gitleaks.

```sh
make setup && make verify && make run
```

En PowerShell que no admite &&, ejecutar cada comando por separado y continuar
solo si el anterior termino correctamente. Si no esta instalado Make:

```sh
npm ci
npm run setup:db
npm run verify
npm run run
```

Estas alternativas ejecutan los mismos scripts de Node; GitHub Actions ejecuta
los comandos make de la consigna.

El setup genera .env ignorado con cinco secretos aleatorios distintos, levanta
PostgreSQL 16, aplica migraciones con checksum, configura cuentas y carga el seed.
Si el puerto 5432 esta ocupado, establecer POSTGRES_PORT antes del primer setup.
No copiar contrasenas a .env.example. El ejemplo no se usa como fuente de secretos.

El bootstrap requiere una cuenta administrativa para crear roles y transferir
propiedad (migraciones historicas 001-003 y correccion 004). Despues, migraciones
y seed usan la cuenta migrator. La aplicacion de demostracion usa reader.
Repetir setup no borra datos ni cambia los checksums de migraciones anteriores.
Para un volumen previo de M01/M02, conservar la credencial administrativa local
e incorporar las cuatro credenciales nuevas mediante variables de entorno;
no cambiar POSTGRES_USER/POSTGRES_PASSWORD creyendo que eso reinicializa el volumen.

## Permisos declarados

| Rol | Operaciones permitidas |
| --- | --- |
| migrator | Propietario de las tablas; crea, altera y elimina objetos; migra y carga fixtures |
| writer | INSERT en devices/telemetry_events; SELECT, INSERT y UPDATE en device_status |
| reader | SELECT en las cuatro tablas de aplicacion |
| operator | SELECT, INSERT y UPDATE en telemetry_alerts |

Cada rol tiene una cuenta independiente, sin SUPERUSER, CREATEDB, CREATEROLE,
REPLICATION ni BYPASSRLS. Las cuentas de servicio no heredan privilegios de
otras funciones. writer, reader y operator no pueden borrar datos, cambiar
tablas, leer schema_migrations ni asumir el rol migrator.
Las tablas futuras creadas por role_migrator dan SELECT al lector por defecto;
el escritor y el operador necesitan un GRANT explicito para objetos nuevos.

## Verificacion

make verify prepara el entorno, ejecuta las suites reales M01/M02/M03 y exige:
casos normales, al menos dos limites y tres accesos denegados, un fallo
declarado y una rotacion. Un test fallido, omitido o pendiente impide aprobar.
Las denegaciones se prueban ejecutando SQL con cuentas propias y comprobando
SQLSTATE 42501. Los fixtures son sinteticos y las pruebas revierten sus cambios.

El escaner Gitleaks 8.30.1 esta fijado por digest de imagen. Revisa el historial
completo de todas las referencias locales y los archivos actuales. No usa
excepciones ni baselines, y una credencial ficticia temporal comprueba que el
detector realmente rechaza secretos. Los reportes no incluyen valores secretos.

Resultados:
- artifacts/m03-verify.json: resultado, SHA, pruebas, permisos, rotacion y escaneo.
- evidence/m03-roles-secrets.json: manifiesto versionado de la entrega.
- evidence/m03-roles-secrets-local.json: evidencia ejecutada con el SHA exacto.
- artifacts/m01-verify.json y artifacts/m02-verify.json: regresiones de hitos anteriores.

Los reportes versionados indican el commit sobre el que se ejecutaron. La
ejecucion de Actions del tag week-03-final entrega los JSON y el log del SHA
final como artefacto descargable. No se incrusta el SHA de un commit dentro
de ese mismo commit.

## Secretos y entorno

La configuracion usa variables separadas, nunca cadenas de conexion.
Consultar [rotacion y respuesta ante exposicion](docs/M03-rotacion-secretos.md).
Para rotar localmente una cuenta:

```sh
npm run rotate:secret -- writer
```

Docker Compose es el entorno validado. Con un Learner Lab disponible, usar
CDRL_DATABASE_MODE=external e inyectar las cinco cuentas y sus secretos.
La conexion externa exige TLS con validacion de certificado. No se afirma
haber desplegado ni validado AWS Academy.

La historia M01/M02 conserva un valor publico de desarrollo. M03 lo retira
del codigo actual y usa credenciales nuevas, manteniendo los commits originales.
Un escaneo sin hallazgos no garantiza la ausencia de todo secreto posible.

## Documentacion y entrega

- [ADR M03](docs/ADR-003-roles-y-secretos.md).
- [Rotacion](docs/M03-rotacion-secretos.md).
- [Entrega, autoria y defensa](docs/M03-entrega-y-defensa.md).
- [ADR M01](docs/ADR-001-contrato-telemetria-postgresql.md).
- [ADR M02](docs/ADR-002-modelo-relacional-operativo.md).

La entrega historica M03 usa URL del repositorio, tag week-03-final, SHA exacto, salida de make verify
y evidencia generada. git rev-parse week-03-final^{commit} devuelve el SHA.
No usar force push ni borrar/recrear los tags finales.

Para detener PostgreSQL conservando datos: docker compose down.
make clean elimina el volumen local: usarlo solo cuando se quiera borrar esa base.
