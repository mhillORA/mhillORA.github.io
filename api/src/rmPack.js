const { safeQuery, LENS } = require("./cosmos");
const { RM_DQ, FACT_ENRICH, RM_ENTITIES, RM_LANDING } = require("./rmSchema");

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function pickField(row, ...keys) {
  if (!row) return null;
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
  }
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = keys.map(norm);
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === "") continue;
    const nk = norm(k);
    if (want.includes(nk)) return v;
  }
  return null;
}

function slugName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function indexBy(rows, key) {
  const m = new Map();
  for (const r of rows || []) {
    const id = pickField(r, key, `${key.charAt(0).toUpperCase()}${key.slice(1)}`);
    if (id != null && id !== "") m.set(String(id), r);
  }
  return m;
}

function studyKeyFromQuestion(question) {
  const a = String(question).match(/\b\d{2}-\d{3}-\d{4}\b/);
  if (a) return a[0];
  const b = String(question).match(/\bO-\d{4,}\b/i);
  if (b) return b[0];
  return "";
}

function parseRmIntent(question) {
  const t = String(question || "").toLowerCase();
  return {
    studyKey: studyKeyFromQuestion(question),
    wantOver: /(over.?allocat|overbook|too many hours)/.test(t),
    wantGap: /(capacity|headcount|gap|shortfall|demand|short on)/.test(t),
    wantAssign: /(assign|booked|staffed|who is on|who.?s on|cra)/.test(t),
    craOnly: /\bcra\b/.test(t),
    wantOverview: /(overview|summary|briefing|what.?s loaded|how many)/.test(t)
  };
}

async function countDocs(containerId, docType) {
  if (!containerId) return 0;
  try {
    const rows = await safeQuery(
      containerId,
      "SELECT VALUE COUNT(1) FROM c WHERE c.docType = @t",
      [{ name: "@t", value: docType }]
    );
    return rows[0] || 0;
  } catch (_) {
    return 0;
  }
}

async function loadLatestRun() {
  const rows = await safeQuery(
    LENS.rmRuns,
    "SELECT TOP 1 c.finishedAt, c.sourceBlob, c.ok, c.counts, c.startedAt, c._ts FROM c WHERE c.docType = @t ORDER BY c._ts DESC",
    [{ name: "@t", value: "lens_rm_run" }]
  );
  return rows[0] || null;
}

async function loadDimensions() {
  const [employees, roles, studies, activities] = await Promise.all([
    safeQuery(LENS.rmEmployees, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Employee.docType }]),
    safeQuery(LENS.rmRoles, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Role.docType }]),
    safeQuery(LENS.rmStudies, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Study.docType }]),
    safeQuery(LENS.rmActivities, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Activity.docType }])
  ]);
  const roster = await safeQuery(LENS.rmRoster, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_LANDING.roster.docType }]);
  const nameByKey = new Map();
  for (const r of roster) {
    if (r.nameKey) nameByKey.set(String(r.nameKey), r);
  }
  for (const e of employees) {
    const nk = slugName(pickField(e, "fullName"));
    if (nk && !nameByKey.has(nk)) nameByKey.set(nk, e);
  }
  return {
    employeeByKey: indexBy(employees, "employeeKey"),
    roleById: indexBy(roles, "roleId"),
    studyByKey: indexBy(studies, "studyKey"),
    activityById: indexBy(activities, "activityId"),
    nameByKey,
    employees,
    roles,
    studies
  };
}

