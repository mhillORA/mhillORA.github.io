const { getDb, safeQuery, LENS, SHARED_READ } = require("./cosmos");
const { narrateWithFoundry } = require("./foundry");
const { getProjectBundle, studyMatchesProject } = require("./projectJoin");
const { getViewerContext, foundryViewerSlice } = require("./userPrefs");
const { answerRmQuestion, looksLikeRmRefinement } = require("./rmPack");
const { loadLivePack } = require("./veevaLive");

function guessKey(text, priorTurns) {
  const t = String(text || "").toLowerCase();
  if (/(no enrolled|missing enrolled|without enrolled|enrolled count|null enrolled)/.test(t)) {
    return "missing_enrolled";
  }
  if (/(site scorecard|which sites|site performance|site psm|investigators?|\bsites?\b)/.test(t) && !/\bvisits?\b/.test(t)) {
    return "sites";
  }
  if (/(pipeline|opportunit|net revenue|open deals|salesforce account)/.test(t)) {
    return "pipeline";
  }
  if (/(competitor|sponsor|registry|market|poland|cac|bid|trialhub|ct\.gov|clinicaltrials)/.test(t)) {
    return "competitive";
  }
  if (/(netsuite|profitability|gross margin|\bgm\b|budgeted gm|actual gm|change order|billable hr|cost per billable|eos gm|service line)/.test(t)) {
    return "netsuite";
  }
  if (/(staff|resource|cra|fte|capacity|assign|backfill|headcount|over.?allocat|overallocat|under.?utili|under.?allocat|allocation)/.test(t)) return "staffing";
  const priorStaffing = (priorTurns || []).some(
    (turn) =>
      (turn.needs || []).includes("insightsrm") ||
      turn.rmIntent ||
      /(staff|resource|fte|allocat|utili)/i.test(turn.question || "")
  );
  if (priorStaffing && looksLikeRmRefinement(text)) return "staffing";
  if (/(visit|visits)/.test(t)) return "visits";
  return "enrollment";
}

function barColor(pct) {
  if (pct < 80) return "#ed1c24";
  if (pct < 95) return "#b46a00";
  return "#3ebdac";
}

function indicationNeedle(question) {
  const t = String(question || "").toLowerCase();
  if (t.includes("dry eye") || t.includes("ded")) return "dry eye";
  if (t.includes("glaucoma")) return "glaucoma";
  if (t.includes("cataract")) return "cataract";
  return null;
}

