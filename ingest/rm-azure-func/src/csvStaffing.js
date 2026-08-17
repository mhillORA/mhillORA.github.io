const crypto = require("crypto");

const MONTH_NUM = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const EMPLOYEE_SPEC = {
  container: "lens_rm_staffing_employee",
  docType: "lens_rm_staffing_employee",
  pk: "nameKey",
  view: "employee"
};

const WORKITEM_SPEC = {
  container: "lens_rm_staffing_workitem",
  docType: "lens_rm_staffing_workitem",
  pk: "studyKey",
  view: "workitem"
};

const ROSTER_SPEC = {
  container: "lens_rm_roster",
  docType: "lens_rm_roster",
  pk: "employeeNumber",
  view: "roster"
};

const EXPORT_ASSIGN_SPEC = {
  container: "lens_rm_export_assignments",
  docType: "lens_rm_export_assignment",
  pk: "studyKey",
  view: "assign"
};

const SCHEDULE_SPEC = {
  container: "lens_rm_schedule",
  docType: "lens_rm_schedule",
  pk: "studyKey",
  view: "schedule"
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  return rows
    .slice(1)
    .filter((r) => r.some((x) => String(x || "").trim()))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = r[i] == null ? "" : String(r[i]).trim();
      });
      return o;
    });
}

function slug(s, n = 40) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, n);
}

function parseStudy(label) {
  const t = String(label || "").trim();
  if (!t) return { studyKey: null, studyName: null, studyLabel: null };
  const m = t.match(/^(\d{2}-\d{3}-\d{4}|O-\d+)\s*-\s*(.*)$/i);
  if (m) return { studyKey: m[1], studyName: m[2].trim(), studyLabel: t };
  if (/^(\d{2}-\d{3}-\d{4}|O-\d+)$/i.test(t)) return { studyKey: t, studyName: null, studyLabel: t };
  return { studyKey: t, studyName: null, studyLabel: t };
}

