import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const compose = (...args) => run("docker", ["compose", "--profile", "mongo", ...args]);
const shell = 'exec mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';
const script = (file) => compose("exec", "-T", "mongo", "sh", "-c", `${shell} ${file}`);

function ensureEnv() {
  if (!fs.existsSync(".env")) run("node", ["scripts/prepare-env.mjs"]);
  let text = fs.readFileSync(".env", "utf8");
  const add = [];
  if (!/^MONGO_USER=/m.test(text)) add.push("MONGO_USER=cdrl_mongo");
  if (!/^MONGO_PORT=/m.test(text)) add.push("MONGO_PORT=27017");
  if (!/^MONGO_APP_USER=/m.test(text)) add.push("MONGO_APP_USER=cdrl_app");
  for (const name of ["MONGO_PASSWORD", "MONGO_APP_PASSWORD"]) {
    const pattern = new RegExp(`^${name}=.*$`, "m");
    if (!process.env[name] && !text.match(pattern)?.[0].split("=")[1]?.trim()) {
      text = text.replace(pattern, "");
      add.push(`${name}=${crypto.randomBytes(32).toString("hex")}`);
    }
  }
  if (add.length) {
    fs.writeFileSync(".env", text + (text.endsWith("\n") ? "" : "\n") + add.join("\n") + "\n");
    console.log("Variables MONGO_* agregadas a .env (secretos no impresos).");
  }
}

const cmd = process.argv[2] || "up";
if (cmd === "up") {
  ensureEnv();
  compose("up", "-d", "--wait", "mongo");
  script("/mongo/init.js");
  script("/mongo/seed.js");
} else if (cmd === "init") script("/mongo/init.js");
else if (cmd === "seed") script("/mongo/seed.js");
else if (cmd === "down") compose("stop", "mongo");
else { console.error("Uso: node scripts/mongo.mjs [up|init|seed|down]"); process.exit(1); }
