const dbc = db.getSiblingDB("cdrl");
const user = process.env.M09_TEST_USER;
const password = process.env.M09_TEST_PASSWORD;
const role = process.env.M09_TEST_ROLE;
const collection = process.env.M09_TEST_COLLECTION;
const mode = process.env.M09_TEST_MODE;

if (!user || !password || !role || !collection) {
  throw new Error("Faltan identificadores de la prueba temporal de permisos.");
}

if (mode === "setup") {
  dbc.createRole({
    role,
    privileges: [{
      resource: { db: "cdrl", collection },
      actions: ["find", "insert", "remove"]
    }],
    roles: []
  });
  dbc.createUser({ user, pwd: password, roles: [{ role, db: "cdrl" }] });
  dbc.createCollection(collection);
} else if (mode === "revoke") {
  dbc.updateRole(role, {
    privileges: [{
      resource: { db: "cdrl", collection },
      actions: ["find", "insert"]
    }],
    roles: []
  });
} else if (mode === "cleanup") {
  if (dbc.getCollectionNames().includes(collection)) dbc.getCollection(collection).drop();
  if (dbc.getUser(user)) dbc.dropUser(user);
  if (dbc.getRole(role)) dbc.dropRole(role);
} else {
  throw new Error("Modo inválido para la prueba temporal de permisos.");
}
