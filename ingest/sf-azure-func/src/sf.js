const { CosmosClient } = require("@azure/cosmos");

function req(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function opt(name, fallback) {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

async function getAccessToken() {
  const login = opt("SF_LOGIN_URL", "https://login.salesforce.com").replace(/\/$/, "");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: req("SF_CLIENT_ID"),
    client_secret: req("SF_CLIENT_SECRET")
  });
  const res = await fetch(`${login}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Salesforce token failed (${res.status}): ${json.error || ""} ${json.error_description || JSON.stringify(json)}`);
  }
  return {
    accessToken: json.access_token,
    instanceUrl: String(json.instance_url || "").replace(/\/$/, "")
  };
}

async function queryAll(accessToken, instanceUrl, soql) {
  const version = opt("SF_API_VERSION", "v61.0");
  let url = `${instanceUrl}/services/data/${version}/query?q=${encodeURIComponent(soql)}`;
  const rows = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Salesforce query failed (${res.status}): ${json[0]?.message || JSON.stringify(json)}`);
    }
    rows.push(...(json.records || []));
    url = json.nextRecordsUrl ? `${instanceUrl}${json.nextRecordsUrl}` : null;
  }
  return rows;
}

function flatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k === "attributes") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk === "attributes") continue;
        out[`${k}_${sk}`] = sv;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toDoc(row, syncedAt) {
  const flat = flatten(row);
  const sfId = String(flat.Id || "").trim();
  if (!sfId) return null;
  return {
    id: sfId,
    docType: "lens_sf_row",
    sfId,
    syncedAt,
    ...flat
  };
}

async function upsertDocs(docs) {
  const endpoint = req("COSMOS_ENDPOINT");
  const key = req("COSMOS_KEY");
  const dbName = opt("COSMOS_DATABASE", "bd-budgets");
  const containerId = opt("SF_COSMOS_CONTAINER", "lens_sf_crosswalk");
  const client = new CosmosClient({ endpoint, key });
  const { database } = await client.databases.createIfNotExists({ id: dbName });
  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: { paths: ["/docType"] }
  });
  let n = 0;
  for (const doc of docs) {
    await container.items.upsert(doc);
    n += 1;
  }
  return { containerId, n };
}

async function runSfIngest(context) {
  const soql = (process.env.SF_SOQL || "").trim();
  if (!soql) {
    throw new Error("SF_SOQL is not set. Paste a SOQL query in the Function App setting.");
  }
  const { accessToken, instanceUrl } = await getAccessToken();
  context.log(`Salesforce token OK · instance ${instanceUrl}`);
  const rows = await queryAll(accessToken, instanceUrl, soql);
  const syncedAt = new Date().toISOString();
  const docs = rows.map((r) => toDoc(r, syncedAt)).filter(Boolean);
  const result = await upsertDocs(docs);
  context.log(`upserted ${result.n} docs into ${result.containerId}`);
  return { ...result, queried: rows.length };
}

module.exports = { runSfIngest, getAccessToken, queryAll, toDoc };
