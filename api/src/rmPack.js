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

function parseExcludeTitle(question) {
  const t = String(question || "").toLowerCase();
  const needles = [];
  const withTitle = t.match(/with\s+([a-z][a-z .&/-]{1,40}?)\s+in\s+(?:their\s+)?titles?/);
  if (withTitle) needles.push(withTitle[1].trim());
  if (/(remove|exclude|without|drop|except|filter out|do not include|don't include|not the)/.test(t)) {
    if (/\bdirectors?\b/.test(t)) needles.push("director");
    if (/\bmanagers?\b/.test(t) && !/\bproject manager\b/.test(t)) needles.push("manager");
    if (/\bvps?\b|vice president/.test(t)) needles.push("vp");
  }
  return [...new Set(needles.filter(Boolean))];
}

function looksLikeRmRefinement(question) {
  const t = String(question || "").toLowerCase();
  return /(remove|exclude|without|drop|except|filter out|those|them|that list|the list|only (show|keep|include)|do not include|don't include|with .+ in (their )?title|\bdirectors?\b)/.test(
    t
  );
}

function mergeRmIntent(question, priorTurns) {
  const intent = parseRmIntent(question);
  intent.excludeTitle = parseExcludeTitle(question);
  const last = [...(priorTurns || [])].reverse().find((t) => t && t.rmIntent);
  if (!last || !last.rmIntent) return intent;
  const blank =
    !intent.wantUnder &&
    !intent.wantOver &&
    !intent.wantGap &&
    !intent.wantSpareRole &&
    !intent.wantAssign &&
    !intent.studyKey &&
    !intent.wantOverview;
  if (blank) {
    intent.wantUnder = !!last.rmIntent.wantUnder;
    intent.wantOver = !!last.rmIntent.wantOver;
    intent.wantGap = !!last.rmIntent.wantGap;
    intent.wantSpareRole = !!last.rmIntent.wantSpareRole;
    intent.wantAssign = !!last.rmIntent.wantAssign;
    intent.studyKey = last.rmIntent.studyKey || "";
    intent.craOnly = intent.craOnly || !!last.rmIntent.craOnly;
  }
  intent.excludeTitle = [...new Set([...(last.rmIntent.excludeTitle || []), ...intent.excludeTitle])];
  return intent;
}

function applyTitleFilters(rows, intent) {
  const needles = (intent && intent.excludeTitle) || [];
  if (!needles.length) return rows || [];
  return (rows || []).filter((r) => {
    const title = String(pickField(r, "jobTitle", "title") || "").toLowerCase();
    return !needles.some((n) => title.includes(String(n).toLowerCase()));
  });
}

function withRmIntent(answer, intent) {
  if (answer) {
    answer.rmIntent = {
      wantUnder: !!intent.wantUnder,
      wantOver: !!intent.wantOver,
      wantGap: !!intent.wantGap,
      wantSpareRole: !!intent.wantSpareRole,
      wantAssign: !!intent.wantAssign,
      studyKey: intent.studyKey || "",
      craOnly: !!intent.craOnly,
      excludeTitle: intent.excludeTitle || []
    };
  }
  return answer;
}

function parseRmIntent(question) {
  const t = String(question || "").toLowerCase();
  const wantUnder = /(under.?utili[sz]|under.?allocat|underused|under.?used|on the bench|on bench|available fte|unused fte|spare fte|not fully booked|who has capacity)/.test(
    t
  );
  const wantOver = /(over.?allocat|overbook|too many hours|over.?utili[sz])/.test(t) && !wantUnder;
  const wantSpareRole = /(spare capacity|surplus capacity|roles? with spare|roles? with surplus)/.test(t);
  const wantGap = !wantUnder && /(capacity|headcount|gap|shortfall|demand|short on)/.test(t);
  return {
    studyKey: studyKeyFromQuestion(question),
    wantOver,
    wantUnder,
    wantSpareRole,
    wantGap,
    wantAssign: /(assign|booked|staffed|who is on|who.?s on|cra)/.test(t),
    craOnly: /\bcra\b/.test(t),
    wantOverview: /(overview|summary|briefing|what.?s loaded|how many)/.test(t)
  };
}

function isActiveEmployee(row) {
  const status = String(pickField(row, "positionStatus") || "").toLowerCase();
  if (status && /inactiv|terminat|leave|separat/.test(status)) return false;
  if (status.includes("active")) return true;
  const a = pickField(row, "active");
  if (a === false) return false;
  if (a === true) return true;
  return true;
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
  const [employees, roles, studies, activities, departments] = await Promise.all([
    safeQuery(LENS.rmEmployees, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Employee.docType }]),
    safeQuery(LENS.rmRoles, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Role.docType }]),
    safeQuery(LENS.rmStudies, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Study.docType }]),
    safeQuery(LENS.rmActivities, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Activity.docType }]),
    safeQuery(LENS.rmDepartments, "SELECT * FROM c WHERE c.docType = @t", [{ name: "@t", value: RM_ENTITIES.Dim_Department.docType }])
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
    departmentById: indexBy(departments, "departmentId"),
    nameByKey,
    employees,
    roles,
    studies
  };
}

