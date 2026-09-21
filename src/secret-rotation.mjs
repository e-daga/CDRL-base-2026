import pg from "pg";

export async function rotateDatabasePassword(admin, user, newPassword) {
  if (!newPassword || newPassword.length < 24) throw new Error("La nueva contrasena debe tener al menos 24 caracteres.");
  try {
    await admin.query(`ALTER ROLE ${pg.escapeIdentifier(user)} PASSWORD ${pg.escapeLiteral(newPassword)}`);
    await admin.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE usename = $1 AND pid <> pg_backend_pid()
    `, [user]);
  } catch (error) {
    throw new Error(`Fallo al rotar credencial (SQLSTATE ${error.code || "local"}).`);
  }
}
