import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootDir } from "../src/config.mjs";
import { withMongo, findEventsPage, findEventsByDevice, eventsPageQuery, explainQuery } from "../src/mongo.mjs";
import { summarizeExplain } from "../src/m05-report.mjs";

// Coleccion aislada con el validador y los indices reales de events: no toca
// los eventos ni las alertas de la aplicacion.
const FIXTURE = `m08_pagination_${randomUUID().replaceAll("-", "")}`;
let fixtureCreated = false;
const PAGE_INDEX = "idx_events_device_observed_id";
const fixtureEvents = () => JSON.parse(fs.readFileSync(path.join(rootDir, "tests", "fixtures", "m08", "events-pages.json"), "utf8"))
  .map((doc) => ({ ...doc, observed_at: new Date(doc.observed_at), ingested_at: new Date(doc.ingested_at) }));
const id = (n) => `e8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const query = { deviceId: "dev_m08_a", from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z", collection: FIXTURE };
// Orden esperado: observed_at desc y, con la misma fecha, event_id desc.
const ORDER = [7, 6, 5, 4, 3, 2, 1].map(id);

const event = (eventId, observedAt) => ({
  event_id: eventId, device_id: "dev_m08_a", event_type: "temperature_c",
  observed_at: new Date(observedAt), ingested_at: new Date(observedAt), metric_value: 20,
  unit: "C", severity: "info", source: "synthetic-m08", payload: {}
});
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function walk(db, params) {
  const pages = [];
  let cursor;
  do {
    const page = await findEventsPage(db, { ...query, ...params, cursor });
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor);
  return pages;
}
const ids = (pages) => pages.flatMap((page) => page.items.map((item) => item.event_id));

before(async () => {
  execFileSync(process.execPath, ["scripts/mongo.mjs", "up"], { cwd: rootDir, stdio: "inherit" });
  await withMongo(async (db) => {
    const [events] = await db.listCollections({ name: "events" }).toArray();
    await db.createCollection(FIXTURE, { validator: events.options.validator, validationLevel: "strict", validationAction: "error" });
    fixtureCreated = true;
    for (const index of await db.collection("events").listIndexes().toArray()) {
      if (index.name !== "_id_") await db.collection(FIXTURE).createIndex(index.key, { name: index.name, unique: index.unique ?? false });
    }
  });
});

after(async () => {
  if (fixtureCreated) await withMongo((db) => db.collection(FIXTURE).drop());
});

async function resetFixture(db) {
  await db.collection(FIXTURE).deleteMany({});
  await db.collection(FIXTURE).insertMany(fixtureEvents());
}

test("[M08][normal] el recorrido por cursor entrega todo en orden estable, sin repetir ni perder", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const pages = await walk(db, { limit: 3 });
    assert.deepEqual(pages.map((page) => page.items.length), [3, 3, 1]);
    assert.deepEqual(ids(pages), ORDER);
    assert.deepEqual(pages.map((page) => page.has_more), [true, true, false]);
    assert.equal(pages.at(-1).next_cursor, null);
    assert.ok(pages.every((page) => page.limit === 3));
    assert.ok(!ids(pages).includes(id(8)), "no mezcla otro dispositivo");
    // Compatibilidad: la primera pagina trae los mismos eventos que la consulta anterior.
    const previous = await findEventsByDevice(db, { ...query, limit: 50 });
    const first = await findEventsPage(db, { ...query, limit: 50 });
    assert.deepEqual(first.items.map((item) => item.observed_at), previous.map((item) => item.observed_at));
    assert.deepEqual(new Set(first.items.map((item) => item.event_id)), new Set(previous.map((item) => item.event_id)));
    assert.deepEqual(Object.keys(first.items[0]).sort(), Object.keys(previous[0]).sort(), "misma forma de cada evento");
  });
});

test("[M08][normal] la pagina con cursor usa el indice declarado y no ordena en memoria", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const indexes = await db.collection("events").listIndexes().toArray();
    assert.ok(indexes.some((index) => index.name === PAGE_INDEX), "init.js crea el indice en events");
    const pages = await walk(db, { limit: 3 });
    const cursors = [undefined, ...pages.slice(0, -1).map((page) => page.next_cursor)];
    for (const [n, cursor] of cursors.entries()) {
      const { filter, sort } = eventsPageQuery({ ...query, cursor });
      const plan = summarizeExplain(await explainQuery(db, FIXTURE, filter, sort, 4));
      assert.ok(plan.indexes.includes(PAGE_INDEX), `plan sin ${PAGE_INDEX}: ${plan.indexes}`);
      assert.ok(!plan.stages.includes("SORT"), `ordena en memoria: ${plan.stages}`);
      // limit+1 filas y, con cursor, la fila del cursor que se descarta: no crece con la pagina (no es un skip).
      const budget = 4 + (cursor ? 1 : 0);
      assert.ok(plan.totalDocsExamined <= budget, `pagina ${n + 1}: revisa ${plan.totalDocsExamined} documentos (maximo ${budget})`);
    }
  });
});

test("[M08][boundary] eventos con la misma fecha se desempatan por event_id aunque crucen paginas", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const pages = await walk(db, { limit: 2 });
    assert.deepEqual(pages.map((page) => page.items.map((item) => item.event_id)), [[id(7), id(6)], [id(5), id(4)], [id(3), id(2)], [id(1)]]);
    // Las mismas tres fechas iguales con otro tamano de pagina dan el mismo orden.
    assert.deepEqual(ids(await walk(db, { limit: 1 })), ORDER);
  });
});

test("[M08][boundary] coleccion vacia y dispositivo sin eventos devuelven una pagina vacia y final", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const none = await findEventsPage(db, { ...query, deviceId: "dev_m08_sin_eventos", limit: 3 });
    assert.deepEqual(none, { items: [], next_cursor: null, has_more: false, limit: 3 });
    await db.collection(FIXTURE).deleteMany({});
    assert.deepEqual(await findEventsPage(db, { ...query, limit: 3 }), { items: [], next_cursor: null, has_more: false, limit: 3 });
  });
});

test("[M08][boundary] la ultima pagina exacta no deja una pagina vacia extra", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const exact = await findEventsPage(db, { ...query, limit: 7 });
    assert.equal(exact.items.length, 7);
    assert.equal(exact.has_more, false);
    assert.equal(exact.next_cursor, null);
    const pages = await walk(db, { limit: 6 });
    assert.deepEqual(pages.map((page) => page.items.length), [6, 1]);
  });
});

test("[M08][boundary] insertar entre paginas no repite ni pierde los eventos originales", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const first = await findEventsPage(db, { ...query, limit: 3 });
    assert.deepEqual(first.items.map((item) => item.event_id), [id(7), id(6), id(5)]);
    const inserted = {
      newer: event(id(101), "2026-10-20T13:00:00Z"), // antes del cursor: ya se paso
      tieAfter: event("e8000000-0000-4000-8000-0000000000a1", "2026-10-20T10:00:00Z"), // misma fecha, id mayor que el cursor
      tieBefore: event(id(0), "2026-10-20T10:00:00Z"), // misma fecha, id menor que el cursor
      older: event(id(102), "2026-10-20T08:30:00Z") // despues del cursor
    };
    await db.collection(FIXTURE).insertMany(Object.values(inserted));

    const rest = [];
    for (let cursor = first.next_cursor; cursor;) {
      const page = await findEventsPage(db, { ...query, limit: 3, cursor });
      rest.push(page);
      cursor = page.next_cursor;
    }
    const seen = [...first.items.map((item) => item.event_id), ...ids(rest)];
    for (const original of ORDER) assert.equal(seen.filter((value) => value === original).length, 1, `${original} debe salir una vez`);
    assert.equal(new Set(seen).size, seen.length, "sin repetidos");
    assert.deepEqual(ids(rest), [id(4), id(3), id(0), id(2), id(102), id(1)]);
    assert.ok(!seen.includes(inserted.newer.event_id) && !seen.includes(inserted.tieAfter.event_id), "lo insertado antes de la posicion no aparece en este recorrido");
    // Un recorrido nuevo desde la primera pagina si ve todo lo insertado.
    const again = ids(await walk(db, { limit: 3 }));
    assert.equal(again.length, 11);
    assert.equal(again[0], inserted.newer.event_id);
  });
});

test("[M08][declared failure] un cursor invalido se rechaza con un error claro", async () => {
  await withMongo(async (db) => {
    await resetFixture(db);
    const first = await findEventsPage(db, { ...query, limit: 3 });
    const invalid = {
      "texto vacio": "",
      "no es texto": 123,
      "no es base64 de JSON": "esto-no-es-un-cursor",
      "version desconocida": encode({ v: 2, at: "2026-10-20T10:00:00.000Z", id: id(5), q: "x" }),
      "fecha mal formada": encode({ v: 1, at: "ayer", id: id(5), q: "x" }),
      "event_id mal formado": encode({ v: 1, at: "2026-10-20T10:00:00.000Z", id: "5", q: "x" }),
      "cursor alterado": first.next_cursor.slice(0, -4) + "AAAA"
    };
    for (const [name, cursor] of Object.entries(invalid)) {
      await assert.rejects(findEventsPage(db, { ...query, limit: 3, cursor }), /cursor invalido/, name);
    }
    // Un cursor valido no sirve para otros filtros.
    await assert.rejects(findEventsPage(db, { ...query, deviceId: "dev_m08_b", limit: 3, cursor: first.next_cursor }), /otra consulta/);
    await assert.rejects(findEventsPage(db, { ...query, from: "2026-10-19T00:00:00Z", limit: 3, cursor: first.next_cursor }), /otra consulta/);
    await assert.rejects(findEventsPage(db, { ...query, limit: 0 }), /limit/);
    await assert.rejects(findEventsPage(db, { ...query, limit: 101 }), /limit/);
    assert.equal(await db.collection(FIXTURE).countDocuments(), 8, "los rechazos no cambian datos");
  });
});
