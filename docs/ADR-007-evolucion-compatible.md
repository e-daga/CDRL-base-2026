# ADR-007 - Evolucion compatible de documentos

## Decision y alcance
M07 corresponde a Semana 08 en Classroom: archivos m07 y tag week-08-final.
Seguimos usando MongoDB standalone en Docker Compose junto a PostgreSQL.
No se ha desplegado AWS ni se ha migrado la coleccion events de la aplicacion.
La demostracion usa seis documentos sinteticos en colecciones unicas por corrida.

## Contrato y compatibilidad
V1: schema_version ausente; sin campos de firmware o procedencia.
V2 nativo: schema_version=2 y firmware_version X.Y.Z; firmware_status opcional
reported para conservar los documentos M06.
V2 migrado: schema_version=2, firmware_version=null, firmware_status=unknown,
migrated_from=1. No conocemos el firmware real y no inventamos uno.
El marcador describe una convencion, no certifica la procedencia: cualquier
escritor autorizado puede producir un documento que cumpla el contrato.
Validadores de servidor y aplicacion rechazan combinaciones contradictorias.

La vista shape=legacy conserva campos/tipos de M05; la vista current sigue
disponible y ahora expone el estado del firmware. Los clientes que necesiten
la forma estricta M05 deben pedir legacy. No se promete compatibilidad con
lectores que acceden directamente a MongoDB y rechazan campos nuevos, ni con
consumidores que suponen que todo schema_version=2 conoce su firmware.
readEvent devuelve el documento almacenado; la vista normalizada de lectura
no debe guardarse automaticamente como si fuera un documento de escritura.
El consumidor de prueba compara contra una salida esperada independiente,
incluyendo orden, fechas, tipos y contenido. Se ejecuta antes, durante,
despues y tras rollback usando el migrador real, no el simplificado del
test de contrato. Los dos v2 nativos quedan intactos.

## Migracion y reanudacion
scripts/event-migration.mjs migra solo v1 dentro de un alcance exacto no vacio
(source, device_id y/o event_id). inspect no escribe; muestra pendientes y lotes.
migrate exige runId UUID explicito. El mismo UUID debe conservar coleccion y
alcance. El diario debe ser una coleccion separada. El batchSize controla el
lote de candidatos; la reconciliacion de entradas anteriores usa un cursor.
El diario guarda identificadores y hashes antes/despues, no copias completas
ni payload. Un registro de claim por documento arbitra corridas distintas.
Cada escritura compara atomicamente el documento leido completo; si cambia,
no se sobrescribe. No hay transaccion de toda la corrida.
Una pausa por maxBatches deja una transicion parcial legible. Ademas se prueba
una excepcion entre aplicar un documento y confirmar su entrada de diario:
al reanudar reconoce el hash posterior y termina sin duplicar.
Se conservan _id, event_id, fechas y los campos originales.
Repetir la migracion completa cambia cero documentos.

## Rollback y conflictos
El rollback usa el runId y sus entradas; no revierte v2 nativos ni otra corrida.
Solo retira los cuatro campos agregados cuando el documento completo coincide
con el hash posterior. Comprueba el hash original tras revertir.
Una escritura posterior bloquea la reversion automatica, aunque sea legitima.
conflicts cuenta conflictos nuevos de esa invocacion; unresolved_conflicts
conserva el total pendiente del diario. Repetir rollback no convierte un
conflicto pendiente en exito: el CLI devuelve codigo 2 si cualquiera es positivo.
Iniciar rollback marca la corrida como fase rollback; no se permite volver a
migrar con ese UUID. Para otra migracion usar otro UUID tras revisar conflictos.
Las operaciones sobre el mismo runId deben serializarse. No hay lease global
para ejecutar migrate y rollback simultaneamente sobre una misma corrida.
La comparacion de contenido no detecta una modificacion que luego retorna
exactamente al valor anterior (problema ABA). No se afirma historial inmutable.
No borrar el diario: no es un backup, pero es necesario para reanudar/revertir.
No existe resolucion automatica de conflictos ni rollback general de cambios
ajenos. El alcance temporal corresponde a los documentos observados por la
corrida, no a un snapshot transaccional frente a nuevas inserciones.

## Aislamiento y entorno existente
La demo crea colecciones m07_delivery_<UUID> y m07_journal_<UUID> con el
validador real; al terminar elimina solo colecciones creadas por ella.
Las pruebas de los companeros tambien usan nombres aleatorios por ejecucion.
Nunca ejecutamos el CLI de migracion sobre los fixtures compartidos de events.
El setup actualiza el validador del fixture M06 si ya existe y contiene
unicamente el documento sintetico esperado; no borra su contenido ni omite
sus pruebas. Si detecta documentos ajenos aborta.
Los secretos siguen en variables de entorno/.env ignorado. Los reportes
contienen solo experimentos sinteticos; Gitleaks revisa archivos e historia.
La ausencia de hallazgos no es garantia absoluta de ausencia de secretos.

## Verificacion y evidencia
make setup prepara contratos y seed sin ejecutar una migracion destructiva.
make verify mantiene M01-M06 y agrega todas las pruebas M07.
make run muestra la secuencia real en colecciones aisladas.
Normal: cuatro v1 se migran, dos v2 se preservan y el consumidor no cambia.
Limites: transicion parcial, ausencia de candidatos, segunda ejecucion sin
cambios, rollback repetido.
Fallo declarado: version invalida, escritura concurrente, conflicto persistente,
falta de UUID, diario compartido e interrupcion del diario.
artifacts/m07-migration.json registra fases, conteos, hashes y resultados.
artifacts/m07-verify.json registra pruebas, SHA y escaneo.
evidence/m07-compatible-evolution.json es el manifiesto; *-local.json es la
evidencia ejecutada. Actions y los adjuntos de entrega identifican el SHA final.
Un reporte versionado puede identificar la revision previa que se verifico
antes de agregar el reporte. No se inventa un hash autorreferencial.
Los tiempos corresponden a seis fixtures; no son rendimiento de produccion.
make run repite el experimento con otros IDs/tiempos; cada reporte es una corrida.

## Autoria
Francesco: contrato, vistas, fixtures y pruebas (9afb363, 869c8e1, 5a9b9d4).
Jonathan / Radh117: migracion, diario, CLI y rollback (c4fc703).
Eddi: revision de limites, conflictos persistentes, aislamiento, prueba
integral con migrador real, compatibilidad de entorno M06, evidencia y cierre.
Se conserva historia, pruebas y tags anteriores.
