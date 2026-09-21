# CDRL-base-2026 - M03 roles y secretos

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

Entregar URL del repositorio, tag week-03-final, SHA exacto, salida de make verify
y evidencia generada. git rev-parse week-03-final^{commit} devuelve el SHA.
No usar force push ni borrar/recrear los tags finales.

Para detener PostgreSQL conservando datos: docker compose down.
make clean elimina el volumen local: usarlo solo cuando se quiera borrar esa base.
