const { app } = require("@azure/functions");
const { answerFromCosmos, getBriefing } = require("./ask");
const { getFinanceBriefing, getProjectBundle } = require("./projectJoin");
const { foundryStatus } = require("./foundry");
const { principalFromRequest } = require("./principal");
const { getViewerContext, upsertPref, deletePref } = require("./userPrefs");
const { graphStatus } = require("./graph");

function json(status, body) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    jsonBody: body
  };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const cosmos = Boolean(
      (process.env.COSMOS_ENDPOINT || "").trim() &&
        (process.env.COSMOS_KEY || "").trim() &&
        !(process.env.COSMOS_KEY || "").includes("SET_IN")
    );
    return json(200, {
      ok: true,
      app: "ora-data-lens",
      access: "read-only except lens_user_prefs (own Entra doc)",
      cosmos,
      foundry: foundryStatus(),
      graph: graphStatus()
    });
  }
});

app.http("briefing", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "briefing",
  handler: async () => {
    try {
      const briefing = await getBriefing();
      return json(200, { briefing });
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
});

app.http("ask", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "ask",
  handler: async (request) => {
    if (request.method === "OPTIONS") return json(204, {});
    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      body = {};
    }
    const question = String(body.question || "").trim();
    if (!question) return json(400, { error: "question required" });
    try {
      const principal = principalFromRequest(request);
      const answer = await answerFromCosmos(question, body.sources || [], {
        projectNumber: String(body.projectNumber || "").trim(),
        principal
      });
      return json(200, { answer });
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
});

app.http("finance", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "finance",
  handler: async () => {
    try {
      const finance = await getFinanceBriefing();
      return json(200, { finance });
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
});

app.http("meContext", {
  methods: ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "me/context",
  handler: async (request) => {
    if (request.method === "OPTIONS") return json(204, {});
    const principal = principalFromRequest(request);
    if (!principal) return json(401, { error: "sign in with Entra to load or save context" });
    try {
      if (request.method === "GET") {
        const context = await getViewerContext(principal);
        return json(200, { context });
      }
      if (request.method === "DELETE") {
        const context = await deletePref(principal);
        return json(200, { context, deleted: true });
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
      return json(200, { context });
    } catch (err) {
      const msg = String(err.message || err);
      const code = /unknown roleKey|signed-in/.test(msg) ? 400 : 503;
      return json(code, { error: msg });
    }
  }
});

app.http("project", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "project",
  handler: async (request) => {
    const number = String(request.query.get("number") || request.query.get("id") || "").trim();
    if (!number) return json(400, { error: "number required" });
    try {
      const project = await getProjectBundle(number);
      return json(200, { project });
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
});