function departmentOfEmployee(emp, dims) {
  if (!emp || !dims.departmentById) return null;
  const homeRole = dims.roleById.get(String(pickField(emp, "roleId") || ""));
  const deptId = homeRole ? pickField(homeRole, "departmentId") : null;
  const dept = deptId ? dims.departmentById.get(String(deptId)) : null;
  return dept ? pickField(dept, "departmentName") : null;
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

function personKey(row) {
  return String(row.employeeKey || slugName(row.fullName) || row.fullName || "");
}

function utilizationRow({ employeeKey, fullName, jobTitle, timeAllocation, assigned, active, contractor, source, _ts }) {
  const cap = timeAllocation == null ? 1 : timeAllocation;
  const booked = assigned == null ? 0 : assigned;
  const delta = booked - cap;
  return {
    employeeKey,
    fullName,
    jobTitle,
    timeAllocation: cap,
    currentAssignedFte: booked,
    overAllocationFte: delta > 0.001 ? delta : 0,
    spareFte: delta < -0.001 ? -delta : 0,
    utilizationPct: cap > 0 ? booked / cap : null,
    active,
    contractor,
    source,
    _ts
  };
}

async function assignedByPerson(dims) {
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
        _ts: a._ts,
        source: "fact_assignments"
      });
    }
    const g = byEmp.get(key);
    g.assigned += fte;
    if (a._ts && (!g._ts || a._ts > g._ts)) g._ts = a._ts;
  }
  return byEmp;
}

async function assignedFromStaffingGrid(dims) {
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
  const byEmp = new Map();
  for (const r of slice) {
    const name = pickField(r, "employeeName", "name");
    const nk = slugName(name);
    if (!nk) continue;
    const roster = dims.nameByKey.get(nk);
    const key = String((roster && pickField(roster, "employeeKey")) || nk);
    byEmp.set(key, {
      employeeKey: roster ? pickField(roster, "employeeKey") : null,
      fullName: name,
      jobTitle: pickField(r, "roleCode") || (roster && pickField(roster, "jobTitle")),
      assigned: numOrNull(pickField(r, "valueFte")) || 0,
      _ts: r._ts,
      source: "staffing_employee"
    });
  }
  return byEmp;
}

