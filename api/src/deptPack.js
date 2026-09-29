/**
 * Department rollup from YY-DEPT-SEQ (middle segment).
 * e.g. 25-150-0005 → dept 150. Ask: "tell me about 150" / "dept 110".
 */

const { getDb, safeQuery, LENS } = require("./cosmos");

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deptFromProjectNumber(pn) {
  const m = String(pn || "")
    .trim()
    .match(/^\d{2}-(\d{3})-\d{4}$/);
  return m ? m[1] : null;
}

function normalizeDeptCode(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d{3}$/.test(s)) return s;
  if (/^\d{1,2}$/.test(s)) return s.padStart(3, "0");
  const m = s.match(/\bdept(?:artment)?\s*(\d{1,3})\b/i) || s.match(/\b(\d{3})\b/);
  if (!m) return null;
  return String(m[1]).padStart(3, "0");
}

/** Extract dept code from a question when user asks about a department (not a full YY-DEPT-SEQ). */
function deptCodeFromQuestion(text) {
  const t = String(text || "").trim();
  if (/\b\d{2}-\d{3}-\d{4}\b/.test(t)) return null; // full project number wins
  const explicit =
    t.match(/\b(?:dept|department|dept code|department code)\s*[#:]?\s*(\d{1,3})\b/i) ||
    t.match(/\b(?:about|for|on)\s+(\d{1,3})\b/i) ||
    t.match(/^(\d{1,3})\s*$/);
  if (explicit) return normalizeDeptCode(explicit[1]);
  // bare 3-digit in a short ask
  const bare = t.match(/\b(\d{3})\b/);
  if (bare && t.length < 80) return normalizeDeptCode(bare[1]);
  return null;
}

function cleanDeptName(serviceLine) {
  const sline = String(serviceLine || "").trim();
  if (!sline) return null;
  if (sline.includes(":")) return sline.split(":")[0].trim();
  if (/Clinical/i.test(sline)) return sline.split(/Clinical/i)[0].trim() || sline;
  return sline;
}

async function loadNsStudyRows() {
  return safeQuery(
    "ora_ns_study",
    `SELECT TOP 500 c.id, c.project_number, c.project_name, c.project_manager, c.service_line,
            c.project_status, c.study_dept, c.study_year, c.study_seq,
            c.total_budgeted, c.total_actual, c.percent_complete, c.realization_rate,
            c.inv_fee_budget, c.ptc_budget, c.invoiced_amount, c.revenue_recognized
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_ns_study" }]
  );
}

async function loadNsGmRows() {
  return safeQuery(
    LENS.nsProjects,
    `SELECT TOP 500 c.id, c.project_number, c.project_name, c.project_manager, c.service_line,
            c.project_status, c.budgeted_gm_pct, c.actual_gm_pct_prior_month, c.gm_pct_variance,
            c.change_order_status, c.customer_name
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "lens_ns_project" }]
  );
}

function rowDept(r) {
  if (r.study_dept != null && String(r.study_dept).trim()) {
    return normalizeDeptCode(r.study_dept);
  }
  return deptFromProjectNumber(r.project_number);
}

async function getDepartmentBundle(deptCode) {
  getDb();
  const code = normalizeDeptCode(deptCode);
  if (!code) {
    return {
      dept_code: null,
      loaded: false,
      note: "Department code required (e.g. 110, 150)."
    };
  }

  const [studies, jobs] = await Promise.all([loadNsStudyRows(), loadNsGmRows()]);
  const studyRows = (studies || []).filter((r) => rowDept(r) === code);
  const jobRows = (jobs || []).filter((r) => deptFromProjectNumber(r.project_number) === code);

  const nameVotes = {};
  for (const r of [...studyRows, ...jobRows]) {
    const n = cleanDeptName(r.service_line);
    if (!n) continue;
    nameVotes[n] = (nameVotes[n] || 0) + 1;
  }
  const deptName =
    Object.entries(nameVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || `Department ${code}`;

  const pms = [...new Set([...studyRows, ...jobRows].map((r) => r.project_manager).filter(Boolean))];
  const statuses = {};
  for (const r of studyRows) {
    const st = String(r.project_status || "").trim() || "(blank)";
    statuses[st] = (statuses[st] || 0) + 1;
  }

  const sum = (rows, field) =>
    rows.reduce((s, r) => s + (num(r[field]) != null ? num(r[field]) : 0), 0);
  const knownGm = jobRows.filter((r) => num(r.gm_pct_variance) != null);
  const underGm = knownGm.filter((r) => num(r.gm_pct_variance) < 0);

  const projectNumbers = [
    ...new Set(
      [...studyRows, ...jobRows].map((r) => r.project_number).filter(Boolean)
    )
  ].sort();

  return {
    dept_code: code,
    dept_name: deptName,
    loaded: studyRows.length > 0 || jobRows.length > 0,
    studies: studyRows.length,
    gm_jobs: jobRows.length,
    projects: projectNumbers.length,
    project_numbers: projectNumbers,
    project_managers: pms,
    status_counts: Object.entries(statuses)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n })),
    totals: {
      budgeted_hours: studyRows.length ? sum(studyRows, "total_budgeted") : null,
      actual_hours: studyRows.length ? sum(studyRows, "total_actual") : null,
      inv_fee_budget: studyRows.length ? sum(studyRows, "inv_fee_budget") : null,
      ptc_budget: studyRows.length ? sum(studyRows, "ptc_budget") : null,
      invoiced_amount: studyRows.length ? sum(studyRows, "invoiced_amount") : null,
      revenue_recognized: studyRows.length ? sum(studyRows, "revenue_recognized") : null
    },
    gm: {
      with_variance: knownGm.length,
      under_gm: underGm.length,
      missing_gm: jobRows.length - knownGm.length
    },
    study_rows: studyRows
      .slice()
      .sort((a, b) => String(a.project_number).localeCompare(String(b.project_number)))
      .slice(0, 80)
      .map((r) => ({
        project_number: r.project_number,
        project_name: r.project_name || "",
        project_manager: r.project_manager || "",
        project_status: r.project_status || "",
        service_line: r.service_line || "",
        percent_complete: num(r.percent_complete),
        inv_fee_budget: num(r.inv_fee_budget),
        invoiced_amount: num(r.invoiced_amount),
        total_budgeted: num(r.total_budgeted),
        total_actual: num(r.total_actual)
      })),
    job_rows: jobRows
      .slice()
      .sort((a, b) => {
        const av = num(a.gm_pct_variance);
        const bv = num(b.gm_pct_variance);
        if (av == null && bv == null) return String(a.project_number).localeCompare(String(b.project_number));
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      })
      .slice(0, 80)
      .map((r) => ({
        project_number: r.project_number,
        project_name: r.project_name || "",
        customer_name: r.customer_name || "",
        service_line: r.service_line || "",
        budgeted_gm_pct: num(r.budgeted_gm_pct),
        actual_gm_pct_prior_month: num(r.actual_gm_pct_prior_month),
        gm_pct_variance: num(r.gm_pct_variance),
        change_order_status: r.change_order_status || ""
      })),
    note: studyRows.length || jobRows.length
      ? `Dept ${code} (${deptName}) from YY-DEPT-SEQ middle segment on ora_ns_study / lens_ns_projects.`
      : `No NetSuite study/GM rows with department code ${code}.`
  };
}

module.exports = {
  normalizeDeptCode,
  deptCodeFromQuestion,
  deptFromProjectNumber,
  getDepartmentBundle
};
