# ADR-006 - Evolucion, auditoria y recuperacion

## Decision y alcance
Continuamos MongoDB standalone local junto a PostgreSQL. M06 demuestra
coexistencia de versiones, una transicion auditada y recuperacion de un
fixture sintetico en una coleccion aislada. No se afirma despliegue AWS,
recuperacion de toda la base, replica set ni transacciones entre colecciones.

## Evolucion y consultas
Francesco implemento coexistencia: eventos antiguos sin schema_version son
v1; v2 exige schema_version=2 y firmware_version X.Y.Z. No se reescriben
documentos al leer. La consulta Q1 ofrece una vista comun (v1, firmware null)
pero readEvent devuelve el documento almacenado. No enviar automaticamente
la vista normalizada como documento para guardar: v1 explicita no es valida.
El validador de servidor y la normalizacion de escritura validan versiones.
Los fixtures conocidos suman 8 v1 y 3 v2; se conservan los 6 eventos M05.
init usa collMod para volumen existente y createCollection para base nueva.
Q1/Q2 y todas las pruebas M01-M05 permanecen. La evolucion no necesita
otro indice porque no cambia los filtros de las consultas existentes.

## Auditoria
Jonathan implemento una intencion pending antes del cambio en alerts,
seguida del cambio y la confirmacion completed. Solo registra identificadores,
actor sintetico, accion, fecha y cambios de estado/fecha permitidos.
No copia payload, variables de entorno ni documentos completos.
El esquema rechaza campos adicionales. Los actores de la demo son etiquetas
sinteticas, no una identidad autenticada ni un campo donde introducir secretos.
setup prepara coleccion, validador e indices antes de usar la operacion.
El indice unico operation_id evita duplicados. Reintentar exige mismo actor
y alerta. Un fallo de cierre produce AUDIT_PENDING, nunca exito completo.
La correccion de integracion guarda audit_operation_id en la misma escritura
atomica que reconoce la alerta; una fecha igual por si sola no identifica una
operacion. Dos operaciones con la misma fecha no se atribuyen el mismo cambio.
No hay atomicidad entre colecciones: quedan intenciones pendientes cuando
la alerta cambia por otra operacion. Requieren reconciliacion/intervencion.
La prueba del fallo de cierre inyecta una excepcion en el cliente sobre una
base real; no simula una caida de todo MongoDB. La cuenta readWrite puede
editar registros: este historial no es inmutable ni resistente a administradores.

## Recuperacion y protecciones
src/m06-recovery.mjs trabaja solo sobre m06_recovery_fixture dentro de cdrl.
No acepta como destino events, alerts u otra coleccion. Copia el validador
de events a la coleccion aislada, con strict/error.
El fixture tiene _id fijo y campos sinteticos conocidos. Si encuentra datos
ajenos, aborta sin borrarlos. Nunca ejecuta dropDatabase ni drop de colecciones.
Procedimiento:
1. Preparar el fixture y leerlo realmente desde MongoDB.
2. Serializar respaldo Extended JSON preservando fechas y calcular SHA-256.
3. Guardar artifacts/m06-fixture-backup.json antes del fallo; si falla la
   escritura del archivo, no se borra el fixture.
4. Borrar solo ese documento y verificar que ya no existe.
5. Restaurar el respaldo validado, leer de nuevo y comparar hashes.
6. Repetir restauracion y comprobar que no duplica.
El SHA-256 detecta cambios accidentales; no es firma de autenticidad.
Ademas se exige coincidencia con el fixture permitido, no documentos arbitrarios.
La demo relee el archivo JSON guardado, comprueba que coincide y restaura
desde ese objeto; no es un backup general con mongodump ni recuperacion de discos.
La restauracion exportada restoreFixture admite el objeto JSON del respaldo;
los tests alteran ese objeto para comprobar rechazos.

## Medicion y limites
Se reportan expected, missingAfterFailure, recovered, lostDocuments,
differences, recoveryMs y hashes original/restaurado. recoveryMs usa reloj
monotonico e incluye borrado, confirmacion de ausencia, restauracion y lectura.
El respaldo no se incluye en ese intervalo. La segunda restauracion se reporta
por separado. Es una medicion de un documento, no RTO/RPO de produccion.
El fixture restaurado permanece en la coleccion aislada y permite repetir
el experimento. La demo de auditoria usa IDs nuevos, exporta su registro y
limpia unicamente esos documentos sinteticos; no altera alertas del seed.

## Verificacion y entrega
make setup prepara contratos y cuentas; make verify ejecuta todas las suites,
escanea secretos y genera evidencia de las tres partes; make run muestra
consultas y repite la demo aislada. Los reportes failed nunca cuentan como
una entrega aprobada. No se desactiva ninguna prueba.
Caso normal: lectura mixta, auditoria completada y recuperacion 1/1.
Limites: documentos antiguos, reintentos, ausencia y restauracion repetida.
Fallo declarado: respaldo corrupto, destino ajeno, fallo de respaldo,
auditoria pendiente y versiones invalidas.
evidence/m06-evolution-audit-recovery.json es el manifiesto versionado;
el archivo *-local.json y el artefacto de Actions registran la ejecucion y SHA.
El reporte versionado conserva SHA base y cambios del momento de ejecucion.
El adjunto final identifica el commit final, no un hash inventado.
Las mediciones de make run pueden diferir de make verify porque son ejecuciones
distintas; cada resultado describe su propio experimento.

## Autoria
Francesco Romero: modelo v1/v2, consultas, fixtures y pruebas (8fb2832 a 1b6f189).
Jonathan / Radh117: auditoria idempotente y pruebas (1f5abf7).
Eddi Daga: revision, correccion de atribucion, recuperacion aislada, pruebas
complementarias, evidencia, CI y cierre. Se conserva historia y tags anteriores.
