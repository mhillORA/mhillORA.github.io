const { app } = require("@azure/functions");
const { answerFromCosmos, getBriefing, getSfBriefing } = require("./ask");
const { getFinanceBriefing, getProjectBundle } = require("./projectJoin");
const { getRmBriefing, getRmPeopleBoard } = require("./rmPack");
const { foundryStatus } = require("./foundry");
const { principalFromRequest } = require("./principal");
const { getViewerContext, upsertPref, deletePref } = require("./userPrefs");
const { graphStatus } = require("./graph");
const { getSyncStatus } = require("./syncStatus");

/**
 * CORS for SWA ↔ Functions (same host usually skips preflight; still needed for
 * local vite, cross-subdomain, and custom headers). Echo Origin when present.
 */
function corsHeaders(request = null) {
  const reqOrigin = request
    ? String(
        (typeof request.headers?.get === "function"
          ? request.headers.get("origin") || request.headers.get("Origin")
          : "") || ""
      ).trim()
    : "";
  const allowed = String(process.env.LENS_CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  let origin = "*";
  if (allowed.length) {
    const o = reqOrigin.replace(/\/$/, "");
    origin = o && allowed.includes(o) ? o : allowed[0];
  } else if (reqOrigin) {
    origin = reqOrigin;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "content-type, authorization, x-ms-client-principal, x-ms-client-principal-id, x-ms-client-principal-name",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(status, body, request = null) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request)
    },
    jsonBody: body
  };
}

function optionsOk(request) {
  return { status: 204, headers: corsHeaders(request) };
}

app.http("health", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "health",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const cosmos = Boolean(
      (process.env.COSMOS_ENDPOINT || "").trim() &&
        (process.env.COSMOS_KEY || "").trim() &&
        !(process.env.COSMOS_KEY || "").includes("SET_IN")
    );
    return json(
      200,
      {
        ok: true,
        app: "ora-data-lens",
        access: "read-only except lens_user_prefs (own Entra doc)",
        cosmos,
        foundry: foundryStatus(),
        graph: graphStatus()
      },
      request
    );
  }
});

app.http("briefing", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "briefing",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const briefing = await getBriefing();
      return json(200, { briefing }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

/** Cosmos feed counts + syncState watermarks for the Sources / Data Sync Status page. */
app.http("syncStatus", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sync-status",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const status = await getSyncStatus();
      return json(200, status, request);
    } catch (err) {
      return json(503, { ok: false, error: String(err.message || err) }, request);
    }
  }
});

app.http("ask", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      body = {};
    }
    const question = String(body.question || "").trim();
    if (!question) return json(400, { error: "question required" }, request);
    try {
      const principal = principalFromRequest(request);
      const answer = await answerFromCosmos(question, body.sources || [], {
        projectNumber: String(body.projectNumber || "").trim(),
        principal,
        prior: Array.isArray(body.prior) ? body.prior.slice(-3) : []
      });
      return json(200, { answer }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

app.http("finance", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "finance",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const finance = await getFinanceBriefing();
      return json(200, { finance }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

app.http("pipeline", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "pipeline",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const pipeline = await getSfBriefing();
      return json(200, { pipeline }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

app.http("rmBriefing", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "rm",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const rm = await getRmBriefing();
      return json(200, { rm }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

app.http("rmPeople", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "rm/people",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    try {
      const people = await getRmPeopleBoard();
      return json(200, { people }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});

app.http("meContext", {
  methods: ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "me/context",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const principal = principalFromRequest(request);
    if (!principal) {
      return json(401, { error: "sign in with Entra to load or save context" }, request);
    }
    try {
      if (request.method === "GET") {
        const context = await getViewerContext(principal);
        return json(200, { context }, request);
      }
      if (request.method === "DELETE") {
        const context = await deletePref(principal);
        return json(200, { context, deleted: true }, request);
      }
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        body = {};
      }
      const context = await upsertPref(principal, {
        roleKey: body.roleKey,
        notes: body.notes,
        extras: body.extras,
        useEntra: body.useEntra === true
      });
      return json(200, { context }, request);
    } catch (err) {
      const msg = String(err.message || err);
      const code = /unknown roleKey|signed-in/.test(msg) ? 400 : 503;
      return json(code, { error: msg }, request);
    }
  }
});

app.http("project", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "project",
  handler: async (request) => {
    if (request.method === "OPTIONS") return optionsOk(request);
    const number = String(request.query.get("number") || request.query.get("id") || "").trim();
    if (!number) return json(400, { error: "number required" }, request);
    try {
      const project = await getProjectBundle(number);
      return json(200, { project }, request);
    } catch (err) {
      return json(503, { error: String(err.message || err) }, request);
    }
  }
});
