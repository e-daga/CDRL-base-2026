import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { createApi } from "../src/http-api.mjs";

const cases = [];
async function capture(base, id, method, path, expected, mode = "MongoDB real / reader") {
  const response = await fetch(base + path, { method });
  const body = await response.text();
  assert.equal(response.status, expected, id);
  const record = { id, mode, method, url: base + path, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body, capturedAt: new Date().toISOString() };
  cases.push(record);
  console.log(`${id}: ${method} ${path} -> ${response.status} ${response.statusText}`);
  return body ? JSON.parse(body) : null;
}
async function runServer(options, work) {
  const server = createApi(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
await runServer({}, async base => {
  await capture(base, "health", "GET", "/health", 200);
  const page = await capture(base, "events", "GET", "/api/events?deviceId=dev_sensor_01&limit=1", 200);
  assert.equal(page.items.length, 1, "Se necesita el fixture de make setup.");
  await capture(base, "event", "GET", "/api/events/" + page.items[0].event_id, 200);
  await capture(base, "alerts", "GET", "/api/alerts?limit=1", 200);
  for (const [id, path] of [["health", "/health"], ["events", "/api/events?deviceId=dev_sensor_01&limit=1"], ["event", "/api/events/" + page.items[0].event_id], ["alerts", "/api/alerts?limit=1"]]) {
    await capture(base, id + "-head", "HEAD", path, 200);
    await capture(base, id + "-post", "POST", path, 405);
  }
  await capture(base, "invalid", "GET", "/api/events?deviceId=dev_sensor_01&limit=0", 400);
  await capture(base, "absent", "GET", "/api/events/00000000-0000-0000-0000-000000000000", 404);
  await capture(base, "unknown", "GET", "/not-a-route", 404);
  await capture(base, "empty", "GET", "/api/events?deviceId=dev_http_no_records&limit=1", 200);
});
for (const [id, name, status] of [["unavailable", "MongoServerSelectionError", 503], ["internal", "Error", 500]]) {
  await runServer({ read: () => { const error = new Error("Controlled dependency failure"); error.name = name; throw error; } }, base => capture(base, id, "GET", "/health", status, "Fallo inyectado en prueba aislada; no se detuvo MongoDB"));
}
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/semana11-http.json", JSON.stringify({ assignment: "Actividad Semana 11-0", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), capturedAt: new Date().toISOString(), cases }, null, 2) + "\n");
