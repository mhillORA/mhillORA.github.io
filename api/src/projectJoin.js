const { getDb, safeQuery, LENS, SHARED_READ } = require("./cosmos");

/**
 * Project number ↔ ora_fact_study is computed at read time.
 * There is no mapping container. Match on study_number (exact, prefix, or token).
 */

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function enrolledOf(row) {
  if (row == null || row.total_enrolled == null || row.total_enrolled === "") return null;
  const n = Number(row.total_enrolled);
  return Number.isFinite(n) ? n : null;
}

function asOfMeta(rows) {
  const stamps = (rows || [])
    .map((r) => {
      if (typeof r._ts === "number" && r._ts > 0) return r._ts * 1000;
      const s = Date.parse(r.syncedAt || "");
      return Number.isFinite(s) ? s : 0;
    })
    .filter((n) => n > 0);
  if (!stamps.length) {
    const now = new Date();
    return {
      asOf: now.toISOString(),
      asOfLabel: `read ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      asOfKind: "query"
    };
  }
  const d = new Date(Math.max(...stamps));
  return {
    asOf: d.toISOString(),
    asOfLabel: `as of ${d.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    asOfKind: "document"
  };
}

function normalizeId(v) {
  return String(v || "").trim().toUpperCase();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a clinical study_number belongs to a NetSuite project_number. */
function studyMatchesProject(studyNumber, projectNumber) {
  const sn = normalizeId(studyNumber);
  const pn = normalizeId(projectNumber);
  if (!sn || !pn || pn.length < 4) return false;
  if (sn === pn) return true;
  if (sn.startsWith(`${pn} `) || sn.startsWith(`${pn}-`) || sn.startsWith(`${pn}_`) || sn.startsWith(`${pn}/`)) {
    return true;
  }
  return new RegExp(`(^|[^A-Z0-9])${escapeRe(pn)}([^A-Z0-9]|$)`).test(sn);
}

function matchKind(studyNumber, projectNumber) {
  const sn = normalizeId(studyNumber);
  const pn = normalizeId(projectNumber);
  if (sn === pn) return "exact";
  if (sn.startsWith(pn)) return "prefix";
  if (studyMatchesProject(studyNumber, projectNumber)) return "token";
  return null;
}

const NS_SELECT =
  "SELECT TOP 200 c.id, c.project_number, c.project_name, c.project_manager, c.customer_name, c.project_status, c.service_line, c.change_order_status, c.budgeted_gm_pct, c.actual_gm_pct_prior_month, c.gm_pct_variance, c.projected_eos_gm_pct_prior_month, c.cost_per_billable_hr_actual, c.cost_per_billable_hr_budgeted, c.sourceBlob, c.syncedAt, c._ts FROM c WHERE c.docType = @t";

const STUDY_SELECT =
  "SELECT TOP 200 c.study_number, c.sponsor, c.indication, c.phase, c.total_enrolled, c.psm, c.screen_fail_rate_recomputed, c.lifecycle_state, c.n_contributing_sites, c._ts FROM c WHERE c.docType = @t";

async function loadNsProjects() {
  return safeQuery(LENS.nsProjects, NS_SELECT, [{ name: "@t", value: "lens_ns_project" }]);
}

async function loadStudies() {
  return safeQuery(SHARED_READ.oraFactStudy, STUDY_SELECT, [{ name: "@t", value: "ora_fact_study" }]);
}

function studiesForProject(studies, projectNumber) {
  return (studies || [])
    .filter((s) => studyMatchesProject(s.study_number, projectNumber))
    .map((s) => ({
      study_number: s.study_number || "",
      sponsor: s.sponsor || "",
      indication: s.indication || "",
      phase: s.phase || "",
      total_enrolled: enrolledOf(s),
      psm: s.psm != null ? s.psm : null,
      screen_fail_rate: s.screen_fail_rate_recomputed != null ? s.screen_fail_rate_recomputed : null,
      lifecycle_state: s.lifecycle_state || "",
      n_contributing_sites: s.n_contributing_sites != null ? s.n_contributing_sites : null,
      match: matchKind(s.study_number, projectNumber)
    }));
}

function compactJob(r) {
  return {
    id: r.id,
    project_number: r.project_number || "",
    project_name: r.project_name || "",
    project_manager: r.project_manager || "",
    customer_name: r.customer_name || "",
    project_status: r.project_status || "",
    service_line: r.service_line || "",
    change_order_status: r.change_order_status || "",
    budgeted_gm_pct: numOrNull(r.budgeted_gm_pct),
    actual_gm_pct_prior_month: numOrNull(r.actual_gm_pct_prior_month),
    gm_pct_variance: numOrNull(r.gm_pct_variance),
    projected_eos_gm_pct_prior_month: numOrNull(r.projected_eos_gm_pct_prior_month),
    cost_per_billable_hr_actual: numOrNull(r.cost_per_billable_hr_actual),
    cost_per_billable_hr_budgeted: numOrNull(r.cost_per_billable_hr_budgeted)
  };
}

async function getFinanceBriefing() {
  getDb();
  const [jobs, studies] = await Promise.all([loadNsProjects(), loadStudies()]);
  const meta = asOfMeta(jobs);
  if (!jobs.length) {
    return {
      loaded: false,
      asOf: meta.asOf,
      asOfLabel: meta.asOfLabel,
      asOfKind: meta.asOfKind,
      projects: 0,
      uniqueNumbers: 0,
      withGm: 0,
      missingGm: 0,
      underGm: 0,
      overGm: 0,
      linked: 0,
      unlinked: 0,
      changeOrdersKnown: 0,
      serviceLines: [],
      note: "lens_ns_projects is empty. NetSuite ingest has not written a snapshot yet. Blank is missing, not zero.",
      rows: []
    };
  }

  const known = jobs.filter((r) => numOrNull(r.gm_pct_variance) != null);
  const missing = jobs.filter((r) => numOrNull(r.gm_pct_variance) == null);
  const under = known.filter((r) => numOrNull(r.gm_pct_variance) < 0);
  const over = known.filter((r) => numOrNull(r.gm_pct_variance) >= 0);
  const unique = new Set(jobs.map((r) => r.project_number).filter(Boolean));
  const byLine = {};
  for (const r of jobs) {
    const line = String(r.service_line || "").trim() || "(blank)";
    byLine[line] = (byLine[line] || 0) + 1;
  }

  const rows = jobs
    .slice()
    .sort((a, b) => {
      const av = numOrNull(a.gm_pct_variance);
      const bv = numOrNull(b.gm_pct_variance);
      if (av == null && bv == null) return String(a.project_number).localeCompare(String(b.project_number));
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    })
    .map((r) => {
      const linkedStudies = studiesForProject(studies, r.project_number);
      return {
        ...compactJob(r),
        linkedStudyCount: linkedStudies.length,
        linkedStudyNumbers: linkedStudies.map((s) => s.study_number)
      };
    });

  const linkedNumbers = new Set(rows.filter((r) => r.linkedStudyCount > 0).map((r) => r.project_number));

  return {
    loaded: true,
    asOf: meta.asOf,
    asOfLabel: meta.asOfLabel,
    asOfKind: meta.asOfKind,
    sourceBlob: jobs[0] && jobs[0].sourceBlob ? jobs[0].sourceBlob : "",
    projects: jobs.length,
    uniqueNumbers: unique.size,
    withGm: known.length,
    missingGm: missing.length,
    underGm: under.length,
    overGm: over.length,
    linked: linkedNumbers.size,
    unlinked: unique.size - linkedNumbers.size,
    changeOrdersKnown: jobs.filter((r) => String(r.change_order_status || "").trim()).length,
    serviceLines: Object.entries(byLine)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n })),
    note: `${missing.length} job${missing.length === 1 ? "" : "s"} have GM% missing (not zero). Join to ora_fact_study is computed here on project_number ↔ study_number — no mapping table.`,
    rows
  };
}

