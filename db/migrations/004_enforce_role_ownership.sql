-- Bootstrap administrativo: conservar 001-003 y transferir la propiedad al migrador.
ALTER ROLE role_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE role_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE role_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE role_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO role_migrator;
GRANT USAGE ON SCHEMA public TO role_writer, role_reader, role_operator;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO role_migrator, role_writer, role_reader, role_operator', current_database());
END
$$;

ALTER TABLE schema_migrations OWNER TO role_migrator;
ALTER TABLE devices OWNER TO role_migrator;
ALTER TABLE telemetry_events OWNER TO role_migrator;
ALTER TABLE device_status OWNER TO role_migrator;
ALTER TABLE telemetry_alerts OWNER TO role_migrator;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, role_writer, role_reader, role_operator;
GRANT INSERT ON devices, telemetry_events TO role_writer;
GRANT SELECT, INSERT, UPDATE ON device_status TO role_writer;
GRANT SELECT ON devices, telemetry_events, device_status, telemetry_alerts TO role_reader;
GRANT SELECT, INSERT, UPDATE ON telemetry_alerts TO role_operator;

ALTER DEFAULT PRIVILEGES FOR ROLE role_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE role_migrator IN SCHEMA public GRANT SELECT ON TABLES TO role_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE role_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
