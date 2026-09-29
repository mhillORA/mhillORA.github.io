/**
 * Proxy sync triggers from Data Lens → Buddy Function App.
 * Uses BUDDY_API_BASE + BUDDY_COPILOT_KEY (or COPILOT_ASK_KEY).
 * NetSuite study Excel/Cosmos upsert stays on netsuite-pull-job (optional webhook).
 */

const DEFAULT_BUDDY_BASE =
  "https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net";

const SYNC_CATALOG = [
  {
    id: "veeva",
    name: "Veeva Vault",
    path: "/api/veeva/sync",
    method: "POST",
    body: { prioritizeEmpty: true },
    note: "Live ora_veeva_* mirrors (studies, sites, milestones, subjects)."
  },
  {
    id: "salesforce",
    name: "Salesforce",
    path: "/api/salesforce/sync",
    method: "POST",
    body: { tables: true, thenCrosswalk: true },
    note: "ora_sf_* tables + sponsor crosswalk."
  },
  {
    id: "ctgov",
    name: "ClinicalTrials.gov",
    path: "/api/ctgov/sync",
    method: "POST",
    body: {},
    note: "ora_ctgov_trials refresh."
  },
  {
    id: "netsuite_study",
    name: "NetSuite study intel",
    path: null,
    method: "JOB",
    note: "SuiteQL + Excel + Cosmos ora_ns_study via netsuite-pull-job (STUDY_ONLY)."
  }
];

function buddyBase() {
  return String(process.env.BUDDY_API_BASE || process.env.BUDDY_STUDY_SYNC_URL || DEFAULT_BUDDY_BASE)
    .trim()
    .replace(/\/$/, "")
    .replace(/\/api$/i, "");
}

function buddyKey() {
  return String(
    process.env.BUDDY_COPILOT_KEY ||
      process.env.COPILOT_ASK_KEY ||
      process.env["buddy-copilot-key"] ||
      ""
  ).trim();
}

function syncConfigStatus() {
  const key = buddyKey();
  return {
    buddyApiBase: buddyBase(),
    copilotKeyConfigured: Boolean(key),
    netsuiteJobWebhookConfigured: Boolean(String(process.env.NETSUITE_JOB_WEBHOOK || "").trim()),
    catalog: SYNC_CATALOG.map((c) => ({
      id: c.id,
      name: c.name,
      note: c.note,
      trigger: c.method === "JOB" ? "containerapp_job_or_webhook" : "buddy_api"
    })),
    dailyHint:
      "Schedule: Timer/Logic App daily POST to Buddy /api/veeva/sync, /api/salesforce/sync?tables=true, /api/ctgov/sync with x-copilot-key; netsuite-pull-job STUDY_ONLY on Monday (or daily if you set schedule)."
  };
}

async function proxyBuddy(path, { method = "POST", body = {} } = {}) {
  const key = buddyKey();
  if (!key) {
    return {
      ok: false,
      error:
        "Set BUDDY_COPILOT_KEY (or COPILOT_ASK_KEY) on the Data Lens Function App — same value as Buddy COPILOT_ASK_KEY."
    };
  }
  const url = `${buddyBase()}${path.startsWith("/") ? path : `/${path}`}`;
  // SWA API ~30s hard limit; Veeva/SF take minutes. Always ask Buddy to background-kick.
  const payload =
    method === "GET"
      ? undefined
      : JSON.stringify({ ...(body || {}), async: true, background: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-copilot-key": key
      },
      body: payload,
      signal: ctrl.signal
    });
    const text = await res.text();
    let jsonBody = null;
    try {
      jsonBody = text ? JSON.parse(text) : {};
    } catch (_) {
      jsonBody = { raw: text.slice(0, 500) };
    }
    if (res.status === 202 || jsonBody.accepted === true) {
      return {
        ok: true,
        accepted: true,
        status: res.status,
        url,
        error: undefined,
        message:
          jsonBody.message ||
          "Buddy accepted sync in background. Refresh Sources in a few minutes (Veeva may need 2–3 Sync clicks if time budget hits).",
        body: jsonBody
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        url,
        error: jsonBody.error || jsonBody.message || `Buddy returned ${res.status}`,
        body: jsonBody
      };
    }
    return { ok: true, status: res.status, url, body: jsonBody };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      url,
      error: aborted
        ? "Not a Veeva auth failure — Lens SWA cut the wait (~25s). Use Buddy → Data Status → Ingest Veeva (background). Or wait and refresh Sources; a kick may already be running."
        : String(err.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function triggerNetsuiteStudyJob() {
  const hook = String(process.env.NETSUITE_JOB_WEBHOOK || "").trim();
  if (hook) {
    try {
      const res = await fetch(hook, { method: "POST", headers: { Accept: "application/json" } });
      const text = await res.text();
      return {
        ok: res.ok,
        via: "webhook",
        status: res.status,
        body: text.slice(0, 400),
        error: res.ok ? undefined : `Webhook returned ${res.status}`
      };
    } catch (err) {
      return { ok: false, via: "webhook", error: String(err.message || err) };
    }
  }
  return {
    ok: false,
    via: "manual",
    error: "NetSuite study pull is the Container App job netsuite-pull-job (not Buddy).",
    startCommand:
      "az containerapp job start -g RG_Workloads -n netsuite-pull-job",
    scheduleHint:
      "Keep STUDY_ONLY=1 + BUDDY_API_BASE + BUDDY_COPILOT_KEY on the job. Optional: set NETSUITE_JOB_WEBHOOK on Lens to a Logic App that starts the job.",
    dailyHint: "Schedule the job daily/Monday in Azure Container Apps (or Logic App → start job)."
  };
}

async function triggerSync(feedId, opts = {}) {
  const id = String(feedId || "").trim().toLowerCase();
  const item = SYNC_CATALOG.find((c) => c.id === id);
  if (!item) {
    return {
      ok: false,
      error: `Unknown feed '${feedId}'. Use: ${SYNC_CATALOG.map((c) => c.id).join(", ")}`
    };
  }

  if (item.method === "JOB") {
    const job = await triggerNetsuiteStudyJob();
    return {
      feed: item.id,
      name: item.name,
      triggeredBy: "ora-data-lens",
      ...job
    };
  }

  const body = { ...(item.body || {}), ...(opts.body || {}) };
  if (opts.full === true && item.id === "veeva") body.full = true;
  const result = await proxyBuddy(item.path, { method: "POST", body });
  return {
    feed: item.id,
    name: item.name,
    triggeredBy: "ora-data-lens",
    note: item.note,
    ...result
  };
}

async function triggerAll(opts = {}) {
  const order = ["veeva", "salesforce", "ctgov"];
  const results = [];
  for (const id of order) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await triggerSync(id, opts));
  }
  if (opts.includeNetsuite) {
    results.push(await triggerSync("netsuite_study", opts));
  }
  return {
    ok: results.every((r) => r.ok),
    results,
    config: syncConfigStatus()
  };
}

module.exports = {
  SYNC_CATALOG,
  syncConfigStatus,
  triggerSync,
  triggerAll
};