async function loadSitesForStudies(studyNumbers) {
  const nums = [...new Set((studyNumbers || []).map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 8);
  if (!nums.length) return [];
  const batches = await Promise.all(
    nums.map((sn) =>
      safeQuery(
        SHARED_READ.oraFactSite,
        `SELECT TOP 12 c.org_clean, c.organization, c.country, c.indication, c.phase, c.site_psm, c.total_enrolled, c.study_name, c._ts
         FROM c WHERE c.docType = @t AND c.study_name = @sn`,
        [
          { name: "@t", value: "ora_fact_site" },
          { name: "@sn", value: sn }
        ]
      )
    )
  );
  return batches.flat().map((s) => ({
    study_name: s.study_name || "",
    site: s.org_clean || s.organization || "—",
    country: s.country || "",
    indication: s.indication || "",
    phase: s.phase || "",
    enrolled: enrolledOf(s),
    site_psm: s.site_psm != null ? s.site_psm : null
  }));
}

async function getProjectBundle(projectNumber) {
  getDb();
  const pn = String(projectNumber || "").trim();
  if (!pn || pn.length > 40) {
    return {
      project_number: pn,
      jobs: [],
      studies: [],
      sites: [],
      join: { method: "computed", matchedOn: "study_number", count: 0, note: "project_number required" }
    };
  }

  const [jobs, studies] = await Promise.all([loadNsProjects(), loadStudies()]);
  const matchedJobs = jobs.filter((r) => normalizeId(r.project_number) === normalizeId(pn)).map(compactJob);
  const matchedStudies = studiesForProject(studies, pn);
  const sites = await loadSitesForStudies(matchedStudies.map((s) => s.study_number));
  const kinds = [...new Set(matchedStudies.map((s) => s.match).filter(Boolean))];

  let note;
  if (!matchedJobs.length && !matchedStudies.length) {
    note = `No lens_ns_projects row and no ora_fact_study.study_number matching ${pn}. Join is computed at read time (exact / prefix / token on study_number).`;
  } else if (!matchedStudies.length) {
    note = `NetSuite has this project. No ora_fact_study.study_number equals or contains ${pn}. There is no mapping table — if Veeva uses a different study id, it will not join.`;
  } else if (!matchedJobs.length) {
    note = `ora_fact_study matched on study_number, but lens_ns_projects has no job for ${pn}.`;
  } else {
    note = `Joined ${matchedJobs.length} NetSuite job${matchedJobs.length === 1 ? "" : "s"} to ${matchedStudies.length} ora_fact_study row${matchedStudies.length === 1 ? "" : "s"} on project_number ↔ study_number (${kinds.join(", ") || "computed"}). No mapping table.`;
  }

  const meta = asOfMeta([...jobs.filter((r) => normalizeId(r.project_number) === normalizeId(pn)), ...studies.filter((s) => studyMatchesProject(s.study_number, pn))]);

  return {
    project_number: pn,
    asOf: meta.asOf,
    asOfLabel: meta.asOfLabel,
    jobs: matchedJobs,
    studies: matchedStudies,
    sites,
    join: {
      method: "computed",
      matchedOn: "project_number ↔ ora_fact_study.study_number",
      count: matchedStudies.length,
      kinds,
      note
    }
  };
}

module.exports = {
  studyMatchesProject,
  getFinanceBriefing,
  getProjectBundle
};
