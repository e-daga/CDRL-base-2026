-- M03: roles de base de datos con privilegios minimos por responsabilidad.
-- No contiene contraseñas ni credenciales. Los usuarios de login (con password)
-- se crean por separado en scripts/create_service_users.mjs, leyendo variables
-- de entorno que nunca se versionan (ver .env.example).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'role_migrator') THEN
    CREATE ROLE role_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'role_writer') THEN
    CREATE ROLE role_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'role_reader') THEN
    CREATE ROLE role_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'role_operator') THEN
    CREATE ROLE role_operator NOLOGIN;
  END IF;
END
$$;

-- migracion: unico rol que puede crear/alterar/eliminar tablas.
-- Se otorga al usuario que aplica esta migracion (normalmente el usuario
-- bootstrap del contenedor de Postgres), sin importar como se llame.
GRANT ALL PRIVILEGES ON SCHEMA public TO role_migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO role_migrator;
GRANT role_migrator TO CURRENT_USER;

-- escritura: el pipeline de ingesta agrega telemetria cruda (solo INSERT) y
-- reporta el heartbeat/estado de cada dispositivo con un upsert
-- (INSERT ... ON CONFLICT DO UPDATE). Ese patron necesita SELECT ademas de
-- INSERT/UPDATE porque Postgres debe leer la fila en conflicto para
-- resolverlo; por eso device_status lleva los tres, acotados a esa tabla.
-- Nunca toca telemetry_alerts: el pipeline de ingesta no decide sobre alertas.
GRANT USAGE ON SCHEMA public TO role_writer;
GRANT INSERT ON devices, telemetry_events TO role_writer;
GRANT SELECT, INSERT, UPDATE ON device_status TO role_writer;

-- lectura: solo consultas de solo lectura sobre todo el modelo, para
-- reportes y dashboards. Nunca escribe nada.
GRANT USAGE ON SCHEMA public TO role_reader;
GRANT SELECT ON devices, telemetry_events, device_status, telemetry_alerts TO role_reader;

-- operacion: gestiona el ciclo de vida de una alerta (abrirla, reconocerla,
-- resolverla), sin acceso a la telemetria cruda ni al estado de dispositivos.
GRANT USAGE ON SCHEMA public TO role_operator;
GRANT SELECT, INSERT, UPDATE ON telemetry_alerts TO role_operator;
