const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");
const { BlobServiceClient } = require("@azure/storage-blob");
const { parseCsv, toDoc } = require("./map");

const COSMOS_CONTAINER = "lens_ns_projects";

function env(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

async function loadCsvToCosmos(csvText, blobPath, log) {
  const syncedAt = new Date().toISOString();
  const docs = parseCsv(csvText).map((r) => toDoc(r, syncedAt, blobPath)).filter(Boolean);
  if (!docs.length) {
    log(`No project rows in ${blobPath}`);
    return { upserted: 0, deleted: 0 };
  }

  const endpoint = env("COSMOS_ENDPOINT");
  const key = env("COSMOS_KEY");
  const dbName = env("COSMOS_DATABASE", "bd-budgets");
  if (!endpoint || !key || key.includes("SET_IN")) {
    throw new Error("Set COSMOS_ENDPOINT and COSMOS_KEY on this Function App (not the Data Lens SWA)");
  }

  const client = new CosmosClient({ endpoint, key });
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: COSMOS_CONTAINER,
    partitionKey: { paths: ["/project_number"] }
  });

  for (const doc of docs) {
    await container.items.upsert(doc);
  }

  const { resources: existing } = await container.items
    .query({
      query: "SELECT c.id, c.project_number FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: "lens_ns_project" }]
    })
    .fetchAll();
  const keep = new Set(docs.map((d) => d.id));
  let deleted = 0;
  for (const old of existing) {
    if (keep.has(old.id)) continue;
    await container.item(old.id, old.project_number).delete();
    deleted += 1;
  }
  return { upserted: docs.length, deleted, blob: blobPath };
}

async function latestProfitabilityCsv() {
  const conn = env("NETSUITE_STORAGE");
  if (!conn) throw new Error("NETSUITE_STORAGE is empty on this Function App");
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient("netsuite");
  const hits = [];
  for await (const blob of container.listBlobsFlat({ prefix: "landing/" })) {
    const name = blob.name || "";
    if (!/landing\/\d{4}\/\d{2}\/\d{2}\/\d+\/.*project_profitability.*\.csv$/i.test(name)) continue;
    hits.push(name);
  }
  hits.sort();
  if (!hits.length) {
    throw new Error("No landing/**/*project_profitability*.csv in container netsuite");
  }
  const blobPath = hits[hits.length - 1];
  const buf = await container.getBlobClient(blobPath).downloadToBuffer();
  return { blobPath, text: buf.toString("utf8") };
}

app.timer("nsProfitabilityTimer", {
  schedule: "0 */5 * * * *",
  handler: async (_timer, context) => {
    const { blobPath, text } = await latestProfitabilityCsv();
    const result = await loadCsvToCosmos(text, blobPath, (m) => context.log(m));
    context.log(JSON.stringify(result));
  }
});

app.storageBlob("nsProfitabilityToCosmos", {
  path: "netsuite/landing/{year}/{month}/{day}/{run}/{name}",
  connection: "NETSUITE_STORAGE",
  handler: async (blob, context) => {
    const name = String(context.triggerMetadata.name || "");
    const year = context.triggerMetadata.year;
    const month = context.triggerMetadata.month;
    const day = context.triggerMetadata.day;
    const run = context.triggerMetadata.run;
    const blobPath = `landing/${year}/${month}/${day}/${run}/${name}`;
    if (!/project_profitability.*\.csv$/i.test(name)) {
      context.log(`skip ${blobPath}`);
      return;
    }
    const text = Buffer.isBuffer(blob) ? blob.toString("utf8") : String(blob || "");
    const result = await loadCsvToCosmos(text, blobPath, (m) => context.log(m));
    context.log(JSON.stringify(result));
  }
});
