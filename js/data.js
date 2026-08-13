const SOURCES = [
  { id: "veeva", name: "Veeva Vault", cat: "eTMF, regulatory, safety", sync: "from Cosmos", scope: "read-only", fresh: true },
  { id: "imednet", name: "iMedNet", cat: "EDC — clinical data", sync: "from Cosmos", scope: "ora_fact_study", fresh: true },
  { id: "medidata", name: "Medidata", cat: "EDC — clinical data", sync: "from Cosmos", scope: "ora_fact_study", fresh: true },
  { id: "ctgov", name: "ClinicalTrials.gov", cat: "Public registry", sync: "from Cosmos", scope: "ora_ctgov_trials", fresh: true },
  { id: "trialhub", name: "TrialHub", cat: "Feasibility and sites", sync: "from Cosmos", scope: "ora_trialhub_trials", fresh: true },
  { id: "insightsrm", name: "InsightsRM", cat: "Resource management", sync: "not in Cosmos yet", scope: "gold ETL later", fresh: false },
  { id: "netsuite", name: "NetSuite", cat: "Finance and revenue", sync: "not in Cosmos yet", scope: "gold ETL later", fresh: false },
  { id: "salesforce", name: "Salesforce", cat: "Commercial pipeline", sync: "from Cosmos", scope: "ora_sponsor_crosswalk", fresh: true }
];

const WORKSPACES = [
  { id: "clinops", label: "Clinical operations", ids: ["veeva", "imednet", "medidata", "ctgov", "insightsrm", "netsuite"] },
  { id: "bd", label: "Business development", ids: ["salesforce", "ctgov", "trialhub"] },
  { id: "finance", label: "Finance and delivery", ids: ["netsuite", "insightsrm", "salesforce", "imednet", "medidata"] },
  { id: "all", label: "All sources", ids: SOURCES.map((s) => s.id) }
];

const DETAIL = {
  veeva: "TMF (not queried yet)",
  imednet: "ora_fact_study",
  medidata: "ora_fact_study",
  ctgov: "ora_ctgov_trials",
  trialhub: "ora_trialhub_trials",
  insightsrm: "not loaded",
  netsuite: "not loaded",
  salesforce: "ora_sponsor_crosswalk"
};

const DOT = {
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
  { text: "Which Ora dry eye studies enrolled the most subjects?", icon: "chart", needs: "Reads ora_fact_study" },
  { text: "Show competing dry eye trials", icon: "globe", needs: "Reads ora_trialhub_trials + ora_ctgov_trials" },
  { text: "List Ora glaucoma studies", icon: "chart", needs: "Reads ora_fact_study" }
];
