const SKIP_SHEETS = new Set(["ReadMe", "Model_Relationships", "Dim_Date"]);

/** Ora Resource Management production domain. Demo / sandbox / test catalog rows stay out. */
const PRODUCTION_DOMAIN_ID = 200;

const SHEETS = [
  { sheet: "Dim_Study", container: "lens_rm_studies", docType: "lens_rm_study", idField: "studyKey", pk: "studyKey" },
  { sheet: "Dim_Role", container: "lens_rm_roles", docType: "lens_rm_role", idField: "roleId", pk: "roleId" },
  { sheet: "Dim_Employee", container: "lens_rm_employees", docType: "lens_rm_employee", idField: "employeeKey", pk: "employeeKey" },
  { sheet: "Dim_Activity", container: "lens_rm_activities", docType: "lens_rm_activity", idField: "activityId", pk: "activityId" },
  { sheet: "Dim_Department", container: "lens_rm_departments", docType: "lens_rm_department", idField: "departmentId", pk: "departmentId" },
  { sheet: "Dim_Organization", container: "lens_rm_organizations", docType: "lens_rm_organization", idField: "organizationId", pk: "organizationId" },
  { sheet: "Dim_Domain", container: "lens_rm_domains", docType: "lens_rm_domain", idField: "domainId", pk: "domainId" },
  { sheet: "Dim_User", container: "lens_rm_users", docType: "lens_rm_user", idField: "userId", pk: "userId" },
  { sheet: "Fact_Actuals", container: "lens_rm_actuals", docType: "lens_rm_actual", idField: "actualFactKey", pk: "studyKey" },
  { sheet: "Fact_Assignments", container: "lens_rm_assignments", docType: "lens_rm_assignment", idField: "assignmentFactKey", pk: "studyKey" },
  { sheet: "Fact_Projections", container: "lens_rm_projections", docType: "lens_rm_projection", idField: "projectionFactKey", pk: "studyKey" },
  { sheet: "Fact_Headcount", container: "lens_rm_headcount", docType: "lens_rm_headcount", idField: "headcountFactKey", pk: "roleId" }
];

const DQ_SHEETS = [
  "DQ_00_Summary",
  "DQ_01_DateLogicErrors",
  "DQ_02_ExtremeFTEValues",
  "DQ_03_DuplicateAssignments",
  "DQ_04_OverAllocatedPersonnel",
  "DQ_05_InactiveEmployeeActivity",
  "DQ_06_BlankOrZeroFields",
  "DQ_07_CapacityGaps"
];

const NUM_FIELDS = new Set([
  "roleId",
  "domainId",
  "departmentId",
  "organizationId",
  "activityId",
  "employeeKey",
  "userId",
  "parentDomainId",
  "sortOrder",
  "numSites",
  "numCountries",
  "probability",
  "timeAllocation",
  "billingRate",
  "createdByUserId",
  "modifiedByUserId",
  "batchId",
  "valueFte",
  "projectedValueFte",
  "capacityFte",
  "beginDateKey",
  "endDateKey",
  "actualFactKey",
  "assignmentFactKey",
  "projectionFactKey",
  "headcountFactKey",
  "rowsFound",
  "fte",
  "recordKey",
  "currentAssignedFte",
  "overAllocationFte",
  "overAllocationPct",
  "currentDemandFte",
  "gapFte"
]);

const BOOL_FIELDS = new Set([
  "isSynthetic",
  "active",
  "contractor",
  "isDefault",
  "inProjectionsMasterData"
]);

const DATE_FIELDS = new Set(["beginDate", "endDate", "hireRehireDate", "createdOn", "modifiedOn", "date"]);

function toCamel(name) {
  const n = String(name || "")
    .replace(/_raw$/i, "Raw")
    .replace(/_([a-z])/gi, (_, c) => c.toUpperCase());
  if (!n) return n;
  return n.charAt(0).toLowerCase() + n.slice(1);
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

function dateOrNull(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.length > 10 ? new Date(s).toISOString() : `${s}T00:00:00.000Z`;
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const epoch = Date.UTC(1899, 11, 30) + n * 86400000;
    return new Date(epoch).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function coerce(key, value) {
  if (NUM_FIELDS.has(key)) return numOrNull(value);
  if (BOOL_FIELDS.has(key)) return boolOrNull(value);
  if (DATE_FIELDS.has(key)) return dateOrNull(value);
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return dateOrNull(value);
  return String(value).trim();
}

function rowToFields(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    const key = toCamel(k);
    if (!key) continue;
    out[key] = coerce(key, v);
  }
  return out;
}

function asId(v) {
  if (v == null || v === "") return null;
  return String(v).trim();
}

function keepRow(sheet, fields) {
  if (sheet === "Dim_Domain") {
    const id = Number(fields.domainId);
    return id === PRODUCTION_DOMAIN_ID;
  }
  if (fields.domainId != null && Number(fields.domainId) !== PRODUCTION_DOMAIN_ID) return false;
  return true;
}

function landingMeta(blobPath, syncedAt) {
  return {
    source: "insightsrm",
    datasetKind: "actual",
    landing: "xlsx",
    untilGold: true,
    sourceBlob: blobPath,
    syncedAt
  };
}

function toDocs(sheetDef, rows, syncedAt, blobPath) {
  const docs = [];
  for (const raw of rows) {
    const fields = rowToFields(raw);
    if (!keepRow(sheetDef.sheet, fields)) continue;
    const id = asId(fields[sheetDef.idField]);
    const pk = asId(fields[sheetDef.pk]);
    if (!id || !pk) continue;
    docs.push({
      id,
      [sheetDef.pk]: pk,
      docType: sheetDef.docType,
      ...landingMeta(blobPath, syncedAt),
      ...fields,
      id,
      [sheetDef.pk]: pk
    });
  }
  return docs;
}

function toDqDocs(sheet, rows, syncedAt, blobPath) {
  const docs = [];
  rows.forEach((raw, i) => {
    const fields = rowToFields(raw);
    const key =
      asId(fields.recordKey) ||
      asId(fields.assignmentFactKey) ||
      asId(fields.employeeKey) ||
      asId(fields.roleCode) ||
      asId(fields.sheet) ||
      String(i + 1);
    docs.push({
      id: `${sheet}__${key}__${i + 1}`,
      sheet,
      docType: "lens_rm_dq",
      ...landingMeta(blobPath, syncedAt),
      rowIndex: i + 1,
      ...fields,
      id: `${sheet}__${key}__${i + 1}`,
      sheet
    });
  });
  return docs;
}

module.exports = {
  SKIP_SHEETS,
  SHEETS,
  DQ_SHEETS,
  PRODUCTION_DOMAIN_ID,
  toDocs,
  toDqDocs,
  rowToFields
};
