const { safeQuery, LENS, SHARED_READ } = require("./cosmos");

function guessKey(text) {
  const t = String(text || "").toLowerCase();
  if (/(competitor|sponsor|registry|market|poland|cac|pipeline|bid|trialhub|ct\.gov|clinicaltrials)/.test(t)) {
    return "competitive";
  }
  if (/(staff|resource|cra|fte|capacity|assign|backfill|headcount)/.test(t)) return "staffing";
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
  return {
    q: question,
    needs: ["imednet", "medidata"],
    icon: "chart",
    summary: studyCode
      ? `${visits.length} visit rows for ${studyCode} from lens_visits (gold sync).`
      : `${visits.length} recent visit rows from lens_visits. Name a study code to filter.`,
    chartTitle: studyCode ? `Visits by status · ${studyCode}` : "Recent visits by status",
    chartNote: `bd-budgets / lens_visits · ${new Date().toISOString()}`,
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
  };
}

async function fromLensStudies(question) {
  const studies = await safeQuery(LENS.studies, "SELECT * FROM c WHERE c.status = 'active' ORDER BY c.pctOfPlan ASC");
  if (!studies.length) return null;
  const behind = studies.filter((s) => s.pctOfPlan != null && s.pctOfPlan < 0.95);
  return {
    q: question,
    needs: ["imednet", "medidata", "netsuite"],
    icon: "chart",
    summary: `${behind.length} of ${studies.length} active studies in lens_studies are below 95% of plan.`,
    chartTitle: "Enrollment against plan, active studies",
    chartNote: `bd-budgets / lens_studies · ${new Date().toISOString()}`,
    chartType: "bar",
    bars: (behind.length ? behind : studies).slice(0, 6).map((s) => {
      const pct = Math.round((s.pctOfPlan || 0) * 100);
      return { label: `${s.studyCode}${s.phase ? ` (${s.phase})` : ""}`, pct: Math.min(100, pct), value: `${pct}%`, color: barColor(pct) };
    }),
    tableTitle: "Studies behind plan",
    grid: "1.1fr .9fr .9fr 1.2fr",
    cols: ["Study", "Enrolled / plan", "Revenue at risk", "Primary driver"],
    rows: behind.slice(0, 8).map((s) => [
      s.studyCode,
      `${s.enrolled}/${s.plannedToDate}`,
      s.revenueAtRisk != null ? `$${Math.round(s.revenueAtRisk / 1000)}K` : "—",
      s.primaryDriver || "—"
    ]),
    caveat: "Gold-layer snapshot in lens_studies. Bid-workbench budget docs live in container studies and are not overwritten.",
    trace: [`Queried ${LENS.studies} on bd-budgets.`, "Flagged pctOfPlan < 0.95."],
    query: "lens_studies where status = 'active' order by pctOfPlan asc",
    confidence: "high",
    followUps: ["Show visits for the worst study", "Filter to dry eye", "What changed since last week?"]
  };
}