function enrichFact(factName, row, dims) {
  const spec = FACT_ENRICH[factName];
  if (!spec) return { ...row };
  const out = { ...row };
  for (const j of spec) {
    const fk = pickField(row, j.factCol);
    let dim = null;
    if (j.dim === "Dim_Employee") dim = dims.employeeByKey.get(String(fk));
    else if (j.dim === "Dim_Role") dim = dims.roleById.get(String(fk));
    else if (j.dim === "Dim_Study") dim = dims.studyByKey.get(String(fk));
    else if (j.dim === "Dim_Activity") dim = dims.activityById.get(String(fk));
    if (!dim) continue;
    for (const f of j.fields) {
      const v = pickField(dim, f);
      if (v != null && v !== "" && out[f] == null) out[f] = v;
    }
  }
  if (!out.employeeName) out.employeeName = pickField(out, "fullName");
  if (!out.activity) out.activity = pickField(out, "activityName", "activityNameRaw");
  if (!out.studyLabel && out.studyKey) {
    const s = dims.studyByKey.get(String(out.studyKey));
    out.studyLabel = s ? pickField(s, "studyLabel", "studyName") || out.studyKey : out.studyKey;
  }
  if (!out.roleCode) {
    const role = dims.roleById.get(String(pickField(out, "roleId")));
    out.roleCode = role ? pickField(role, "roleCode") : null;
  }
  return out;
}

function normalizeOverRow(row, dims) {
  const employeeKey = pickField(row, "employeeKey");
  const emp = employeeKey ? dims.employeeByKey.get(String(employeeKey)) : null;
  const fullName =
    pickField(row, "fullName", "employeeName", "name") || (emp ? pickField(emp, "fullName") : null);
  const jobTitle = pickField(row, "jobTitle", "title") || (emp ? pickField(emp, "jobTitle") : null);
  const timeAllocation =
    numOrNull(pickField(row, "timeAllocation", "timeAllocationFte")) ??
    numOrNull(emp ? pickField(emp, "timeAllocation") : null) ??
    1;
  const currentAssignedFte =
    numOrNull(pickField(row, "currentAssignedFte", "currentAssignedFTE", "assignedFte", "valueFte")) ?? null;
  let overAllocationFte = numOrNull(pickField(row, "overAllocationFte", "overAllocationFTE", "overFte"));
  if (overAllocationFte == null && currentAssignedFte != null) {
    overAllocationFte = currentAssignedFte - timeAllocation;
  }
  if (overAllocationFte == null || overAllocationFte <= 0.001) return null;
  return {
    employeeKey,
    fullName,
    jobTitle,
    timeAllocation,
    currentAssignedFte,
    overAllocationFte,
    active: pickField(row, "active"),
    contractor: pickField(row, "contractor"),
    source: pickField(row, "source") || "dq04",
    _ts: row._ts
  };
}

function normalizeGapRow(row) {
  const gapFte = numOrNull(pickField(row, "gapFte", "gapFTE"));
  if (gapFte == null) return null;
  return {
    roleCode: pickField(row, "roleCode"),
    roleGroup: pickField(row, "roleGroup"),
    capacityFte: numOrNull(pickField(row, "capacityFte", "capacityFTE")),
    currentDemandFte: numOrNull(pickField(row, "currentDemandFte", "currentDemandFTE")),
    gapFte,
    note: pickField(row, "note"),
    _ts: row._ts
  };
}

async function loadDqOver(dims) {
  const raw = await safeQuery(LENS.rmDq, "SELECT * FROM c WHERE c.docType = @t AND c.sheet = @s", [
    { name: "@t", value: "lens_rm_dq" },
    { name: "@s", value: RM_DQ.overAllocated.sheet }
  ]);
  const out = [];
  for (const r of raw) {
    const n = normalizeOverRow({ ...r, source: "dq04" }, dims);
    if (n) out.push(n);
  }
  return out;
}

async function loadDqGaps() {
  const raw = await safeQuery(LENS.rmDq, "SELECT * FROM c WHERE c.docType = @t AND c.sheet = @s", [
    { name: "@t", value: "lens_rm_dq" },
    { name: "@s", value: RM_DQ.capacityGaps.sheet }
  ]);
  return raw.map(normalizeGapRow).filter(Boolean);
}

