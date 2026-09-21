# Entrega y defensa de M03

## Archivos para Classroom

- URL: https://github.com/e-daga/CDRL-base-2026
- Tag: week-03-final.
- SHA exacto: git rev-parse week-03-final^{commit}.
- Salida completa de make verify: artifacts/m03-verify.log, disponible en Actions.
- Evidencia de ejecucion: evidence/m03-roles-secrets-local.json.
- Manifiesto versionado: evidence/m03-roles-secrets.json.
- Resultado estructurado: artifacts/m03-verify.json.

Descargar el artefacto m03-delivery-SHA de la ejecucion del tag en GitHub Actions.
Ese paquete contiene el resultado y la evidencia generados en el SHA final.
El archivo local de evidencia se excluye de Git para evitar meter su propio SHA
en el commit que lo contiene. El manifiesto versionado explica como obtenerlo.
Los reportes versionados son instantaneas de la ejecucion indicada dentro
del JSON; el resultado de Actions corresponde a la revision que se entrega.

## Que se implemento y por que

PostgreSQL tiene cuatro roles NOLOGIN que agrupan permisos y cuatro cuentas
LOGIN diferentes que heredan exactamente uno de esos roles. Esto permite
cambiar una credencial sin cambiar la politica de autorizacion.
El bootstrap administrativo crea roles y cuentas; los servicios no usan esa cuenta.

El migrador es propietario del esquema de tablas del proyecto y puede hacer
CREATE, ALTER y DROP. Al abrir su conexion se usa SET ROLE role_migrator para
que las tablas nuevas queden bajo el mismo propietario. La tabla
schema_migrations guarda los nombres y checksums para detectar cambios en
migraciones ya aplicadas.

El escritor inserta dispositivos y eventos. En device_status puede hacer
SELECT, INSERT y UPDATE porque un upsert necesita consultar la fila existente.
No lee telemetria cruda ni modifica alertas.

El lector puede consultar las cuatro tablas de aplicacion y no escribir.
El operador puede consultar, insertar y actualizar alertas; no puede acceder
a telemetria cruda ni al estado de dispositivos. Ninguna de esas tres cuentas
puede cambiar el esquema, borrar filas, crear usuarios o asumir el rol migrador.

Las pruebas negativas no simulan la autorizacion. Abren conexiones con esas
cuentas, ejecutan SQL y exigen el codigo 42501 de PostgreSQL. Una operacion que
funciona cuando debia ser rechazada hace fallar la entrega. Los limites 0 y
100 se insertan bajo el escritor y luego se revierten para mantener el seed.

Gitleaks revisa los archivos actuales y el historial alcanzable de todas las
referencias locales. El checkout de Actions descarga el historial completo.
Un secreto sintetico temporal prueba que el escaner funciona. No hay
allowlists, baselines ni comentarios que desactiven hallazgos en el escaneo.
El reporte no contiene los valores detectados.

## Respuestas breves

Por que cuatro cuentas: para que cada proceso tenga solo los permisos que necesita.

Por que GRANT ALL no bastaba: no cambia el propietario de una tabla; ALTER y
DROP requieren propiedad. La migracion nueva transfiere esa propiedad.

Como sabemos que se deniega: la base devuelve 42501 al ejecutar SQL con la
cuenta restringida, y la prueba exige ese codigo.

Donde estan las contrasenas: en .env local ignorado o en variables inyectadas
por el entorno; nunca en el codigo, los reportes o los argumentos de comandos.

Como se rotan: se cambia la credencial, se terminan sesiones anteriores, se
actualiza el consumidor y se comprueba que la nueva funciona y la vieja no.

Por que los tests viejos usan migrator: M01/M02 prueban integridad y preparan
fixtures que requieren escritura y limpieza. Las pruebas M03 verifican la
autorizacion usando las cuentas restringidas reales.

## Autoria tecnica

El historial conserva las aportaciones originales:
- Francesco Romero: migracion inicial de roles, commit f27871b.
- Radh117: pruebas iniciales de privilegios y ADR, commit 84a7a9d.
- La integracion M03 se registra en los commits nuevos de esta entrega.

No se reatribuyen commits ni se simulan contribuciones. Cada integrante debe
revisar la implementacion actual y poder explicar su aporte y la integracion.
