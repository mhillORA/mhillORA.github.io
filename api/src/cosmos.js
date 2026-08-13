const { CosmosClient } = require("@azure/cosmos");

let client;
let db;

/** Same account + database as Study Bid Workbench. Do not write the SBW containers. */
const COSMOS_DATABASE_DEFAULT = "bd-budgets";

const LENS = {
  studies: "lens_studies",
  visits: "lens_visits",
  metrics: "lens_metrics",
  sources: "lens_sources",
  syncRuns: "lens_syncRuns",
  nsProjects: "lens_ns_projects"
};

const SHARED_READ = {
  budgets: "studies",
  oraFactStudy: "ora_fact_study",
  oraFactSite: "ora_fact_site",
  oraCtgov: "ora_ctgov_trials",
  oraTrialhub: "ora_trialhub_trials",
  oraCrosswalk: "ora_sponsor_crosswalk"
};

const CONTAINERS = [
  { id: LENS.studies, partitionKey: { paths: ["/studyCode"] } },
  { id: LENS.visits, partitionKey: { paths: ["/studyCode"] } },
  { id: LENS.metrics, partitionKey: { paths: ["/metricType"] } },
  { id: LENS.sources, partitionKey: { paths: ["/sourceId"] } },
  { id: LENS.syncRuns, partitionKey: { paths: ["/runDate"] } }
];

function getDb() {
  const endpoint = (process.env.COSMOS_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_KEY || "").trim();
  const dbName = (process.env.COSMOS_DATABASE || COSMOS_DATABASE_DEFAULT).trim();
  if (!endpoint || !key || key.includes("SET_IN")) {
    throw new Error("COSMOS_ENDPOINT / COSMOS_KEY not configured");
  }
  if (!client) client = new CosmosClient({ endpoint, key });
  if (!db) db = client.database(dbName);
  return db;
}

async function ensureContainers() {
  const endpoint = (process.env.COSMOS_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_KEY || "").trim();
  const dbName = (process.env.COSMOS_DATABASE || COSMOS_DATABASE_DEFAULT).trim();
  const c = new CosmosClient({ endpoint, key });
  const { database } = await c.databases.createIfNotExists({ id: dbName });
  for (const def of CONTAINERS) {
    await database.containers.createIfNotExists(def);
  }
  db = database;
  client = c;
  return database;
}

async function upsertMany() {
  throw new Error("Data Lens API is read-only. Gold ETL must use a separate writer, not this SWA.");
}

async function queryContainer(containerId, query, parameters = []) {
  const container = getDb().container(containerId);
  const { resources } = await container.items.query({ query, parameters }).fetchAll();
  return resources;
}

async function safeQuery(containerId, query, parameters = []) {
  try {
    return await queryContainer(containerId, query, parameters);
  } catch (_) {
    return [];
  }
}

module.exports = {
  getDb,
  ensureContainers,
  upsertMany,
  queryContainer,
  safeQuery,
  CONTAINERS,
  LENS,
  SHARED_READ,
  COSMOS_DATABASE_DEFAULT
};
