const sql = require("mssql");
const { ensureContainers, upsertMany, getDb, LENS } = require("./cosmos");
const { GOLD_QUERIES } = require("./goldQueries");

function sqlConfig() {
  return {
    server: (process.env.SQL_SERVER || "").trim(),
    database: (process.env.SQL_DATABASE || "gold").trim(),
    user: (process.env.SQL_USER || "").trim(),
    password: (process.env.SQL_PASSWORD || "").trim(),
    options: {
      encrypt: true,
      trustServerCertificate: false
    }
  };
}

function hasSql() {
  const c = sqlConfig();
  return Boolean(c.server && c.user && c.password && !c.password.includes("SET_IN"));
}

function toDocs(rows, mapper) {
  return (rows || []).map(mapper);
}

async function runGoldSync({ triggeredBy = "timer" } = {}) {
  const runDate = new Date().toISOString().slice(0, 10);
  const started = new Date().toISOString();
  await ensureContainers();

  if (!hasSql()) {
    const note = "SQL_* not configured — skipped warehouse pull. Cosmos containers ensured.";
    await upsertMany(LENS.syncRuns, [)
      {
        id: `run-${started}`,
        runDate,
        docType: "syncRun",
        status: "skipped",
        triggeredBy,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        note
      }
    ]);
    return { status: "skipped", note };
  }

  const pool = await sql.connect(sqlConfig());
  const counts = {};

  try {
    const studies = await pool.request().query(GOLD_QUERIES.studies);
    counts.studies = await upsertMany(
      LENS.studies,
      toDocs(studies.recordset, (r) => ({
        id: String(r.study_code),
        studyCode: String(r.study_code),
        docType: "study",
        studyName: r.study_name,
        indication: r.indication,
        phase: r.phase,
        status: r.status,
        enrolled: Number(r.enrolled || 0),
        plannedToDate: Number(r.planned_to_date || 0),
        pctOfPlan: r.planned_to_date ? Number(r.enrolled) / Number(r.planned_to_date) : null,
        revenueAtRisk: Number(r.revenue_at_risk || 0),
        primaryDriver: r.primary_driver,
        fpiDate: r.fpi_date,
        sourceSystem: r.source_system,
        asOf: r.as_of,
        syncedAt: started
      }))
    );

    const visits = await pool.request().query(GOLD_QUERIES.visits);
    counts.visits = await upsertMany(
      LENS.visits,
      toDocs(visits.recordset, (r) => ({
        id: String(r.visit_id),
        studyCode: String(r.study_code),
        docType: "visit",
        subjectId: r.subject_id,
        siteId: r.site_id,
        visitName: r.visit_name,
        visitStatus: r.visit_status,
        visitDate: r.visit_date,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        asOf: r.as_of,
        syncedAt: started
      }))
    );

    const metrics = await pool.request().query(GOLD_QUERIES.metrics);
    counts.metrics = await upsertMany(
      LENS.metrics,
      toDocs(metrics.recordset, (r) => ({
        id: `${r.metric_type}:${r.grain_key}`,
        metricType: String(r.metric_type),
        grainKey: r.grain_key,
        docType: "metric",
        label: r.label,
        valueNum: Number(r.value_num || 0),
        valueText: r.value_text,
        colorHint: r.color_hint,
        chartGroup: r.chart_group,
        asOf: r.as_of,
        syncedAt: started
      }))
    );

    const sources = await pool.request().query(GOLD_QUERIES.sources);
    counts.sources = await upsertMany(
      LENS.sources,
      toDocs(sources.recordset, (r) => ({
        id: String(r.source_id),
        sourceId: String(r.source_id),
        docType: "source",
        name: r.name,
        category: r.category,
        lastSync: r.last_sync,
        scopeText: r.scope_text,
        fresh: Boolean(r.fresh)
      }))
    );
  } finally {
    await pool.close();
  }

  const finished = new Date().toISOString();
  await upsertMany(LENS.syncRuns, [)
    {
      id: `run-${started}`,
      runDate,
      docType: "syncRun",
      status: "ok",
      triggeredBy,
      startedAt: started,
      finishedAt: finished,
      counts
    }
  ]);

  return { status: "ok", counts, startedAt: started, finishedAt: finished };
}

async function latestSync() {
  try {
    const { resources } = await getDb()
      .container(LENS.syncRuns)
      .items.query({
        query: "SELECT TOP 1 * FROM c ORDER BY c.startedAt DESC"
      })
      .fetchAll();
    return resources[0] || null;
  } catch (_) {
    return null;
  }
}

module.exports = { runGoldSync, latestSync };