async function loadOverFromAssignments(dims) {
  const rows = await safeQuery(LENS.rmAssignments, "SELECT * FROM c WHERE c.docType = @t", [
    { name: "@t", value: RM_ENTITIES.Fact_Assignments.docType }
  ]);
  const byEmp = new Map();
  for (const raw of rows) {
    const a = enrichFact("Fact_Assignments", raw, dims);
    const key = String(pickField(a, "employeeKey") || slugName(a.employeeName) || "");
    if (!key) continue;
    const fte = numOrNull(pickField(a, "valueFte")) || 0;
    if (!byEmp.has(key)) {
      byEmp.set(key, {
        employeeKey: pickField(a, "employeeKey"),
        fullName: a.employeeName,
        jobTitle: a.jobTitle,
        assigned: 0,
        _ts: a._ts
      });
    }
    const g = byEmp.get(key);
    g.assigned += fte;
    if (a._ts && (!g._ts || a._ts > g._ts)) g._ts = a._ts;
  }
  const out = [];
  for (const g of byEmp.values()) {
    const emp = g.employeeKey ? dims.employeeByKey.get(String(g.employeeKey)) : null;
    const timeAllocation = numOrNull(emp ? pickField(emp, "timeAllocation") : null) ?? 1;
    const over = g.assigned - timeAllocation;
    if (over <= 0.001) continue;
    const n = normalizeOverRow(
      {
        employeeKey: g.employeeKey,
        fullName: g.fullName || (emp && pickField(emp, "fullName")),
        jobTitle: g.jobTitle || (emp && pickField(emp, "jobTitle")),
        timeAllocation,
        currentAssignedFte: g.assigned,
        overAllocationFte: over,
        active: emp ? pickField(emp, "active") : null,
        source: "fact_assignments",
        _ts: g._ts
      },
      dims
    );
    if (n) out.push(n);
  }
  return out;
}

async function loadOverFromStaffingGrid(dims) {
  const totals = await safeQuery(
    LENS.rmStaffingEmployee,
    "SELECT * FROM c WHERE c.docType = @t AND c.rowKind = @k",
    [
      { name: "@t", value: RM_LANDING.staffing_employee.docType },
      { name: "@k", value: "total" }
    ]
  );
  const months = totals.map((r) => r.yearMonth).filter(Boolean).sort();
  const latest = months.length ? months[months.length - 1] : null;
  const slice = latest ? totals.filter((r) => r.yearMonth === latest) : totals;
  const out = [];
  for (const r of slice) {
    const name = pickField(r, "employeeName", "name");
    const nk = slugName(name);
    const roster = nk ? dims.nameByKey.get(nk) : null;
    const timeAllocation = numOrNull(roster ? pickField(roster, "timeAllocation") : null) ?? 1;
    const assigned = numOrNull(pickField(r, "valueFte")) || 0;
    const n = normalizeOverRow(
      {
        fullName: name,
        jobTitle: pickField(r, "roleCode") || (roster && pickField(roster, "jobTitle")),
        timeAllocation,
        currentAssignedFte: assigned,
        overAllocationFte: assigned - timeAllocation,
        active: roster ? pickField(roster, "active") : null,
        source: "staffing_employee",
        _ts: r._ts
      },
      dims
    );
    if (n) out.push(n);
  }
  return out;
}

