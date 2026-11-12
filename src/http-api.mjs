import { createServer } from "node:http";
import { withMongoAs } from "./mongo-accounts.mjs";
import { findEventsPage, findOpenAlerts, readEvent, eventsPageQuery, SEVERITIES } from "./mongo.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE = /^dev_[a-z0-9_]+$/;
const pick = (doc, fields) => Object.fromEntries(fields.filter(k => doc[k] !== undefined).map(k => [k, doc[k]]));
const eventView = doc => pick(doc, ["event_id", "device_id", "event_type", "observed_at", "metric_value", "unit", "severity"]);
const alertView = doc => pick(doc, ["alert_id", "event_id", "device_id", "alert_type", "severity", "status", "opened_at"]);
class BadRequest extends Error {}
function params(url, allowed) {
  for (const k of url.searchParams.keys()) {
    if (!allowed.includes(k) || url.searchParams.getAll(k).length !== 1) throw new BadRequest();
  }
  return Object.fromEntries(url.searchParams);
}
function limitOf(value = "20") {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new BadRequest();
  return Number(value);
}

// Local read-only teaching API. No end-user authentication or public deployment.
// The connection always uses M09 reader, never maintenance or root credentials.
export function createApi({ read = work => withMongoAs("reader", work) } = {}) {
  return createServer({ maxHeaderSize: 8192, requestTimeout: 10000 }, async (req, res) => {
    const send = (status, body, extra = {}) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
      res.end(req.method === "HEAD" ? undefined : json);
    };
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const detail = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
      if (!["/health", "/api/events", "/api/alerts"].includes(url.pathname) && !detail) return send(404, { error: "route_not_found" });
      if (!["GET", "HEAD"].includes(req.method)) return send(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      if (url.pathname === "/health") {
        params(url, []);
        await read(db => db.command({ ping: 1 }));
        return send(200, { status: "ok", database: "reachable", mode: "read-only" });
      }
      if (detail) {
        params(url, []);
        if (!UUID.test(detail[1])) throw new BadRequest();
        const doc = await read(db => readEvent(detail[1], { db }));
        return doc ? send(200, eventView(doc)) : send(404, { error: "event_not_found" });
      }
      if (url.pathname === "/api/events") {
        const p = params(url, ["deviceId", "from", "to", "cursor", "limit"]);
        p.limit = limitOf(p.limit);
        try { eventsPageQuery(p); } catch { throw new BadRequest(); }
        const page = await read(db => findEventsPage(db, p));
        return send(200, { ...page, items: page.items.map(eventView) });
      }
      const p = params(url, ["deviceId", "severity", "limit"]);
      p.limit = limitOf(p.limit);
      if ((p.deviceId !== undefined && !DEVICE.test(p.deviceId)) || (p.severity !== undefined && !SEVERITIES.includes(p.severity))) throw new BadRequest();
      const items = await read(db => findOpenAlerts(db, p));
      return send(200, { items: items.map(alertView), limit: p.limit });
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: "invalid_parameters" });
      if (error.name?.startsWith("Mongo") || /Falta .*PASSWORD/.test(error.message)) return send(503, { error: "database_unavailable" }, { "Retry-After": "5" });
      return send(500, { error: "internal_error" });
    }
  });
}
