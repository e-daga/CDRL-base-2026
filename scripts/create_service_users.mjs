import pg from "pg";
import { withClient } from "../src/db.mjs";
import { databaseConfig, serviceRoles } from "../src/config.mjs";

await withClient(async (client) => {
  await client.query("BEGIN");
  try {
    for (const role of serviceRoles) {
      const { user, password } = databaseConfig(role);
      const identifier = pg.escapeIdentifier(user);
      const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
      if (!existing.rowCount) await client.query(`CREATE ROLE ${identifier}`);
      const memberships = await client.query(`
        SELECT parent.rolname FROM pg_auth_members m
        JOIN pg_roles parent ON parent.oid = m.roleid
        JOIN pg_roles member ON member.oid = m.member
        WHERE member.rolname = $1
      `, [user]);
      for (const membership of memberships.rows) {
        if (membership.rolname !== `role_${role}`) {
          throw new Error("La cuenta tiene membresias inesperadas.");
        }
      }
      // Role/password statements need SQL literals; quote with pg and never print the SQL.
      await client.query(`ALTER ROLE ${identifier} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
      await client.query(`GRANT role_${role} TO ${identifier}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`No se pudieron configurar las cuentas de servicio (SQLSTATE ${error.code || "local"}).`);
  }
}, "bootstrap");
console.log("Cuatro cuentas de servicio configuradas con roles separados.");
