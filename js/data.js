const SOURCES = [
  { id: "veeva", name: "Veeva Vault", cat: "eTMF, regulatory, safety", sync: "12 min ago", scope: "48,210 documents", fresh: true },
  { id: "imednet", name: "iMedNet", cat: "EDC — clinical data", sync: "4 min ago", scope: "31 active studies", fresh: true },
  { id: "medidata", name: "Medidata", cat: "EDC — clinical data", sync: "6 min ago", scope: "18 active studies", fresh: true },
  { id: "ctgov", name: "ClinicalTrials.gov", cat: "Public registry", sync: "Yesterday", scope: "6,842 ophthalmology trials", fresh: false },
  { id: "trialhub", name: "TrialHub", cat: "Feasibility and sites", sync: "3 hr ago", scope: "2,140 investigator sites", fresh: true },
  { id: "insightsrm", name: "InsightsRM", cat: "Resource management", sync: "35 min ago", scope: "412 staff across 31 studies", fresh: true },
  { id: "netsuite", name: "NetSuite", cat: "Finance and revenue", sync: "1 hr ago", scope: "FY24–FY26 ledgers", fresh: true },
  { id: "salesforce", name: "Salesforce", cat: "Commercial pipeline", sync: "22 min ago", scope: "314 open opportunities", fresh: true }
];

const WORKSPACES = [
  { id: "clinops", label: "Clinical operations", ids: ["veeva", "imednet", "medidata", "ctgov", "insightsrm", "netsuite"] },
  { id: "bd", label: "Business development", ids: ["salesforce", "ctgov", "trialhub"] },
  { id: "finance", label: "Finance and delivery", ids: ["netsuite", "insightsrm", "salesforce", "imednet", "medidata"] },
  { id: "all", label: "All sources", ids: SOURCES.map((s) => s.id) }
];

