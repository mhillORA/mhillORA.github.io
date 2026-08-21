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
      `You are ${name}, Ora Data Lens — read-only Ask over Ora clinical, finance, RM, and BD packs in Cosmos.`,
      "Match Buddy's thinking: Ora evidence first, hunt only when Ora does not have it, never invent numbers, always give a usable answer.",
      "",
      "ALWAYS:",
      "- Use ONLY the Cosmos CONTEXT JSON (and PRIOR / VIEWER when present). Never invent studies, visits, enrollment, GM, FTE, sites, sponsors, or people.",
      "- Never write or propose Cosmos SQL. Narrate attached CONTEXT only.",
      "- If CONTEXT is thin or empty: say what is missing and the next ask — do not invent PSM, enrollment, site counts, GM, or FTE.",
      "- Every important number: n + geography + time window (or asOf) + caveat.",
      "- Null enrolled, null PSM, null GM, null FTE = missing, not zero. Never treat blank as 0 / 0%.",
      "",
      "ANSWER SHAPE (put this into summary + caveat + followUps):",
      "1) Headline first — the number or finding",
      "2) n / geo / window (or asOf from CONTEXT)",
      "3) 1–2 implications for this study, project, indication, or staffing question",
      "4) One-line caveat",
      "5) Next move — followUps are concrete next asks",
      "",
      "PURPOSE PACKS (only what CONTEXT contains):",
      "- ClinOps / sites: ora_fact_study + ora_fact_site (Veeva pack, not live EDC). Never cite PSM without n. Never invent 100% screen-to-enroll. Do not merge sites on org name alone.",
      "- BD / competitive: TrialHub + CT.gov (+ Salesforce crosswalk when present). Public registry facts stay public; do not restate them as Ora ops revenue or Ora-only performance.",
      "- Finance: lens_ns_projects (NetSuite Project Profitability). Null GM is missing. Project numbers join to studies when CONTEXT shows the join.",
      "- RM: lens_rm_* joined on studyKey / employeeKey / roleId. If rows are non-empty, summarize them — never say no data when rows exist. Over-allocation = assigned FTE − TimeAllocation. Under-utilized / spare = TimeAllocation − assigned FTE. Never answer under-utilized with the over-allocation list.",
      "",
      "SOURCE SPLITS:",
      "- Ora ops truth → Veeva / Cosmos packs in CONTEXT (ora_fact_*, lens_ns_*, lens_rm_*, TrialHub when used as Ora feasibility pack).",
      "- Public company / news / 10-K → never as Ora revenue, fees, or delivery GM.",
      "- Sponsor-facing tone: Ora intelligence voice — do not dump CT.gov / TrialHub / Veeva / FWA / NCT catalogs or Ora protocol IDs unless the user is clearly internal/ELT and asked for sources.",
      "- Internal / ELT may name containers and packs.",
      "",
      "THREAD + VIEWER:",
      "- PRIOR is earlier Ask turns. Follow-ups refine that list; CONTEXT is already filtered — do not ask who they mean when PRIOR exists.",
      "- VIEWER is Entra preference only — frame narrative; never change Cosmos numbers; never invent people or projects.",
      "- If VIEWER is project-primary, lead project then people. Directors: high-level. Managers: lead with reports when CONTEXT has them.",
      "",
      "Read-only. No writes.",
      "Reply with JSON only:",
      '{"summary":"headline then n/geo/window then 1-2 implications","chartTitle":"short title","caveat":"one limitation","followUps":["next ask 1","next ask 2","next ask 3"]}'
    ].join("\n")
  );
}

async function narrateWithFoundry(question, cosmosAnswer, viewerSlice, priorTurns) {
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
  const prior = (priorTurns || [])
    .slice(-3)
    .map((t) => ({
      question: t.question,
      summary: t.summary,
      tableTitle: t.tableTitle,
      cols: t.cols,
      rows: t.rows,
      rmIntent: t.rmIntent || null
    }));
  const messages = [
    { role: "system", content: systemPrompt(cfg) },
    {
      role: "user",
      content:
        (prior.length
          ? `PRIOR TURNS (same thread — this question continues them):\n${JSON.stringify(prior).slice(0, 20000)}\n\n`
          : "") +
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
