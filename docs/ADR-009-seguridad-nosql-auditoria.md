# ADR-009: Seguridad NoSQL y auditoria util

## Contexto y decision

M09 corresponde a Semana 10. Conservamos MongoDB standalone y los contratos de
M01-M08. Los controles de PostgreSQL de M03 no sustituyen los permisos MongoDB.
Usamos cuatro cuentas de servicio distintas y roles sin herencia: ingest para
find/insert/update en events; reader para find en events/alerts; operator para
find/insert/update en alerts/alert_audit y listCollections; auditor para find
en alert_audit. La matriz detallada esta en M09-permisos-mongo.md.

La cuenta root solo configura usuarios/roles y validadores. La cuenta de
mantenimiento readWrite prepara y limpia fixtures y ejecuta migraciones; no se
usa para demostrar accesos de servicio. Las consultas normales de run usan reader;
la demo M09 usa las cuatro cuentas reales. El laboratorio contiene credenciales
de mantenimiento para reproducir los experimentos, no es un servidor desplegado
para usuarios no confiables. En produccion deben separarse procesos y secretos.

## Amenazas y controles por operacion

Se prueban lecturas cruzadas, inserciones/actualizaciones/borrados no permitidos,
alteracion de auditoria por terceros, creacion de usuarios, escalamiento de roles
y autenticacion incorrecta. Los rechazos exigen codigo 13 Unauthorized del servidor
(18 para autenticacion), no un if de JavaScript. La matriz efectiva se obtiene
con connectionStatus/showPrivileges y se compara con la declarada.

Los probes de escritura se limitan a IDs sinteticos. Se compara el estado de los
datos antes y despues. Los intentos destructivos requieren previamente comprobar
privilegios y el intento dropDatabase apunta a un nombre temporal, no a cdrl.
La limpieza usa IDs/UUID propios, nunca borra por prefijos compartidos.

## Auditoria y alcance

Se conserva el flujo acknowledgeAlertWithAudit de Jonathan, con actor sintetico,
accion fija, recurso (tipo/id), resultado y codigo acotados, fecha y operation_id.
Los registros se releen con auditor. Hay un exito, una denegacion por recurso
inexistente y otra por conflicto; el reintento conserva un unico registro.
additionalProperties:false y listas de campos/codigos impiden persistir payload,
tokens, contrasenas, cadenas de conexion, datos personales o errores crudos.
Los errores publicos de auditoria tampoco adjuntan la causa cruda del driver.

IMPORTANTE: not_found y state_conflict son denegaciones de negocio, no errores
de autorizacion MongoDB. Los seis Unauthorized reales se registran por separado
en deniedOperations del reporte con actor/accion/recurso/resultado/codigo. Esa
evidencia del experimento NO es un capturador automatico de todos los accesos.
Una llamada directa a MongoDB o hecha fuera del flujo no genera por si sola una
fila en alert_audit. No se afirma tener auditoria nativa de MongoDB Enterprise.

El actor es un identificador sintetico proporcionado por codigo confiable del
laboratorio, no una identidad de usuario final autenticada por HTTP. Un servicio
real tendria que derivarlo de su sesion autenticada y no aceptar actor arbitrario.

## Fallos y compatibilidad

Una intencion pending precede al cambio de alerta. Solo se informa completed
cuando se confirma el cierre de auditoria. Si falla insertar el registro no se
aplica el reconocimiento; si falla cerrarlo puede quedar la alerta modificada
y el registro pending. Se devuelve AUDIT_PENDING y se reintenta con el mismo ID.
La prueba inyecta ese fallo en el punto de escritura usando un proxy sobre una
conexion real operator: no simula los rechazos de permisos. La recuperacion real
conserva un registro sin duplicarlo. No hay transaccion entre ambas colecciones.

Los registros anteriores de M06 siguen siendo legibles. Los registros nuevos
incluyen resource/result/result_code. La cuenta operator comprueba el validador,
pero no crea colecciones ni indices en tiempo de reconocimiento: setup lo prepara.
Una cuenta reader que invoque ese flujo sigue siendo rechazada por MongoDB;
no se toman prestados privilegios de mantenimiento para completar la operacion.

## Remediacion probada

