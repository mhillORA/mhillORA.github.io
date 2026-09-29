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
  const ptc = money(intel?.ptc_budget);
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

  const paymentMs = veevaMs.filter((m) => m.payment_relevant);
  const nextTriggers = paymentMs.filter((m) => !m.complete).slice(0, 12);
  const hitTriggers = paymentMs.filter((m) => m.complete).slice(0, 20);

  const gaps = [];
  if (invFee == null && ptc == null && bidTotal == null && nsMilestoneTotal == null) {
    gaps.push("No pricing pool yet (need ora_ns_study inv/PTC, Buddy bid totals, or NS milestone amounts).");
  }
  if (targetPatients == null) {
    gaps.push("No contracted patient target (Buddy HLBP/bid drivers.enrolledSubjects) — patient % uses hours % when present.");
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
    method: "pricing × patients/milestones → earned vs billed",
    pricing: {
      inv_fee_budget: invFee,
      ptc_budget: ptc,
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
    gaps,
    note:
      gaps.length === 0
        ? "Payment position uses NetSuite pricing/billing + Veeva enrollment/milestones (+ Buddy bid target when present)."
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
        ["PTC budget", p.ptc_budget != null ? String(p.ptc_budget) : "—", "ora_ns_study"],
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
  const lines = [
    `Payment position for ${payment.project_number}: pricing pool ${
      p.pricing_pool != null ? p.pricing_pool : "—"
    }, enrolled ${pts.enrolled != null ? pts.enrolled : "—"}` +
      (pts.target != null ? ` / target ${pts.target}` : "") +
      `, earned ${mon.earned_estimate != null ? mon.earned_estimate : "—"}, billed ${
        mon.billed != null ? mon.billed : "—"
      }, remaining ${mon.remaining_to_bill != null ? mon.remaining_to_bill : "—"}.`
  ];
  if (payment.note) lines.push(payment.note);
  return lines;
}

module.exports = {
  buildPaymentPosition,
  paymentSections,
  paymentSummaryLines
};
