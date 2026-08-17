const { app } = require("@azure/functions");
const { loadWorkbookToCosmos, loadStaffingBuffer, runRmIngest } = require("./load");
const { classifyCsvName } = require("./csvStaffing");

async function runLatest(_timer, context) {
  process.env.TZ = "America/New_York";
  const result = await runRmIngest((m) => context.log(m));
  context.log(JSON.stringify(result));
}

/** 6:35 AM Eastern daily — after NetSuite 6:05 and Salesforce 6:20. Separate Function App. */
app.timer("rmLoad_0635ET", {
  schedule: "0 35 6 * * *",
  handler: runLatest
});

app.http("rmLoadNow", {
  methods: ["POST"],
  authLevel: "function",
  route: "rm/load",
  handler: async (request, context) => {
    try {
      const result = await runRmIngest((m) => context.log(m));
      return { status: 200, jsonBody: { ok: true, ...result } };
    } catch (err) {
      context.error(String(err.stack || err));
      return { status: 500, jsonBody: { ok: false, error: String(err.message || err) } };
    }
  }
});

app.storageBlob("rmLandingToCosmos", {
  path: "insightsrm/landing/{year}/{month}/{day}/{run}/{name}",
  connection: "INSIGHTSRM_STORAGE",
  handler: async (blob, context) => {
    const name = String(context.triggerMetadata.name || "");
    const year = context.triggerMetadata.year;
    const month = context.triggerMetadata.month;
    const day = context.triggerMetadata.day;
    const run = context.triggerMetadata.run;
    const blobPath = `landing/${year}/${month}/${day}/${run}/${name}`;
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const log = (m) => context.log(m);
    if (name.startsWith("~$")) {
      log(`skip ${blobPath}`);
      return;
    }
    if (/\.xlsx$/i.test(name)) {
      const result = await loadWorkbookToCosmos(buffer, blobPath, log);
      context.log(JSON.stringify(result));
      return;
    }
    if (/\.zip$/i.test(name) || classifyCsvName(name)) {
      const result = await loadStaffingBuffer(buffer, blobPath, name, log);
      context.log(JSON.stringify(result));
      return;
    }
    log(`skip ${blobPath}`);
  }
});
