const SOURCES = [
  { id: "ora", name: "Ora clinical rollup", cat: "Studies + sites (Veeva pack)", sync: "from Cosmos", scope: "ora_fact_study + ora_fact_site", fresh: true, loaded: true },
  { id: "ctgov", name: "ClinicalTrials.gov", cat: "Public registry", sync: "from Cosmos", scope: "ora_ctgov_trials", fresh: true, loaded: true },
  { id: "trialhub", name: "TrialHub", cat: "Feasibility and sites", sync: "from Cosmos", scope: "ora_trialhub_trials", fresh: true, loaded: true },
  { id: "salesforce", name: "Salesforce", cat: "Sponsor crosswalk", sync: "from Cosmos", scope: "ora_sponsor_crosswalk", fresh: true, loaded: true },
  { id: "veeva", name: "Veeva Vault", cat: "eTMF, regulatory, safety", sync: "not in Cosmos yet", scope: "gold ETL later", fresh: false, loaded: false },
  { id: "imednet", name: "iMedNet", cat: "Live EDC — not a separate feed", sync: "use Ora clinical rollup", scope: "not split out yet", fresh: false, loaded: false },
  { id: "medidata", name: "Medidata", cat: "Live EDC — not a separate feed", sync: "use Ora clinical rollup", scope: "not split out yet", fresh: false, loaded: false },
  { id: "insightsrm", name: "InsightsRM", cat: "Resource management", sync: "not in Cosmos yet", scope: "gold ETL later", fresh: false, loaded: false },
  { id: "netsuite", name: "NetSuite", cat: "Project profitability", sync: "from Cosmos", scope: "lens_ns_projects", fresh: true, loaded: true }
];

const WORKSPACES = [
  { id: "clinops", label: "Clinical operations", ids: ["ora", "ctgov", "trialhub"] },
  { id: "bd", label: "Business development", ids: ["salesforce", "ctgov", "trialhub"] },
  { id: "finance", label: "Finance and delivery", ids: ["ora", "netsuite", "salesforce"] },
  { id: "all", label: "Loaded sources", ids: SOURCES.filter((s) => s.loaded).map((s) => s.id) }
];

const PURPOSES = [
  {
    id: "clinops",
    label: "ClinOps",
    hint: "Enrollment, sites, studies",
    workspace: "clinops",
    ids: ["ora", "ctgov", "trialhub"]
  },
  {
    id: "finance",
    label: "Finance",
    hint: "GM, delivery, project list",
    workspace: "finance",
    ids: ["ora", "netsuite", "salesforce"]
  },
  {
    id: "bd",
    label: "Business development",
    hint: "Registry and sponsors",
    workspace: "bd",
    ids: ["salesforce", "ctgov", "trialhub"]
  }
];

const DETAIL = {
  ora: "ora_fact_study + ora_fact_site",
  veeva: "not loaded",
  imednet: "not a separate feed",
  medidata: "not a separate feed",
  ctgov: "ora_ctgov_trials",
  trialhub: "ora_trialhub_trials",
  insightsrm: "not loaded",
  netsuite: "lens_ns_projects",
  salesforce: "ora_sponsor_crosswalk"
};

const DOT = {
  ora: "#052c49",
  veeva: "#052c49",
  imednet: "#273b8a",
  medidata: "#752f8b",
  ctgov: "#3ebdac",
  trialhub: "#2a9084",
  insightsrm: "#273b8a",
  netsuite: "#ed1c24",
  salesforce: "#63666b"
};

const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16l4-6 3 3 5-7"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M21 19a5 5 0 0 0-6-4.7"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
};

const EXAMPLE_QUESTIONS = [
  { text: "Which Ora dry eye studies enrolled the most subjects?", icon: "chart", needs: "Certified · ora_fact_study" },
  { text: "List Ora glaucoma studies", icon: "chart", needs: "Certified · ora_fact_study" },
  { text: "Which Ora sites enrolled the most in dry eye?", icon: "users", needs: "Certified · ora_fact_site" },
  { text: "Show competing dry eye trials", icon: "globe", needs: "Certified · TrialHub + CT.gov" },
  { text: "Which projects are under budgeted GM?", icon: "chart", needs: "Certified · NetSuite profitability" }
];

const FINANCE_QUESTIONS = [
  { text: "Which projects are under budgeted GM?", icon: "chart", needs: "Certified · NetSuite" },
  { text: "Which NetSuite projects have no GM%?", icon: "chart", needs: "Missing ≠ zero" },
  { text: "Show change order status for posterior projects", icon: "file", needs: "NetSuite · posterior" },
  { text: "Which projects have the highest cost per billable hour vs budget?", icon: "chart", needs: "NetSuite cost/hr" }
];

const BD_QUESTIONS = [
  { text: "Show competing dry eye trials", icon: "globe", needs: "Certified · TrialHub + CT.gov" },
  { text: "Show competing glaucoma trials", icon: "globe", needs: "Certified · TrialHub + CT.gov" },
  { text: "Which Ora studies match this indication?", icon: "chart", needs: "ora_fact_study" }
];
