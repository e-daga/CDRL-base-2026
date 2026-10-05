const fs = require("fs");
const dbc = db.getSiblingDB("cdrl");
const load = (file, coll, key) => {
  const docs = EJSON.parse(fs.readFileSync(file, "utf8"));
  for (const d of docs) dbc[coll].replaceOne({ [key]: d[key] }, d, { upsert: true });
  print(coll + ": " + dbc[coll].countDocuments({}) + " documentos");
};
load("/mongo/fixtures/events.json", "events", "event_id");
load("/mongo/fixtures/alerts.json", "alerts", "alert_id");