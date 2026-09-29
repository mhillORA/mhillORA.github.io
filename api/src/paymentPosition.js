/**
 * Payment position for a YY-DEPT-SEQ study:
 * pricing (NS + bid) × patients enrolled × milestones → earned vs billed.
 * Read-only over Cosmos bd-budgets.
 */

const { safeQuery, SHARED_READ } = require("./cosmos");

function studyMatchesProject(studyNumber, projectNumber) {
  const sn = String(studyNumber || "")
    .trim()
    .toUpperCase();
  const pn = String(projectNumber || "")
    .trim()
    .toUpperCase();
  if (!sn || !pn || pn.length < 4) return false;
  if (sn === pn) return true;
  if (sn.startsWith(`${pn} `) || sn.startsWith(`${pn}-`) || sn.startsWith(`${pn}_`) || sn.startsWith(`${pn}/`)) {
    return true;
  }
  return new RegExp(`(^|[^A-Z0-9])${pn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`).test(sn);
}
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.round(Number(n) * 100) / 100;
}

function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.round(Number(n) * 1000) / 1000;
}

function classifyPaymentMilestone(name, type) {
  const s = `${name || ""} ${type || ""}`.toLowerCase();
  if (/\b(invoice|payment|billable|fee)\b/.test(s)) return "payment_trigger";
  if (/\bfsi\b|\bfpi\b|fpfv|first subject|first patient|ready to enroll/.test(s)) return "enrollment_start";
  if (/\blsi\b|lpfv|last subject in|last patient in/.test(s)) return "enrollment_end";
  if (/\blso\b|last subject out|last patient out|lplv/.test(s)) return "study_close";
  if (/\bsiv\b|site initiat/.test(s)) return "site_startup";
  if (/\birb\b|ethics|contract|cta\b/.test(s)) return "startup";
  if (/\bmilestone\b/.test(s)) return "milestone";
  return "other";
}

function milestoneDone(row) {
  if (row.complete__v === true || row.complete__v === "true" || row.complete__v === 1) return true;
  if (row.actual_finish_date__v || row.actual_finish) return true;
  const st = String(row.task_status || row.status__v || "").toLowerCase();
  return /\b(complet|closed|done|finished)\b/.test(st);
}

