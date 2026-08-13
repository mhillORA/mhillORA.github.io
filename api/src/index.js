const { app } = require("@azure/functions");
const { answerFromCosmos } = require("./ask");

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
      cosmos
    });
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
      const answer = await answerFromCosmos(question, body.sources || []);
      return json(200, { answer });
    } catch (err) {
      return json(503, { error: String(err.message || err) });
    }
  }
});
