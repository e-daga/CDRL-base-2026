const fs = require("fs");
const dbc = db.getSiblingDB("cdrl");
const load = (file, coll, key) => {
  const docs = EJSON.parse(fs.readFileSync(file, "utf8"));
  for (const d of docs) dbc[coll].replaceOne({ [key]: d[key] }, d, { upsert: true });
  print(coll + ": " + dbc[coll].countDocuments({}) + " documentos");
};
load("/mongo/fixtures/events.json", "events", "event_id");
load("/mongo/fixtures/alerts.json", "alerts", "alert_id");
// M06: eventos v1 y v2 adicionales; los fixtures de M05 no se tocan.
load("/mongo/fixtures/events-m06.json", "events", "event_id");
