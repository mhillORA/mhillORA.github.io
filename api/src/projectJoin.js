const { getDb, safeQuery, LENS } = require("./cosmos");
const { loadLivePack } = require("./veevaLive");

/**
 * Project number ↔ live ora_veeva_study.study_number is computed at read time.
 * There is no mapping container. Match on study_number (exact, prefix, or token).
 *
 * Ora NetSuite study numbers are YY-DEPT-SEQ (e.g. 25-150-0005 = year 2025, dept 150, seq 0005).
 * Study intel lives in ora_ns_study (alongside lens_ns_projects GM rows).
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

async function loadNsProjects() {
  return safeQuery(LENS.nsProjects, NS_SELECT, [{ name: "@t", value: "lens_ns_project" }]);
}

const NS_STUDY_SELECT =
  "SELECT TOP 50 c.id, c.project_number, c.project_name, c.project_manager, c.service_line, c.project_status, " +
  "c.start_date, c.calculated_end_date, c.total_budgeted, c.total_actual, c.total_etc, c.total_projected, " +
  "c.realization_rate, c.percent_complete, c.inv_fee_budget, c.inv_fee_actual, c.ptc_budget, c.ptc_actual, " +
  "c.oopc_labor_actual, c.oopc_travel_actual, c.ptc_categories, c.invoiced_amount, " +
  "c.revenue_recognized, c.cost_of_sales, c.gross_profit, c.gross_margin_pct, c.study_year, c.study_dept, " +
  "c.study_seq, c.pulledAt, c.syncedAt, c._ts FROM c WHERE c.docType = @t AND c.project_number = @pn";

async function loadNsStudyIntel(projectNumber) {
  const pn = String(projectNumber || "").trim();
  if (!pn) return [];
  return safeQuery("ora_ns_study", NS_STUDY_SELECT, [
    { name: "@t", value: "ora_ns_study" },
    { name: "@pn", value: pn }
  ]);
}

function compactStudyIntel(r) {
  return {
    id: r.id,
    project_number: r.project_number || "",
    project_name: r.project_name || "",
    project_manager: r.project_manager || "",
    service_line: r.service_line || "",
    project_status: r.project_status || "",
    study_year: r.study_year ?? null,
    study_dept: r.study_dept ?? null,
    study_seq: r.study_seq ?? null,
    total_budgeted: numOrNull(r.total_budgeted),
    total_actual: numOrNull(r.total_actual),
    total_etc: numOrNull(r.total_etc),
    total_projected: numOrNull(r.total_projected),
    realization_rate: numOrNull(r.realization_rate),
    percent_complete: numOrNull(r.percent_complete),
    inv_fee_budget: numOrNull(r.inv_fee_budget),
    inv_fee_actual: numOrNull(r.inv_fee_actual),
    ptc_budget: numOrNull(r.ptc_budget),
    ptc_actual: numOrNull(r.ptc_actual),
    oopc_labor_actual: numOrNull(r.oopc_labor_actual),
    oopc_travel_actual: numOrNull(r.oopc_travel_actual),
    ptc_categories: r.ptc_categories && typeof r.ptc_categories === "object" ? r.ptc_categories : null,
    invoiced_amount: numOrNull(r.invoiced_amount),
    revenue_recognized: numOrNull(r.revenue_recognized),
    cost_of_sales: numOrNull(r.cost_of_sales),
    gross_margin_pct: numOrNull(r.gross_margin_pct),
    pulledAt: r.pulledAt || r.syncedAt || null
  };
}

async function loadStudies() {
  const pack = await loadLivePack();
  return pack.studies || [];
}

function studiesForProject(studies, projectNumber) {
  return (studies || [])
    .filter((s) => studyMatchesProject(s.study_number, projectNumber))
    .map((s) => ({
      id: s.id || null,
      veeva_study_id: s.id || null,
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
    note: `${missing.length} job${missing.length === 1 ? "" : "s"} have GM% missing (not zero). Join to ora_veeva_study is computed here on project_number ↔ study_number — no mapping table.`,
    rows
  };
}

async function loadSitesForStudies(studyNumbers, opts = {}) {
  const maxStudies = Math.min(40, Math.max(8, Number(opts.maxStudies) || 24));
  const maxSites = Math.min(200, Math.max(48, Number(opts.maxSites) || 120));
  const nums = [...new Set((studyNumbers || []).map((s) => String(s || "").trim()).filter(Boolean))].slice(
    0,
    maxStudies
  );
  if (!nums.length) return [];
  const want = new Set(nums.map((s) => String(s).toUpperCase()));
  const pack = await loadLivePack();
  return (pack.sites || [])
    .filter((s) => {
      const sn = String(s.study_number || s.study_name || "").toUpperCase();
      const code = String(s.ora_project_code || "").toUpperCase();
      return want.has(sn) || [...want].some((pn) => studyMatchesProject(sn, pn) || studyMatchesProject(code, pn));
    })
    .slice(0, maxSites)
    .map((s) => ({
      study_name: s.study_name || "",
      study_number: s.study_number || "",
      site: s.org_clean || s.organization || "—",
      country: s.country || "",
      city: s.city || "",
      state: s.state || "",
      indication: s.indication || "",
      phase: s.phase || "",
      enrolled: enrolledOf(s),
      site_psm: s.site_psm != null ? s.site_psm : null,
      principal_investigator: s.principal_investigator || "",
      site_status: s.site_status || "",
      ora_project_code: s.ora_project_code || "",
      veeva_study_id: s.veeva_study_id || null
    }));
}

async function getProjectBundle(projectNumber, opts = {}) {
  getDb();
  const pn = String(projectNumber || "").trim();
  if (!pn || pn.length > 40) {
    return {
      project_number: pn,
      jobs: [],
      studyIntel: [],
      studies: [],
      sites: [],
      investigators: [],
      join: { method: "computed", matchedOn: "study_number", count: 0, note: "project_number required" }
    };
  }

  const [jobs, studies, studyIntelRaw] = await Promise.all([
    loadNsProjects(),
    loadStudies(),
    loadNsStudyIntel(pn)
  ]);
  const matchedJobs = jobs.filter((r) => normalizeId(r.project_number) === normalizeId(pn)).map(compactJob);
  const studyIntel = (studyIntelRaw || []).map(compactStudyIntel);
  const matchedStudies = studiesForProject(studies, pn);
  const sites = await loadSitesForStudies(
    matchedStudies.map((s) => s.study_number).concat([pn]),
    { maxStudies: opts.maxStudies || 24, maxSites: opts.maxSites || 120 }
  );
  const investigators = sites
    .filter((s) => String(s.principal_investigator || "").trim())
    .map((s) => ({
      pi: s.principal_investigator,
      site: s.site,
      study: s.study_number || s.study_name,
      country: s.country,
      enrolled: s.enrolled,
      site_psm: s.site_psm,
      site_status: s.site_status
    }));
  const kinds = [...new Set(matchedStudies.map((s) => s.match).filter(Boolean))];

  let note;
  if (!matchedJobs.length && !matchedStudies.length && !studyIntel.length) {
    note = `No lens_ns_projects / ora_ns_study row and no ora_veeva_study.study_number matching ${pn}. Join is computed at read time (exact / prefix / token on study_number). Format: YY-DEPT-SEQ.`;
  } else if (!matchedStudies.length) {
    note = `NetSuite has this project${studyIntel.length ? " (study intel present)" : ""}. No live Veeva study_number equals or contains ${pn}. There is no mapping table — if Vault uses a different study id, it will not join.`;
  } else if (!matchedJobs.length && !studyIntel.length) {
    note = `ora_veeva_study matched on study_number, but lens_ns_projects / ora_ns_study have no row for ${pn}.`;
  } else {
    const bits = [];
    if (matchedJobs.length) bits.push(`${matchedJobs.length} GM job(s)`);
    if (studyIntel.length) bits.push(`${studyIntel.length} study intel`);
    bits.push(`${matchedStudies.length} Veeva study row(s)`);
    if (sites.length) bits.push(`${sites.length} site(s)`);
    if (investigators.length) bits.push(`${investigators.length} PI(s)`);
    note = `Joined ${bits.join(" + ")} on project_number ↔ study_number (${kinds.join(", ") || "computed"}). YY-DEPT-SEQ. No mapping table.`;
  }

  const meta = asOfMeta([
    ...jobs.filter((r) => normalizeId(r.project_number) === normalizeId(pn)),
    ...studyIntelRaw,
    ...studies.filter((s) => studyMatchesProject(s.study_number, pn))
  ]);

  return {
    project_number: pn,
    asOf: meta.asOf,
    asOfLabel: meta.asOfLabel,
    jobs: matchedJobs,
    studyIntel,
    studies: matchedStudies,
    sites,
    investigators,
    join: {
      method: "computed",
      matchedOn: "project_number ↔ ora_veeva_study.study_number (+ site PI)",
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
