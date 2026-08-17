/**
 * InsightsRM star schema — from workbook sheet Model_Relationships.
 * Used at read time to join Cosmos lens_rm_* packs in memory (no mapping table).
 */

const RM_ENTITIES = {
  Dim_Study: {
    sheet: "Dim_Study",
    container: "lens_rm_studies",
    docType: "lens_rm_study",
    pk: "studyKey",
    label: "Study"
  },
  Dim_Role: {
    sheet: "Dim_Role",
    container: "lens_rm_roles",
    docType: "lens_rm_role",
    pk: "roleId",
    label: "Role"
  },
  Dim_Employee: {
    sheet: "Dim_Employee",
    container: "lens_rm_employees",
    docType: "lens_rm_employee",
    pk: "employeeKey",
    label: "Employee"
  },
  Dim_Activity: {
    sheet: "Dim_Activity",
    container: "lens_rm_activities",
    docType: "lens_rm_activity",
    pk: "activityId",
    label: "Activity"
  },
  Dim_Department: {
    sheet: "Dim_Department",
    container: "lens_rm_departments",
    docType: "lens_rm_department",
    pk: "departmentId",
    label: "Department"
  },
  Dim_Organization: {
    sheet: "Dim_Organization",
    container: "lens_rm_organizations",
    docType: "lens_rm_organization",
    pk: "organizationId",
    label: "Organization"
  },
  Dim_Domain: {
    sheet: "Dim_Domain",
    container: "lens_rm_domains",
    docType: "lens_rm_domain",
    pk: "domainId",
    label: "Domain"
  },
  Dim_User: {
    sheet: "Dim_User",
    container: "lens_rm_users",
    docType: "lens_rm_user",
    pk: "userId",
    label: "User"
  },
  Dim_Date: {
    sheet: "Dim_Date",
    container: null,
    docType: null,
    pk: "dateKey",
    label: "Date"
  },
  Fact_Actuals: {
    sheet: "Fact_Actuals",
    container: "lens_rm_actuals",
    docType: "lens_rm_actual",
    pk: "studyKey",
    label: "Actuals"
  },
  Fact_Assignments: {
    sheet: "Fact_Assignments",
    container: "lens_rm_assignments",
    docType: "lens_rm_assignment",
    pk: "studyKey",
    label: "Assignments"
  },
  Fact_Projections: {
    sheet: "Fact_Projections",
    container: "lens_rm_projections",
    docType: "lens_rm_projection",
    pk: "studyKey",
    label: "Projections"
  },
  Fact_Headcount: {
    sheet: "Fact_Headcount",
    container: "lens_rm_headcount",
    docType: "lens_rm_headcount",
    pk: "roleId",
    label: "Headcount"
  }
};

/** CSV landing packs — same studyKey / nameKey joins, not in the xlsx relationship sheet. */
const RM_LANDING = {
  staffing_employee: {
    container: "lens_rm_staffing_employee",
    docType: "lens_rm_staffing_employee",
    pk: "nameKey",
    join: { employeeName: "nameKey", studyKey: "studyKey" }
  },
  staffing_workitem: {
    container: "lens_rm_staffing_workitem",
    docType: "lens_rm_staffing_workitem",
    pk: "studyKey",
    join: { studyKey: "studyKey", employeeName: "employeeName" }
  },
  roster: {
    container: "lens_rm_roster",
    docType: "lens_rm_roster",
    pk: "employeeNumber",
    join: { fullName: "nameKey", employeeNumber: "employeeNumber" }
  },
  export_assignments: {
    container: "lens_rm_export_assignments",
    docType: "lens_rm_export_assignment",
    pk: "studyKey",
    join: { studyKey: "studyKey", employeeName: "nameKey" }
  },
  schedule: {
    container: "lens_rm_schedule",
    docType: "lens_rm_schedule",
    pk: "studyKey",
    join: { studyKey: "studyKey" }
  }
};

