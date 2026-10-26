import { createHash } from "node:crypto";
import { BSON } from "mongodb";

export const EVENT_MIGRATION_JOURNAL = "event_migration_journal";
export const MIGRATED_EVENT_FIELDS = {
  schema_version: 2,
  firmware_version: null,
  firmware_status: "unknown",
  migrated_from: 1
};

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  const serialized = BSON.EJSON.serialize(value, { relaxed: false });
  return createHash("sha256").update(JSON.stringify(stable(serialized))).digest("hex");
}

function assertScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).length === 0) {
    throw new Error("El alcance debe ser un filtro MongoDB explícito y no vacío.");
  }
  const allowed = new Set(["source", "device_id", "event_id"]);
  for (const [field, value] of Object.entries(scope)) {
    if (!allowed.has(field) || typeof value !== "string" || !value.trim()) {
      throw new Error("El alcance solo admite valores exactos no vacíos para source, device_id o event_id.");
    }
  }
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error("runId debe ser un UUID explícito.");
}

function assertBatchSize(batchSize) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("batchSize debe ser un entero positivo.");
}

function assertCollections(collection, journalCollection) {
  for (const name of [collection, journalCollection]) {
    if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new Error("Nombre de coleccion invalido.");
  }
  if (collection === journalCollection) throw new Error("El diario debe estar separado de los eventos.");
}

function eventQuery(scope) {
  return { $and: [scope, { schema_version: { $exists: false } }] };
}

function itemId(runId, documentId) {
  return `item:${runId}:${hash(documentId)}`;
}

function claimId(collection, documentId) {
  return `claim:${collection}:${hash(documentId)}`;
}

function migratedDocument(doc) {
  return { ...doc, ...MIGRATED_EVENT_FIELDS };
}

function exactDocumentFilter(doc) {
  return {
    _id: doc._id,
    $expr: { $eq: ["$$ROOT", { $literal: doc }] }
  };
}

async function setItemStatus(journal, entry, status) {
  await journal.updateOne({ _id: entry._id }, { $set: { status, updated_at: new Date() } });
}

async function releaseClaim(journal, collection, runId, documentId) {
  await journal.deleteOne({ _id: claimId(collection, documentId), migration_id: runId });
}

async function applyEntry(events, journal, collection, runId, entry, doc) {
  if (!doc) {
    await setItemStatus(journal, entry, "conflict");
    await releaseClaim(journal, collection, runId, entry.document_id);
    return "conflict";
  }
  const currentHash = hash(doc);
  if (currentHash === entry.after_sha256) {
    await setItemStatus(journal, entry, "applied");
    return "already_applied";
  }
  if (currentHash !== entry.before_sha256) {
    await setItemStatus(journal, entry, "conflict");
    await releaseClaim(journal, collection, runId, entry.document_id);
    return "conflict";
  }

  const replacement = migratedDocument(doc);
  if (hash(replacement) !== entry.after_sha256) {
    throw new Error(`El registro de migración para ${entry.event_id} no coincide con el documento.`);
  }
  const result = await events.updateOne(
    { ...exactDocumentFilter(doc), schema_version: { $exists: false } },
    { $set: MIGRATED_EVENT_FIELDS }
  );
  if (result.modifiedCount !== 1) {
    await setItemStatus(journal, entry, "conflict");
    await releaseClaim(journal, collection, runId, entry.document_id);
    return "conflict";
  }
  await setItemStatus(journal, entry, "applied");
  return "applied";
}

async function recordCandidate(journal, runId, collection, doc) {
  const id = itemId(runId, doc._id);
  const existing = await journal.findOne({ _id: id });
  if (existing) return existing;

  const claim = {
    _id: claimId(collection, doc._id),
    type: "claim",
    migration_id: runId,
    collection,
    document_id: doc._id,
    event_id: doc.event_id,
    status: "active",
    created_at: new Date()
  };
  let ownsClaim = true;
  try {
    await journal.insertOne(claim);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const owner = await journal.findOne({ _id: claim._id });
    if (!owner) throw error;
    ownsClaim = owner.migration_id === runId;
  }

  const after = migratedDocument(doc);
  const entry = {
    _id: id,
    type: "document",
    migration_id: runId,
    document_id: doc._id,
    event_id: doc.event_id,
    before_sha256: hash(doc),
    after_sha256: hash(after),
    status: ownsClaim ? "pending" : "conflict",
    ...(ownsClaim ? {} : { conflict_reason: "claimed_by_another_migration" }),
    created_at: new Date(),
    updated_at: new Date()
  };
  try {
    await journal.insertOne(entry);
    return entry;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const raced = await journal.findOne({ _id: id });
    if (!raced) throw error;
    return raced;
  }
}

export async function inspectEventMigration(db, scope, { collection = "events", batchSize = 100 } = {}) {
  assertScope(scope);
  assertBatchSize(batchSize);
  const count = await db.collection(collection).countDocuments(eventQuery(scope));
  return { collection, scope_sha256: hash(scope), pending: count, batch_size: batchSize, batches: Math.ceil(count / batchSize) };
}

