# ADR-003 - Roles separados y secretos fuera de Git

## Estado

Propuesto para M03.

## Decision

La base usa cuatro roles sin login, cada uno con una responsabilidad limitada:

- `role_migrator`: aplica cambios de esquema.
- `role_writer`: inserta telemetria y actualiza `device_status`.
- `role_reader`: consulta el modelo sin escribir.
- `role_operator`: gestiona `telemetry_alerts`.

La migracion de roles no contiene contrasenas. Los usuarios de servicio y sus
credenciales se configuraran despues mediante variables de entorno o un gestor
de secretos de AWS Academy Learner Lab. Docker Compose queda como respaldo local.

## Rotacion

Crear una credencial nueva en el gestor del entorno, actualizar la variable de
entorno sin versionarla, reiniciar el servicio y revocar la credencial anterior
tras comprobar la conexion. Los fixtures del repositorio son sinteticos.
