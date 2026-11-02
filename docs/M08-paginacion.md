# M08 - Paginacion por cursor e indices (Francesco)

Objetivo: recorrer los eventos de un dispositivo por paginas sin `skip`, con un orden estable, sin repetir ni perder eventos, y con un indice que resuelva el filtro y el orden. La funcion anterior (`findEventsByDevice`) no cambia.

## Funcion

`findEventsPage(db, opciones)` en `src/mongo.mjs`.

| Parametro | Tipo | Default | Descripcion |
| --- | --- | --- | --- |
| `deviceId` | string `dev_...` | obligatorio | Dispositivo. |
| `from` | fecha o texto ISO | sin limite | `observed_at >= from`. |
| `to` | fecha o texto ISO | sin limite | `observed_at <= to`. |
| `cursor` | string o `null` | `null` | `next_cursor` de la pagina anterior. Sin cursor empieza en la primera pagina. |
| `limit` | entero 1-100 | `50` | Tamano de pagina (misma regla que M05). |
| `shape` | `"current"` o `"legacy"` | `"current"` | Forma de cada evento (vistas de M06/M07). |
| `collection` | string | `"events"` | Solo para fixtures aislados en pruebas. |

### Respuesta

```json
{
  "items": [ { "event_id": "...", "observed_at": "Date", "...": "..." } ],
  "next_cursor": "eyJ2IjoxLCJhdCI6...",
  "has_more": true,
  "limit": 3
}
```

- `items`: hasta `limit` eventos, con la misma forma que devuelve `findEventsByDevice` (`toEventView` o `toLegacyEventView`).
- `has_more`: `true` si hay al menos otro evento despues. Se calcula pidiendo `limit + 1` filas, sin contar la coleccion.
- `next_cursor`: texto para pedir la siguiente pagina. Es `null` cuando `has_more` es `false`: la ultima pagina nunca deja una pagina vacia extra.
- Sin resultados (coleccion vacia o dispositivo sin eventos): `{ items: [], next_cursor: null, has_more: false, limit }`.

### Errores

Lanza `Error` (no devuelve una pagina vacia) cuando:

- `cursor invalido: ...`: texto vacio o que no es string, no es base64url de JSON, version desconocida, fecha o `event_id` mal formados, o un cursor de **otra consulta** (otro `deviceId`, `from` o `to`).
- `limit debe ser entero entre 1 y 100.`, `deviceId invalido.`, `Rango temporal invalido.`, `Rango temporal invertido.` y `shape invalido`, igual que en la consulta anterior.

## Orden estable

`{ observed_at: -1, event_id: -1 }`: primero lo mas reciente y, con la misma fecha, el `event_id` mayor. `event_id` es unico (`uq_events_event_id`), asi que no hay dos filas con la misma posicion y el orden no depende de como MongoDB guarde los empates.

## Cursor

El cursor es `base64url` de `{ v: 1, at: <observed_at ISO>, id: <event_id>, q: <huella de los filtros> }` de la ultima fila entregada. Para el cliente es opaco: solo lo devuelve tal cual.

La siguiente pagina pide lo que esta **despues** de esa posicion:

```js
{ device_id, observed_at: { $gte: from, $lte: at },
  $or: [ { observed_at: { $lt: at } }, { event_id: { $lt: id } } ] }
```

El tope `$lte: at` va en el rango para que el indice **empiece en el cursor** y no recorra las paginas anteriores. El `$or` solo descarta los empates ya entregados. `q` es una huella (SHA-256 recortada) de `deviceId`, `from` y `to`: un cursor no se puede usar con otros filtros.

## Indice

`mongo/init.js` crea:

```js
dbc.events.createIndex({ device_id: 1, observed_at: -1, event_id: -1 }, { name: "idx_events_device_observed_id" });
```

- Igualdad en `device_id`, rango en `observed_at` y el mismo orden que la consulta, con `event_id` como desempate: MongoDB lee el indice en orden y **no ordena en memoria** (no hay etapa `SORT`).
- Se conservan los indices anteriores. `idx_events_device_observed` sigue existiendo y la consulta Q1 de M05 lo sigue usando; la prueba de M05 que lo exige pasa.
- `init.js` es repetible: en un volumen existente, `make setup` agrega el indice sin borrar datos.

Comprobado con `explain("executionStats")` sobre el fixture (prueba `[M08][normal] ... usa el indice declarado`):

| Pagina (limit 3, se piden 4) | Plan | Claves revisadas | Documentos revisados |
| --- | --- | --- | --- |
| 1 (sin cursor) | `IXSCAN idx_events_device_observed_id` -> `FETCH` -> `LIMIT` | 4 | 4 |
| 2 y 3 (con cursor) | igual | hasta 5 | hasta 5 |

