# ADR-003 - Roles separados y secretos fuera de Git

## Estado

Aceptado para M03. La propuesta original se completa con cuentas, permisos
efectivos, pruebas de denegacion, rotacion y evidencia automatica.

## Contexto

M01/M02 usaban una conexion administrativa para todas las operaciones.
Declarar GRANT sobre roles sin cambiar las conexiones no separaba los accesos.
Ademas, GRANT ALL sobre una tabla no concede su propiedad para ALTER/DROP.

## Decision

Conservar las migraciones 001-003 sin modificar sus checksums. Agregar 004,
ejecutada por el bootstrap, que transfiere las cinco tablas al role_migrator,
retira permisos PUBLIC sobre esquema/base y define permisos minimos.

| Grupo NOLOGIN | Cuenta por defecto | Permisos |
| --- | --- | --- |
| role_migrator | cdrl_migrator | Propiedad de tablas, DDL, migraciones y fixtures |
| role_writer | cdrl_writer | INSERT devices/telemetry_events; SELECT/INSERT/UPDATE device_status |
| role_reader | cdrl_reader | SELECT devices/telemetry_events/device_status/telemetry_alerts |
| role_operator | cdrl_operator | SELECT/INSERT/UPDATE telemetry_alerts |

Los usuarios se configuran en scripts/create_service_users.mjs usando variables
de entorno. Cada usuario hereda solo su grupo y carece de atributos
administrativos. El bootstrap no se usa para consultas de aplicacion.

La conexion migrator ejecuta SET ROLE role_migrator para que objetos nuevos
sean del grupo. Los permisos por defecto conceden lectura de tablas futuras
al lector, sin extender escritura u operacion implicitamente. No se concede
CREATE ni TEMPORARY a writer, reader u operator.

Los modelos usan UUID/text como claves; no necesitan privilegios de secuencias.
device_status necesita SELECT ademas de INSERT/UPDATE para resolver el upsert.
operator conoce el identificador de evento que recibe del flujo, pero no
puede consultar su contenido crudo.

## Secretos y rotacion

El setup local genera secretos criptograficamente aleatorios en .env ignorado.
El ejemplo versionado contiene campos vacios y no hay contrasenas por defecto
en configuracion o Compose. En cloud se inyectan variables y se exige TLS.
La rotacion tiene procedimiento y comando en M03-rotacion-secretos.md:
actualiza PostgreSQL, termina sesiones, actualiza al consumidor y verifica
que la credencial vieja falla. La suite prueba ese flujo con una cuenta efimera.

Gitleaks con imagen fijada por digest inspecciona archivos e historial completo.
Un fixture temporal prueba el rechazo. No se usan baselines o allowlists.
Los valores sinteticos publicos de los hitos anteriores quedan en el historial
original; no se oculta ese antecedente ni se reescribe la historia.

## Verificacion y consecuencias

M03 conecta realmente como cada usuario. Comprueba identidades, atributos,
membresias, permisos sobre todas las tablas y operaciones permitidas.
Los rechazos ejecutan SQL y exigen 42501; incluyen escritura no autorizada,
lectura prohibida, DDL, borrado, TRUNCATE, escalamiento y creacion de usuarios.
Se prueban limites 0/100, consultas vacias y privilegios de tablas nuevas.

make verify ejecuta todas las suites y rechaza fallos, skips o TODOs. El
resultado estructurado incluye el SHA y se adjunta en Actions junto al log.
Se conserva el historial y autoria individual.

El costo es administrar cinco credenciales (bootstrap y cuatro servicios).
El migrador, por ser propietario, puede manipular los datos: se reserva para
despliegues/fixtures y no es una cuenta de aplicacion. El bootstrap sigue
siendo una cuenta privilegiada necesaria para aprovisionar y rotar usuarios.
Docker Compose se valida; AWS depende de permisos y disponibilidad del Lab.
