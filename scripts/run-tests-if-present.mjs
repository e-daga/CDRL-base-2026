import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";

const testsDir = path.join(rootDir, "tests");
const testFiles = fs.readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();

if (testFiles.length === 0) {
  console.log("No hay pruebas Node todavia; esta parte queda para el commit de pruebas.");
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...testFiles.map((file) => path.join(testsDir, file))],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
