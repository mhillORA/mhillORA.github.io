function envSet(name) {
  const v = (process.env[name] || "").trim();
  if (!v || v.includes("SET_IN")) return "";
  return v;
}

function envSetAny(names) {
  for (const name of names) {
    const v = envSet(name);
    if (v) return { value: v, from: name };
  }
  return { value: "", from: null };
}

const KEY_ALIASES = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "FOUNDRY_API_KEY",
  "AZURE_AI_API_KEY"
];
const ENDPOINT_ALIASES = [
  "AZURE_OPENAI_ENDPOINT",
  "FOUNDRY_PROJECT_ENDPOINT",
  "AZURE_AI_ENDPOINT"
];
const DEPLOYMENT_ALIASES = [
  "AZURE_OPENAI_DEPLOYMENT",
  "FOUNDRY_DEPLOYMENT",
  "AZURE_OPENAI_MODEL"
];

function azureConfig() {
  const endpoint = envSetAny(ENDPOINT_ALIASES);
  const apiKey = envSetAny(KEY_ALIASES);
  const deployment = envSetAny(DEPLOYMENT_ALIASES);
  const agentName = envSet("FOUNDRY_AGENT_NAME") || "OraDataLens";
  return {
    endpoint: endpoint.value.replace(/\/$/, ""),
    apiKey: apiKey.value,
    deployment: deployment.value,
    agentName,
    sources: { endpoint: endpoint.from, apiKey: apiKey.from, deployment: deployment.from }
  };
}

function foundryConfigured() {
  const c = azureConfig();
  return Boolean(c.endpoint && c.apiKey && c.deployment);
}

function foundryStatus() {
  const c = azureConfig();
  return {
    configured: foundryConfigured(),
    deployment: c.deployment || null,
    agentName: c.agentName,
    endpointKind: /services\.ai\.azure\.com|\/api\/projects\//i.test(c.endpoint)
      ? "foundry_project"
      : c.endpoint
        ? "azure_openai"
        : null,
    resolvedFrom: c.sources
  };
}

function resourceNameFromEndpoint(endpoint) {
  const e = String(endpoint || "");
  let m = e.match(/^https:\/\/([^.]+)\.services\.ai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.openai\.azure\.com/i);
  if (m) return m[1];
  m = e.match(/^https:\/\/([^.]+)\.cognitiveservices\.azure\.com/i);
  if (m) return m[1];
  return null;
}

