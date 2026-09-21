import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rootDir } from "../src/config.mjs";

const image = "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim();

export function scanSecrets() {
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("Se requiere historial completo: git fetch --unshallow (CI usa fetch-depth: 0).");
  }
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const forbidden = files.filter((file) => /(^|\/)(\.env($|\.)|[^/]+\.(pem|key|p12|pfx)$)/i.test(file) && file !== ".env.example");
  if (forbidden.length) throw new Error("Archivos de secretos en Git: " + forbidden.join(", "));
  const parent = path.join(rootDir, ".local");
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, "secret-scan-"));
  try {
    for (const file of files) {
      const source = path.resolve(rootDir, file);
      if (!source.startsWith(rootDir + path.sep)) throw new Error("Ruta fuera del repositorio.");
      if (!fs.existsSync(source)) continue;
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error("El escaneo requiere archivos regulares, sin enlaces simbolicos.");
      const target = path.join(temp, "files", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    execFileSync("git", ["bundle", "create", path.join(temp, "history.bundle"), "--all"], { cwd: rootDir, stdio: "pipe" });
    fs.writeFileSync(path.join(temp, "default.toml"), '[extend]\nuseDefault = true\n');
    fs.mkdirSync(path.join(temp, "canary"));
    // Synthetic throwaway secret proves the detector fails when a secret is introduced.
    fs.writeFileSync(path.join(temp, "canary/probe.txt"), "api_key = " + crypto.randomBytes(32).toString("hex") + "\n");
    const flags = "--config /scan/default.toml --gitleaks-ignore-path /nonexistent --ignore-gitleaks-allow --redact=100 --no-banner --log-level error --report-format json";
    const command = [
      "git clone --quiet --mirror /scan/history.bundle /tmp/history || exit 2",
      `gitleaks git /tmp/history --log-opts=--all ${flags} --report-path /scan/history.json; history_status=$?`,
      `gitleaks dir /scan/files ${flags} --report-path /scan/files.json; files_status=$?`,
      `gitleaks dir /scan/canary ${flags} --report-path /scan/canary.json; canary_status=$?`,
      '[ "$history_status" -eq 0 ] && [ "$files_status" -eq 0 ] && [ "$canary_status" -eq 1 ]'
    ].join("\n");
    const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", "-v", `${temp}:/scan`, image, "-c", command],
      { cwd: rootDir, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    const read = (file) => fs.existsSync(path.join(temp, file)) ? JSON.parse(fs.readFileSync(path.join(temp, file), "utf8")) : null;
    const history = read("history.json");
    const current = read("files.json");
    const canary = read("canary.json");
    const findings = [...(history || []), ...(current || [])].map((finding) => ({
      rule: finding.RuleID, file: finding.File, line: finding.StartLine, commit: finding.Commit || null
    }));
    const passed = result.status === 0 && history !== null && current !== null && history.length === 0 && current.length === 0 && canary?.length > 0;
    const report = {
      status: passed ? "passed" : "failed", tool: "gitleaks", version: "8.30.1", image,
      scope: ["all Git refs and complete reachable history", "tracked and non-ignored new files"],
      commitsScanned: Number(git("rev-list", "--all", "--count")), filesScanned: files.length,
      findings, detectionSelfTest: canary?.length > 0 ? "passed" : "failed",
      limitations: "Pattern-based scanning cannot guarantee absence of every possible secret."
    };
    fs.mkdirSync(path.join(rootDir, "artifacts"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "artifacts/m03-secrets.json"), JSON.stringify(report, null, 2) + "\n");
    if (!passed) throw new Error("El escaneo de secretos fallo. Revisar artifacts/m03-secrets.json (sin valores secretos).");
    console.log(`Secretos: 0 hallazgos; ${report.commitsScanned} commits revisados; detector probado con fixture temporal.`);
    return report;
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith("secret-scan-")) {
      throw new Error("Ruta temporal inesperada; no se elimina.");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) scanSecrets();
