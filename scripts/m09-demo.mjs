import fs from "node:fs";
import { collectM09 } from "../src/m09-report.mjs";
const file = new URL("../artifacts/m09-security.json", import.meta.url);
try {
  const report = await collectM09();
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log("M09: cuatro cuentas, seis rechazos Unauthorized, tres registros auditados y remediacion real.");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fs.writeFileSync(file, JSON.stringify({ status: "failed", generatedAt: new Date().toISOString(), error: "No se completo la demostracion M09; no se exportan errores de conexion." }, null, 2) + "\n");
  throw new Error("Fallo la demostracion M09.");
}