function parseMonth(header) {
  const raw = String(header || "").trim();
  const m = raw.match(/^([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const monthNumber = MONTH_NUM[m[1].toLowerCase()];
  const year = Number(m[2]);
  if (!monthNumber || !year) return null;
  const yearMonth = `${year}-${String(monthNumber).padStart(2, "0")}`;
  return { year, monthNumber, monthName: m[1], yearMonth, header: raw };
}

function parsePercent(raw) {
  const s = String(raw || "").trim().replace(/%/g, "").replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n / 100 : null;
}

function parseUsDate(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return `${iso}T00:00:00.000Z`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseFte(raw) {
  const s = String(raw || "").trim().replace(/,/g, "");
  if (!s) return null;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > 1.5) return n / 100;
  return n;
}

function monthHeaders(row) {
  return Object.keys(row || {}).map(parseMonth).filter(Boolean);
}

function landingMeta(blobPath, syncedAt) {
  return {
    source: "insightsrm",
    datasetKind: "actual",
    landing: "csv",
    untilGold: true,
    sourceBlob: blobPath,
    syncedAt
  };
}

function makeId(parts) {
  const base = parts.filter(Boolean).join("__").slice(0, 180);
  const h = crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 8);
  return `${base}__${h}`;
}

function yesNo(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(s)) return true;
  if (["no", "false", "0"].includes(s)) return false;
  return null;
}

function unpivot(row, extra, blobPath, syncedAt) {
  const docs = [];
  const months = monthHeaders(row);
  for (const m of months) {
    const valueFte = parseFte(row[m.header]);
    if (valueFte == null || valueFte === 0) continue;
    docs.push({
      ...landingMeta(blobPath, syncedAt),
      ...extra,
      ...m,
      valueFte,
      valuePct: Math.round(valueFte * 10000) / 100
    });
  }
  return docs;
}

function employeeDocs(rows, blobPath, syncedAt) {
  const docs = [];
  for (const row of rows) {
    const name = String(row.Name || "").trim();
    if (!name) continue;
    const study = parseStudy(row.Study);
    const activity = String(row.Activity || "").trim();
    const rowKind = activity.toLowerCase() === "total" || !study.studyKey ? "total" : "line";
    const nameKey = slug(name, 60) || "unknown";
    const extra = {
      docType: EMPLOYEE_SPEC.docType,
      nameKey,
      employeeName: name,
      organization: row.Organization || null,
      department: row.Department || null,
      roleCode: row.Role || null,
      costCenter: row["Cost Center"] || null,
      contractor: yesNo(row.Contractor),
      studyKey: rowKind === "line" ? study.studyKey : null,
      studyName: study.studyName,
      studyLabel: study.studyLabel,
      activity: activity || null,
      label: row.Label || null,
      rowKind,
      view: "employee"
    };
    if (!extra[EMPLOYEE_SPEC.pk]) continue;
    const pivoted = unpivot(row, extra, blobPath, syncedAt);
    for (const doc of pivoted) {
      const id = makeId([
        "emp",
        doc.nameKey,
        doc.studyKey || "total",
        slug(doc.activity),
        slug(doc.label),
        doc.yearMonth
      ]);
      docs.push({ ...doc, id, nameKey: doc.nameKey });
    }
  }
  return docs;
}

function workitemDocs(rows, blobPath, syncedAt) {
  const docs = [];
  for (const row of rows) {
    const study = parseStudy(row.Study);
    if (!study.studyKey) continue;
    const employee = String(row.Employee || "").trim();
    const rowKind = employee.toLowerCase() === "total" ? "total" : "line";
    const extra = {
      docType: WORKITEM_SPEC.docType,
      studyKey: study.studyKey,
      studyName: study.studyName,
      studyLabel: study.studyLabel,
      activity: String(row.Activity || "").trim() || null,
      roleCode: String(row.Role || "").trim() || null,
      employeeName: rowKind === "total" ? null : employee || null,
      nameKey: rowKind === "total" ? null : slug(employee, 60) || null,
      label: String(row.Label || "").trim() || null,
      rowKind,
      view: "workitem"
    };
    const pivoted = unpivot(row, extra, blobPath, syncedAt);
    for (const doc of pivoted) {
      const id = makeId([
        "wi",
        doc.studyKey,
        slug(doc.activity),
        slug(doc.roleCode),
        doc.nameKey || "total",
        slug(doc.label),
        doc.yearMonth
      ]);
      docs.push({ ...doc, id, studyKey: doc.studyKey });
    }
  }
  return docs;
}

function classifyCsvName(filename) {
  const n = String(filename || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (/staffing-by-employee/.test(n)) return "employee";
  if (/staffing-by-workitem-role/.test(n)) return "workitem-role";
  if (/staffing-by-workitem/.test(n)) return "workitem";
  if (/^rm-employees\.csv$/.test(n)) return "roster";
  if (/^rm-assignments\.csv$/.test(n)) return "assign";
  if (/^rm-sch[_-]/.test(n)) return "schedule";
  if (/staffing/.test(n) && /employee/.test(n)) return "employee";
  if (/staffing/.test(n) && /workitem/.test(n)) return "workitem";
  return null;
}

function rosterDocs(rows, blobPath, syncedAt) {
  const docs = [];
  for (const row of rows) {
    const employeeNumber = String(row["Employee ID"] || row.EmployeeID || "").trim();
    const firstName = String(row["First Name"] || row.FirstName || "").trim();
    const lastName = String(row["Last Name"] || row.LastName || "").trim();
    const fullName = `${firstName} ${lastName}`.trim();
    if (!employeeNumber || !fullName) continue;
    const nameKey = slug(fullName, 60);
    docs.push({
      ...landingMeta(blobPath, syncedAt),
      id: employeeNumber,
      employeeNumber,
      nameKey,
      firstName,
      lastName,
      fullName,
      jobTitle: row.Title || null,
      roleCode: row.Role || null,
      region: row.Region || null,
      subRegion: row["Sub-Region"] || row.SubRegion || null,
      email: row.Email || null,
      managerName: row["Manager ID"] || row.Manager || null,
      costCenter: row["Cost Center"] || null,
      timeAllocation: parsePercent(row["Work-time %"] || row.TimeAllocation),
      billingRate: Number(row["Billing Rate"]) || 0,
      contractor: yesNo(row.Contractor),
      employeeType: row["Employee Type"] || null,
      positionStatus: row["Position Status"] || null,
      hireRehireDate: parseUsDate(row["Hire/Rehire Date"]),
      jobFunctionDescription: row["Job Function Description"] || null,
      billableStatus: row["Billable or Non-Billable or Partially Billable"] || null,
      custom4: row["Custom 4"] || null,
      custom5: row["Custom 5"] || null,
      active: yesNo(row.Active),
      docType: ROSTER_SPEC.docType,
      view: "roster"
    });
  }
  return docs;
}

function assignDocs(rows, blobPath, syncedAt) {
  const docs = [];
  for (const row of rows) {
    const assignmentId = String(row.ID || row.Id || "").trim();
    const study = parseStudy(row.Task || row.Study || "");
    if (!assignmentId || !study.studyKey) continue;
    const employeeName = String(row.Employee || "").trim();
    const valueFte = parsePercent(row.Value);
    docs.push({
      ...landingMeta(blobPath, syncedAt),
      id: assignmentId,
      assignmentId,
      studyKey: study.studyKey,
      studyName: study.studyName,
      studyLabel: study.studyLabel || row.Task || null,
      employeeName: employeeName || null,
      nameKey: slug(employeeName, 60) || null,
      activity: String(row.Activity || "").trim() || null,
      beginDate: parseUsDate(row.Begin),
      endDate: parseUsDate(row.End),
      valueFte,
      valuePct: valueFte == null ? null : Math.round(valueFte * 10000) / 100,
      label: String(row.Label || "").trim() || null,
      status: String(row.Status || "").trim() || null,
      docType: EXPORT_ASSIGN_SPEC.docType,
      view: "assign"
    });
  }
  return docs;
}

function scheduleDocs(rows, blobPath, syncedAt) {
  const docs = [];
  for (const row of rows) {
    const workItem = String(row.WorkItem || row["Work Item"] || "").trim();
    const oraId = String(row["OraProject ID"] || row.OraProjectId || "").trim();
    const study = parseStudy(workItem || oraId);
    const studyKey = oraId || study.studyKey;
    if (!studyKey) continue;
    const activity = String(row.Activity || "").trim() || "All";
    const id = makeId(["sch", studyKey, slug(activity)]);
    const sites = Number(row["# of Sites"]);
    const countriesN = Number(row["# of Countries"]);
    docs.push({
      ...landingMeta(blobPath, syncedAt),
      id,
      studyKey,
      workItem: workItem || null,
      studyName: study.studyName,
      studyLabel: study.studyLabel || workItem || null,
      activity,
      beginDate: parseUsDate(row.Begin),
      endDate: parseUsDate(row.End),
      resourceRegion: row["Resource Region"] || null,
      protocol: row.Protocol || null,
      therapeuticArea: row["Therapeutic Area"] || null,
      sponsor: row.Sponsor || null,
      currentProjectStatus: row["Current Project Status"] || null,
      status: row.Status || null,
      indication: row.Indication || null,
      enrollmentMethod: row["Enrollment Method"] || null,
      studyNickname: row["Study Nickname"] || null,
      oraProjectId: oraId || studyKey,
      numSites: Number.isFinite(sites) ? sites : null,
      numCountries: Number.isFinite(countriesN) ? countriesN : null,
      countries: row["Name of Country(ies)"] || null,
      probability: parsePercent(row.Probability) ?? (row.Probability ? Number(row.Probability) : null),
      studySite: row["Study Site"] || null,
      docType: SCHEDULE_SPEC.docType,
      view: "schedule"
    });
  }
  return docs;
}

function docsFromCsvText(filename, text, blobPath, syncedAt) {
  const kind = classifyCsvName(filename);
  const rows = parseCsv(text);
  if (kind === "employee") return { kind, spec: EMPLOYEE_SPEC, docs: employeeDocs(rows, blobPath, syncedAt) };
  if (kind === "workitem" || kind === "workitem-role") {
    return { kind, spec: WORKITEM_SPEC, docs: workitemDocs(rows, blobPath, syncedAt) };
  }
  if (kind === "roster") return { kind, spec: ROSTER_SPEC, docs: rosterDocs(rows, blobPath, syncedAt) };
  if (kind === "assign") return { kind, spec: EXPORT_ASSIGN_SPEC, docs: assignDocs(rows, blobPath, syncedAt) };
  if (kind === "schedule") return { kind, spec: SCHEDULE_SPEC, docs: scheduleDocs(rows, blobPath, syncedAt) };
  return { kind: null, spec: null, docs: [] };
}

module.exports = {
  EMPLOYEE_SPEC,
  WORKITEM_SPEC,
  ROSTER_SPEC,
  EXPORT_ASSIGN_SPEC,
  SCHEDULE_SPEC,
  parseCsv,
  classifyCsvName,
  docsFromCsvText,
  employeeDocs,
  workitemDocs,
  rosterDocs,
  assignDocs,
  scheduleDocs
};