function mergeOverRows(lists) {
  const byKey = new Map();
  const priority = { dq04: 3, fact_assignments: 2, staffing_employee: 1 };
  for (const list of lists) {
    for (const r of list) {
      const key = String(r.employeeKey || slugName(r.fullName) || r.fullName || "");
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev || (priority[r.source] || 0) >= (priority[prev.source] || 0)) {
        byKey.set(key, r);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (b.overAllocationFte || 0) - (a.overAllocationFte || 0));
}

async function loadOverAllocated(dims) {
  const d = dims || (await loadDimensions());
  const [dq, facts, grid] = await Promise.all([
    loadDqOver(d),
    loadOverFromAssignments(d),
    loadOverFromStaffingGrid(d)
  ]);
  return mergeOverRows([dq, facts, grid]);
}

async function loadAssignments(dims, { studyKey, craOnly, limit = 200 } = {}) {
  let rows = [];
  if (studyKey) {
    rows = await safeQuery(
      LENS.rmExportAssignments,
      "SELECT * FROM c WHERE c.docType = @t AND c.studyKey = @k",
      [
        { name: "@t", value: RM_LANDING.export_assignments.docType },
        { name: "@k", value: studyKey }
      ]
    );
    if (!rows.length) {
      rows = await safeQuery(
        LENS.rmAssignments,
        "SELECT * FROM c WHERE c.docType = @t AND c.studyKey = @k",
        [
          { name: "@t", value: RM_ENTITIES.Fact_Assignments.docType },
          { name: "@k", value: studyKey }
        ]
      );
      rows = rows.map((r) => enrichFact("Fact_Assignments", r, dims));
    }
  } else {
    rows = await safeQuery(LENS.rmExportAssignments, `SELECT TOP ${limit} * FROM c WHERE c.docType = @t`, [
      { name: "@t", value: RM_LANDING.export_assignments.docType }
    ]);
    if (!rows.length) {
      const fact = await safeQuery(LENS.rmAssignments, `SELECT TOP ${limit} * FROM c WHERE c.docType = @t`, [
        { name: "@t", value: RM_ENTITIES.Fact_Assignments.docType }
      ]);
      rows = fact.map((r) => enrichFact("Fact_Assignments", r, dims));
    }
  }
  if (craOnly) {
    rows = rows.filter(
      (r) =>
        /cra/i.test(String(pickField(r, "roleCode", "roleCodeRaw") || "")) ||
        /cra/i.test(String(r.jobTitle || "")) ||
        /clinical research associate/i.test(String(r.jobTitle || ""))
    );
  }
  return rows.slice(0, limit);
}

async function loadHeadcount(dims) {
  const rows = await safeQuery(LENS.rmHeadcount, "SELECT * FROM c WHERE c.docType = @t", [
    { name: "@t", value: RM_ENTITIES.Fact_Headcount.docType }
  ]);
  return rows.map((r) => enrichFact("Fact_Headcount", r, dims));
}

async function getRmInventory() {
  const [studies, employees, assignments, actuals, roster, exportAssign, staffingEmp, dqSheets, runs] =
    await Promise.all([
      countDocs(LENS.rmStudies, RM_ENTITIES.Dim_Study.docType),
      countDocs(LENS.rmEmployees, RM_ENTITIES.Dim_Employee.docType),
      countDocs(LENS.rmAssignments, RM_ENTITIES.Fact_Assignments.docType),
      countDocs(LENS.rmActuals, RM_ENTITIES.Fact_Actuals.docType),
      countDocs(LENS.rmRoster, RM_LANDING.roster.docType),
      countDocs(LENS.rmExportAssignments, RM_LANDING.export_assignments.docType),
      countDocs(LENS.rmStaffingEmployee, RM_LANDING.staffing_employee.docType),
      countDocs(LENS.rmDq, "lens_rm_dq"),
      loadLatestRun()
    ]);
  const loaded = studies + employees + assignments + roster + exportAssign + staffingEmp + dqSheets > 0;
  return {
    loaded,
    studies,
    employees,
    assignments,
    actuals,
    roster,
    exportAssign,
    staffingEmp,
    dqSheets,
    lastRun: runs
  };
}

async function getRmBriefing() {
  const dims = await loadDimensions();
  const inventory = await getRmInventory();
  const [over, gaps, headcount] = await Promise.all([
    loadOverAllocated(dims),
    loadDqGaps(),
    loadHeadcount(dims)
  ]);
  const short = gaps.filter((g) => (g.gapFte || 0) < 0);
  const stamps = [...over, ...gaps, ...headcount, ...(inventory.lastRun ? [inventory.lastRun] : [])];
  const meta = stamps.length
    ? {
        asOf: new Date(Math.max(...stamps.map((r) => (r._ts || 0) * 1000))).toISOString(),
        asOfLabel: inventory.lastRun
          ? `RM landing · ${String(inventory.lastRun.finishedAt || "").slice(0, 16).replace("T", " ")} UTC`
          : "RM packs in Cosmos"
      }
    : { asOf: new Date().toISOString(), asOfLabel: "RM not loaded yet" };

  if (!inventory.loaded) {
    return {
      loaded: false,
      ...meta,
      overCount: 0,
      shortRoles: 0,
      studies: 0,
      employees: 0,
      assignments: 0,
      roster: 0,
      note: "lens_rm_* is empty. Upload the RM workbook + CSVs to container insightsrm and run ora-lens-rm-ingest.",
      topOver: [],
      lastBlob: null
    };
  }

  return {
    loaded: true,
    ...meta,
    overCount: over.length,
    shortRoles: short.length,
    studies: inventory.studies,
    employees: inventory.employees,
    assignments: inventory.assignments + inventory.exportAssign,
    roster: inventory.roster,
    actuals: inventory.actuals,
    staffingRows: inventory.staffingEmp,
    note: "Actual InsightsRM in Cosmos until DW gold. Joins follow Model_Relationships (studyKey, employeeKey, roleId).",
    topOver: over.slice(0, 5).map((r) => ({
      name: r.fullName,
      overFte: r.overAllocationFte,
      assigned: r.currentAssignedFte,
      source: r.source
    })),
    lastBlob: inventory.lastRun ? inventory.lastRun.sourceBlob : null
  };
}

function fteLabel(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

function buildOverAnswer(question, over, stampFn) {
  const maxOver = Math.max(0.01, ...over.map((r) => Math.abs(r.overAllocationFte || 0)));
  const sources = [...new Set(over.map((r) => r.source))];
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: `${over.length} people are over-allocated vs their time allocation in InsightsRM (${sources.join(" + ")}). Not NetSuite.`,
      chartTitle: "Over-allocation (FTE over time allocation)",
      chartNote: "InsightsRM · DQ_04 + Fact_Assignments + staffing grid · not NetSuite",
      chartType: "bar",
      bars: over.slice(0, 8).map((r) => ({
        label: String(r.fullName || "—").slice(0, 36),
        pct: Math.round((Math.abs(r.overAllocationFte || 0) / maxOver) * 100),
        value: fteLabel(r.overAllocationFte),
        color: "#ed1c24"
      })),
      tableTitle: "Over-allocated personnel",
      grid: "1.3fr 1.1fr 0.5fr 0.5fr 0.5fr 0.6fr",
      cols: ["Name", "Title", "Capacity", "Assigned", "Over by", "Source"],
      rows: over.slice(0, 12).map((r) => [
        r.fullName || "—",
        r.jobTitle || "—",
        fteLabel(r.timeAllocation),
        fteLabel(r.currentAssignedFte),
        fteLabel(r.overAllocationFte),
        r.source || "—"
      ]),
      caveat:
        "Actual RM landing in Cosmos until DW. Over-allocation = assigned FTE minus Dim_Employee.TimeAllocation (default 1.0). Blank FTE is missing, not zero.",
      trace: [
        "Joined Fact_Assignments → Dim_Employee / Dim_Role / Dim_Study per Model_Relationships.",
        "DQ_04_OverAllocatedPersonnel + assignment rollups + staffing totals.",
        "Did not read lens_ns_projects or ora_fact_study."
      ],
      query: "lens_rm_dq DQ_04 + lens_rm_assignments Σ valueFte by employeeKey",
      confidence: "high",
      followUps: ["Which roles are short on capacity?", "Show CRA assignments", "Show assignments for 19-120-0012"]
    },
    over
  );
}