function toUtilizationLists(byEmp, dims) {
  const over = [];
  const under = [];
  const seen = new Set();
  for (const g of byEmp.values()) {
    const emp = g.employeeKey ? dims.employeeByKey.get(String(g.employeeKey)) : null;
    const nameKey = slugName(g.fullName);
    const roster = nameKey ? dims.nameByKey.get(nameKey) : null;
    const person = emp || roster || {};
    if (emp && !isActiveEmployee(emp) && g.assigned <= 0.001) continue;
    const timeAllocation =
      numOrNull(emp ? pickField(emp, "timeAllocation") : null) ??
      numOrNull(roster ? pickField(roster, "timeAllocation") : null) ??
      1;
    const row = utilizationRow({
      employeeKey: g.employeeKey || pickField(person, "employeeKey"),
      fullName: g.fullName || pickField(person, "fullName"),
      jobTitle: g.jobTitle || pickField(person, "jobTitle"),
      timeAllocation,
      assigned: g.assigned,
      active: pickField(person, "active"),
      contractor: pickField(person, "contractor"),
      source: g.source,
      _ts: g._ts
    });
    const key = personKey(row);
    if (key) seen.add(key);
    if (row.overAllocationFte > 0.001) over.push(row);
    else if (row.spareFte > 0.05) under.push(row);
  }
  for (const emp of dims.employees || []) {
    if (!isActiveEmployee(emp)) continue;
    const timeAllocation = numOrNull(pickField(emp, "timeAllocation")) ?? 1;
    if (timeAllocation <= 0) continue;
    const key = String(pickField(emp, "employeeKey") || slugName(pickField(emp, "fullName")) || "");
    if (!key || seen.has(key) || seen.has(slugName(pickField(emp, "fullName")))) continue;
    const row = utilizationRow({
      employeeKey: pickField(emp, "employeeKey"),
      fullName: pickField(emp, "fullName"),
      jobTitle: pickField(emp, "jobTitle"),
      timeAllocation,
      assigned: 0,
      active: pickField(emp, "active"),
      contractor: pickField(emp, "contractor"),
      source: "dim_employee",
      _ts: emp._ts
    });
    if (row.spareFte > 0.05) under.push(row);
  }
  over.sort((a, b) => (b.overAllocationFte || 0) - (a.overAllocationFte || 0));
  under.sort((a, b) => (b.spareFte || 0) - (a.spareFte || 0));
  return { over, under };
}

let utilizationCache = null;

async function loadUtilization(dims) {
  const d = dims || (await loadDimensions());
  if (utilizationCache && utilizationCache.dims === d) return utilizationCache.value;
  const [facts, grid] = await Promise.all([assignedByPerson(d), assignedFromStaffingGrid(d)]);
  const merged = new Map(grid);
  for (const [k, v] of facts) merged.set(k, v);
  const value = toUtilizationLists(merged, d);
  const dqOver = await loadDqOver(d);
  const byKey = new Map(value.over.map((r) => [personKey(r), r]));
  for (const r of dqOver) {
    const key = personKey(r);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (r.source === "dq04" && prev.source !== "dq04")) {
      byKey.set(key, {
        ...r,
        spareFte: 0,
        utilizationPct:
          r.timeAllocation > 0 && r.currentAssignedFte != null ? r.currentAssignedFte / r.timeAllocation : null
      });
    }
  }
  value.over = [...byKey.values()].sort((a, b) => (b.overAllocationFte || 0) - (a.overAllocationFte || 0));
  utilizationCache = { dims: d, value };
  return value;
}