async function fromOraFactStudy(question) {
  const needle = indicationNeedle(question);
  const rows = await safeQuery(
    SHARED_READ.oraFactStudy,
    "SELECT TOP 80 c.study_number, c.sponsor, c.indication, c.phase, c.total_enrolled, c.psm, c.screen_fail_rate_recomputed, c.lifecycle_state, c.n_contributing_sites FROM c WHERE c.docType = @t",
    [{ name: "@t", value: "ora_fact_study" }]
  );
  if (!rows.length) return null;
  const filtered = needle
    ? rows.filter((r) => String(r.indication || "").toLowerCase().includes(needle))
    : rows;
  const used = filtered.length ? filtered : rows;
  const maxEnroll = Math.max(1, ...used.map((r) => Number(r.total_enrolled || 0)));
  return {
    q: question,
    needs: ["imednet", "medidata"],
    icon: "chart",
    summary: needle
      ? `${used.length} Ora studies in ora_fact_study match “${needle}”. Bars are total enrolled (Veeva rollup already in this Cosmos account).`
      : `${used.length} Ora studies from ora_fact_study (same bd-budgets database as Study Bid Workbench).`,
    chartTitle: needle ? `Ora enrollment · ${needle}` : "Ora study enrollment (intelligence pack)",
    chartNote: `bd-budgets / ora_fact_study · read-only`,
    chartType: "bar",
    bars: used.slice(0, 8).map((r) => ({
      label: `${r.study_number || "—"} (${r.phase || "—"})`,
      pct: Math.round((Number(r.total_enrolled || 0) / maxEnroll) * 100),
      value: String(r.total_enrolled || 0),
      color: "#052c49"
    })),
    tableTitle: "Study rollups",
    grid: "1fr .7fr .7fr .8fr 1fr",
    cols: ["Study", "Enrolled", "PSM", "Screen fail", "Indication"],
    rows: used.slice(0, 10).map((r) => [
      r.study_number || "—",
      String(r.total_enrolled ?? "—"),
      r.psm != null ? String(r.psm) : "—",
      r.screen_fail_rate_recomputed != null ? String(r.screen_fail_rate_recomputed) : "—",
      r.indication || "—"
    ]),
    caveat: "This is the existing clinical-intelligence pack, not the daily gold visit mart. Visit-level questions need lens_visits after gold sync.",
    trace: [
      "Connected to the same Cosmos database as Study Bid Workbench (bd-budgets).",
      `Read container ${SHARED_READ.oraFactStudy} (docType = ora_fact_study). Did not write.`
    ],
    query: "ora_fact_study where docType = 'ora_fact_study'",
    confidence: "high",
    followUps: ["Which sites enroll fastest for this indication?", "Show competing trials", "Filter to glaucoma"]
  };
}

async function fromRegistry(question) {
  const needle = indicationNeedle(question) || "dry eye";
  const th = await safeQuery(
    SHARED_READ.oraTrialhub,
    "SELECT TOP 80 c.nct, c.title, c.sponsor, c.indication, c.phase, c.status, c.patients, c.n_countries, c.countries FROM c WHERE c.docType = @t",
    [{ name: "@t", value: "ora_trialhub_trials" }]
  );
  const ct = await safeQuery(
    SHARED_READ.oraCtgov,
    "SELECT TOP 40 c.id, c.nct, c.briefTitle, c.oraIndication, c.overallStatus FROM c WHERE c.docType = @t OR NOT IS_DEFINED(c.docType)",
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
  return {
    q: question,
    needs: ["ctgov", "trialhub", "salesforce"],
    icon: "globe",
    summary: `${used.length} TrialHub trials and ${ct.length} CT.gov docs already sit in this Cosmos account. Country bars are TrialHub facility rollups for “${needle}”.`,
    chartTitle: `Industry trials by country · ${needle}`,
    chartNote: `bd-budgets / ora_trialhub_trials + ora_ctgov_trials · read-only`,
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
    caveat: "Read-only on existing intelligence containers. Salesforce match is ora_sponsor_crosswalk when we wire named accounts.",
    trace: [
      `Read ${SHARED_READ.oraTrialhub} and ${SHARED_READ.oraCtgov} on bd-budgets.`,
      "Did not write. Gold-layer competitive marts would land in lens_metrics later."
    ],
    query: "ora_trialhub_trials + ora_ctgov_trials",
    confidence: "medium",
    followUps: ["Which of these sponsors have we bid on before?", "Filter to allergen challenge", "Show Ora studies for the same indication"]
  };
}

async function answerFromCosmos(question, sources) {
  const key = guessKey(question);
  let answer = null;
  if (key === "visits") answer = await fromLensVisits(question);
  if (!answer && key === "competitive") answer = await fromRegistry(question);
  if (!answer) answer = await fromLensStudies(question);
  if (!answer && key !== "competitive") answer = await fromOraFactStudy(question);
  if (!answer) answer = await fromRegistry(question);
  if (!answer) return null;
  answer.sourcesUsed = sources;
  return answer;
}

module.exports = { answerFromCosmos, guessKey };