Una cuenta, rol y coleccion exclusivos m09_test_<uuid> empiezan con find, insert
y remove. Se inserta y elimina un documento para demostrar el permiso excesivo.
Se retira solo remove mediante updateRole. Tras reconectar, insertar y leer siguen
funcionando; borrar produce Unauthorized y el documento permanece. Se eliminan
solo esa cuenta/rol/coleccion. El script administrativo rechaza destinos fuera de
ese namespace y los secretos temporales viajan por entorno, no en argumentos.

Ademas se retiro createIndex de la cuenta operator real: se prueba que no puede
crear un indice y que el reconocimiento auditado sigue funcionando. No se amplian
permisos reales para simular el problema. Setup reemplaza los permisos declarados
de forma repetible y no borra datos.

## Secretos y rotacion

Setup genera secretos aleatorios independientes en .env ignorado, o recibe variables
del entorno. .env.example no tiene valores secretos. Gitleaks revisa historial
completo y archivos actuales; un canario temporal prueba que el detector funciona.
Un escaneo sin hallazgos no demuestra ausencia absoluta de cualquier secreto.

Para rotar una cuenta Mongo: generar un nuevo valor fuera de Git, actualizar su
variable en el gestor de secretos/entorno, ejecutar setup para updateUser y reciclar
los clientes. Verificar nueva conexion y rechazo del secreto anterior antes de
declarar la rotacion completa. No se afirma haber probado revocacion de sesiones
Mongo abiertas mediante cambio de password; la remediacion de esta entrega prueba
privilegios tras reconexion, no rotacion. Docker local no usa TLS; un despliegue
externo requiere configuracion TLS y evaluacion adicional. No se valido AWS.

## Limites y alternativas

Operator necesita update sobre alert_audit para pasar pending a completed. Puede
alterar campos permitidos si sus credenciales se comprometen; el validador no es
inmutabilidad. Mantenimiento/root tambien pueden modificar o borrar registros.
No se promete evidencia resistente a un administrador malicioso. Una auditoria
append-only separada o un destino externo seria una evolucion con mas complejidad,
roles y gestion de retencion; no se introduce sin cambiar el contrato de M06.

Se descarta usar readWrite para todas las operaciones de servicio: permitiria
lecturas, escrituras y borrados que no corresponden. Se conservan permisos mas
amplios solo en mantenimiento, que debe aislarse en un despliegue real.

## Resultado de integracion

La ejecucion [Actions 42553309973](https://github.com/e-daga/CDRL-base-2026/actions/runs/42553309973)
del commit de247c79bb1f2deff1950869ed6d3f6f4205fcb1 aprobo setup, verify y run.
187 pruebas: 16 M09 y 171 de los hitos anteriores, incluyendo las nuevas pruebas
de auditoria que Jonathan agrego a M06. Cero fail, skipped y todo; el escaner no
encontro secretos y su prueba de deteccion paso.

La evidencia de verify contiene cuatro matrices efectivas, seis respuestas reales
Unauthorized sin cambios de datos y tres registros auditados (un exito y dos
denegaciones de negocio). La remediacion elimino un documento antes de revocar
remove; despues de revocarlo el servidor nego delete con codigo 13 y conservo el
documento, mientras insert/find siguieron permitidos. Limpieza temporal completada.
Las ejecuciones posteriores generan sus propios IDs, fechas y SHA de evidencia.

## Reproduccion, evidencia y autoria

make setup && make verify && make run conserva las pruebas previas. Verify exige
ambas suites M09, normal/dos limites/fallo declarado/remediacion y no permite
fail/skipped/todo. Genera artifacts/m09-verify.json con permisos, auditoria, remedio,
pruebas y escaneo; artifacts/m09-security.json contiene la demo. Run repite la demo
sin reemplazar la evidencia de verify. En fallo los resultados M09 quedan failed.

Manifiesto: evidence/m09-nosql-security-audit.json. Evidencia ejecutada:
evidence/m09-nosql-security-audit-local.json. Los reportes versionados identifican
el commit probado; la evidencia descargable del SHA final evita referencias a un
SHA dentro de su propio commit. Tag semanal: week-10-final. No reemplazar tags.

Francesco: 6f086de, 96521cd, ebeaa06, 8257184, roles, secretos, pruebas y matriz.
Jonathan (Radh117): 32d4aaf, resultados auditados y remediacion de permisos.
Eddi con asistencia de Codex: revision, integracion, aislamiento, reduccion del
permiso createIndex, errores sanitizados, evidencia, pruebas adicionales y cierre.
Se preservan los commits de los companeros y no se desactivan tests.