function mergeOverRows(lists) {
  const byKey = new Map();
  const priority = { dq04: 3, fact_assignments: 2, staffing_employee: 1, dim_employee: 0 };
  for (const list of lists) {
    for (const r of list) {
      const key = personKey(r);
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
  const util = await loadUtilization(dims);
  return util.over;
}

async function loadUnderUtilized(dims) {
  const util = await loadUtilization(dims);
  return util.under;
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

async function loadAllAssignments(dims) {
  const fact = await safeQuery(LENS.rmAssignments, "SELECT * FROM c WHERE c.docType = @t", [
    { name: "@t", value: RM_ENTITIES.Fact_Assignments.docType }
  ]);
  if (fact.length) return fact.map((r) => enrichFact("Fact_Assignments", r, dims));
  return safeQuery(LENS.rmExportAssignments, "SELECT * FROM c WHERE c.docType = @t", [
    { name: "@t", value: RM_LANDING.export_assignments.docType }
  ]);
}

function ymd(v) {
  if (v == null || v === "") return null;
  return String(v).slice(0, 10);
}

function dedicatedPct(fte) {
  if (fte == null) return null;
  return Math.round(Number(fte) * 1000) / 10;
}

function touchYmd(bounds, d) {
  if (!d) return;
  if (!bounds.min || d < bounds.min) bounds.min = d;
  if (!bounds.max || d > bounds.max) bounds.max = d;
}

function assignmentLine(a) {
  const fte = numOrNull(pickField(a, "valueFte"));
  return {
    activity: pickField(a, "activity", "activityName", "activityNameRaw") || "—",
    beginDate: ymd(pickField(a, "beginDate")),
    endDate: ymd(pickField(a, "endDate")),
    valueFte: fte,
    dedicatedPct: dedicatedPct(fte),
    status: pickField(a, "status") || null
  };
}

async function getRmPeopleBoard() {
  const dims = await loadDimensions();
  const [rows, util] = await Promise.all([loadAllAssignments(dims), loadUtilization(dims)]);
  const utilByKey = new Map();
  for (const r of [...(util.over || []), ...(util.under || [])]) {
    const k = personKey(r);
    if (k) utilByKey.set(k, r);
    if (r.employeeKey) utilByKey.set(String(r.employeeKey), r);
  }

  const people = new Map();
  const studies = new Map();
  const bounds = { min: null, max: null };
  for (const a of rows) {
    const empKey = String(pickField(a, "employeeKey") || "");
    const name = String(pickField(a, "employeeName", "fullName") || "").trim();
    const id = empKey || slugName(name);
    if (!id) continue;
    const emp = empKey ? dims.employeeByKey.get(empKey) : null;
    const fullName = name || pickField(emp, "fullName") || "—";
    const jobTitle = pickField(a, "jobTitle") || pickField(emp, "jobTitle") || null;
    const department = departmentOfEmployee(emp, dims);
    if (!people.has(id)) {
      people.set(id, {
        id,
        employeeKey: empKey || null,
        fullName,
        jobTitle,
        department,
        timeAllocation: numOrNull(emp ? pickField(emp, "timeAllocation") : null) ?? 1,
        studies: new Map()
      });
    }
    const p = people.get(id);
    const sk = String(pickField(a, "studyKey") || "").trim() || "—";
    if (!p.studies.has(sk)) {
      const study = dims.studyByKey.get(sk);
      p.studies.set(sk, {
        studyKey: sk,
        studyName: pickField(study, "studyName") || pickField(a, "studyName", "studyLabel") || sk,
        lines: []
      });
    }
    const line = assignmentLine(a);
    touchYmd(bounds, line.beginDate);
    touchYmd(bounds, line.endDate);
    p.studies.get(sk).lines.push(line);

    const studyDim = dims.studyByKey.get(sk);
    if (!studies.has(sk)) {
      studies.set(sk, {
        studyKey: sk,
        studyName: pickField(studyDim, "studyName") || pickField(a, "studyName", "studyLabel") || sk,
        sponsor: pickField(studyDim, "sponsor") || null,
        status: pickField(studyDim, "currentProjectStatus", "status") || null,
        roles: new Map()
      });
    }
    const roleId = String(pickField(a, "roleId") || "") || "—";
    const role = roleId !== "—" ? dims.roleById.get(roleId) : null;
    const roleCode =
      pickField(a, "roleCode") || (role ? pickField(role, "roleCode") : null) || "Unmapped";
    const roleGroup = pickField(a, "roleGroup") || (role ? pickField(role, "roleGroup") : null);
    const studyNode = studies.get(sk);
    if (!studyNode.roles.has(roleId)) {
      studyNode.roles.set(roleId, { roleId, roleCode, roleGroup, staff: new Map() });
    }
    const roleNode = studyNode.roles.get(roleId);
    if (!roleNode.staff.has(id)) {
      roleNode.staff.set(id, {
        id,
        employeeKey: empKey || null,
        fullName,
        jobTitle,
        department,
        lines: []
      });
    }
    roleNode.staff.get(id).lines.push(line);
  }

  const list = [...people.values()]
    .map((p) => {
      const personStudies = [...p.studies.values()]
        .map((s) => {
          const begins = s.lines.map((l) => l.beginDate).filter(Boolean).sort();
          const ends = s.lines.map((l) => l.endDate).filter(Boolean).sort();
          const ftes = s.lines.map((l) => l.valueFte).filter((n) => n != null);
          s.lines.sort((a, b) => String(a.beginDate || "").localeCompare(String(b.beginDate || "")));
          return {
            studyKey: s.studyKey,
            studyName: s.studyName,
            beginDate: begins[0] || null,
            endDate: ends.length ? ends[ends.length - 1] : null,
            peakDedicatedPct: ftes.length ? dedicatedPct(Math.max(...ftes)) : null,
            lineCount: s.lines.length,
            lines: s.lines
          };
        })
        .sort((a, b) => (b.peakDedicatedPct || 0) - (a.peakDedicatedPct || 0));
      const u = utilByKey.get(p.id) || utilByKey.get(String(p.employeeKey)) || utilByKey.get(slugName(p.fullName));
      return {
        id: p.id,
        employeeKey: p.employeeKey,
        fullName: p.fullName,
        jobTitle: p.jobTitle,
        department: p.department || null,
        timeAllocation: p.timeAllocation,
        assignedFte: u ? u.currentAssignedFte : null,
        spareFte: u ? u.spareFte : null,
        overAllocationFte: u ? u.overAllocationFte : null,
        studyCount: personStudies.length,
        studies: personStudies
      };
    })
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

  const studyList = [...studies.values()]
    .map((s) => {
      const roles = [...s.roles.values()]
        .map((r) => {
          const staff = [...r.staff.values()]
            .map((p) => {
              p.lines.sort((a, b) => String(a.beginDate || "").localeCompare(String(b.beginDate || "")));
              const ftes = p.lines.map((l) => l.valueFte).filter((n) => n != null);
              return {
                id: p.id,
                employeeKey: p.employeeKey,
                fullName: p.fullName,
                jobTitle: p.jobTitle,
                department: p.department || null,
                peakDedicatedPct: ftes.length ? dedicatedPct(Math.max(...ftes)) : null,
                lines: p.lines
              };
            })
            .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
          return {
            roleId: r.roleId,
            roleCode: r.roleCode,
            roleGroup: r.roleGroup,
            staffCount: staff.length,
            staff
          };
        })
        .sort((a, b) => String(a.roleCode).localeCompare(String(b.roleCode)));
      const staffIds = new Set(roles.flatMap((r) => r.staff.map((p) => p.id)));
      return {
        studyKey: s.studyKey,
        studyName: s.studyName,
        sponsor: s.sponsor,
        status: s.status,
        roleCount: roles.length,
        staffCount: staffIds.size,
        roles
      };
    })
    .sort((a, b) => String(a.studyKey).localeCompare(String(b.studyKey)));

  return {
    loaded: list.length > 0 || studyList.length > 0,
    people: list,
    studies: studyList,
    dateMin: bounds.min,
    dateMax: bounds.max,
    note: "By study / by role / by employee restacks the same assignment facts. Date filter keeps windows that overlap From–To. Dedicated % is Fact_Assignments.ValueFTE × 100. Click a name for activity windows."
  };
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
  const [over, under, gaps, headcount] = await Promise.all([
    loadOverAllocated(dims),
    loadUnderUtilized(dims),
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
      underCount: 0,
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
    underCount: under.length,
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
    topUnder: under.slice(0, 5).map((r) => ({
      name: r.fullName,
      spareFte: r.spareFte,
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
      followUps: ["Who is under-utilized?", "Which roles are short on capacity?", "Show CRA assignments"]
    },
    over
  );
}

function buildUnderAnswer(question, under, stampFn) {
  const maxSpare = Math.max(0.01, ...under.map((r) => Math.abs(r.spareFte || 0)));
  const sources = [...new Set(under.map((r) => r.source))];
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: `${under.length} people have unused capacity vs their time allocation in InsightsRM (${sources.join(" + ")}). Spare FTE = TimeAllocation minus assigned FTE. Not NetSuite.`,
      chartTitle: "Under-utilized (spare FTE vs time allocation)",
      chartNote: "InsightsRM · Fact_Assignments + Dim_Employee.TimeAllocation · not over-allocation",
      chartType: "bar",
      bars: under.slice(0, 8).map((r) => ({
        label: String(r.fullName || "—").slice(0, 36),
        pct: Math.round((Math.abs(r.spareFte || 0) / maxSpare) * 100),
        value: fteLabel(r.spareFte),
        color: "#3ebdac"
      })),
      tableTitle: "Under-utilized personnel",
      grid: "1.3fr 1.1fr 0.5fr 0.5fr 0.5fr 0.6fr",
      cols: ["Name", "Title", "Capacity", "Assigned", "Spare", "Source"],
      rows: under.slice(0, 12).map((r) => [
        r.fullName || "—",
        r.jobTitle || "—",
        fteLabel(r.timeAllocation),
        fteLabel(r.currentAssignedFte),
        fteLabel(r.spareFte),
        r.source || "—"
      ]),
      caveat:
        "Actual RM landing in Cosmos until DW. Under-utilized = Dim_Employee.TimeAllocation minus assigned FTE on Fact_Assignments. People with no assignment rows and an Active position status are listed as spare = full allocation. Blank FTE is missing, not zero.",
      trace: [
        "Joined Fact_Assignments → Dim_Employee on employeeKey per Model_Relationships.",
        "Did not use DQ_04 (that sheet is over-allocation only).",
        "Did not read lens_ns_projects or ora_fact_study."
      ],
      query: "lens_rm_assignments Σ valueFte by employeeKey vs Dim_Employee.timeAllocation (spare > 0.05)",
      confidence: "high",
      followUps: ["Who is over-allocated?", "Which roles are short on capacity?", "Show CRA assignments"]
    },
    under
  );
}

function buildGapAnswer(question, gaps, headcount, stampFn, preferSurplus = false) {
  const short = gaps.filter((g) => (g.gapFte || 0) < 0).sort((a, b) => (a.gapFte || 0) - (b.gapFte || 0));
  const surplus = gaps.filter((g) => (g.gapFte || 0) > 0).sort((a, b) => (b.gapFte || 0) - (a.gapFte || 0));
  const useSurplus = preferSurplus && surplus.length;
  const chartSource = (useSurplus ? surplus : short.length ? short : surplus).slice(0, 8);
  const maxAbs = Math.max(0.01, ...chartSource.map((r) => Math.abs(r.gapFte || 0)));
  const tableSource = (useSurplus ? surplus : short.length ? short : gaps).slice(0, 12);
  return stampFn(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary: gaps.length
        ? useSurplus
          ? `${surplus.length} InsightsRM role${surplus.length === 1 ? "" : "s"} have spare capacity (gap FTE > 0). ${short.length} are short.`
          : `${short.length} role${short.length === 1 ? "" : "s"} are short vs headcount (gap FTE < 0). ${surplus.length} have spare capacity.`
        : `${headcount.length} headcount rows from Fact_Headcount joined to Dim_Role.`,
      chartTitle: useSurplus
        ? "Role spare capacity (FTE)"
        : short.length
          ? "Role capacity shortfall (FTE)"
          : "Role capacity (Fact_Headcount)",
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
      tableTitle: useSurplus ? "Roles with spare capacity" : short.length ? "Roles short on capacity" : "Role capacity gaps",
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

async function answerRmQuestion(question, stampFn, priorTurns) {
  utilizationCache = null;
  const intent = mergeRmIntent(question, priorTurns);
  const dims = await loadDimensions();
  const inventory = await getRmInventory();

  if (!inventory.loaded) {
    return withRmIntent(buildInventoryAnswer(question, inventory, { overCount: 0, underCount: 0 }, stampFn), intent);
  }

  const needPeople = intent.wantOver || intent.wantUnder || (!intent.wantGap && !intent.wantSpareRole && !intent.wantAssign && !intent.studyKey);
  const [overRaw, underRaw, gaps, headcount] = await Promise.all([
    needPeople || intent.wantOver ? loadOverAllocated(dims) : Promise.resolve([]),
    intent.wantUnder || needPeople ? loadUnderUtilized(dims) : Promise.resolve([]),
    intent.wantGap || intent.wantSpareRole ? loadDqGaps() : Promise.resolve([]),
    intent.wantGap || intent.wantSpareRole ? loadHeadcount(dims) : Promise.resolve([])
  ]);
  const over = applyTitleFilters(overRaw, intent);
  const under = applyTitleFilters(underRaw, intent);
  const titleNote = (intent.excludeTitle || []).length
    ? ` Excluded titles containing ${intent.excludeTitle.map((n) => `"${n}"`).join(", ")}.`
    : "";

  if (intent.wantUnder) {
    if (under.length) {
      const ans = buildUnderAnswer(question, under, stampFn);
      if (titleNote) ans.summary = `${ans.summary}${titleNote}`;
      return withRmIntent(ans, intent);
    }
    return withRmIntent(
      stampFn(
        {
          q: question,
          needs: ["insightsrm"],
          icon: "users",
          summary:
            `No under-utilized people matched after filters.${titleNote} Nobody with assigned FTE more than 0.05 below Dim_Employee.TimeAllocation. This is not the over-allocation list.`,
          chartTitle: "No under-utilized personnel",
          chartNote: "InsightsRM · spare FTE vs time allocation",
          chartType: "bar",
          bars: [],
          tableTitle: "Under-utilized personnel",
          grid: "1fr",
          cols: ["Note"],
          rows: [["Assigned FTE is at or above time allocation, or remaining people were excluded by the title filter."]],
          caveat: "Under-utilized is spare capacity at the person grain. Role spare capacity is a different question.",
          trace: ["Computed assigned FTE from Fact_Assignments vs Dim_Employee.TimeAllocation.", "Did not return DQ_04 over-allocation.", titleNote.trim() || "No title filter."],
          query: "spare FTE = timeAllocation - Σ assignment valueFte",
          confidence: "medium",
          followUps: ["Who is over-allocated?", "Which roles are short on capacity?", "Show CRA assignments"]
        },
        []
      ),
      intent
    );
  }

  if (intent.studyKey || (intent.wantAssign && !intent.wantOver && !intent.wantUnder)) {
    const assignments = applyTitleFilters(
      await loadAssignments(dims, {
        studyKey: intent.studyKey,
        craOnly: intent.craOnly
      }),
      intent
    );
    if (assignments.length) {
      return withRmIntent(buildAssignAnswer(question, assignments, intent.studyKey, stampFn), intent);
    }
  }

  if (intent.wantOver && over.length) {
    const ans = buildOverAnswer(question, over, stampFn);
    if (titleNote) ans.summary = `${ans.summary}${titleNote}`;
    return withRmIntent(ans, intent);
  }

  if (intent.wantSpareRole && (gaps.length || headcount.length)) {
    return withRmIntent(buildGapAnswer(question, gaps, headcount, stampFn, true), intent);
  }

  if (intent.wantGap && (gaps.length || headcount.length)) {
    return withRmIntent(buildGapAnswer(question, gaps, headcount, stampFn, false), intent);
  }

  if (over.length && !intent.wantUnder) {
    return withRmIntent(buildOverAnswer(question, over, stampFn), intent);
  }

  if (under.length) {
    const ans = buildUnderAnswer(question, under, stampFn);
    if (titleNote) ans.summary = `${ans.summary}${titleNote}`;
    return withRmIntent(ans, intent);
  }

  if (gaps.length || headcount.length) {
    return withRmIntent(buildGapAnswer(question, gaps, headcount, stampFn), intent);
  }

  const assignments = applyTitleFilters(
    await loadAssignments(dims, { craOnly: intent.craOnly, limit: 80 }),
    intent
  );
  if (assignments.length) {
    return withRmIntent(buildAssignAnswer(question, assignments, "", stampFn), intent);
  }

  const briefing = await getRmBriefing();
  return withRmIntent(buildInventoryAnswer(question, inventory, briefing, stampFn), intent);
}

module.exports = {
  answerRmQuestion,
  getRmBriefing,
  getRmPeopleBoard,
  getRmInventory,
  loadOverAllocated,
  loadUnderUtilized,
  loadDimensions,
  pickField,
  fteLabel,
  studyKeyFromQuestion,
  looksLikeRmRefinement
};