function buildGapAnswer(question, gaps, headcount, stampFn) {
  const short = gaps.filter((g) => (g.gapFte || 0) < 0).sort((a, b) => (a.gapFte || 0) - (b.gapFte || 0));
  const surplus = gaps.filter((g) => (g.gapFte || 0) > 0);
  const chartSource = (short.length ? short : surplus).slice(0, 8);
  const maxAbs = Math.max(0.01, ...chartSource.map((r) => Math.abs(r.gapFte || 0)));
  const tableSource = (short.length ? short : gaps).slice(0, 12);
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: gaps.length
        ? `${short.length} role${short.length === 1 ? "" : "s"} are short vs headcount (gap FTE < 0). ${surplus.length} have spare capacity.`
        : `${headcount.length} headcount rows from Fact_Headcount joined to Dim_Role.`,
      chartTitle: short.length ? "Role capacity shortfall (FTE)" : "Role capacity (Fact_Headcount)",
      chartNote: "InsightsRM DQ_07 + Fact_Headcount · not NetSuite",
      chartType: "bar",
      bars: chartSource.map((r) => {
        const v = r.gapFte || 0;
        return {
          label: String(r.roleCode || r.roleGroup || "—").slice(0, 36),
          pct: Math.round((Math.abs(v) / maxAbs) * 100),
          value: fteLabel(v),
          color: v < 0 ? "#ed1c24" : "#3ebdac"
        };
      }),
      tableTitle: short.length ? "Roles short on capacity" : "Role capacity gaps",
      grid: "0.9fr 0.7fr 0.7fr 0.7fr 0.7fr",
      cols: ["Role", "Capacity", "Demand", "Gap FTE", "Note"],
      rows: tableSource.map((r) => [
        r.roleCode || "—",
        fteLabel(r.capacityFte),
        fteLabel(r.currentDemandFte),
        fteLabel(r.gapFte),
        r.note || "—"
      ]),
      caveat: "Role-level capacity from DQ_07 / Fact_Headcount — not a person list.",
      trace: ["Read lens_rm_dq DQ_07_CapacityGaps.", "Joined Fact_Headcount → Dim_Role on roleId."],
      query: "lens_rm_dq DQ_07 + lens_rm_headcount",
      confidence: "high",
      followUps: ["Who is over-allocated?", "Show CRA assignments"]
    },
    gaps.length ? gaps : headcount
  );
}

