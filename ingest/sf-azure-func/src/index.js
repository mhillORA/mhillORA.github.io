const { app } = require("@azure/functions");
const { runSfIngest } = require("./sf");

/** 6:20 AM Eastern daily — after NetSuite 6:05. */
app.timer("sfLoad_0620ET", {
  schedule: "0 20 6 * * *",
  handler: async (myTimer, context) => {
    process.env.TZ = "America/New_York";
    try {
      const result = await runSfIngest(context);
      context.log("sf ingest done", result);
    } catch (err) {
      context.error(String(err.message || err));
      throw err;
    }
  }
});

app.http("sfLoadNow", {
  methods: ["POST"],
  authLevel: "function",
  route: "sf/load",
  handler: async (request, context) => {
    try {
      const result = await runSfIngest(context);
      return {
        status: 200,
        jsonBody: { ok: true, ...result }
      };
    } catch (err) {
      return {
        status: 500,
        jsonBody: { ok: false, error: String(err.message || err) }
      };
    }
  }
});
