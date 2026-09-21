import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";

const files = fs.readdirSync(path.join(rootDir, "tests")).filter((file) => file.endsWith(".test.mjs")).sort().map((file) => path.join("tests", file));
if (!files.length) throw new Error("No hay pruebas para ejecutar.");
const options = process.argv.includes("--report") ? ["--test-reporter=./scripts/test-reporter.mjs"] : [];
const result = spawnSync(process.execPath, ["--test", ...options, ...files], { cwd: rootDir, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