function countryNeedle(question) {
  const t = String(question || "").toLowerCase();
  if (/\b(united states|u\.s\.a\.?|\busa\b|\bus\b)\b/.test(t)) return "United States";
  if (/\b(united kingdom|\buk\b|britain)\b/.test(t)) return "United Kingdom";
  if (/\bcanada\b/.test(t)) return "Canada";
  if (/\bgermany\b/.test(t)) return "Germany";
  if (/\bpoland\b/.test(t)) return "Poland";
  if (/\bjapan\b/.test(t)) return "Japan";
  if (/\baustralia\b/.test(t)) return "Australia";
  return null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function enrolledOf(row) {
  if (row == null || row.total_enrolled == null || row.total_enrolled === "") return null;
  const n = Number(row.total_enrolled);
  return Number.isFinite(n) ? n : null;
}

function asOfMeta(rows) {
  const stamps = (rows || []).map((r) => r._ts).filter((n) => typeof n === "number" && n > 0);
  if (!stamps.length) {
    const now = new Date();
    return {
      asOf: now.toISOString(),
      asOfLabel: `read ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      asOfKind: "query"
    };
  }
  const d = new Date(Math.max(...stamps) * 1000);
  return {
    asOf: d.toISOString(),
    asOfLabel: `as of ${d.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    asOfKind: "document"
  };
}

function stamp(answer, rows) {
  const meta = asOfMeta(rows);
  answer.asOf = meta.asOf;
  answer.asOfLabel = meta.asOfLabel;
  answer.asOfKind = meta.asOfKind;
  if (answer.chartNote && !/as of |read /.test(answer.chartNote)) {
    answer.chartNote = `${answer.chartNote} · ${meta.asOfLabel}`;
  }
  return answer;
}

function pctLabel(n) {
  if (n == null) return "—";
  return `${Math.round(Number(n) * 1000) / 10}%`;
}

function gmOf(row, field) {
  return numOrNull(row[field]);
}

async function fromNsProjects(question) {
  const t = String(question || "").toLowerCase();
  const rows = await safeQuery(
    LENS.nsProjects,
    "SELECT TOP 200 c.id, c.project_number, c.project_name, c.project_manager, c.customer_name, c.project_status, c.service_line, c.change_order_status, c.budgeted_gm_pct, c.actual_gm_pct_prior_month, c.gm_pct_variance, c.projected_eos_gm_pct_prior_month, c.cost_per_billable_hr_actual, c.cost_per_billable_hr_budgeted, c.sourceBlob, c.syncedAt, c._ts FROM c WHERE c.docType = @t",
    [{ name: "@t", value: "lens_ns_project" }]
  );
  if (!rows.length) return null;

  const proj = String(question).match(/\b\d{2}-\d{3}-\d{4}\b/);
  let used = rows;
  if (proj) used = rows.filter((r) => r.project_number === proj[0]);
  if (t.includes("posterior")) used = used.filter((r) => String(r.service_line || "").toLowerCase().includes("posterior"));
  if (t.includes("anterior")) used = used.filter((r) => String(r.service_line || "").toLowerCase().includes("anterior"));
  if (t.includes("medical device")) used = used.filter((r) => String(r.service_line || "").toLowerCase().includes("medical"));
  if (!used.length) used = rows;

  const wantMissing = /(no gm|missing gm|blank gm|without gm)/.test(t);
  const wantCost = /(billable|cost per)/.test(t);
  const known = used.filter((r) => gmOf(r, "gm_pct_variance") != null);
  const missing = used.filter((r) => gmOf(r, "gm_pct_variance") == null);
  const under = known.filter((r) => gmOf(r, "gm_pct_variance") < 0).sort((a, b) => gmOf(a, "gm_pct_variance") - gmOf(b, "gm_pct_variance"));
  const costKnown = used
    .filter((r) => gmOf(r, "cost_per_billable_hr_actual") != null)
    .slice()
    .sort((a, b) => (gmOf(b, "cost_per_billable_hr_actual") || 0) - (gmOf(a, "cost_per_billable_hr_actual") || 0));
  const chartSource = wantMissing
    ? []
    : wantCost && costKnown.length
      ? costKnown.slice(0, 8)
      : (/(under|behind|below|short)/.test(t) && under.length ? under : known.slice().sort((a, b) => gmOf(a, "gm_pct_variance") - gmOf(b, "gm_pct_variance"))).slice(0, 8);
  const maxAbs = Math.max(0.01, ...chartSource.map((r) => Math.abs(gmOf(r, "gm_pct_variance") || 0)));
  const tableRows = wantMissing ? missing : used;

  return stamp(
    {
      q: question,
      needs: ["netsuite"],
      icon: "chart",
      summary: wantMissing
        ? `${missing.length} of ${used.length} NetSuite projects have no GM% in the profitability snapshot.`
        : wantCost
          ? `${costKnown.length} projects have actual cost per billable hour. Blank cost is missing, not zero.`
          : `${known.length} projects have GM%. ${under.length} are under budgeted GM. ${missing.length} have GM missing (not zero).`,
      chartTitle: wantMissing
        ? "No GM chart — values are missing"
        : wantCost
          ? "Actual cost per billable hour (known values only)"
          : "GM% variance vs budget (known values only)",
      chartNote: "NetSuite Project Profitability · lens_ns_projects · read-only",
      chartType: "bar",
      bars: (wantCost
        ? (() => {
            const maxCost = Math.max(1, ...chartSource.map((r) => gmOf(r, "cost_per_billable_hr_actual") || 0));
            return chartSource.map((r) => {
              const v = gmOf(r, "cost_per_billable_hr_actual");
              return {
                label: `${r.project_number} ${r.project_name || ""}`.slice(0, 42),
                pct: Math.round((v / maxCost) * 100),
                value: v == null ? "—" : `$${Math.round(v)}`,
                color: "#052c49"
              };
            });
          })()
        : chartSource.map((r) => {
            const v = gmOf(r, "gm_pct_variance");
            return {
              label: `${r.project_number} ${r.project_name || ""}`.slice(0, 42),
              pct: Math.round((Math.abs(v) / maxAbs) * 100),
              value: pctLabel(v),
              color: v < 0 ? "#ed1c24" : "#3ebdac"
            };
          })),
      tableTitle: wantMissing ? "Projects with GM missing" : wantCost ? "Cost per billable hour" : "Project profitability",
      grid: wantCost ? "0.8fr 1.4fr 0.7fr 0.7fr 0.6fr" : "0.8fr 1.4fr 0.6fr 0.6fr 0.6fr 1fr",
      cols: wantCost
        ? ["Number", "Project", "Actual $/hr", "Budget $/hr", "Variance GM"]
        : ["Number", "Project", "Budget GM", "Actual GM", "Variance", "Change order"],
      rows: (wantCost ? costKnown : tableRows).slice(0, 12).map((r) =>
        wantCost
          ? [
              r.project_number || "—",
              r.project_name || "—",
              gmOf(r, "cost_per_billable_hr_actual") == null ? "—" : `$${Math.round(gmOf(r, "cost_per_billable_hr_actual"))}`,
              gmOf(r, "cost_per_billable_hr_budgeted") == null ? "—" : `$${Math.round(gmOf(r, "cost_per_billable_hr_budgeted"))}`,
              pctLabel(gmOf(r, "gm_pct_variance"))
            ]
          : [
              r.project_number || "—",
              r.project_name || "—",
              pctLabel(gmOf(r, "budgeted_gm_pct")),
              pctLabel(gmOf(r, "actual_gm_pct_prior_month")),
              pctLabel(gmOf(r, "gm_pct_variance")),
              r.change_order_status || "—"
            ]
      ),
      projectKeys: (wantCost ? costKnown : tableRows).slice(0, 12).map((r) => r.project_number || ""),
      projectKeys: tableRows.slice(0, 12).map((r) => r.project_number || ""),
      missingCount: missing.length,
      missingNote: wantMissing ? "" : missingNote(missing.length, known.length).replace(/enrolled value/g, "GM%").replace(/enrolled/g, "GM%"),
      caveat: "Snapshot from NetSuite Project Profitability (blob → lens_ns_projects). Blank GM is missing, not 0%. Grain is job (US/AU can share a project number).",
      trace: [
        `Read container ${LENS.nsProjects} (docType = lens_ns_project). Did not write.`,
        rows[0] && rows[0].sourceBlob ? `Last blob ${rows[0].sourceBlob}.` : "No sourceBlob on docs yet.",
        wantMissing ? "Filtered to missing GM." : "Chart uses known gm_pct_variance only."
      ],
      query: "lens_ns_projects where docType = 'lens_ns_project'",
      confidence: "high",
      followUps: [
        "Which projects are under budgeted GM?",
        "Which NetSuite projects have no GM%?",
        "Show change order status for posterior projects"
      ]
    },
    used
  );
}

async function fromRmStaffing(question, priorTurns) {
  return answerRmQuestion(question, stamp, priorTurns);
}

function missingNote(missingCount, knownCount) {
  if (!missingCount) return "";
  return `${missingCount} ${missingCount === 1 ? "study has" : "studies have"} no enrolled value. They are listed in the table and omitted from the chart — not plotted as zero. ${knownCount} ${knownCount === 1 ? "study has" : "studies have"} a number.`;
}

function emptyLiveAnswer(question, pack) {
  return stamp(
    {
      q: question,
      needs: ["ora", "veeva"],
      icon: "chart",
      summary: `Live Veeva ingest has not landed in Cosmos yet (${pack} is empty). Data Lens does not fall back to ora_fact_* Excel dumps.`,
      chartTitle: "No live Vault rows",
      chartNote: "ora_veeva_* · read-only",
      chartType: "bar",
      bars: [],
      tableTitle: "Result",
      grid: "1fr",
      cols: ["Note"],
      rows: [["Workbench ingest of ora_veeva_* has not written documents this SWA can read."]],
      caveat: "Null is missing, not zero. When the live containers populate, Ask will use FSI→LSI PSM from ora_veeva_milestone.",
      trace: [`Queried ${pack} on bd-budgets. Zero documents. Did not read ora_fact_study / ora_fact_site.`],
      query: `${pack} empty`,
      confidence: "low",
      followUps: [
        "Which Ora dry eye studies enrolled the most subjects?",
        "Show competing dry eye trials",
        "Which projects are under budgeted GM?"
      ]
    },
    []
  );
}

async function fromOraFactSite(question) {
  const needle = indicationNeedle(question);
  const country = countryNeedle(question);
  const studyMatch = String(question).match(/\b(?:ORA[- ]?\d{3,}|ADX[-][\w-]+)\b/i);
  const pack = await loadLivePack();
  if (!(pack.sites || []).length) return emptyLiveAnswer(question, SHARED_READ.veevaSite);
  const studyKey = studyMatch ? studyMatch[0].replace(/\s+/g, "-").toUpperCase() : null;
  const rows = pack.sites.filter((r) => {
    if (needle && !String(r.indication || "").toLowerCase().includes(needle)) return false;
    if (country && String(r.country || "") !== country) return false;
    if (studyKey) {
      const sn = String(r.study_number || r.study_name || "").toUpperCase();
      if (!sn.includes(studyKey)) return false;
    }
    return true;
  });
  if (!rows.length) return null;

  const byKey = new Map();
  for (const r of rows) {
    const org = r.org_clean || r.organization;
    if (!org) continue;
    const key = `${org}||${r.country || "_unknown"}`;
    let g = byKey.get(key);
    if (!g) {
      g = { org, country: r.country || "—", studyCount: 0, enrolled: [], psms: [], indications: new Set() };
      byKey.set(key, g);
    }
    g.studyCount += 1;
    const enr = numOrNull(r.total_enrolled);
    const psm = numOrNull(r.site_psm);
    if (enr != null) g.enrolled.push(enr);
    if (psm != null && psm > 0) g.psms.push(psm);
    if (r.indication) g.indications.add(r.indication);
  }

  const aggregates = [...byKey.values()].map((g) => ({
    org: g.org,
    country: g.country,
    studyCount: g.studyCount,
    enrolledSum: g.enrolled.length ? g.enrolled.reduce((a, b) => a + b, 0) : null,
    sitePsm: g.psms.length
      ? g.psms.slice().sort((a, b) => a - b)[Math.floor(g.psms.length / 2)]
      : null,
    indication: [...g.indications].slice(0, 2).join(", ") || "—"
  }));
  const known = aggregates.filter((a) => a.enrolledSum != null);
  const missingCount = aggregates.length - known.length;
  const ranked = known.slice().sort((a, b) => b.enrolledSum - a.enrolledSum);
  const chartRows = ranked.slice(0, 8);
  const maxEnroll = Math.max(1, ...chartRows.map((a) => a.enrolledSum));
  const scope = [needle, country, studyMatch && studyMatch[0]].filter(Boolean).join(" · ") || "all matching rows";

  return stamp(
    {
      q: question,
      needs: ["ora"],
      icon: "users",
      summary: `${known.length} Ora sites in live Vault have an enrolled total for ${scope}. ${missingCount} more site rows have enrolled missing. PSM uses enrolled / months(FSI→LSI); null dates stay null.`,
      chartTitle: `Ora sites by enrolled · ${scope} · known values only`,
      chartNote: "Live Vault · ora_veeva_site · read-only",
      chartType: "bar",
      bars: chartRows.map((a) => ({
        label: `${a.org} (${a.country})`,
        pct: Math.round((a.enrolledSum / maxEnroll) * 100),
        value: String(a.enrolledSum),
        color: "#052c49"
      })),
      tableTitle: "Site rollups (org × country)",
      grid: "1.4fr .7fr .5fr .6fr .7fr",
      cols: ["Site", "Country", "Studies", "Enrolled", "Site PSM"],
      rows: ranked.slice(0, 12).map((a) => [
        a.org,
        a.country,
        String(a.studyCount),
        a.enrolledSum == null ? "—" : String(a.enrolledSum),
        a.sitePsm == null ? "—" : String(a.sitePsm)
      ]),
      missingCount,
      missingNote: missingNote(missingCount, known.length),
      caveat: "Live ora_veeva_site joined to org + milestone FSI/LSI. Blank enrolled or missing FSI/LSI is missing PSM, not zero. Concurrent studies = distinct active Vault studies at the same org×country.",
      trace: [
        `Read ${SHARED_READ.veevaSite} + ${SHARED_READ.veevaMilestone} (live mirrors). Did not write. Did not read ora_fact_*.`,
        needle ? `Indication CONTAINS "${needle}".` : "No indication filter.",
        country ? `country = ${country}.` : "No country filter.",
        `${rows.length} site×study rows → ${aggregates.length} org×country sites.`
      ],
      query: "ora_veeva_site + ora_veeva_milestone FSI→LSI PSM",
      confidence: "high",
      followUps: [
        "Which Ora sites enrolled the most in glaucoma?",
        "Which Ora dry eye studies enrolled the most subjects?",
        "Show competing dry eye trials"
      ]
    },
    rows
  );
}

async function fromLensVisits(question) {
  const studyMatch = String(question).match(/\bORA[- ]?\d{3,}\b/i);
  const studyCode = studyMatch ? studyMatch[0].replace(/\s+/g, "-").toUpperCase() : null;
  const visits = studyCode
    ? await safeQuery(
        LENS.visits,
        "SELECT * FROM c WHERE c.studyCode = @study ORDER BY c.visitDate",
        [{ name: "@study", value: studyCode }]
      )
    : await safeQuery(LENS.visits, "SELECT TOP 50 * FROM c ORDER BY c.visitDate DESC");
  if (!visits.length) return null;

  const byStatus = {};
  for (const v of visits) {
    const s = v.visitStatus || "Unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const max = Math.max(1, ...Object.values(byStatus));
  return stamp(
    {
      q: question,
      needs: ["ora"],
      icon: "chart",
      summary: studyCode
        ? `${visits.length} visit rows for ${studyCode} from lens_visits (gold sync).`
        : `${visits.length} recent visit rows from lens_visits. Name a study code to filter.`,
      chartTitle: studyCode ? `Visits by status · ${studyCode}` : "Recent visits by status",
      chartNote: "lens_visits · read-only",
      chartType: "bar",
      bars: Object.entries(byStatus).map(([label, n]) => ({
        label,
        pct: Math.round((n / max) * 100),
        value: String(n),
        color: "#273b8a"
      })),
      tableTitle: "Visit rows",
      grid: "1fr 1fr 1fr 1fr",
      cols: ["Study", "Visit", "Status", "Date"],
      rows: visits.slice(0, 12).map((v) => [v.studyCode, v.visitName, v.visitStatus, v.visitDate || ""]),
      caveat: "Fed from warehouse gold → lens_visits. Not live EDC.",
      trace: [`Opened shared Cosmos database bd-budgets, container ${LENS.visits}.`, studyCode ? `Filtered studyCode = ${studyCode}.` : "Took latest 50."],
      query: studyCode ? `lens_visits where studyCode = '${studyCode}'` : "lens_visits top 50",
      confidence: "high",
      followUps: ["Which visits are overdue?", "Break this out by site", "Show enrollment for the same study"]
    },
    visits
  );
}

async function fromLensStudies(question) {
  const studies = await safeQuery(LENS.studies, "SELECT * FROM c WHERE c.status = 'active' ORDER BY c.pctOfPlan ASC");
  if (!studies.length) return null;
  const known = studies.filter((s) => s.pctOfPlan != null);
  const missingCount = studies.length - known.length;
  const behind = known.filter((s) => s.pctOfPlan < 0.95);
  const chartRows = (behind.length ? behind : known).slice(0, 6);
  return stamp(
    {
      q: question,
      needs: ["ora"],
      icon: "chart",
      summary: `${behind.length} of ${known.length} active studies with a plan figure in lens_studies are below 95% of plan.`,
      chartTitle: "Enrollment against plan, active studies",
      chartNote: "lens_studies · read-only",
      chartType: "bar",
      bars: chartRows.map((s) => {
        const pct = Math.round(s.pctOfPlan * 100);
        return { label: `${s.studyCode}${s.phase ? ` (${s.phase})` : ""}`, pct: Math.min(100, pct), value: `${pct}%`, color: barColor(pct) };
      }),
      tableTitle: "Studies behind plan",
      grid: "1.1fr .9fr .9fr 1.2fr",
      cols: ["Study", "Enrolled / plan", "Revenue at risk", "Primary driver"],
      rows: behind.slice(0, 8).map((s) => [
        s.studyCode,
        `${s.enrolled ?? "—"}/${s.plannedToDate ?? "—"}`,
        s.revenueAtRisk != null ? `$${Math.round(s.revenueAtRisk / 1000)}K` : "—",
        s.primaryDriver || "—"
      ]),
      missingCount,
      missingNote: missingCount
        ? `${missingCount} active studies have no pctOfPlan. They are omitted from the chart, not plotted as 0%.`
        : "",
      caveat: "Gold-layer snapshot in lens_studies. Bid-workbench budget docs live in container studies and are not overwritten.",
      trace: [`Queried ${LENS.studies} on bd-budgets.`, "Flagged pctOfPlan < 0.95. Null plan is missing, not zero."],
      query: "lens_studies where status = 'active' order by pctOfPlan asc",
      confidence: "high",
      followUps: ["Show visits for the worst study", "Filter to dry eye", "What changed since last week?"]
    },
    studies
  );
}

async function fromOraFactStudy(question, opts = {}) {
  const needle = indicationNeedle(question);
  const pack = await loadLivePack();
  const rows = pack.studies || [];
  if (!rows.length) return emptyLiveAnswer(question, SHARED_READ.veevaStudy);
  const filtered = rows.filter((r) => {
    if (needle && !String(r.indication || "").toLowerCase().includes(needle)) return false;
    if (opts.projectNumber && !studyMatchesProject(r.study_number, opts.projectNumber)) return false;
    return true;
  });
  if (opts.projectNumber && !filtered.length) return null;
  const used = filtered.length ? filtered : rows;
  const known = used.filter((r) => enrolledOf(r) != null);
  const missing = used.filter((r) => enrolledOf(r) == null);
  const wantMissing = opts.missingOnly || guessKey(question) === "missing_enrolled";
  const tableRows = wantMissing ? missing : used;
  const maxEnroll = Math.max(1, ...known.map((r) => enrolledOf(r)));
  const chartSource = wantMissing ? [] : known.slice(0, 8);
  return stamp(
    {
      q: question,
      needs: ["ora"],
      icon: "chart",
      summary: wantMissing
        ? `${missing.length} of ${used.length}${needle ? ` “${needle}”` : ""} Ora studies in the clinical rollup have no enrolled value.`
        : needle
          ? `${known.length} Ora “${needle}” studies have an enrolled count. ${missing.length} more match the indication with enrolled missing.`
          : `${known.length} Ora studies have an enrolled count in live Vault. ${missing.length} have enrolled missing.`,
      chartTitle: wantMissing
        ? "No enrollment chart — values are missing"
        : needle
          ? `Ora enrollment · ${needle} · known values only`
          : "Ora study enrollment · known values only",
      chartNote: "Live Vault · ora_veeva_study · read-only",
      chartType: "bar",
      bars: chartSource.map((r) => {
        const n = enrolledOf(r);
        return {
          label: `${r.study_number || "—"} (${r.phase || "—"})`,
          pct: Math.round((n / maxEnroll) * 100),
          value: String(n),
          color: "#052c49"
        };
      }),
      tableTitle: wantMissing ? "Studies with enrolled missing" : "Study rollups",
      grid: "1fr .7fr .7fr .8fr 1fr",
      cols: ["Study", "Enrolled", "PSM", "Lifecycle", "Indication"],
      rows: tableRows.slice(0, 12).map((r) => [
        r.study_number || "—",
        enrolledOf(r) == null ? "—" : String(enrolledOf(r)),
        r.psm != null ? String(r.psm) : "—",
        r.lifecycle_state || "—",
        r.indication || "—"
      ]),
      missingCount: missing.length,
      missingNote: wantMissing ? "" : missingNote(missing.length, known.length),
      caveat: "Live ora_veeva_study. Study PSM is the median of positive site PSMs (enrolled / FSI→LSI months). Blank enrolled or missing FSI/LSI is missing, not zero.",
      trace: [
        "Connected to the same Cosmos database as Study Bid Workbench (bd-budgets).",
        `Read ${SHARED_READ.veevaStudy} + sites/milestones. Did not write. Did not read ora_fact_*.`,
        wantMissing ? "Filtered to rows with total_enrolled null." : "Chart excludes null enrolled."
      ],
      query: "ora_veeva_study + median positive site PSM",
      confidence: "high",
      followUps: wantMissing
        ? ["Which Ora dry eye studies enrolled the most subjects?", "List Ora glaucoma studies", "Show competing dry eye trials"]
        : ["Which Ora studies have no enrolled count in Cosmos?", "Show competing trials", "Filter to glaucoma"]
    },
    used
  );
}

async function fromRegistry(question) {
  const needle = indicationNeedle(question) || "dry eye";
  const th = await safeQuery(
    SHARED_READ.oraTrialhub,
    "SELECT TOP 80 c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients, c.n_countries, c.countries, c._ts FROM c WHERE c.docType = @t",
    [{ name: "@t", value: "ora_trialhub_trials" }]
  );
  const ct = await safeQuery(
    SHARED_READ.oraCtgov,
    "SELECT TOP 40 c.id, c.nct, c.briefTitle, c.oraIndication, c.overallStatus, c._ts FROM c WHERE c.docType = @t OR NOT IS_DEFINED(c.docType)",
    [{ name: "@t", value: "ora_ctgov_trials" }]
  );
  const thHit = th.filter((r) => String(r.indication || "").toLowerCase().includes(needle));
  const used = thHit.length ? thHit : th;
  if (!used.length && !ct.length) return null;

  const byCountry = {};
  for (const r of used) {
    const countries = Array.isArray(r.countries) ? r.countries : String(r.countries || "").split(/[;,]/);
    for (const raw of countries) {
      const c = String(raw || "").trim();
      if (!c) continue;
      byCountry[c] = (byCountry[c] || 0) + 1;
    }
  }
  const countryRows = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(1, ...countryRows.map((x) => x[1]));
  return stamp(
    {
      q: question,
      needs: ["ctgov", "trialhub"],
      icon: "globe",
      summary: `${used.length} TrialHub trials and ${ct.length} CT.gov docs for this pull. Country bars count TrialHub facilities for “${needle}”.`,
      chartTitle: `Industry trials by country · ${needle}`,
      chartNote: "TrialHub + CT.gov · read-only",
      chartType: "bar",
      bars: countryRows.map(([label, n]) => ({
        label,
        pct: Math.round((n / max) * 100),
        value: String(n),
        color: "#273b8a"
      })),
      tableTitle: "Sample industry trials",
      grid: "1.1fr .6fr 1.2fr .8fr",
      cols: ["NCT", "Phase", "Sponsor", "Status"],
      rows: used.slice(0, 8).map((r) => [r.nct || "—", r.phase || "—", r.sponsor || "—", r.status || "—"]),
      caveat: "Public registry facts stay public. Do not mix CT.gov / TrialHub counts with Salesforce Total_Ora_Net_Revenue__c or 10-K.",
      trace: [
        `Read ${SHARED_READ.oraTrialhub} and ${SHARED_READ.oraCtgov} on bd-budgets.`,
        "Did not write."
      ],
      query: "ora_trialhub_trials + ora_ctgov_trials",
      confidence: "medium",
      followUps: ["Which Ora studies match this indication?", "Show competing glaucoma trials", "Which Ora studies have no enrolled count in Cosmos?"]
    },
    [...used, ...ct]
  );
}

async function fromSfPipeline(question) {
  const rows = await safeQuery(
    SHARED_READ.sfOpportunity,
    `SELECT TOP 80 c.Name, c.StageName, c.IsClosed, c.IsWon, c.CloseDate, c.AccountId,
            c.Total_Ora_Net_Revenue__c, c._ts
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_sf_opportunity" }]
  );
  if (!rows.length) {
    return stamp(
      {
        q: question,
        needs: ["salesforce"],
        icon: "chart",
        summary:
          "Live Salesforce opportunity ingest has not landed (ora_sf_opportunity is empty). Data Lens does not use Amount and does not fall back to Excel dumps.",
        chartTitle: "No Salesforce opportunities",
        chartNote: "ora_sf_opportunity · Total_Ora_Net_Revenue__c only",
        chartType: "bar",
        bars: [],
        tableTitle: "Result",
        grid: "1fr",
        cols: ["Note"],
        rows: [["Workbench ingest of ora_sf_opportunity has not written documents this SWA can read."]],
        caveat: "Pipeline $ is Total_Ora_Net_Revenue__c only — never Amount. Never mix with 10-K.",
        trace: [`Queried ${SHARED_READ.sfOpportunity}. Zero documents.`],
        query: "ora_sf_opportunity empty",
        confidence: "low",
        followUps: ["Show competing dry eye trials", "Which Ora dry eye studies enrolled the most subjects?"]
      },
      []
    );
  }
  const netOf = (r) => numOrNull(r.Total_Ora_Net_Revenue__c);
  const open = rows.filter((r) => r.IsClosed !== true && !/^closed/i.test(String(r.StageName || "")));
  const known = open.filter((r) => netOf(r) != null);
  const missing = open.length - known.length;
  const byStage = {};
  for (const r of known) {
    const st = String(r.StageName || "—").trim() || "—";
    byStage[st] = (byStage[st] || 0) + netOf(r);
  }
  const stageRows = Object.entries(byStage).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...stageRows.map((x) => x[1]));
  const money = (n) => (n == null ? "—" : `$${Math.round(n / 1000)}K`);
  return stamp(
    {
      q: question,
      needs: ["salesforce"],
      icon: "chart",
      summary: `${open.length} open Salesforce opportunities. ${known.length} have Total_Ora_Net_Revenue__c; ${missing} are missing $ (not zero). Bars are Ora net revenue by stage — not Amount, not 10-K.`,
      chartTitle: "Open pipeline · Total_Ora_Net_Revenue__c by stage",
      chartNote: "ora_sf_opportunity · never Amount",
      chartType: "bar",
      bars: stageRows.map(([label, n]) => ({
        label,
        pct: Math.round((n / max) * 100),
        value: money(n),
        color: "#273b8a"
      })),
      tableTitle: "Open opportunities",
      grid: "1.3fr .8fr .8fr .8fr",
      cols: ["Opportunity", "Stage", "Close", "Ora net $"],
      rows: open.slice(0, 12).map((r) => [
        r.Name || "—",
        r.StageName || "—",
        r.CloseDate || "—",
        money(netOf(r))
      ]),
      missingCount: missing,
      missingNote: missing ? `${missing} open opps have Total_Ora_Net_Revenue__c missing — omitted from the chart, not plotted as $0.` : "",
      caveat: "Salesforce $ = Total_Ora_Net_Revenue__c only. Do not mix with CT.gov, TrialHub, or public 10-K revenue.",
      trace: [`Read ${SHARED_READ.sfOpportunity}. Did not select Amount.`],
      query: "ora_sf_opportunity Total_Ora_Net_Revenue__c (open)",
      confidence: "high",
      followUps: ["Show competing dry eye trials", "Which Ora dry eye studies enrolled the most subjects?"]
    },
    rows
  );
}

function emptyRmAnswer(question) {
  return stamp(
    {
      q: question,
      needs: ["insightsrm"],
      icon: "users",
      summary:
        "RM is in scope. Cosmos lens_rm_* has no rows for this question yet — InsightsRM has not been loaded (ora-lens-rm-ingest), or this pack is empty. Not an Ora clinical-rollup question.",
      chartTitle: "No InsightsRM rows yet",
      chartNote: "lens_rm_* · not NetSuite · not ora_veeva_study",
      chartType: "bar",
      bars: [],
      tableTitle: "InsightsRM",
      grid: "1fr",
      cols: ["Note"],
      rows: [["No lens_rm_* documents yet. Upload the RM workbook/zips to container insightsrm and run ora-lens-rm-ingest."]],
      caveat: "InsightsRM packs are separate from live Veeva and NetSuite. Blank FTE is missing, not zero.",
      trace: [
        "Purpose is RM (insightsrm). Did not query ora_veeva_*.",
        "lens_rm_dq / roster / assignments / staffing grids were empty or missing."
      ],
      query: "lens_rm_* (empty)",
      confidence: "medium",
      followUps: ["Who is over-allocated?", "Which roles are short on capacity?", "Show CRA assignments"]
    },
    []
  );
}

function emptyAnswer(question) {
  return stamp(
    {
      q: question,
      needs: [],
      icon: "chart",
      summary: "Cosmos answered, but no documents matched this question in live Veeva, Salesforce, TrialHub, CT.gov, or lens_* marts.",
      chartTitle: "No matching rows",
      chartNote: "bd-budgets · read-only",
      chartType: "bar",
      bars: [],
      tableTitle: "Result",
      grid: "1fr",
      cols: ["Note"],
      rows: [["No matching documents"]],
      caveat: "Ask reads ora_veeva_* / ora_sf_* live mirrors, not ora_fact_* Excel dumps. Blank is missing, not zero.",
      trace: ["Connected to bd-budgets.", "Queried lens_* then live Veeva / SF / TrialHub / CT.gov. Zero matches."],
      query: "-- no matching documents",
      confidence: "medium",
      followUps: [
        "Which Ora dry eye studies enrolled the most subjects?",
        "Show competing dry eye trials",
        "List Ora glaucoma studies"
      ]
    },
    []
  );
}

async function getBriefing() {
  getDb();
  const pack = await loadLivePack();
  const rows = pack.studies || [];
  const known = rows.filter((r) => enrolledOf(r) != null);
  const missing = rows.filter((r) => enrolledOf(r) == null);
  const top = known.slice().sort((a, b) => enrolledOf(b) - enrolledOf(a))[0];
  const dry = rows.filter((r) => String(r.indication || "").toLowerCase().includes("dry eye"));
  const glauc = rows.filter((r) => String(r.indication || "").toLowerCase().includes("glaucoma"));
  const meta = asOfMeta(rows);
  return {
    asOf: meta.asOf,
    asOfLabel: meta.asOfLabel,
    asOfKind: meta.asOfKind,
    studies: rows.length,
    withEnrolled: known.length,
    missingEnrolled: missing.length,
    topStudy: top ? { study: top.study_number, enrolled: enrolledOf(top), indication: top.indication || "" } : null,
    dryEye: dry.length,
    glaucoma: glauc.length
  };
}

async function fromProjectContext(question, projectNumber) {
  const bundle = await getProjectBundle(projectNumber);
  const jobs = bundle.jobs || [];
  const studies = bundle.studies || [];
  const sites = bundle.sites || [];
  if (!jobs.length && !studies.length) return null;

  const t = String(question || "").toLowerCase();
  const wantSites = /(site|investigator)/.test(t) && sites.length;
  const wantClinical = /(enroll|study|psm|screen fail|indication|lifecycle)/.test(t) && studies.length;

  if (wantSites) {
    const known = sites.filter((s) => s.enrolled != null);
    const maxEnroll = Math.max(1, ...known.map((s) => s.enrolled));
    return stamp(
      {
        q: question,
        needs: ["ora", "netsuite"],
        icon: "users",
        summary: `${sites.length} live Vault site row${sites.length === 1 ? "" : "s"} for studies joined to ${projectNumber}. ${bundle.join.note}`,
        chartTitle: `Sites · ${projectNumber}`,
        chartNote: "Join computed at read time · no mapping table",
        chartType: "bar",
        bars: known.slice(0, 8).map((s) => ({
          label: String(s.site || "—").slice(0, 36),
          pct: Math.round((s.enrolled / maxEnroll) * 100),
          value: String(s.enrolled),
          color: "#052c49"
        })),
        tableTitle: "Sites on joined studies",
        grid: "1.2fr 0.8fr 0.6fr 0.6fr 0.8fr",
        cols: ["Site", "Study", "Country", "Enrolled", "Site PSM"],
        rows: sites.slice(0, 12).map((s) => [
          s.site || "—",
          s.study_name || "—",
          s.country || "—",
          s.enrolled == null ? "—" : String(s.enrolled),
          s.site_psm == null ? "—" : String(s.site_psm)
        ]),
        caveat: bundle.join.note,
        trace: [
          `Computed join project_number ${projectNumber} → ora_veeva_study.study_number.`,
          `Read live ${SHARED_READ.veevaSite} for those study names. Did not write.`
        ],
        query: `computed join ${projectNumber} → ora_veeva_site`,
        confidence: studies.length ? "high" : "medium",
        followUps: [
          `What is GM on ${projectNumber}?`,
          `Enrollment for ${projectNumber}`,
          "Which projects are under budgeted GM?"
        ]
      },
      sites
    );
  }

  if (wantClinical) {
    const known = studies.filter((s) => s.total_enrolled != null);
    const maxEnroll = Math.max(1, ...known.map((s) => s.total_enrolled));
    return stamp(
      {
        q: question,
        needs: ["ora", "netsuite"],
        icon: "chart",
        summary: `${studies.length} live Veeva study row${studies.length === 1 ? "" : "s"} joined to ${projectNumber}. ${jobs.length} NetSuite job${jobs.length === 1 ? "" : "s"} share that number. ${bundle.join.note}`,
        chartTitle: `Enrollment · studies joined to ${projectNumber}`,
        chartNote: "Join computed at read time · no mapping table",
        chartType: "bar",
        bars: known.slice(0, 8).map((s) => ({
          label: s.study_number || "—",
          pct: Math.round((s.total_enrolled / maxEnroll) * 100),
          value: String(s.total_enrolled),
          color: "#052c49"
        })),
        tableTitle: "ora_veeva_study rows for this project number",
        grid: "1fr 0.7fr 0.7fr 0.8fr 1fr",
        cols: ["Study", "Enrolled", "PSM", "Match", "Indication"],
        rows: studies.slice(0, 12).map((s) => [
          s.study_number || "—",
          s.total_enrolled == null ? "—" : String(s.total_enrolled),
          s.psm == null ? "—" : String(s.psm),
          s.match || "—",
          s.indication || "—"
        ]),
        caveat: bundle.join.note,
        trace: [
          `Computed join: ${bundle.join.matchedOn}.`,
          "Did not write Cosmos. No mapping container."
        ],
        query: `computed join ${projectNumber} → ora_veeva_study.study_number`,
        confidence: "high",
        followUps: [
          `Sites for ${projectNumber}`,
          `What is GM on ${projectNumber}?`,
          "Which projects are under budgeted GM?"
        ]
      },
      studies
    );
  }

  if (jobs.length) {
    const known = jobs.filter((r) => gmOf(r, "gm_pct_variance") != null);
    const missing = jobs.filter((r) => gmOf(r, "gm_pct_variance") == null);
    const maxAbs = Math.max(0.01, ...known.map((r) => Math.abs(gmOf(r, "gm_pct_variance") || 0)));
    return stamp(
      {
        q: question,
        needs: ["netsuite", "ora"],
        icon: "chart",
        summary: `${jobs.length} NetSuite job${jobs.length === 1 ? "" : "s"} for ${projectNumber}. ${studies.length} live Veeva match${studies.length === 1 ? "" : "es"} on study_number. ${bundle.join.note}`,
        chartTitle: `GM% variance · ${projectNumber}`,
        chartNote: "NetSuite + computed study join · read-only",
        chartType: "bar",
        bars: known.map((r) => {
          const v = gmOf(r, "gm_pct_variance");
          return {
            label: String(r.project_name || r.project_number).slice(0, 42),
            pct: Math.round((Math.abs(v) / maxAbs) * 100),
            value: pctLabel(v),
            color: v < 0 ? "#ed1c24" : "#3ebdac"
          };
        }),
        tableTitle: "NetSuite jobs for this project number",
        grid: "0.8fr 1.4fr 0.6fr 0.6fr 0.6fr 1fr",
        cols: ["Number", "Project", "Budget GM", "Actual GM", "Variance", "Change order"],
        rows: jobs.map((r) => [
          r.project_number || "—",
          r.project_name || "—",
          pctLabel(gmOf(r, "budgeted_gm_pct")),
          pctLabel(gmOf(r, "actual_gm_pct_prior_month")),
          pctLabel(gmOf(r, "gm_pct_variance")),
          r.change_order_status || "—"
        ]),
        projectKeys: jobs.map((r) => r.project_number || ""),
        missingCount: missing.length,
        missingNote: missing.length
          ? `${missing.length} job${missing.length === 1 ? " has" : "s have"} GM% missing (not zero).`
          : "",
        caveat: bundle.join.note,
        trace: [
          `Read ${LENS.nsProjects} for project_number = ${projectNumber}.`,
          `Joined in-memory to ${SHARED_READ.veevaStudy}.study_number. Did not write.`
        ],
        query: `lens_ns_projects + computed join to ora_veeva_study (${projectNumber})`,
        confidence: "high",
        followUps: [
          `Enrollment for ${projectNumber}`,
          `Sites for ${projectNumber}`,
          "Which projects are under budgeted GM?"
        ]
      },
      jobs
    );
  }

  return fromOraFactStudy(question, { projectNumber });
}

async function answerFromCosmos(question, sources, opts) {
  getDb();
  const fromQ = String(question).match(/\b\d{2}-\d{3}-\d{4}\b/);
  const projectNumber = String((opts && opts.projectNumber) || (fromQ && fromQ[0]) || "").trim();
  const priorTurns = Array.isArray(opts && opts.prior) ? opts.prior : [];
  const src = new Set((sources || []).map(String));
  const rmScope = src.has("insightsrm") && !src.has("ora");
  let key = guessKey(question, priorTurns);
  if (rmScope) key = "staffing";
  let answer = null;
  if (projectNumber && key !== "staffing") answer = await fromProjectContext(question, projectNumber);
  if (!answer && key === "staffing") answer = await fromRmStaffing(question, priorTurns);
  if (!answer && key === "staffing") answer = emptyRmAnswer(question);
  if (!answer && key === "missing_enrolled") answer = await fromOraFactStudy(question, { missingOnly: true });
  if (!answer && key === "netsuite") answer = await fromNsProjects(question);
  if (!answer && key === "sites") answer = await fromOraFactSite(question);
  if (!answer && key === "visits") answer = await fromLensVisits(question);
  if (!answer && key === "visits") answer = await fromOraFactSite(question);
  if (!answer && key === "competitive") answer = await fromRegistry(question);
  if (!answer && key === "pipeline") answer = await fromSfPipeline(question);
  if (!answer && key !== "competitive" && key !== "pipeline") answer = await fromOraFactStudy(question, projectNumber ? { projectNumber } : {});
  if (!answer) answer = await fromLensStudies(question);
  if (!answer) answer = await fromRegistry(question);
  if (!answer) answer = await fromSfPipeline(question);
  if (!answer) answer = emptyAnswer(question);
  answer.sourcesUsed = sources;
  if (projectNumber) answer.projectNumber = projectNumber;

  let viewerSlice = null;
  if (opts && opts.principal) {
    try {
      const viewer = await getViewerContext(opts.principal);
      viewerSlice = foundryViewerSlice(viewer);
      if (viewerSlice) {
        answer.viewer = {
          role: viewerSlice.role,
          primary: viewerSlice.primary,
          then: viewerSlice.then
        };
      }
    } catch (_) {
      viewerSlice = null;
    }
  }

  try {
    const llm = await narrateWithFoundry(question, answer, viewerSlice, priorTurns);
    answer.summary = llm.summary || answer.summary;
    answer.chartTitle = llm.chartTitle || answer.chartTitle;
    answer.caveat = llm.caveat || answer.caveat;
    answer.followUps = llm.followUps || answer.followUps;
    answer.chartNote = `${answer.chartNote} · ${llm.agentName} (${llm.model})`;
    answer.trace = [
      ...(answer.trace || []),
      `Foundry ${llm.via} wrote the narrative. Bars and table are Cosmos rows, not model-invented.`,
      viewerSlice
        ? `VIEWER frame: ${viewerSlice.role || "custom"} (primary ${viewerSlice.primary || "—"}; secondary reference, not a data source).`
        : "No Entra viewer preference on this turn."
    ];
  } catch (err) {
    answer.foundryError = String(err.message || err);
    answer.caveat = `${answer.caveat} Foundry did not run: ${answer.foundryError}`;
    answer.trace = [...(answer.trace || []), `Foundry skipped: ${answer.foundryError}`];
  }
  return answer;
}

module.exports = { answerFromCosmos, guessKey, getBriefing };
