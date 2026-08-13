const { app } = require("@azure/functions");
const { answerFromCosmos } = require("./ask");
const { runGoldSync, latestSync } = require("./goldSync");

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

function headerGet(request, name) {
  return (
    request.headers.get(name) ||
    request.headers.get(name.toLowerCase()) ||
    request.headers.get(name.toUpperCase()) ||
    ""
  );
}

function authorizeSync(request) {
  const expected = String(process.env.GOLD_SYNC_KEY || "").trim();
  const got = String(headerGet(request, "x-sync-key") || "").trim();
  if (expected && !expected.includes("SET_IN") && got === expected) {
    return { ok: true, via: "sync_key" };
  }
  return { ok: false };
}

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async () => json(200, { ok: true, app: "ora-data-lens" })
});

app.http("ask", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
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
      const answer = await answerFromCosmos(question, body.sources || []);
      if (!answer) return json(204, { demo: true, reason: "no cosmos rows; UI will use canned mock" });
      return json(200, { answer });
    } catch (err) {
      return json(204, { demo: true, reason: String(err.message || err) });
    }
  }
});

app.http("goldSync", {
  methods: ["POST"],
  route: "gold/sync",
  authLevel: "anonymous",
  handler: async (request) => {
    if (!authorizeSync(request)) return json(401, { error: "unauthorized" });
    try {
      const result = await runGoldSync({ triggeredBy: "http" });
      return json(200, result);
    } catch (err) {
      return json(500, { error: String(err.message || err) });
    }
  }
});

app.http("goldStatus", {
  methods: ["GET"],
  route: "gold/status",
  authLevel: "anonymous",
  handler: async () => json(200, { last: await latestSync() })
});

app.timer("goldDaily", {
  schedule: "0 0 11 * * *",
  handler: async (_myTimer, context) => {
    try {
      const result = await runGoldSync({ triggeredBy: "timer" });
      context.log("goldDaily", result);
    } catch (err) {
      context.error("goldDaily failed", err);
      throw err;
    }
  }
});