const DETAIL = {
  veeva: "2,904 TMF docs",
  imednet: "11 studies",
  medidata: "7 studies",
  ctgov: "218 records",
  trialhub: "640 sites",
  insightsrm: "58 assignments",
  netsuite: "FY26 Q1–Q3",
  salesforce: "96 opportunities"
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

const ANSWERS = {
  enrollment: {
    q: "Which active dry eye studies are behind on enrollment, and what is the cost impact?",
    needs: ["imednet", "medidata", "netsuite"],
    icon: "chart",
    summary: "Four of your eleven active dry eye studies are tracking below the enrollment curve, and two of them carry most of the delay. ORA-2291 is 38% behind plan at week 14, driven by a 41% screen-failure rate at three high-volume sites. Together the four studies represent about $2.1M of revenue that slips from FY26 Q3 into Q4 if the current pace holds.",
    chartTitle: "Enrollment against plan, active dry eye studies",
    chartNote: "Data as of 12 Aug 2026, 09:14 ET",
    chartType: "bar",
    bars: [
      { label: "ORA-2291 (CAE, phase 2)", pct: 62, value: "62%", color: "#ed1c24" },
      { label: "ORA-2144 (phase 3)", pct: 71, value: "71%", color: "#ed1c24" },
      { label: "ORA-1988 (phase 2b)", pct: 84, value: "84%", color: "#b46a00" },
      { label: "ORA-2310 (phase 1)", pct: 91, value: "91%", color: "#b46a00" },
      { label: "All other active studies", pct: 100, value: "104%", color: "#3ebdac" }
    ],
    tableTitle: "The four studies behind plan",
    grid: "1.1fr .9fr .9fr 1.2fr",
    cols: ["Study", "Gap to plan", "Revenue at risk", "Primary driver"],
    rows: [
      ["ORA-2291", "−58 subjects", "$940K", "41% screen failure, 3 sites"],
      ["ORA-2144", "−34 subjects", "$610K", "Site activation 6 weeks late"],
      ["ORA-1988", "−12 subjects", "$310K", "Seasonal recruitment dip"],
      ["ORA-2310", "−7 subjects", "$240K", "IRB amendment pending"]
    ],
    caveat: "Revenue at risk is derived from NetSuite milestone schedules, not signed change orders. Enrollment counts exclude subjects screened in the last 48 hours pending EDC entry.",
    trace: [
      "Matched 11 active studies with indication = dry eye across iMedNet and Medidata.",
      "Compared cumulative enrolled subjects to the planned curve stored on each study record.",
      "Joined studies below 95% of plan to their NetSuite milestone schedule on study code."
    ],
    query: 'studies\n  where indication = "dry eye" and status = "active"          -- iMedNet, Medidata\n  compute pct_of_plan = enrolled / planned_to_date\n  where pct_of_plan < 0.95\n  join netsuite.milestones on study_code\n  compute revenue_at_risk = sum(milestone_value where quarter = "FY26 Q3")\n  order by pct_of_plan asc',
    confidence: "high",
    followUps: [
      "Which three sites drive the ORA-2291 screen failures?",
      "What did we forecast for FY26 Q3 before this slip?",
      "Show the same view for glaucoma studies"
    ]
  },
  staffing: {
    q: "Are we staffed for the studies starting next quarter?",
    needs: ["insightsrm", "imednet", "netsuite"],
    icon: "users",
    summary: "Nine studies start in FY26 Q4 and current assignments cover them at 82% of planned effort. The gap is concentrated in clinical monitoring: you are short 3.4 FTE of CRA capacity in EMEA, and two lead CRAs are booked above 100% from October. Data management and biostatistics are covered with headroom.",
    chartTitle: "Assigned effort against planned, FY26 Q4 starts",
    chartNote: "InsightsRM assignments as of 12 Aug 2026",
    chartType: "bar",
    bars: [
      { label: "Clinical monitoring (EMEA)", pct: 64, value: "64%", color: "#ed1c24" },
      { label: "Project management", pct: 79, value: "79%", color: "#b46a00" },
      { label: "Clinical monitoring (NA)", pct: 93, value: "93%", color: "#b46a00" },
      { label: "Data management", pct: 100, value: "106%", color: "#3ebdac" },
      { label: "Biostatistics", pct: 100, value: "112%", color: "#3ebdac" }
    ],
    tableTitle: "Roles to fill before October",
    grid: "1.1fr .7fr .8fr 1.2fr",
    cols: ["Role", "Gap", "Studies affected", "Earliest available"],
    rows: [
      ["CRA II, EMEA", "3.4 FTE", "4", "Rolls off ORA-2144, 06 Oct"],
      ["Lead CRA", "1.0 FTE", "2", "No internal capacity"],
      ["Project manager", "0.8 FTE", "3", "Rolls off ORA-1988, 22 Sep"]
    ],
    caveat: "Assignments reflect planned allocations in InsightsRM, not actual timesheet hours. Studies without a signed contract are excluded from planned effort.",
    trace: [
      "Listed studies with a planned first-patient-in date inside FY26 Q4 from iMedNet and the NetSuite contract record.",
      "Pulled planned effort by role from each study resource plan in InsightsRM.",
      "Subtracted committed assignments per person, capping at 100% availability, and grouped the shortfall by role and region."
    ],
    query: "studies\n  where fpi_date between 2026-10-01 and 2026-12-31          -- iMedNet, NetSuite\n  join insightsrm.resource_plans on study_code\n  join insightsrm.assignments on person_id\n  compute coverage = assigned_fte / planned_fte\n  group by role, region\n  where coverage < 1.0\n  order by coverage asc",
    confidence: "high",
    followUps: [
      "Who rolls off a study before October?",
      "What does the EMEA CRA gap cost to backfill?",
      "Which studies slip first if we do nothing?"
    ]
  },
  competitive: {
    q: "Where are competitors running CAC-model dry eye trials that we are not?",
    needs: ["ctgov", "trialhub", "salesforce"],
    icon: "globe",
    summary: "Eighteen CAC-model dry eye trials registered in the last 18 months sit outside your site network, concentrated in four markets. Poland and Australia account for eleven of them, and neither appears in your current feasibility footprint. Two of the sponsors running those studies are already open opportunities in your pipeline.",
    chartTitle: "CAC-model dry eye trials outside the Ora network",
    chartNote: "Registry refreshed 11 Aug 2026, 23:40 ET",
    chartType: "bar",
    bars: [
      { label: "Poland", pct: 100, value: "6", color: "#052c49" },
      { label: "Australia", pct: 83, value: "5", color: "#273b8a" },
      { label: "Spain", pct: 66, value: "4", color: "#752f8b" },
      { label: "Canada", pct: 50, value: "3", color: "#3ebdac" }
    ],
    tableTitle: "Sponsors to approach first",
    grid: "1.2fr .6fr 1.1fr 1.1fr",
    cols: ["Sponsor", "Trials", "Pipeline status", "Nearest Ora site"],
    rows: [
      ["Sponsor A (NCT06412…)", "5", "Open opportunity, $3.4M", "Warsaw — 40 km"],
      ["Sponsor B (NCT06388…)", "4", "No account record", "Melbourne — in network"],
      ["Sponsor C (NCT06501…)", "3", "Closed lost, FY25", "Barcelona — 12 km"]
    ],
    caveat: "Registry data lags sponsor postings by up to two weeks. Sponsor names are masked because your role has read access to registry data but not to named account records.",
    trace: [
      "Filtered ClinicalTrials.gov to interventional dry eye trials using a conjunctival allergen challenge design, first posted since Feb 2025.",
      "Removed trials whose listed facilities match a site in the TrialHub network.",
      "Matched remaining sponsors against Salesforce accounts by normalised legal name."
    ],
    query: 'registry.trials\n  where condition ~ "dry eye" and design ~ "allergen challenge"   -- ClinicalTrials.gov\n    and first_posted >= 2025-02-01\n  anti-join trialhub.sites on facility_id\n  group by country\n  left join salesforce.accounts on normalize(sponsor_name)\n  order by trial_count desc',
    confidence: "medium",
    followUps: [
      "Which of these sponsors have we bid on before?",
      "What would it cost to activate four Polish sites?",
      "Compare their endpoints to our CAC protocol library"
    ]
  }
};