Con cursor se revisa una fila mas: la del cursor, que se descarta. Ese costo **no crece con el numero de pagina**, a diferencia de `skip`, que recorre todo lo anterior. Antes de poner el tope `$lte: at`, la pagina 2 revisaba 7 documentos (todo desde el inicio), y la prueba lo detecto.

La medicion con volumen y la comparacion contra `skip` son el benchmark de Jonathan. Estas cifras son de 8 eventos sinteticos.

## Inserciones durante el recorrido

No hay vista congelada: cada pagina se lee del estado actual de la coleccion. Lo que se garantiza para un recorrido que avanza con `next_cursor`:

- **Los eventos que ya existian no se repiten ni se pierden**, aunque se inserte entre paginas. Como el cursor es una posicion en el orden y no un numero de filas, insertar no desplaza nada.
- **Un evento nuevo aparece en este mismo recorrido solo si queda despues del cursor:** `observed_at` anterior a la ultima fila entregada, o la misma fecha con un `event_id` menor. Por ejemplo, una lectura atrasada que llega tarde.
- **Un evento nuevo que queda antes del cursor** (mas reciente, o la misma fecha con un `event_id` mayor) **no aparece en este recorrido**. Se ve al empezar de nuevo desde la primera pagina.
- Si se borra un evento que todavia no se entrego, simplemente no aparece. Los demas no se mueven.

Lo cubre la prueba `[M08][boundary] insertar entre paginas ...`, que inserta los cuatro casos despues de la primera pagina.

## Pruebas (`tests/m08-paginacion.test.mjs`)

Fixture sintetico `tests/fixtures/m08/events-pages.json`: 7 eventos de `dev_m08_a` (tres con la misma fecha, v1 y v2 mezclados) y 1 de `dev_m08_b`. Se cargan en una coleccion aislada (`m08_pagination_fixture`) con el validador y los indices reales de `events`, y se borra al final.

- **normal:** recorrido completo con `limit` 3 (paginas de 3, 3 y 1, en orden, sin repetidos, sin mezclar otro dispositivo, misma forma que la consulta anterior). Plan con el indice declarado, sin `SORT` y con costo fijo por pagina.
- **boundary:** empates de fecha partidos entre paginas (`limit` 2 y 1); coleccion vacia y dispositivo sin eventos; ultima pagina exacta (`limit` 7 y 6) sin pagina vacia extra; inserciones entre paginas.
- **declared failure:** 7 cursores invalidos (vacio, no texto, no base64 de JSON, version desconocida, fecha o id mal formados, cursor alterado); cursor usado con otro `deviceId` o con otro `from`; `limit` 0 y 101. Ninguno cambia datos.

## Para Jonathan: como invocarla

```js
import { withMongo, findEventsPage, eventsPageQuery, explainQuery } from "../src/mongo.mjs";

await withMongo(async (db) => {
  let cursor = null;
  do {
    const page = await findEventsPage(db, { deviceId: "dev_sensor_01", from: "2026-09-20", to: "2026-09-23", limit: 50, cursor });
    // page.items, page.has_more
    cursor = page.next_cursor;
  } while (cursor);
});
```

- Para medir sin ejecutar la pagina: `const { filter, sort } = eventsPageQuery({ deviceId, from, to, cursor })` y despues `explainQuery(db, "events", filter, sort, limit + 1)`. Es exactamente la consulta que usa `findEventsPage`.
- El cursor se pasa tal cual. No hay que construirlo ni modificarlo, y solo sirve con los mismos `deviceId`, `from` y `to`.
- Para comparar contra la version anterior: `findEventsByDevice` sigue igual (sin cursor, `sort({ observed_at: -1 })`, indice `idx_events_device_observed`).

## Limites

- Solo pagina eventos por dispositivo y rango de fechas. Las alertas y otros filtros (`event_type`) no tienen cursor.
- El cursor no esta firmado. Alguien puede fabricar uno valido para la **misma** consulta y saltar a otra posicion, pero solo ve datos que ya podia consultar. No es un mecanismo de seguridad.
- No se puede ir hacia atras. Para volver, el cliente guarda los cursores que ya uso.
- Los empates en `observed_at` se ordenan por `event_id`, que es un UUID: no indica que evento ocurrio antes.
- Las cifras de `explain` son de un fixture de 8 eventos. Escala y tiempos quedan para el benchmark.
- No se modificaron `verify.mjs`, el workflow ni los scripts generales, y no se creo el tag: es la integracion de la entrega.