function buildAssignAnswer(question, assignments, studyKey, stampFn) {
  const byPerson = {};
  for (const a of assignments) {
    const person = a.employeeName || a.roleCode || String(a.roleId || a.activity || "row");
    byPerson[person] = (byPerson[person] || 0) + (numOrNull(a.valueFte) || 0);
  }
  const roleRows = Object.entries(byPerson).sort((a, b) => b[1] - a[1]);
  const maxFte = Math.max(0.01, ...roleRows.map(([, n]) => n));
  const label = studyKey || "portfolio";
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: `${assignments.length} assignment row${assignments.length === 1 ? "" : "s"} on ${label}. Booked FTE from export CSV or Fact_Assignments joined to Dim_Employee.`,
      chartTitle: studyKey ? `Booked FTE · ${studyKey}` : "Booked FTE (sample)",
      chartNote: "InsightsRM · export assignments + star schema joins",
      chartType: "bar",
      bars: roleRows.slice(0, 8).map(([lbl, n]) => ({
        label: String(lbl).slice(0, 36),
        pct: Math.round((n / maxFte) * 100),
        value: fteLabel(n),
        color: "#273b8a"
      })),
      tableTitle: "Assignments",
      grid: "1.1fr 1fr 0.7fr 0.5fr 0.7fr 0.7fr",
      cols: ["Study", "Person", "Activity", "FTE", "Begin", "Status"],
      rows: assignments.slice(0, 12).map((r) => [
        r.studyKey || "—",
        r.employeeName || "—",
        r.activity || r.activityNameRaw || "—",
        fteLabel(r.valueFte),
        String(r.beginDate || "").slice(0, 10) || "—",
        r.status || "—"
      ]),
      caveat: "StudyKey joins Dim_Study; EmployeeKey joins Dim_Employee per Model_Relationships.",
      trace: [
        studyKey
          ? `Read lens_rm_export_assignments / lens_rm_assignments where studyKey = ${studyKey}.`
          : "Read assignment sample from export + Fact_Assignments.",
        "Enriched with Dim_Employee, Dim_Role, Dim_Study."
      ],
      query: studyKey ? `assignments where studyKey = '${studyKey}'` : "assignments TOP sample",
      confidence: "high",
      followUps: ["Who is over-allocated?", "Which roles are short on capacity?"]
    },
    assignments
  );
}