async function loadVeevaMilestones(veevaStudyIds) {
  const ids = [...new Set((veevaStudyIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await safeQuery(
    SHARED_READ.veevaMilestone,
    `SELECT TOP 500 c.id, c.name__v, c.milestone_type__v, c.study__v, c.site__v,
            c.actual_finish_date__v, c.actual_start_date__v, c.planned_finish_date__v,
            c.complete__v, c._ts
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_veeva_milestone" }]
  );
  const want = new Set(ids.map(String));
  return (rows || [])
    .filter((r) => want.has(String(r.study__v || "")))
    .map((r) => {
      const name = r.name__v || "";
      const type = r.milestone_type__v || "";
      const role = classifyPaymentMilestone(name, type);
      const done = milestoneDone(r);
      return {
        id: r.id,
        name,
        type,
        role,
        study_id: r.study__v || null,
        site_id: r.site__v || null,
        actual_start: r.actual_start_date__v || null,
        actual_finish: r.actual_finish_date__v || null,
        planned_finish: r.planned_finish_date__v || null,
        complete: done,
        payment_relevant: role !== "other"
      };
    })
    .sort((a, b) => String(a.actual_finish || a.planned_finish || "").localeCompare(String(b.actual_finish || b.planned_finish || "")));
}

async function loadNsMilestoneTasks(projectNumber) {
  const pn = String(projectNumber || "").trim();
  if (!pn) return [];
  const rows = await safeQuery(
    "ora_ns_task",
    `SELECT TOP 200 c.id, c.project_number, c.task_id, c.task_name, c.task_status,
            c.is_milestone, c.milestone_amount, c.pct_complete, c.actual_hours,
            c.current_budget_hrs, c.budget
     FROM c WHERE c.docType = @t AND c.project_number = @pn`,
    [
      { name: "@t", value: "ora_ns_task" },
      { name: "@pn", value: pn }
    ]
  );
  return (rows || [])
    .filter((r) => r.is_milestone === true || r.is_milestone === "T" || r.is_milestone === 1 || num(r.milestone_amount) != null)
    .map((r) => ({
      task_id: r.task_id,
      name: r.task_name || "",
      status: r.task_status || "",
      milestone_amount: num(r.milestone_amount),
      pct_complete: num(r.pct_complete),
      complete: milestoneDone(r) || (num(r.pct_complete) != null && num(r.pct_complete) >= 0.999),
      role: classifyPaymentMilestone(r.task_name, "netsuite")
    }));
}

async function loadBidPricing(projectNumber) {
  const pn = String(projectNumber || "").trim();
  if (!pn) return null;
  const rows = await safeQuery(
    SHARED_READ.budgets,
    `SELECT TOP 80 c.id, c.studyId, c.clientName, c.title, c.indication, c.phase,
            c.budgetType, c.drivers, c.totals, c.updatedAt, c.createdAt
     FROM c`
  );
  const hits = (rows || []).filter((r) => {
    const id = String(r.studyId || r.id || "");
    const title = String(r.title || "");
    return studyMatchesProject(id, pn) || studyMatchesProject(title, pn) || id.includes(pn) || title.includes(pn);
  });
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  const bid = hits[0];
  const drivers = bid.drivers || {};
  const totals = bid.totals || {};
  return {
    studyId: bid.studyId || bid.id,
    clientName: bid.clientName || null,
    title: bid.title || null,
    budgetType: bid.budgetType || null,
    indication: bid.indication || null,
    phase: bid.phase || null,
    enrolledSubjects: num(drivers.enrolledSubjects ?? drivers.enrolled),
    screenedSubjects: num(drivers.screenedSubjects ?? drivers.screened),
    coreSites: num(drivers.coreSites),
    enrollmentMonths: num(drivers.enrollmentMonths),
    totalFee: num(totals.grandTotal ?? totals.total ?? totals.oraTotal ?? totals.serviceFees),
    updatedAt: bid.updatedAt || bid.createdAt || null
  };
}

/**
 * @param {object} bundle — from getProjectBundle (jobs, studyIntel, studies, sites, investigators)
 */
function forecastCostLine({ label, budget, actual, progressPct, enrolled, targetPatients }) {
  const b = money(budget);
  const a = money(actual);
  const prog = progressPct != null && progressPct > 0 ? Math.min(1, progressPct) : null;
  const enr = num(enrolled);
  const tgt = num(targetPatients);

  // 1) Per-patient run-rate (preferred when enrollment exists)
  if (a != null && enr != null && enr > 0 && tgt != null && tgt > 0) {
    const perPatient = money(a / enr);
    const eac = money(perPatient * tgt);
    return {
      label,
      method: "per_patient",
      budget: b,
      actual: a,
      per_patient: perPatient,
      forecast_eac: eac,
      remaining: money(eac - a),
      vs_budget: b != null ? money(eac - b) : null,
      note: `$${perPatient}/patient × ${tgt} target`
    };
  }

  // 2) Progress run-rate (hours % or patient % without target)
  if (a != null && prog != null && prog >= 0.02) {
    const eac = money(a / prog);
    return {
      label,
      method: "progress_run_rate",
      budget: b,
      actual: a,
      per_patient: enr != null && enr > 0 ? money(a / enr) : null,
      forecast_eac: eac,
      remaining: money(eac - a),
      vs_budget: b != null ? money(eac - b) : null,
      note: `actual ÷ ${Math.round(prog * 100)}% progress`
    };
  }

  // 3) Budget curve to completion
  if (b != null) {
    const earned = prog != null ? money(b * prog) : null;
    return {
      label,
      method: "budget_curve",
      budget: b,
      actual: a,
      per_patient: null,
      forecast_eac: b,
      remaining: money(b - (a || 0)),
      vs_budget: a != null ? money(a - (earned != null ? earned : a)) : null,
      note: prog != null ? `budget × progress (earned≈${earned})` : "budget only — no progress yet"
    };
  }

  if (a != null) {
    return {
      label,
      method: "actual_only",
      budget: null,
      actual: a,
      per_patient: enr != null && enr > 0 ? money(a / enr) : null,
      forecast_eac: null,
      remaining: null,
      vs_budget: null,
      note: "actual only — no budget/progress for EAC"
    };
  }
  return null;
}

/**
 * Portfolio PTC/OOPC / inv-fee EAC for open (not financially closed) studies in ora_ns_study.
 * Uses hours % complete when present; does not fan out to Veeva per study (too slow).
 */
async function buildPortfolioFeeForecast(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  let sumInvBud = 0;
  let sumInvAct = 0;
  let sumInvEac = 0;
  let sumPtcBud = 0;
  let sumPtcAct = 0;
  let sumPtcEac = 0;
  let sumOopcLabor = 0;
  let sumOopcTravel = 0;
  let withEac = 0;
  let missingActuals = 0;

  for (const r of list) {
    const prog = num(r.percent_complete);
    const inv = forecastCostLine({
      label: "Investigator fees",
      budget: r.inv_fee_budget,
      actual: r.inv_fee_actual,
      progressPct: prog,
      enrolled: null,
      targetPatients: null
    });
    const ptc = forecastCostLine({
      label: "Total PTC",
      budget: r.ptc_budget,
      actual: r.ptc_actual,
      progressPct: prog,
      enrolled: null,
      targetPatients: null
    });
    if (r.inv_fee_actual == null && r.ptc_actual == null) missingActuals += 1;
    if ((inv && inv.forecast_eac != null) || (ptc && ptc.forecast_eac != null)) withEac += 1;

    const invBud = money(r.inv_fee_budget) || 0;
    const invAct = money(r.inv_fee_actual) || 0;
    const invEac = inv?.forecast_eac != null ? inv.forecast_eac : invBud;
    const ptcBud = money(r.ptc_budget) || 0;
    const ptcAct = money(r.ptc_actual) || 0;
    const ptcEac = ptc?.forecast_eac != null ? ptc.forecast_eac : ptcBud;
    const oopcL = money(r.oopc_labor_actual) || 0;
    const oopcT = money(r.oopc_travel_actual) || 0;

    sumInvBud += invBud;
    sumInvAct += invAct;
    sumInvEac += invEac;
    sumPtcBud += ptcBud;
    sumPtcAct += ptcAct;
    sumPtcEac += ptcEac;
    sumOopcLabor += oopcL;
    sumOopcTravel += oopcT;

    lines.push({
      project_number: r.project_number,
      project_name: r.project_name || "",
      project_status: r.project_status || "",
      project_manager: r.project_manager || "",
      service_line: r.service_line || "",
      percent_complete: prog,
      inv_fee_budget: money(r.inv_fee_budget),
      inv_fee_actual: money(r.inv_fee_actual),
      inv_fee_eac: inv?.forecast_eac ?? null,
      ptc_budget: money(r.ptc_budget),
      ptc_actual: money(r.ptc_actual),
      ptc_eac: ptc?.forecast_eac ?? null,
      oopc_labor_actual: money(r.oopc_labor_actual),
      oopc_travel_actual: money(r.oopc_travel_actual),
      method: inv?.method || ptc?.method || "none"
    });
  }

  lines.sort((a, b) => {
    const ae = (a.inv_fee_eac || 0) + (a.ptc_eac || 0);
    const be = (b.inv_fee_eac || 0) + (b.ptc_eac || 0);
    return be - ae;
  });

  return {
    method: "open studies (ora_ns_study) · progress run-rate / budget curve — not financially closed",
    study_count: lines.length,
    with_eac: withEac,
    missing_actuals: missingActuals,
    totals: {
      inv_fee_budget: money(sumInvBud),
      inv_fee_actual: money(sumInvAct),
      inv_fee_eac: money(sumInvEac),
      ptc_budget: money(sumPtcBud),
      ptc_actual: money(sumPtcAct),
      ptc_eac: money(sumPtcEac),
      oopc_labor_actual: money(sumOopcLabor),
      oopc_travel_actual: money(sumOopcTravel),
      combined_eac: money(sumInvEac + sumPtcEac)
    },
    lines,
    note:
      missingActuals > 0
        ? `${missingActuals} stud${missingActuals === 1 ? "y has" : "ies have"} no PTC/inv actuals yet — EAC falls back to budget until the next NS job lands inv_fee_actual/ptc_actual.`
        : "Open-study portfolio EAC from NetSuite budgets/actuals × hours % complete."
  };
}

function portfolioFeeSections(pack) {
  if (!pack) return [];
  const t = pack.totals || {};
  const sections = [
    {
      title: "Portfolio fee forecast (open studies)",
      grid: "1.2fr 0.8fr 0.8fr",
      cols: ["Metric", "Value", "Notes"],
      rows: [
        ["Open studies", String(pack.study_count || 0), "ora_ns_study · not financially closed"],
        ["Inv fee budget / actual / EAC", `${t.inv_fee_budget ?? "—"} / ${t.inv_fee_actual ?? "—"} / ${t.inv_fee_eac ?? "—"}`, "Investigator Compensation"],
        ["PTC budget / actual / EAC", `${t.ptc_budget ?? "—"} / ${t.ptc_actual ?? "—"} / ${t.ptc_eac ?? "—"}`, "Pass-through total"],
        ["OOPC labor / travel (actual)", `${t.oopc_labor_actual ?? "—"} / ${t.oopc_travel_actual ?? "—"}`, "No EAC without budget"],
        ["Combined inv+PTC EAC", t.combined_eac != null ? String(t.combined_eac) : "—", "Sum of study EACs"]
      ]
    },
    {
      title: `Study fee forecast detail (${Math.min(80, (pack.lines || []).length)} of ${pack.study_count || 0})`,
      grid: "0.85fr 1.1fr 0.55fr 0.65fr 0.65fr 0.65fr 0.65fr 0.65fr",
      cols: [
        "Project",
        "Name",
        "% done",
        "Inv bud",
        "Inv EAC",
        "PTC bud",
        "PTC EAC",
        "Method"
      ],
      rows: (pack.lines || []).slice(0, 80).map((r) => [
        r.project_number || "—",
        r.project_name || "—",
        r.percent_complete != null ? `${Math.round(r.percent_complete * 1000) / 10}%` : "—",
        r.inv_fee_budget != null ? String(r.inv_fee_budget) : "—",
        r.inv_fee_eac != null ? String(r.inv_fee_eac) : "—",
        r.ptc_budget != null ? String(r.ptc_budget) : "—",
        r.ptc_eac != null ? String(r.ptc_eac) : "—",
        r.method || "—"
      ]),
      projectKeys: (pack.lines || []).slice(0, 80).map((r) => r.project_number || "")
    }
  ];
  return sections;
}

async function buildPaymentPosition(projectNumber, bundle) {
  const pn = String(projectNumber || "").trim();
  const intel = (bundle.studyIntel && bundle.studyIntel[0]) || null;
  const studies = bundle.studies || [];
  const sites = bundle.sites || [];
  const investigators = bundle.investigators || [];

  const veevaStudyIds = [
    ...new Set(
      studies
        .map((s) => s.veeva_study_id || s.id)
        .filter(Boolean)
        .concat(
          // loadLivePack studies use id as vault id
          studies.map((s) => s.id).filter(Boolean)
        )
    )
  ];

  // studiesForProject may not include vault id — reload from live pack studies on bundle if present
  const studyIdsFromSites = [...new Set(sites.map((s) => s.veeva_study_id).filter(Boolean))];
  const allStudyIds = [...new Set([...veevaStudyIds, ...studyIdsFromSites])];

  const [veevaMs, nsMs, bid] = await Promise.all([
    loadVeevaMilestones(allStudyIds),
    loadNsMilestoneTasks(pn),
    loadBidPricing(pn)
  ]);

  const enrolled =
    studies.reduce((sum, s) => sum + (num(s.total_enrolled) || 0), 0) ||
    sites.reduce((sum, s) => sum + (num(s.enrolled) || 0), 0) ||
    null;

  const targetPatients = bid?.enrolledSubjects ?? null;
  const patientPct =
    targetPatients && enrolled != null && targetPatients > 0 ? pct(enrolled / targetPatients) : null;
  const hoursPct = intel?.percent_complete != null ? pct(intel.percent_complete) : null;
  const progressPct = patientPct != null ? patientPct : hoursPct;

  const invFee = money(intel?.inv_fee_budget);
  const invFeeActual = money(intel?.inv_fee_actual);
  const ptc = money(intel?.ptc_budget);
  const ptcActual = money(intel?.ptc_actual);
  const oopcLabor = money(intel?.oopc_labor_actual);
  const oopcTravel = money(intel?.oopc_travel_actual);
  const invoiced = money(intel?.invoiced_amount);
  const revenue = money(intel?.revenue_recognized);
  const cogs = money(intel?.cost_of_sales);

  const nsMilestoneTotal = money(
    nsMs.reduce((s, m) => s + (m.milestone_amount != null ? m.milestone_amount : 0), 0)
  );
  const nsMilestoneEarned = money(
    nsMs.filter((m) => m.complete).reduce((s, m) => s + (m.milestone_amount != null ? m.milestone_amount : 0), 0)
  );

  const bidTotal = money(bid?.totalFee);
  const pricingPool =
    invFee != null || ptc != null
      ? money((invFee || 0) + (ptc || 0))
      : bidTotal != null
        ? bidTotal
        : nsMilestoneTotal;

  let earnedFromProgress = null;
  if (pricingPool != null && progressPct != null) {
    earnedFromProgress = money(pricingPool * Math.min(1, Math.max(0, progressPct)));
  }

  const earned =
    nsMilestoneEarned != null && nsMilestoneEarned > 0
      ? money((earnedFromProgress || 0) > 0 ? Math.max(earnedFromProgress || 0, nsMilestoneEarned) : nsMilestoneEarned)
      : earnedFromProgress;

  const billed = invoiced != null ? invoiced : revenue;
  const remainingToBill =
    earned != null && billed != null ? money(earned - billed) : earned != null ? earned : null;

  const forecastArgs = {
    progressPct,
    enrolled,
    targetPatients
  };
  const invForecast = forecastCostLine({
    label: "Investigator fees",
    budget: invFee,
    actual: invFeeActual,
    ...forecastArgs
  });
  const ptcForecast = forecastCostLine({
    label: "Total PTC (pass-through)",
    budget: ptc,
    actual: ptcActual,
    ...forecastArgs
  });
  const oopcLaborF = forecastCostLine({
    label: "OOPC labor (payroll)",
    budget: null,
    actual: oopcLabor,
    ...forecastArgs
  });
  const oopcTravelF = forecastCostLine({
    label: "OOPC travel (non-PTC)",
    budget: null,
    actual: oopcTravel,
    ...forecastArgs
  });

  const paymentMs = veevaMs.filter((m) => m.payment_relevant);
  const nextTriggers = paymentMs.filter((m) => !m.complete).slice(0, 12);
  const hitTriggers = paymentMs.filter((m) => m.complete).slice(0, 20);

  const gaps = [];
  if (invFee == null && ptc == null && bidTotal == null && nsMilestoneTotal == null) {
    gaps.push("No pricing pool yet (need ora_ns_study inv/PTC, Buddy bid totals, or NS milestone amounts).");
  }
  if (invFeeActual == null && ptcActual == null) {
    gaps.push("No PTC/OOPC actuals on ora_ns_study yet — needs runs_final with inv_fee_actual/ptc_actual (v91+).");
  }
  if (targetPatients == null) {
    gaps.push("No contracted patient target (Buddy HLBP/bid drivers.enrolledSubjects) — forecast may use hours %.");
  }
  if (enrolled == null) {
    gaps.push("No Veeva enrolled count on joined studies/sites.");
  }
  if (!veevaMs.length) {
    gaps.push("No ora_veeva_milestone rows for joined Vault studies — refresh Veeva sync.");
  }
  if (!nsMs.length) {
    gaps.push("No ora_ns_task milestone rows — next pull should POST tasks with milestone_amount.");
  }
  if (invoiced == null && revenue == null) {
    gaps.push("No invoiced / revenue recognized on ora_ns_study.");
  }

  return {
    project_number: pn,
    method: "pricing × patients/milestones → earned vs billed; PTC/OOPC EAC from burn rate",
    pricing: {
      inv_fee_budget: invFee,
      inv_fee_actual: invFeeActual,
      ptc_budget: ptc,
      ptc_actual: ptcActual,
      oopc_labor_actual: oopcLabor,
      oopc_travel_actual: oopcTravel,
      ptc_categories: intel?.ptc_categories || null,
      pricing_pool: pricingPool,
      ns_milestone_amount_total: nsMilestoneTotal,
      bid_total_fee: bidTotal,
      bid
    },
    patients: {
      enrolled,
      target: targetPatients,
      patient_pct_complete: patientPct,
      sites: sites.length,
      investigators: investigators.length
    },
    milestones: {
      veeva_count: veevaMs.length,
      veeva_payment_relevant: paymentMs.length,
      veeva_hit: hitTriggers.length,
      veeva_open: nextTriggers.length,
      hit: hitTriggers,
      next: nextTriggers,
      ns_tasks: nsMs
    },
    progress: {
      hours_pct_complete: hoursPct,
      patient_pct_complete: patientPct,
      progress_pct_used: progressPct,
      progress_basis: patientPct != null ? "patients" : hoursPct != null ? "hours" : null
    },
    money: {
      invoiced_amount: invoiced,
      revenue_recognized: revenue,
      cost_of_sales: cogs,
      earned_estimate: earned,
      ns_milestone_earned: nsMilestoneEarned,
      billed,
      remaining_to_bill: remainingToBill
    },
    forecast: {
      investigator_fees: invForecast,
      ptc: ptcForecast,
      oopc_labor: oopcLaborF,
      oopc_travel: oopcTravelF,
      basis: progressPct != null && enrolled != null && targetPatients != null
        ? "per_patient_when_possible_else_progress"
        : progressPct != null
          ? "progress_or_budget"
          : "budget_only"
    },
    gaps,
    note:
      gaps.length === 0
        ? "Payment + PTC/OOPC forecast from NetSuite budgets/actuals × Veeva enrollment (+ bid target when present)."
        : `Partial pack — ${gaps.length} gap(s). Still showing every field we have.`
  };
}

function paymentSections(payment) {
  if (!payment) return [];
  const p = payment.pricing || {};
  const pts = payment.patients || {};
  const mon = payment.money || {};
  const prog = payment.progress || {};
  const ms = payment.milestones || {};

  const sections = [
    {
      title: "Payment position (pricing × patients × milestones)",
      grid: "1.2fr 1fr 1fr",
      cols: ["Metric", "Value", "Notes"],
      rows: [
        ["Pricing pool", p.pricing_pool != null ? String(p.pricing_pool) : "—", "Inv fee + PTC (or bid / NS milestones)"],
        ["Inv fee budget", p.inv_fee_budget != null ? String(p.inv_fee_budget) : "—", "ora_ns_study"],
        ["Inv fee actual", p.inv_fee_actual != null ? String(p.inv_fee_actual) : "—", "Investigator Compensation (COGS)"],
        ["PTC budget", p.ptc_budget != null ? String(p.ptc_budget) : "—", "ora_ns_study"],
        ["PTC actual", p.ptc_actual != null ? String(p.ptc_actual) : "—", "sum PTC COGS categories"],
        ["OOPC labor", p.oopc_labor_actual != null ? String(p.oopc_labor_actual) : "—", "Payroll (non-PTC)"],
        ["OOPC travel", p.oopc_travel_actual != null ? String(p.oopc_travel_actual) : "—", "Travel (non-PTC)"],
        ["Patients enrolled", pts.enrolled != null ? String(pts.enrolled) : "—", "ora_veeva_study / site"],
        ["Patient target", pts.target != null ? String(pts.target) : "—", "Buddy bid drivers"],
        [
          "Progress % used",
          prog.progress_pct_used != null ? `${Math.round(prog.progress_pct_used * 1000) / 10}%` : "—",
          prog.progress_basis || "—"
        ],
        ["Earned (est.)", mon.earned_estimate != null ? String(mon.earned_estimate) : "—", "pool × progress (or NS milestone $)"],
        ["Billed", mon.billed != null ? String(mon.billed) : "—", "invoiced / revenue recognized"],
        ["Remaining to bill", mon.remaining_to_bill != null ? String(mon.remaining_to_bill) : "—", "earned − billed"],
        ["Veeva milestones hit / open", `${ms.veeva_hit || 0} / ${ms.veeva_open || 0}`, "payment-relevant roles"]
      ]
    }
  ];

  if ((ms.hit || []).length || (ms.next || []).length) {
    sections.push({
      title: `Veeva milestones (${(ms.hit || []).length} hit · ${(ms.next || []).length} open)`,
      grid: "1.4fr 0.8fr 0.7fr 0.7fr 0.7fr",
      cols: ["Milestone", "Role", "Status", "Actual finish", "Planned"],
      rows: [...(ms.hit || []), ...(ms.next || [])].slice(0, 40).map((m) => [
        m.name || "—",
        m.role || "—",
        m.complete ? "hit" : "open",
        m.actual_finish || "—",
        m.planned_finish || "—"
      ])
    });
  }

  if ((ms.ns_tasks || []).length) {
    sections.push({
      title: `NetSuite milestone tasks (${ms.ns_tasks.length})`,
      grid: "1.4fr 0.7fr 0.7fr 0.6fr",
      cols: ["Task", "Amount", "Status", "Complete"],
      rows: ms.ns_tasks.slice(0, 40).map((m) => [
        m.name || "—",
        m.milestone_amount != null ? String(m.milestone_amount) : "—",
        m.status || "—",
        m.complete ? "yes" : "no"
      ])
    });
  }

  if (p.bid) {
    const b = p.bid;
    sections.push({
      title: "Buddy bid / HLBP pricing",
      grid: "1.1fr 1fr 1fr",
      cols: ["Field", "Value", "Source"],
      rows: [
        ["Study", b.studyId || "—", "studies container"],
        ["Client", b.clientName || "—", "bid"],
        ["Type", b.budgetType || "—", "bid"],
        ["Target patients", b.enrolledSubjects != null ? String(b.enrolledSubjects) : "—", "drivers"],
        ["Core sites", b.coreSites != null ? String(b.coreSites) : "—", "drivers"],
        ["Enrollment months", b.enrollmentMonths != null ? String(b.enrollmentMonths) : "—", "drivers"],
        ["Bid total fee", b.totalFee != null ? String(b.totalFee) : "—", "totals"]
      ]
    });
  }

  const fc = payment.forecast || {};
  const lines = [fc.investigator_fees, fc.ptc, fc.oopc_labor, fc.oopc_travel].filter(Boolean);
  if (lines.length) {
    sections.push({
      title: "PTC / OOPC forecast (EAC)",
      grid: "1.2fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr 1.2fr",
      cols: ["Line", "Budget", "Actual", "EAC forecast", "Remaining", "vs budget", "Method"],
      rows: lines.map((f) => [
        f.label || "—",
        f.budget != null ? String(f.budget) : "—",
        f.actual != null ? String(f.actual) : "—",
        f.forecast_eac != null ? String(f.forecast_eac) : "—",
        f.remaining != null ? String(f.remaining) : "—",
        f.vs_budget != null ? String(f.vs_budget) : "—",
        f.note || f.method || "—"
      ])
    });
  }
  if (p.ptc_categories && typeof p.ptc_categories === "object") {
    const cats = Object.entries(p.ptc_categories);
    if (cats.length) {
      sections.push({
        title: "PTC categories (actual)",
        grid: "1.4fr 0.8fr",
        cols: ["Category", "Actual"],
        rows: cats.map(([k, v]) => [k, v != null ? String(v) : "—"])
      });
    }
  }

  if ((payment.gaps || []).length) {
    sections.push({
      title: "Gaps for full payment math",
      grid: "1fr",
      cols: ["Gap"],
      rows: payment.gaps.map((g) => [g])
    });
  }

  return sections;
}

function paymentSummaryLines(payment) {
  if (!payment) return [];
  const mon = payment.money || {};
  const pts = payment.patients || {};
  const p = payment.pricing || {};
  const fc = payment.forecast || {};
  const inv = fc.investigator_fees;
  const ptcF = fc.ptc;
  const lines = [
    `Payment position for ${payment.project_number}: pricing pool ${
      p.pricing_pool != null ? p.pricing_pool : "—"
    }, enrolled ${pts.enrolled != null ? pts.enrolled : "—"}` +
      (pts.target != null ? ` / target ${pts.target}` : "") +
      `, earned ${mon.earned_estimate != null ? mon.earned_estimate : "—"}, billed ${
        mon.billed != null ? mon.billed : "—"
      }, remaining ${mon.remaining_to_bill != null ? mon.remaining_to_bill : "—"}.`
  ];
  if (inv || ptcF) {
    lines.push(
      `PTC/OOPC forecast: inv fees EAC ${inv?.forecast_eac ?? "—"} (actual ${inv?.actual ?? "—"} / budget ${
        inv?.budget ?? "—"
      }); total PTC EAC ${ptcF?.forecast_eac ?? "—"} (actual ${ptcF?.actual ?? "—"} / budget ${ptcF?.budget ?? "—"}).`
    );
  }
  if (payment.note) lines.push(payment.note);
  return lines;
}

module.exports = {
  buildPaymentPosition,
  buildPortfolioFeeForecast,
  portfolioFeeSections,
  paymentSections,
  paymentSummaryLines
};
