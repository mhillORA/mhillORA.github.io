const { CosmosClient } = require("@azure/cosmos");
const { SHEETS, DQ_SHEETS } = require("./map");

const CONCURRENCY = 12;

function env(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function containerDefs() {
  const defs = SHEETS.map((s) => ({
    id: s.container,
    partitionKey: { paths: [`/${s.pk}`] }
  }));
  defs.push({ id: "lens_rm_dq", partitionKey: { paths: ["/sheet"] } });
  defs.push({ id: "lens_rm_runs", partitionKey: { paths: ["/runDate"] } });
  defs.push({ id: "lens_rm_staffing_employee", partitionKey: { paths: ["/nameKey"] } });
  defs.push({ id: "lens_rm_staffing_workitem", partitionKey: { paths: ["/studyKey"] } });
  defs.push({ id: "lens_rm_roster", partitionKey: { paths: ["/employeeNumber"] } });
  defs.push({ id: "lens_rm_export_assignments", partitionKey: { paths: ["/studyKey"] } });
  defs.push({ id: "lens_rm_schedule", partitionKey: { paths: ["/studyKey"] } });
  return defs;
}

async function getDatabase() {
  const endpoint = env("COSMOS_ENDPOINT");
  const key = env("COSMOS_KEY");
  const dbName = env("COSMOS_DATABASE", "bd-budgets");
  if (!endpoint || !key || key.includes("SET_IN")) {
    throw new Error("Set COSMOS_ENDPOINT and COSMOS_KEY on ora-lens-rm-ingest (not the Data Lens SWA, not the NetSuite function)");
  }
  const client = new CosmosClient({ endpoint, key });
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  for (const def of containerDefs()) {
    await database.containers.createIfNotExists(def);
  }
  return database;
}

async function mapPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, Math.max(1, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function upsertDocs(container, docs) {
  await mapPool(docs, CONCURRENCY, (doc) => container.items.upsert(doc));
}

async function pruneMissing(container, docType, pkField, keepIds) {
  const { resources: existing } = await container.items
    .query({
      query: `SELECT c.id, c.${pkField} FROM c WHERE c.docType = @t`,
      parameters: [{ name: "@t", value: docType }]
    })
    .fetchAll();
  let deleted = 0;
  await mapPool(existing, CONCURRENCY, async (old) => {
    if (keepIds.has(old.id)) return;
    await container.item(old.id, old[pkField]).delete();
    deleted += 1;
  });
  return deleted;
}

async function replaceDocs(database, spec, docs) {
  const container = database.container(spec.container);
  if (docs.length) await upsertDocs(container, docs);
  const deleted = await pruneMissing(
    container,
    spec.docType,
    spec.pk,
    new Set(docs.map((d) => d.id))
  );
  return { upserted: docs.length, deleted };
}

async function replaceSheet(database, sheetDef, docs) {
  return replaceDocs(database, sheetDef, docs);
}

async function replaceDq(database, bySheet) {
  const container = database.container("lens_rm_dq");
  const keep = new Set();
  let upserted = 0;
  for (const sheet of DQ_SHEETS) {
    const docs = bySheet[sheet] || [];
    if (!docs.length) continue;
    await upsertDocs(container, docs);
    upserted += docs.length;
    docs.forEach((d) => keep.add(d.id));
  }
  const { resources: existing } = await container.items
    .query({
      query: "SELECT c.id, c.sheet FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "lens_rm_dq" }]
    })
    .fetchAll();
  let deleted = 0;
  await mapPool(existing, CONCURRENCY, async (old) => {
    if (keep.has(old.id)) return;
    await container.item(old.id, old.sheet).delete();
    deleted += 1;
  });
  return { upserted, deleted };
}

async function writeRun(database, run) {
  const container = database.container("lens_rm_runs");
  await container.items.upsert(run);
}

module.exports = {
  getDatabase,
  replaceSheet,
  replaceDocs,
  replaceDq,
  writeRun
};
