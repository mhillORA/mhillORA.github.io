const TENANT_DEFAULT = "2f298692-acc9-4632-b71b-841d51376914";
const GRAPH = "https://graph.microsoft.com/v1.0";
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function env(name) {
  const v = (process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function graphCredentials() {
  const clientId = env("AZURE_CLIENT_ID");
  const pointed = env("AZURE_CLIENT_SECRET_APP_SETTING_NAME");
  const lookedUp = pointed ? env(pointed) : "";
  const clientSecret = env("AZURE_CLIENT_SECRET") || lookedUp || pointed;
  const tenant = env("AZURE_TENANT_ID") || TENANT_DEFAULT;
  return { clientId, clientSecret, tenant, configured: Boolean(clientId && clientSecret) };
}

function graphStatus() {
  const c = graphCredentials();
  return { configured: c.configured, tenant: c.tenant };
}

function suggestRoleKey(jobTitle) {
  const t = String(jobTitle || "").toLowerCase();
  if (!t) return "";
  if (/\b(chief|ceo|cfo|coo|cmo|president|\bvp\b|vice president|executive)\b/.test(t)) return "exec";
  if (/\b(project manager|\bpm\b|program manager|clinical project)\b/.test(t)) return "pm";
  if (/\bdirector\b/.test(t)) return "director";
  if (/\bmanager\b/.test(t)) return "manager";
  if (/\banalyst\b/.test(t)) return "analyst";
  return "";
}

let tokenMemo = { value: "", exp: 0 };

async function getAppToken() {
  const { clientId, clientSecret, tenant, configured } = graphCredentials();
  if (!configured) {
    throw new Error("Graph is not configured. AZURE_CLIENT_ID / client secret missing on the SWA.");
  }
  if (tokenMemo.value && Date.now() < tokenMemo.exp - 60 * 1000) return tokenMemo.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default"
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Graph token failed (${res.status}): ${json.error || ""} ${json.error_description || JSON.stringify(json).slice(0, 180)}`
    );
  }
  tokenMemo = {
    value: json.access_token,
    exp: Date.now() + Number(json.expires_in || 3600) * 1000
  };
  return tokenMemo.value;
}

async function graphGet(path) {
  const token = await getAppToken();
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 404) return null;
  if (!res.ok) {
    const msg = json.error && json.error.message ? json.error.message : JSON.stringify(json).slice(0, 180);
    throw new Error(`Graph ${res.status}: ${msg}`);
  }
  return json;
}

async function loadEntraProfile(entraId) {
  const id = String(entraId || "").trim();
  if (!id) return { ok: false, error: "no Entra id" };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.profile;
  if (!graphCredentials().configured) {
    return { ok: false, error: "Graph client secret not on this Function App" };
  }
  try {
    const user = await graphGet(
      `/users/${encodeURIComponent(id)}?$select=id,displayName,mail,userPrincipalName,jobTitle,department`
    );
    if (!user) {
      const profile = { ok: false, error: `Graph has no user ${id}` };
      cache.set(id, { at: Date.now(), profile });
      return profile;
    }
    let manager = null;
    let reports = [];
    try {
      const mgr = await graphGet(
        `/users/${encodeURIComponent(id)}/manager?$select=displayName,jobTitle,mail`
      );
      if (mgr && mgr.displayName) {
        manager = { displayName: mgr.displayName, jobTitle: mgr.jobTitle || "", mail: mgr.mail || "" };
      }
    } catch (_) {
      manager = null;
    }
    try {
      const list = await graphGet(
        `/users/${encodeURIComponent(id)}/directReports?$select=displayName,jobTitle,mail&$top=20`
      );
      reports = (list && list.value ? list.value : [])
        .map((r) => ({
          displayName: r.displayName || "",
          jobTitle: r.jobTitle || "",
          mail: r.mail || ""
        }))
        .filter((r) => r.displayName);
    } catch (_) {
      reports = [];
    }
    const jobTitle = user.jobTitle || "";
    const profile = {
      ok: true,
      entraId: user.id || id,
      displayName: user.displayName || "",
      email: user.mail || user.userPrincipalName || "",
      jobTitle,
      department: user.department || "",
      suggestedRoleKey: suggestRoleKey(jobTitle),
      manager,
      reports
    };
    cache.set(id, { at: Date.now(), profile });
    return profile;
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { loadEntraProfile, suggestRoleKey, graphStatus, graphCredentials };