/** From Model_Relationships — Active Power BI relationships only for default joins. */
const RM_RELATIONSHIPS = [
  { from: "Dim_Study", fromCol: "studyKey", to: "Fact_Actuals", toCol: "studyKey", active: true },
  { from: "Dim_Study", fromCol: "studyKey", to: "Fact_Assignments", toCol: "studyKey", active: true },
  { from: "Dim_Study", fromCol: "studyKey", to: "Fact_Projections", toCol: "studyKey", active: true },
  { from: "Dim_Role", fromCol: "roleId", to: "Fact_Actuals", toCol: "roleId", active: true },
  { from: "Dim_Role", fromCol: "roleId", to: "Fact_Assignments", toCol: "roleId", active: true },
  { from: "Dim_Role", fromCol: "roleId", to: "Fact_Projections", toCol: "roleId", active: true },
  { from: "Dim_Role", fromCol: "roleId", to: "Fact_Headcount", toCol: "roleId", active: true },
  { from: "Dim_Role", fromCol: "roleId", to: "Dim_Employee", toCol: "roleId", active: true },
  { from: "Dim_Employee", fromCol: "employeeKey", to: "Fact_Actuals", toCol: "employeeKey", active: true },
  { from: "Dim_Employee", fromCol: "employeeKey", to: "Fact_Assignments", toCol: "employeeKey", active: true },
  { from: "Dim_Activity", fromCol: "activityId", to: "Fact_Actuals", toCol: "activityId", active: true },
  { from: "Dim_Activity", fromCol: "activityId", to: "Fact_Assignments", toCol: "activityId", active: true },
  { from: "Dim_Activity", fromCol: "activityId", to: "Fact_Projections", toCol: "activityId", active: true },
  { from: "Dim_Domain", fromCol: "domainId", to: "Dim_Organization", toCol: "domainId", active: true },
  { from: "Dim_Domain", fromCol: "domainId", to: "Dim_Department", toCol: "domainId", active: true },
  { from: "Dim_Domain", fromCol: "domainId", to: "Dim_Role", toCol: "domainId", active: true },
  { from: "Dim_Domain", fromCol: "domainId", to: "Dim_Employee", toCol: "domainId", active: true },
  { from: "Dim_Domain", fromCol: "domainId", to: "Dim_Activity", toCol: "domainId", active: true },
  { from: "Dim_Organization", fromCol: "organizationId", to: "Dim_Department", toCol: "organizationId", active: true },
  { from: "Dim_Department", fromCol: "departmentId", to: "Dim_Role", toCol: "departmentId", active: true },
  { from: "Dim_User", fromCol: "userId", to: "Dim_Employee", toCol: "createdByUserId", active: true }
];

const RM_DQ = {
  overAllocated: { sheet: "DQ_04_OverAllocatedPersonnel", pk: "employeeKey" },
  capacityGaps: { sheet: "DQ_07_CapacityGaps", pk: "roleCode" }
};

/** Pre-built join paths: fact → dims for display labels. */
const FACT_ENRICH = {
  Fact_Assignments: [
    { dim: "Dim_Employee", factCol: "employeeKey", dimCol: "employeeKey", fields: ["fullName", "jobTitle", "timeAllocation", "active", "region"] },
    { dim: "Dim_Role", factCol: "roleId", dimCol: "roleId", fields: ["roleCode", "roleGroup"] },
    { dim: "Dim_Study", factCol: "studyKey", dimCol: "studyKey", fields: ["studyName", "studyLabel", "sponsor", "therapeuticArea"] },
    { dim: "Dim_Activity", factCol: "activityId", dimCol: "activityId", fields: ["activityName"] }
  ],
  Fact_Actuals: [
    { dim: "Dim_Employee", factCol: "employeeKey", dimCol: "employeeKey", fields: ["fullName", "jobTitle"] },
    { dim: "Dim_Study", factCol: "studyKey", dimCol: "studyKey", fields: ["studyName", "studyLabel"] },
    { dim: "Dim_Role", factCol: "roleId", dimCol: "roleId", fields: ["roleCode"] }
  ],
  Fact_Headcount: [{ dim: "Dim_Role", factCol: "roleId", dimCol: "roleId", fields: ["roleCode", "roleGroup"] }]
};

function entityByContainer(containerId) {
  return Object.values(RM_ENTITIES).find((e) => e.container === containerId) || null;
}

function joinsForFact(factName) {
  return RM_RELATIONSHIPS.filter((r) => r.to === factName && r.active);
}

module.exports = {
  RM_ENTITIES,
  RM_LANDING,
  RM_RELATIONSHIPS,
  RM_DQ,
  FACT_ENRICH,
  entityByContainer,
  joinsForFact
};
