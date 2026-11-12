import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/http-api.mjs";

async function serve(t, options) {
  const server = createApi(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
test("[HTTP] GET health y HEAD usan MongoDB real con reader", async t => {
  const base = await serve(t);
  for (const method of ["GET", "HEAD"]) {
    const r = await fetch(base + "/health", { method });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    if (method === "HEAD") assert.equal(await r.text(), "");
    else assert.equal((await r.json()).database, "reachable");
  }
});
test("[HTTP] consultas reales, detalle y paginacion", async t => {
  const base = await serve(t);
  const response = await fetch(base + "/api/events?deviceId=dev_sensor_01&limit=1");
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.items.length, 1);
  const detail = await fetch(base + "/api/events/" + page.items[0].event_id);
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), page.items[0]);
  if (page.next_cursor) {
    const next = await fetch(base + "/api/events?deviceId=dev_sensor_01&limit=1&cursor=" + page.next_cursor);
    assert.equal(next.status, 200);
    assert.ok((await next.json()).items.every(x => x.event_id !== page.items[0].event_id));
  }
  const alerts = await fetch(base + "/api/alerts?limit=1");
  assert.equal(alerts.status, 200);
  assert.ok((await alerts.json()).items.every(x => x.status === "open"));
});
test("[HTTP] limites 1 y 100; consulta vacia es 200, identificador ausente es 404", async t => {
  const base = await serve(t);
  for (const limit of [1, 100]) {
    const r = await fetch(base + `/api/events?deviceId=dev_http_no_records&limit=${limit}`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).items, []);
  }
  const r = await fetch(base + "/api/events/00000000-0000-0000-0000-000000000000");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "event_not_found");
});
test("[HTTP] parametros invalidos o ambiguos devuelven 400 antes de consultar", async t => {
  const base = await serve(t, { read: () => { throw new Error("No debe acceder a la base"); } });
  for (const path of ["/api/events", "/api/events/invalid", "/health?extra=1", "/api/alerts?severity=wrong", "/api/alerts?limit=0", "/api/alerts?limit=101", "/api/alerts?limit=1&limit=2", "/api/events?deviceId=dev_sensor_01&cursor=bad", "/api/events?deviceId=dev_sensor_01&from=2030&to=2020"]) {
    assert.equal((await fetch(base + path)).status, 400, path);
  }
});
test("[HTTP] rechaza escrituras y distingue ruta inexistente", async t => {
  const base = await serve(t, { read: () => { throw new Error("No debe acceder a la base"); } });
  for (const path of ["/health", "/api/events", "/api/events/00000000-0000-0000-0000-000000000000", "/api/alerts"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await fetch(base + path, { method });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get("allow"), "GET, HEAD");
    }
  }
  assert.equal((await fetch(base + "/unknown")).status, 404);
});
test("[HTTP] fallos controlados 503 y 500 no filtran detalles internos", async t => {
  for (const [name, status] of [["MongoServerSelectionError", 503], ["Error", 500]]) {
    const base = await serve(t, { read: () => { const e = new Error("PRIVATE_DRIVER_DETAIL"); e.name = name; throw e; } });
    const r = await fetch(base + "/health");
    assert.equal(r.status, status);
    assert.ok(!(await r.text()).includes("PRIVATE_DRIVER_DETAIL"));
    if (status === 503) assert.equal(r.headers.get("retry-after"), "5");
  }
});
