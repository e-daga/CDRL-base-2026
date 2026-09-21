import fs from "node:fs";
import path from "node:path";
import { rootDir } from "../src/config.mjs";

export default async function* reporter(events) {
  const cases = [];
  for await (const event of events) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      const data = event.data;
      if (data.details?.type === "suite") continue;
      const status = data.skip ? "skipped" : data.todo ? "todo" : event.type === "test:pass" ? "passed" : "failed";
      cases.push({ name: data.name, status, file: data.file ? path.relative(rootDir, data.file).replaceAll("\\", "/") : null });
      yield `${status === "passed" ? "PASS" : status.toUpperCase()} ${data.name}\n`;
      if (status === "failed") yield `  ${data.details?.error?.message || "Prueba fallida"}\n`;
    }
  }
  const result = {
    total: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    skipped: cases.filter((item) => item.status === "skipped").length,
    todo: cases.filter((item) => item.status === "todo").length,
    cases
  };
  fs.mkdirSync(path.join(rootDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "artifacts/m03-tests.json"), JSON.stringify(result, null, 2) + "\n");
  yield `Pruebas: ${result.total}; pass: ${result.passed}; fail: ${result.failed}; skipped: ${result.skipped}; todo: ${result.todo}\n`;
}
