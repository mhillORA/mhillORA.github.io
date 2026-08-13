const { app } = require("@azure/functions");
const { answerFromCosmos, getBriefing } = require("./ask");
const { getFinanceBriefing, getProjectBundle } = require("./projectJoin");
const { foundryStatus } = require("./foundry");

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
      access: "read-only",
      cosmos,
      foundry: foundryStatus()
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
      const answer = await answerFromCosmos(question, body.sources || [], {
        projectNumber: String(body.projectNumber || "").trim()
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