function buildChatAttempts(endpoint, deployment, apiVersion) {
  const base = String(endpoint || "").replace(/\/$/, "");
  const resource = resourceNameFromEndpoint(base);
  const attempts = [];
  const v1body = () => ({
    model: deployment,
    messages: null,
    max_completion_tokens: 1200,
    temperature: 1
  });
  const classicBody = () => ({
    messages: null,
    max_completion_tokens: 1200,
    temperature: 1
  });
  const pushV1 = (host, label) => {
    const root = host.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({ label, url: `${root}/openai/v1/chat/completions`, body: v1body() });
  };
  const pushClassic = (host, label) => {
    const root = host.replace(/\/$/, "").replace(/\/openai\/v1$/i, "");
    attempts.push({
      label,
      url: `${root}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      body: classicBody()
    });
  };
  if (resource) {
    pushV1(`https://${resource}.openai.azure.com`, "openai_v1_host");
    pushClassic(`https://${resource}.openai.azure.com`, "classic_deployments_host");
    pushV1(`https://${resource}.services.ai.azure.com`, "foundry_services_v1");
  }
  if (/openai\.azure\.com/i.test(base)) {
    pushV1(base, "user_openai_v1");
    pushClassic(base, "user_classic");
  }
  if (/services\.ai\.azure\.com/i.test(base) || /\/api\/projects\//i.test(base)) {
    if (resource) pushV1(`https://${resource}.services.ai.azure.com`, "foundry_services_v1b");
    attempts.push({
      label: "foundry_project_openai_v1",
      url: `${base}/openai/v1/chat/completions`,
      body: v1body()
    });
  }
  const seen = new Set();
  return attempts.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

function extractText(respBody) {
  const msg = respBody?.choices?.[0]?.message;
  if (!msg) return "";
  const raw = msg.content;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n").trim();
  }
  return String(msg.refusal || "").trim();
}

function parseLensJson(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { summary: raw };
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return { summary: raw };
  }
}

function systemPrompt(cfg) {
  const custom = envSet("FOUNDRY_AGENT_INSTRUCTIONS");
  const name = cfg.agentName || "OraDataLens";
  return (
    custom ||
    [
      `You are ${name}, Ora Data Lens.`,
      "You ONLY use the Cosmos CONTEXT JSON attached to this turn.",
      "Never invent studies, visits, enrollment, revenue, or sponsors.",
      "Never write or propose Cosmos SQL. Narrate the attached CONTEXT only.",
      "Null enrolled is missing, not zero. Do not say a study enrolled 0 unless CONTEXT has the number 0.",
      "Site questions use ora_fact_site in CONTEXT when present (org, country, enrolled, site PSM). That is the same Veeva site pack as Buddy — not live EDC.",
      "Finance / GM questions use lens_ns_projects (NetSuite Project Profitability). Null GM is missing, not zero. Do not treat blank as 0%.",
      "InsightsRM / RM questions use lens_rm_* packs joined per Model_Relationships (studyKey, employeeKey, roleId). If rows array in CONTEXT is non-empty, summarize those rows — never say no data when rows exist.",
      "Over-allocation = assigned FTE minus Dim_Employee.TimeAllocation. Blank FTE is missing, not zero.",
      "If CONTEXT is empty or thin, say what is missing.",
      "VIEWER is secondary context (Entra preference). Frame the narrative for that role. Do not change Cosmos numbers. Do not invent people, reports, or projects that are not in CONTEXT or VIEWER extras.",
      "If VIEWER says the project is primary, lead with the project then people. If VIEWER is a director, stay high-level. If VIEWER is a manager, lead with direct reports when CONTEXT has them.",
      "Read-only. No writes.",
      "Reply with JSON only:",
      '{"summary":"2-4 plain sentences","chartTitle":"short title","caveat":"one limitation","followUps":["q1","q2","q3"]}'
    ].join(" ")
  );
}

async function narrateWithFoundry(question, cosmosAnswer, viewerSlice) {
  if (!foundryConfigured()) {
    throw new Error(
      "Foundry is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT on this SWA."
    );
  }
  const cfg = azureConfig();
  const apiVersion = envSet("AZURE_OPENAI_API_VERSION") || "2024-08-01-preview";
  const context = {
    question,
    summary: cosmosAnswer.summary,
    chartTitle: cosmosAnswer.chartTitle,
    tableTitle: cosmosAnswer.tableTitle,
    cols: cosmosAnswer.cols,
    rows: (cosmosAnswer.rows || []).slice(0, 12),
    bars: (cosmosAnswer.bars || []).slice(0, 10),
    query: cosmosAnswer.query,
    caveat: cosmosAnswer.caveat,
    asOf: cosmosAnswer.asOfLabel,
    missingCount: cosmosAnswer.missingCount || 0,
    missingNote: cosmosAnswer.missingNote || "",
    containers: cosmosAnswer.trace
  };
  const viewer = viewerSlice || null;
  const messages = [
    { role: "system", content: systemPrompt(cfg) },
    {
      role: "user",
      content:
        `Question:\n${question}\n\nCONTEXT (JSON, Cosmos read-only):\n${JSON.stringify(context).slice(0, 70000)}` +
        (viewer ? `\n\nVIEWER (secondary, Entra preference — do not invent numbers):\n${JSON.stringify(viewer).slice(0, 8000)}` : "")
    }
  ];
  const attempts = buildChatAttempts(cfg.endpoint, cfg.deployment, apiVersion);
  const failures = [];
  for (const attempt of attempts) {
    const body = { ...attempt.body, messages };
    if (!("model" in attempt.body)) delete body.model;
    const res = await fetch(attempt.url, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": cfg.apiKey },
      body: JSON.stringify(body)
    });
    const respBody = await res.json().catch(() => ({}));
    if (res.ok) {
      const parsed = parseLensJson(extractText(respBody));
      return {
        summary: parsed.summary || cosmosAnswer.summary,
        chartTitle: parsed.chartTitle || cosmosAnswer.chartTitle,
        caveat: parsed.caveat || cosmosAnswer.caveat,
        followUps: Array.isArray(parsed.followUps) && parsed.followUps.length ? parsed.followUps : cosmosAnswer.followUps,
        model: respBody?.model || cfg.deployment,
        via: attempt.label,
        agentName: cfg.agentName
      };
    }
    const msg =
      respBody?.error?.message ||
      respBody?.error?.code ||
      (Object.keys(respBody || {}).length ? JSON.stringify(respBody).slice(0, 180) : res.statusText);
    failures.push(`${attempt.label} → ${res.status} ${msg}`);
    if (res.status !== 404) break;
  }
  throw new Error(
    `Foundry chat failed for deployment "${cfg.deployment}". Tried: ${failures.join(" | ")}`
  );
}

module.exports = { narrateWithFoundry, foundryConfigured, foundryStatus };
