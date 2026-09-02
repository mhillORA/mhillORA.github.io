export const SOURCES = [
  { id: "ora", name: "Ora clinical (live Vault)", cat: "Studies + sites + milestones", sync: "from Cosmos", scope: "ora_veeva_study + ora_veeva_site", loaded: true },
  { id: "ctgov", name: "ClinicalTrials.gov", cat: "Public registry", sync: "from Cosmos", scope: "ora_ctgov_trials", loaded: true },
  { id: "trialhub", name: "TrialHub", cat: "Industry feasibility", sync: "from Cosmos", scope: "ora_trialhub_trials", loaded: true },
  { id: "salesforce", name: "Salesforce", cat: "Pipeline", sync: "from Cosmos", scope: "ora_sf_opportunity", loaded: true },
  { id: "insightsrm", name: "InsightsRM", cat: "Resource management", sync: "temporary Cosmos until DW", scope: "lens_rm_*", loaded: true },
  { id: "netsuite", name: "NetSuite", cat: "Project profitability", sync: "from Cosmos", scope: "lens_ns_projects", loaded: true }
];

export const PURPOSES = [
  { id: "clinops", label: "ClinOps", hint: "Enrollment, sites, studies" },
  { id: "finance", label: "Finance", hint: "GM, delivery, project list" },
  { id: "staffing", label: "RM", hint: "FTE, assignments, capacity" },
  { id: "bd", label: "Business development", hint: "Pipeline, registry, sponsors" }
];

export const NAV = [
  { key: "ask", label: "Ask" },
  { key: "rm", label: "RM" },
  { key: "context", label: "My context" },
  { key: "saved", label: "Saved answers" },
  { key: "sources", label: "Sources" },
  { key: "history", label: "History" }
];

export const SUGGESTIONS = [
  "Which active dry eye studies are behind on enrollment?",
  "Who is over-allocated for next 3 months?",
  "Show Project Profitability GM for ACS service lines"
];
