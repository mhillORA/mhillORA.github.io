/**
 * Writer: newest Project Profitability CSV in blob → Cosmos lens_ns_projects.
 * Run this in Azure (last step of netsuite-pull-job). Not the Data Lens SWA.
 *
 * Env (no secrets in git):
 *   BLOB_ACCOUNT_NAME or AZURE_STORAGE_ACCOUNT
 *   BLOB_CONTAINER=netsuite
 *   AZURE_STORAGE_CONNECTION_STRING  (or DefaultAzureCredential)
 *   COSMOS_ENDPOINT
 *   COSMOS_KEY          (writer key — not the website reader if you can split)
 *   COSMOS_DATABASE=bd-budgets
 */
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const { CosmosClient } = require("@azure/cosmos");

const CONTAINER = "lens_ns_projects";
const PARTITION = "/project_number";
const DOC_TYPE = "lens_ns_project";
const BLOB_CONTAINER_DEFAULT = "netsuite";
const PREFIX = "landing/";

const NUM_FIELDS = [
  "actual_gm_pct_prior_month",
  "budgeted_gm_pct",
  "gm_pct_variance",
  "projected_eos_gm_pct_prior_month",
  "cost_per_billable_hr_actual",
  "cost_per_billable_hr_budgeted"
];

function env(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  return rows
    .slice(1)
    .filter((r) => r.some((x) => String(x || "").trim()))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = r[i] == null ? "" : String(r[i]).trim();
      });
      return o;
    });
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function numOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function docId(row) {
  const num = String(row.project_number || "").trim();
  const name = slug(row.project_name);
  if (!num || !name) return null;
  return `${num}__${name}`;
}

function toDoc(row, syncedAt, blobPath) {
  const id = docId(row);
  if (!id) return null;
  const doc = {
    id,
    project_number: String(row.project_number).trim(),
    docType: DOC_TYPE,
    project_name: row.project_name || "",
    project_manager: row.project_manager || "",
    customer_name: row.customer_name || "",
    project_status: row.project_status || "",
    service_line: row.service_line || "",
    change_order_status: row.change_order_status || null,
    sourceBlob: blobPath,
    syncedAt
  };
  for (const f of NUM_FIELDS) doc[f] = numOrNull(row[f]);
  return doc;
}

function blobClient() {
  const conn = env("AZURE_STORAGE_CONNECTION_STRING");
  if (conn) return BlobServiceClient.fromConnectionString(conn);
  const account = env("BLOB_ACCOUNT_NAME") || env("AZURE_STORAGE_ACCOUNT");
  if (!account) throw new Error("Set AZURE_STORAGE_CONNECTION_STRING or BLOB_ACCOUNT_NAME");
  return new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
}

async function latestProfitabilityCsv(container) {
  const hits = [];
  for await (const blob of container.listBlobsFlat({ prefix: PREFIX })) {
    const name = blob.name || "";
    if (!/landing\/\d{4}\/\d{2}\/\d{2}\/\d+\/.*project_profitability.*\.csv$/i.test(name)) continue;
    hits.push(name);
  }
  hits.sort();
  if (!hits.length) {
    throw new Error(`No landing/**/netsuite_project_profitability*.csv in container ${container.containerName}`);
  }
  return hits[hits.length - 1];
}

async function ensureContainer(db) {
  await db.containers.createIfNotExists({
    id: CONTAINER,
    partitionKey: { paths: [PARTITION] }
  });
}

async function loadExisting(container) {
  const { resources } = await container.items
    .query({
      query: "SELECT c.id, c.project_number FROM c WHERE c.docType = @t",
      parameters: [{ name: "@t", value: DOC_TYPE }]
    })
    .fetchAll();
  return resources;
}

async function main() {
  const syncedAt = new Date().toISOString();
  const blobContainerName = env("BLOB_CONTAINER", BLOB_CONTAINER_DEFAULT);
  const blobs = blobClient().getContainerClient(blobContainerName);
  const blobPath = await latestProfitabilityCsv(blobs);
  const download = await blobs.getBlobClient(blobPath).downloadToBuffer();
  const rows = parseCsv(download.toString("utf8"));
  const docs = rows.map((r) => toDoc(r, syncedAt, blobPath)).filter(Boolean);
  if (!docs.length) throw new Error(`CSV ${blobPath} parsed 0 project rows`);

  const endpoint = env("COSMOS_ENDPOINT");
  const key = env("COSMOS_KEY");
  const dbName = env("COSMOS_DATABASE", "bd-budgets");
  if (!endpoint || !key || key.includes("SET_IN")) {
    throw new Error("COSMOS_ENDPOINT / COSMOS_KEY required on the writer, not the SWA");
  }
  const db = new CosmosClient({ endpoint, key }).database(dbName);
  await ensureContainer(db);
  const cosmos = db.container(CONTAINER);

  for (const doc of docs) {
    await cosmos.items.upsert(doc);
  }

  const keep = new Set(docs.map((d) => d.id));
  const existing = await loadExisting(cosmos);
  let deleted = 0;
  for (const old of existing) {
    if (keep.has(old.id)) continue;
    await cosmos.item(old.id, old.project_number).delete();
    deleted += 1;
  }

  const result = {
    blob: blobPath,
    upserted: docs.length,
    deleted,
    container: CONTAINER,
    database: dbName,
    syncedAt
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
