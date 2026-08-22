/**
 * Live Salesforce pipeline from ora_sf_opportunity.
 * StageName = pipeline stage. $ = Total_Ora_Net_Revenue__c only (never Amount).
 */

const { safeQuery, SHARED_READ } = require("./cosmos");

const REVENUE_FIELDS = [
  "Total_Ora_Net_Revenue__c",
  "Total_Ora_Net_Rev__c",
  "Ora_Net_Revenue__c",
  "Total_Ora_Net_Revenue"
];

function isOppOpen(o) {
  if (o.IsClosed === true || o.IsClosed === "true") return false;
  const stage = String(o.StageName || "").toLowerCase();
  if (/^closed\b/.test(stage)) return false;
  return true;
}

function pickOraNetRevenue(o) {
  if (!o || typeof o !== "object") return { value: null, field: null };
  for (const f of REVENUE_FIELDS) {
    if (o[f] != null && o[f] !== "") {
      const n = Number(o[f]);
      if (Number.isFinite(n)) return { value: n, field: f };
    }
  }
  for (const k of Object.keys(o)) {
    if (/total.?ora.?net.?rev/i.test(k) || /^total_?ora_?net_?rev/i.test(k)) {
      if (o[k] != null && o[k] !== "") {
        const n = Number(o[k]);
        if (Number.isFinite(n)) return { value: n, field: k };
      }
    }
  }
  return { value: null, field: null };
}

function moneyLabel(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e6) return `$${Math.round((n / 1e6) * 10) / 10}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

async function loadOpportunities() {
  return safeQuery(
    SHARED_READ.sfOpportunity,
    `SELECT c.id, c.Name, c.StageName, c.IsClosed, c.IsWon, c.CloseDate, c.AccountId, c.OwnerName,
            c.Total_Ora_Net_Revenue__c, c.Total_Ora_Net_Rev__c, c.Ora_Net_Revenue__c, c.Total_Ora_Net_Revenue, c._ts
     FROM c WHERE c.docType = @t`,
    [{ name: "@t", value: "ora_sf_opportunity" }]
  );
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

async function getSfBriefing() {
  const rows = await loadOpportunities();
  const meta = asOfMeta(rows);
  if (!rows.length) {
    return {
      loaded: false,
      asOf: meta.asOf,
      asOfLabel: meta.asOfLabel,
      asOfKind: meta.asOfKind,
      opportunities: 0,
      open: 0,
      openWithNet: 0,
      openMissingNet: 0,
      openNetSum: null,
      stages: [],
      note: "ora_sf_opportunity is empty. Workbench Salesforce ingest has not written opportunities this SWA can read. Pipeline $ is Total Ora Net Revenue — never Amount.",
      topOpen: []
    };
  }

  const open = rows.filter(isOppOpen);
  let openNetSum = 0;
  let openWithNet = 0;
  const byStage = {};
  for (const r of open) {
    const { value } = pickOraNetRevenue(r);
    const stage = String(r.StageName || "—").trim() || "—";
    if (!byStage[stage]) byStage[stage] = { stage, n: 0, netSum: 0, withNet: 0 };
    byStage[stage].n += 1;
    if (value != null) {
      openWithNet += 1;
      openNetSum += value;
      byStage[stage].netSum += value;
      byStage[stage].withNet += 1;
    }
  }
  const stages = Object.values(byStage).sort((a, b) => b.netSum - a.netSum || b.n - a.n);
  const topOpen = open
    .map((r) => {
      const { value, field } = pickOraNetRevenue(r);
      return {
        name: r.Name || "—",
        stage: r.StageName || "—",
        closeDate: r.CloseDate || null,
        net: value,
        netField: field,
        owner: r.OwnerName || null
      };
    })
    .filter((r) => r.net != null)
    .sort((a, b) => b.net - a.net)
    .slice(0, 8);

  return {
    loaded: true,
    asOf: meta.asOf,
    asOfLabel: meta.asOfLabel,
    asOfKind: meta.asOfKind,
    opportunities: rows.length,
    open: open.length,
    openWithNet,
    openMissingNet: open.length - openWithNet,
    openNetSum: openWithNet ? Math.round(openNetSum) : null,
    stages: stages.map((s) => ({
      stage: s.stage,
      n: s.n,
      netSum: s.withNet ? Math.round(s.netSum) : null
    })),
    note: `${open.length - openWithNet} open opportunities have Total Ora Net Revenue missing (not zero). Stage = pipeline indicator. $ = Total_Ora_Net_Revenue__c only — never Amount.`,
    topOpen
  };
}

module.exports = {
  loadOpportunities,
  getSfBriefing,
  isOppOpen,
  pickOraNetRevenue,
  moneyLabel
};
