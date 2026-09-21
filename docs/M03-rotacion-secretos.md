# Rotacion y respuesta ante secretos expuestos

## Variables y almacenamiento

Bootstrap usa POSTGRES_PASSWORD. Cada servicio usa su propia variable:
MIGRATOR_PASSWORD, WRITER_PASSWORD, READER_PASSWORD y OPERATOR_PASSWORD.
Los nombres de usuario tienen variables equivalentes terminadas en _USER.
No se usan URLs de conexion. La configuracion separa host, puerto, base, usuario y secreto.

En Docker local, make setup crea cinco contrasenas aleatorias de 32 bytes en
.env, con permisos 0600 en sistemas POSIX. .env y .env.* estan ignorados por Git;
.env.example contiene solo nombres y valores no sensibles. En Windows restringir
el acceso al archivo con las ACL de la cuenta local. No compartir .env por chat,
capturas, Classroom o commits. No ejecutar docker compose config sin --quiet
para crear evidencia porque puede mostrar los valores expandidos.

En cloud, el responsable del entorno entrega las variables mediante un gestor
de secretos o inyeccion del proceso. Usar CDRL_DATABASE_MODE=external,
POSTGRES_SSL=true y, si corresponde, POSTGRES_SSL_CA_FILE con el certificado
publico de la autoridad. No se admite desactivar la validacion TLS.
No ejecutar Docker para la base external; el escaner Gitleaks si requiere Docker.
El administrador debe tener permisos para administrar roles y transferir
propiedad. AWS Learner Lab no se ha validado; comprobar sus restricciones antes
de aprovisionar recursos.

## Rotacion local reproducible

1. Detener temporalmente el consumidor de la cuenta que se va a rotar.
2. Desde la raiz del proyecto ejecutar, por ejemplo:

   ```sh
   npm run rotate:secret -- writer
   ```

   Tambien acepta reader, operator y migrator. El programa genera una nueva
   contrasena, prepara un archivo local protegido, cambia la credencial de
   PostgreSQL, termina las sesiones anteriores de esa cuenta y actualiza .env.
   No imprime contrasenas ni las recibe por argumentos de la consola.
3. El mismo programa abre una conexion con la nueva credencial y comprueba que
   la anterior falla con SQLSTATE 28P01. Si no se cumplen ambas condiciones,
   termina con error.
4. Reiniciar el consumidor para que vuelva a cargar .env. Eliminar variables
   antiguas exportadas en la terminal, pues tienen prioridad sobre .env.
5. Ejecutar make verify y make run para registrar el resultado sin secretos.

Una interrupcion excepcional entre el cambio de PostgreSQL y la sustitucion
de .env deja .env.rotation con la credencial nueva. Conservarlo protegido,
comprobar la conexion y completar la sustitucion; no repetir un setup con
variables antiguas, ya que la configuracion del entorno es la fuente de verdad.

La prueba automatica usa una cuenta efimera: comprueba la conexion nueva, el
rechazo de la vieja y la terminacion de una sesion ya abierta. La elimina al
terminar y nunca guarda sus contrasenas en Git.

## Rotacion en cloud

1. Coordinar una ventana de mantenimiento para el consumidor afectado.
2. Crear una version pendiente del secreto en el gestor del entorno.
3. Inyectar esa version como CDRL_NEXT_PASSWORD (minimo 24 caracteres) en un
   proceso administrativo protegido. Conservar la version anterior solo para
   recuperacion controlada mientras se verifica el cambio.
4. Ejecutar npm run rotate:secret -- seguido del rol. En modo external usa
   CDRL_NEXT_PASSWORD, cambia PostgreSQL, termina sesiones y verifica ambas
   credenciales; no escribe el secreto en archivos locales.
5. Promover la nueva version del secreto a la variable ROLE_PASSWORD del
   consumidor, reiniciarlo y verificar su operacion permitida.
6. Retirar la version anterior segun la politica del gestor, retirar
   CDRL_NEXT_PASSWORD del proceso administrativo y registrar solo fecha, rol,
   responsable y resultado. La contrasena anterior ya no autentica en PostgreSQL.

La credencial bootstrap es administrativa. Rotarla mediante el procedimiento del
proveedor o ALTER ROLE desde otra cuenta administrativa autorizada y actualizar
POSTGRES_PASSWORD en el gestor. Reiniciar una instancia con otro valor de
POSTGRES_PASSWORD no cambia por si solo la contrasena de un volumen existente.

## Si aparece un secreto en Git

Revocarlo o rotarlo primero. Avisar al equipo y revisar accesos. Eliminarlo en
un commit nuevo y repetir el escaneo. No usar force push, reescritura de
historia ni cambiar tags de entrega. Si hubo una filtracion real en un commit
antiguo, informar al profesor: un commit posterior no borra la exposicion.

Los valores publicos de desarrollo usados en M01/M02 se mantienen en el
historial original por trazabilidad. M03 elimina esos valores predeterminados
y genera credenciales nuevas; no se declaran como credenciales privadas
filtradas ni se oculta ese antecedente.
