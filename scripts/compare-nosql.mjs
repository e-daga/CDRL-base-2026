import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildM04Report } from "../src/m04-decision.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(rootDir, "docs", "m04-nosql-matrix.json");
const outputPath = path.join(rootDir, "artifacts", "m04-comparison.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
let report;
try {
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  report = buildM04Report(matrix);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  fs.writeFileSync(outputPath, JSON.stringify({ assignmentId: "m04-nosql-decision", status: "failed", error: error.message }, null, 2) + "\n");
  throw error;
}
const comparison = report.comparison;
console.log(`Comparacion M04 generada: ${path.relative(rootDir, outputPath)}`);
for (const item of comparison.clasificacion) {
  console.log(`${item.puesto}. ${item.nombre}: ${item.resultadoSobre100}/100`);
}
if (comparison.empates.length > 0) {
  console.log(`Empates: ${comparison.empates.map((group) => group.alternativas.map((item) => item.nombre).join(" = ")).join("; ")}`);
} else {
  console.log("Empates: ninguno");
}
