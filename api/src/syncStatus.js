/**
 * Read-only Data Sync Status for Ora Data Lens Sources page.
 * Counts Cosmos containers + syncState watermarks written by Buddy / ingest jobs.
 *
 * Project numbers (NetSuite study intel): YY-DEPT-SEQ
 *   e.g. 25-150-0005 → year 2025, dept 150, study sequence 0005 that year.
 * Join to Veeva on project_number ↔ ora_veeva_study.study_number.
 */

const { getDb, safeQuery, LENS, SHARED_READ } = require("./cosmos");

const NS_STUDY = "ora_ns_study";
const NS_TASK = "ora_ns_task";
const SYNC_NS_STUDY = "netsuite_study_intel";

async function countDocs(containerId, docType) {
  const rows = await safeQuery(
    containerId,
    "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
    [{ name: "@t", value: docType }]
  );
  return typeof rows[0] === "number" ? rows[0] : 0;
}

async function readSyncState(id) {
  try {
    const { resource } = await getDb().container(SHARED_READ.syncState).item(id, id).read();
    return resource || null;
  } catch (_) {
    return null;
  }
}

function ageLabel(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function feed({
  id,
  name,
  role,
  container,
  docType,
  count,
  lastSuccessfulSync,
  syncId,
  note,
  joinKey
}) {
  const n = typeof count === "number" ? count : 0;
  return {
    id,
    name,
    role,
    container,
    docType,
    count: n,
    loaded: n > 0,
    lastSuccessfulSync: lastSuccessfulSync || null,
    lastSyncLabel: ageLabel(lastSuccessfulSync),
    syncId: syncId || null,
    note: note || null,
    joinKey: joinKey || null
  };
}

async function getSyncStatus() {
  const nsStudySync = await readSyncState(SYNC_NS_STUDY);

  const [
    nsStudyCount,
    nsTaskCount,
    nsGmCount,
    veevaStudyCount,
    veevaSiteCount,
    sfOppCount,
    ctgovCount,
    trialhubCount,
    rmActualsCount
  ] = await Promise.all([
    countDocs(NS_STUDY, NS_STUDY),
    countDocs(NS_TASK, NS_TASK),
    countDocs(LENS.nsProjects, "lens_ns_project"),
    countDocs(SHARED_READ.veevaStudy, "ora_veeva_study"),
    countDocs(SHARED_READ.veevaSite, "ora_veeva_site"),
    countDocs(SHARED_READ.sfOpportunity, "ora_sf_opportunity"),
    countDocs(SHARED_READ.oraCtgov, "ora_ctgov_trial"),
    countDocs(SHARED_READ.oraTrialhub, "ora_trialhub_trial"),
    countDocs(LENS.rmActuals, "lens_rm_actual")
  ]);

  const feeds = [
    feed({
      id: "ns_study",
      name: "NetSuite study intel",
      role: "Study KPIs / BVA / inv+PTC (YY-DEPT-SEQ)",
      container: NS_STUDY,
      docType: NS_STUDY,
      count: nsStudyCount,
      lastSuccessfulSync: nsStudySync?.lastSuccessfulSync,
      syncId: SYNC_NS_STUDY,
      joinKey: "project_number ↔ ora_veeva_study.study_number",
      note:
        "Pushed by netsuite-pull-job after SuiteQL + Excel (POST Buddy /api/netsuite/study-sync). Excel still written for PMs."
    }),
    feed({
      id: "ns_task",
      name: "NetSuite study tasks",
      role: "Task-level BVA / % complete",
      container: NS_TASK,
      docType: NS_TASK,
      count: nsTaskCount,
      lastSuccessfulSync: nsStudySync?.lastSuccessfulSync,
      syncId: SYNC_NS_STUDY,
      joinKey: "project_number",
      note: "Optional batch with study intel upsert."
    }),
    feed({
      id: "ns_gm",
      name: "NetSuite GM (profitability)",
      role: "Project Profitability snapshot",
      container: LENS.nsProjects,
      docType: "lens_ns_project",
      count: nsGmCount,
      note: "Blob CSV → lens_ns_projects (separate from study intel)."
    }),
    feed({
      id: "veeva_study",
      name: "Veeva studies",
      role: "Live Vault studies",
      container: SHARED_READ.veevaStudy,
      docType: "ora_veeva_study",
      count: veevaStudyCount,
      joinKey: "study_number"
    }),
    feed({
      id: "veeva_site",
      name: "Veeva sites",
      role: "Live Vault sites",
      container: SHARED_READ.veevaSite,
      docType: "ora_veeva_site",
      count: veevaSiteCount
    }),
    feed({
      id: "salesforce",
      name: "Salesforce opportunities",
      role: "Pipeline (Ora net $)",
      container: SHARED_READ.sfOpportunity,
      docType: "ora_sf_opportunity",
      count: sfOppCount
    }),
    feed({
      id: "ctgov",
      name: "ClinicalTrials.gov",
      role: "Public registry",
      container: SHARED_READ.oraCtgov,
      docType: "ora_ctgov_trial",
      count: ctgovCount
    }),
    feed({
      id: "trialhub",
      name: "TrialHub",
      role: "Industry feasibility",
      container: SHARED_READ.oraTrialhub,
      docType: "ora_trialhub_trial",
      count: trialhubCount
    }),
    feed({
      id: "insightsrm",
      name: "InsightsRM actuals",
      role: "RM star schema (until DW)",
      container: LENS.rmActuals,
      docType: "lens_rm_actual",
      count: rmActualsCount
    })
  ];

  return {
    ok: true,
    asOf: new Date().toISOString(),
    projectNumberFormat: "YY-DEPT-SEQ (e.g. 25-150-0005 = year 2025, dept 150, seq 0005)",
    netsuiteStudy: {
      syncId: SYNC_NS_STUDY,
      lastSuccessfulSync: nsStudySync?.lastSuccessfulSync || null,
      lastTriggeredBy: nsStudySync?.lastTriggeredBy || null,
      lastSource: nsStudySync?.lastSource || null,
      lastStudyUpserted: nsStudySync?.lastStudyUpserted ?? null,
      lastTaskUpserted: nsStudySync?.lastTaskUpserted ?? null,
      sampleProjectNumbers: nsStudySync?.sampleProjectNumbers || [],
      studies: nsStudyCount,
      tasks: nsTaskCount
    },
    feeds
  };
}

module.exports = { getSyncStatus, SYNC_NS_STUDY, NS_STUDY, NS_TASK };