export async function migrateEventsV1(db, scope, {
  collection = "events",
  journalCollection = EVENT_MIGRATION_JOURNAL,
  runId,
  batchSize = 100,
  maxBatches = Number.POSITIVE_INFINITY
} = {}) {
  assertScope(scope);
  assertBatchSize(batchSize);
  assertRunId(runId);
  assertCollections(collection, journalCollection);
  if (!Number.isSafeInteger(maxBatches) && maxBatches !== Number.POSITIVE_INFINITY) {
    throw new Error("maxBatches debe ser un entero positivo.");
  }
  if (maxBatches < 1) throw new Error("maxBatches debe ser un entero positivo.");

  const events = db.collection(collection);
  const journal = db.collection(journalCollection);
  const scopeHash = hash(scope);
  const runKey = `run:${runId}`;
  let run = await journal.findOne({ _id: runKey });
  if (!run) {
    try {
      await journal.insertOne({
        _id: runKey, type: "run", migration_id: runId, collection,
        scope_sha256: scopeHash, created_at: new Date(), updated_at: new Date()
      });
      run = { type: "run", collection, scope_sha256: scopeHash };
    } catch (error) {
      if (error.code !== 11000) throw error;
      run = await journal.findOne({ _id: runKey });
      if (!run) throw error;
    }
  }
  if (run.type !== "run" || run.collection !== collection || run.scope_sha256 !== scopeHash) {
    throw new Error("El run-id ya existe con otra colección o alcance.");
  }
  if (run.phase === "rollback") throw new Error("Esta corrida inicio rollback; para migrar de nuevo usar otro run-id.");
  if (run.created_at) {
    await journal.updateOne({ _id: runKey }, { $set: { updated_at: new Date() } });
  }

  let changed = 0;
  let batches = 0;
  const knownEntries = journal.find({ type: "document", migration_id: runId });
  for await (const entry of knownEntries) {
    if (entry.status === "conflict") continue;
    if (entry.status !== "pending" && entry.status !== "applied") continue;
    const current = await events.findOne({ _id: entry.document_id });
    const result = await applyEntry(events, journal, collection, runId, entry, current);
    if (result === "applied") changed += 1;
  }

  let lastId;
  while (batches < maxBatches) {
    const query = eventQuery(scope);
    if (lastId !== undefined) query.$and.push({ _id: { $gt: lastId } });
    const candidates = await events.find(query).sort({ _id: 1 }).limit(batchSize).toArray();
    if (!candidates.length) break;
    batches += 1;
    for (const doc of candidates) {
      lastId = doc._id;
      const entry = await recordCandidate(journal, runId, collection, doc);
      if (entry.status !== "pending") continue;
      const result = await applyEntry(events, journal, collection, runId, entry, await events.findOne({ _id: doc._id }));
      if (result === "applied") changed += 1;
    }
  }

  return {
    migration_id: runId, collection, scope_sha256: scopeHash,
    changed,
    conflicts: await journal.countDocuments({ type: "document", migration_id: runId, status: "conflict" }),
    remaining: await events.countDocuments(eventQuery(scope)), batches, batch_size: batchSize
  };
}

export async function rollbackEventMigration(db, runId, {
  journalCollection = EVENT_MIGRATION_JOURNAL,
  batchSize = 100
} = {}) {
  assertBatchSize(batchSize);
  assertRunId(runId);
  const journal = db.collection(journalCollection);
  const run = await journal.findOne({ _id: `run:${runId}`, type: "run" });
  if (!run) throw new Error(`No existe el registro de migración ${runId}.`);
  assertCollections(run.collection, journalCollection);
  await journal.updateOne({ _id: run._id }, { $set: { phase: "rollback", updated_at: new Date() } });

  const events = db.collection(run.collection);
  let reverted = 0;
  let conflicts = 0;
  let batches = 0;
  const cursor = journal.find({ type: "document", migration_id: runId, status: { $in: ["applied", "pending"] } });
  let batch = [];
  const rollbackBatch = async (entries) => {
    if (!entries.length) return;
    batches += 1;
    for (const entry of entries) {
      const current = await events.findOne({ _id: entry.document_id });
      if (entry.status === "pending" && current && hash(current) === entry.before_sha256) {
        await setItemStatus(journal, entry, "not_applied");
        await releaseClaim(journal, run.collection, runId, entry.document_id);
        continue;
      }
      if (current && hash(current) === entry.before_sha256) {
        await setItemStatus(journal, entry, "rolled_back");
        await releaseClaim(journal, run.collection, runId, entry.document_id);
        continue;
      }
      if (!current || hash(current) !== entry.after_sha256) {
        await setItemStatus(journal, entry, "conflict");
        conflicts += 1;
        continue;
      }
      const result = await events.updateOne(
        exactDocumentFilter(current),
        { $unset: Object.fromEntries(Object.keys(MIGRATED_EVENT_FIELDS).map((key) => [key, ""])) }
      );
      if (result.modifiedCount !== 1) {
        await setItemStatus(journal, entry, "conflict");
        conflicts += 1;
        continue;
      }
      const restored = await events.findOne({ _id: entry.document_id });
      if (!restored || hash(restored) !== entry.before_sha256) {
        await setItemStatus(journal, entry, "conflict");
        conflicts += 1;
        continue;
      }
      await setItemStatus(journal, entry, "rolled_back");
      await releaseClaim(journal, run.collection, runId, entry.document_id);
      reverted += 1;
    }
  };
  for await (const entry of cursor) {
    batch.push(entry);
    if (batch.length === batchSize) {
      await rollbackBatch(batch);
      batch = [];
    }
  }
  await rollbackBatch(batch);

  const claims = journal.find({ type: "claim", migration_id: runId, collection: run.collection });
  for await (const claim of claims) {
    const entry = await journal.findOne({ _id: itemId(runId, claim.document_id) });
    if (!entry || ["not_applied", "rolled_back"].includes(entry.status)) {
      await journal.deleteOne({ _id: claim._id, migration_id: runId });
    }
  }

  const unresolved = await journal.countDocuments({ type: "document", migration_id: runId, status: "conflict" });
  return { migration_id: runId, collection: run.collection, reverted, conflicts, unresolved_conflicts: unresolved, batches, batch_size: batchSize };
}