function buildInventoryAnswer(question, inventory, briefing, stampFn) {
  const run = inventory.lastRun;
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: inventory.loaded
        ? `InsightsRM has ${inventory.studies} studies, ${inventory.employees} employees, ${inventory.assignments + inventory.exportAssign} assignment rows, ${inventory.roster} roster rows in Cosmos. ${briefing.overCount} over-allocated.`
        : "InsightsRM packs are empty in Cosmos — ingest has not completed or used the wrong storage account.",
      chartTitle: inventory.loaded ? "RM pack counts" : "No RM data yet",
      chartNote: "lens_rm_* · Model_Relationships joins at read time",
      chartType: "bar",
      bars: inventory.loaded
        ? [
            { label: "Studies", pct: 100, value: String(inventory.studies), color: "#273b8a" },
            { label: "Employees", pct: 80, value: String(inventory.employees), color: "#273b8a" },
            { label: "Assignments", pct: 60, value: String(inventory.assignments + inventory.exportAssign), color: "#273b8a" },
            { label: "Over-alloc", pct: Math.min(100, briefing.overCount * 10), value: String(briefing.overCount), color: "#ed1c24" }
          ]
        : [],
      tableTitle: "Cosmos inventory",
      grid: "1fr 0.6fr",
      cols: ["Pack", "Count"],
      rows: inventory.loaded
        ? [
            ["Dim_Study (lens_rm_studies)", String(inventory.studies)],
            ["Dim_Employee (lens_rm_employees)", String(inventory.employees)],
            ["Fact_Assignments", String(inventory.assignments)],
            ["RM-assignments.csv export", String(inventory.exportAssign)],
            ["RM-employees roster", String(inventory.roster)],
            ["Staffing-By-Employee grid", String(inventory.staffingEmp)],
            ["DQ sheets", String(inventory.dqSheets)],
            ["Last ingest", run ? String(run.sourceBlob || run.finishedAt || "—") : "—"]
          ]
        : [["Upload landing/yyyy/MM/dd/time/*.xlsx + CSVs to insightsrm", "—"]],
      caveat: "Temporary Cosmos landing until DW gold. Not NetSuite.",
      trace: ["Counted lens_rm_* containers.", run ? `Last run ${run.finishedAt}.` : "No lens_rm_runs yet."],
      query: "lens_rm_* inventory",
      confidence: inventory.loaded ? "high" : "medium",
      followUps: ["Who is over-allocated?", "Which roles are short on capacity?", "Show CRA assignments"]
    },
    run ? [run] : []
  );
}

async function answerRmQuestion(question, stampFn) {
  const intent = parseRmIntent(question);
  const dims = await loadDimensions();
  const inventory = await getRmInventory();

  if (!inventory.loaded) {
    return buildInventoryAnswer(question, inventory, { overCount: 0 }, stampFn);
  }

  const [over, gaps, headcount] = await Promise.all([
    intent.wantOver || !intent.wantGap ? loadOverAllocated(dims) : Promise.resolve([]),
    intent.wantGap || intent.wantOver ? loadDqGaps() : Promise.resolve([]),
    loadHeadcount(dims)
  ]);

  if (intent.studyKey || (intent.wantAssign && !intent.wantOver)) {
    const assignments = await loadAssignments(dims, {
      studyKey: intent.studyKey,
      craOnly: intent.craOnly
    });
    if (assignments.length) {
      return buildAssignAnswer(question, assignments, intent.studyKey, stampFn);
    }
  }

  if (intent.wantOver && over.length) {
    return buildOverAnswer(question, over, stampFn);
  }

  if (intent.wantGap && (gaps.length || headcount.length)) {
    return buildGapAnswer(question, gaps, headcount, stampFn);
  }

  if (over.length) {
    return buildOverAnswer(question, over, stampFn);
  }

  if (gaps.length || headcount.length) {
    return buildGapAnswer(question, gaps, headcount, stampFn);
  }

  const assignments = await loadAssignments(dims, { craOnly: intent.craOnly, limit: 80 });
  if (assignments.length) {
    return buildAssignAnswer(question, assignments, "", stampFn);
  }

  const briefing = await getRmBriefing();
  return buildInventoryAnswer(question, inventory, briefing, stampFn);
}

module.exports = {
  answerRmQuestion,
  getRmBriefing,
  getRmInventory,
  loadOverAllocated,
  loadDimensions,
  pickField,
  fteLabel,
  studyKeyFromQuestion
};
