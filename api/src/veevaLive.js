/**
 * Live Vault mirrors in bd-budgets (ora_veeva_*), not ora_fact_* Excel projections.
 * Site PSM = enrolled / months(FSI→LSI from ora_veeva_milestone). Null dates or enrolled → null, not 0.
 */

const { safeQuery } = require("./cosmos");

const LIVE = {
  study: "ora_veeva_study",
  site: "ora_veeva_site",
  org: "ora_veeva_organization",
  sponsor: "ora_veeva_sponsor",
  milestone: "ora_veeva_milestone",
  subject: "ora_veeva_subject"
};

let cache = { at: 0, pack: null };
const TTL_MS = 3 * 60 * 1000;

function picklistLabel(v) {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v.label || v.name || v.value || null;
  const s = String(v).trim();
  return s || null;
}

function vaultIndicationLabel(raw) {
  if (raw == null || raw === "") return "_unknown";
  let s = picklistLabel(raw) || String(raw);
  s = String(s)
    .replace(/__c$/i, "")
    .replace(/__v$/i, "")
    .replace(/_/g, " ")
    .trim();
  if (!s) return "_unknown";
  return s
    .split(/\s+/)
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function siteEnrollMonthsFromFsiLsi(fsiIso, lsiIso) {
  if (!fsiIso || !lsiIso) return null;
  const a = Date.parse(fsiIso);
  const b = Date.parse(lsiIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const d0 = new Date(start);
  const d1 = new Date(end);
  let months = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + (d1.getUTCMonth() - d0.getUTCMonth());
  if (months < 1) return 1;
  return months;
}

function computeSitePsm(totalEnrolled, enrollMonths) {
  const n = Number(totalEnrolled);
  const m = Number(enrollMonths);
  if (!(n >= 0) || !(m > 0)) return null;
  if (n === 0) return 0;
  return Math.round((n / m) * 1000) / 1000;
}

function classifyEnrollmentMilestone(name, type) {
  const s = `${name || ""} ${type || ""}`.toLowerCase();
  if (/\blso\b|last subject out|last patient out/.test(s)) return null;
  if (/\blsi\b|last subject in|last patient in|lpfv/.test(s)) return "lsi";
  if (/\bfsi\b|\bfpi\b|fpfv|first subject|first patient/.test(s)) return "fsi";
  return null;
}

function isEnrolledSubjectStatus(statusRaw) {
  const status = String(statusRaw || "").toLowerCase();
  if (/\bscreen\s*fail|withdrawn|discontinued|not enrolled\b/.test(status)) return false;
  return true;
}

function isActiveLifecycle(state) {
  const s = String(state || "").toLowerCase();
  if (!s) return true;
  return !/\b(complet|cancel|archiv|closed|terminat)\b/.test(s);
}

async function buildPack() {
  const [studyRows, siteRows, orgs, sponsors, subjects, milestones] = await Promise.all([
    safeQuery(
      LIVE.study,
      `SELECT c.id, c.name__v, c.alternate_study_number__vs, c.study_name__v, c.sponsor__c,
              c.sponsor_organization__v, c.indication__v, c.indication__c, c.study_phase__v,
              c.status__v, c.study_status__v, c.enrollment__vs, c.number_of_sites__c, c.country__c, c._ts
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_study" }]
    ),
    safeQuery(
      LIVE.site,
      `SELECT c.id, c.study__v, c.no_subjects_enrolled__v, c.name__v, c.site_name__v,
              c.organization__clin, c.country__v, c.study_name__v, c.study_number__v,
              c.indication__c, c.study_phase__c, c._ts
       FROM c WHERE c.docType = @t`,
      [{ name: "@t", value: "ora_veeva_site" }]
    ),
    safeQuery(LIVE.org, `SELECT c.id, c.name__v, c.full_name__v FROM c WHERE c.docType = @t`, [
      { name: "@t", value: "ora_veeva_organization" }
    ]),
    safeQuery(LIVE.sponsor, `SELECT c.id, c.name__v FROM c WHERE c.docType = @t`, [
      { name: "@t", value: "ora_veeva_sponsor" }
    ]),
    safeQuery(
      LIVE.subject,
      `SELECT c.site__v, c.subject_status__v, c.status__v FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
      [{ name: "@t", value: "ora_veeva_subject" }]
    ),
    safeQuery(
      LIVE.milestone,
      `SELECT c.site__v, c.study__v, c.name__v, c.milestone_type__v, c.actual_finish_date__v, c.actual_start_date__v
       FROM c WHERE c.docType = @t AND IS_DEFINED(c.site__v) AND c.site__v != null`,
      [{ name: "@t", value: "ora_veeva_milestone" }]
    )
  ]);

  const orgNameById = new Map();
  for (const o of orgs) orgNameById.set(o.id, o.full_name__v || o.name__v || null);
  const sponsorNameById = new Map();
  for (const s of sponsors) sponsorNameById.set(s.id, s.name__v || null);

  const enrolledBySite = new Map();
  for (const sub of subjects) {
    if (!isEnrolledSubjectStatus(`${sub.subject_status__v || ""} ${sub.status__v || ""}`)) continue;
    enrolledBySite.set(sub.site__v, (enrolledBySite.get(sub.site__v) || 0) + 1);
  }

  const datesBySite = new Map();
  for (const m of milestones) {
    const kind = classifyEnrollmentMilestone(m.name__v, m.milestone_type__v);
    if (!kind) continue;
    const when = m.actual_finish_date__v || m.actual_start_date__v;
    if (!when) continue;
    if (!datesBySite.has(m.site__v)) datesBySite.set(m.site__v, {});
    const pack = datesBySite.get(m.site__v);
    if (kind === "fsi") {
      if (!pack.fsi || Date.parse(when) < Date.parse(pack.fsi)) pack.fsi = when;
    } else if (kind === "lsi") {
      if (!pack.lsi || Date.parse(when) > Date.parse(pack.lsi)) pack.lsi = when;
    }
  }

  const studyById = new Map();
  const studies = [];
  for (const s of studyRows) {
    const indicationRaw = s.indication__v || s.indication__c || null;
    const indication = indicationRaw ? vaultIndicationLabel(indicationRaw) : "_unknown";
    const study_number = s.alternate_study_number__vs || s.name__v || s.id;
    const row = {
      id: s.id,
      study_number,
      sponsor: (s.sponsor__c && sponsorNameById.get(s.sponsor__c)) || s.sponsor_organization__v || null,
      indication: indication || "_unknown",
      phase: picklistLabel(s.study_phase__v) || null,
      lifecycle_state: picklistLabel(s.status__v || s.study_status__v) || null,
      total_enrolled: s.enrollment__vs != null ? Number(s.enrollment__vs) : null,
      n_contributing_sites: s.number_of_sites__c != null ? Number(s.number_of_sites__c) : null,
      psm: null,
      _ts: s._ts
    };
    studyById.set(s.id, row);
    studies.push(row);
  }

  const sites = [];
  const sitePsmsByStudy = new Map();
  const concurrentByOrgCountry = new Map();
  for (const site of siteRows) {
    const study = site.study__v ? studyById.get(site.study__v) : null;
    const fromSite = site.indication__c ? vaultIndicationLabel(site.indication__c) : null;
    const indication = fromSite || study?.indication || "_unknown";
    const org =
      (site.organization__clin && orgNameById.get(site.organization__clin)) ||
      site.site_name__v ||
      site.name__v ||
      null;
    if (!org) continue;
    const dates = datesBySite.get(site.id) || {};
    const months = siteEnrollMonthsFromFsiLsi(dates.fsi, dates.lsi);
    let enrolled = site.no_subjects_enrolled__v != null ? Number(site.no_subjects_enrolled__v) : null;
    if (enrolled == null && enrolledBySite.has(site.id)) enrolled = enrolledBySite.get(site.id);
    const site_psm = months != null && enrolled != null ? computeSitePsm(enrolled, months) : null;
    const country = site.country__v || "_unknown";
    const study_number = study?.study_number || site.study_number__v || site.study_name__v || null;
    const study_name = site.study_name__v || site.study_number__v || study?.study_number || null;
    sites.push({
      veeva_site_id: site.id,
      veeva_study_id: site.study__v || null,
      org_clean: org,
      organization: org,
      country,
      indication,
      phase: picklistLabel(site.study_phase__c) || study?.phase || null,
      lifecycle_state: study?.lifecycle_state || null,
      total_enrolled: enrolled,
      site_psm,
      site_enroll_months: months,
      fsi_trust: dates.fsi && dates.lsi ? "high" : dates.fsi || dates.lsi ? "partial" : null,
      study_number,
      study_name,
      _ts: site._ts
    });
    if (site_psm != null && site_psm > 0 && study) {
      if (!sitePsmsByStudy.has(study.id)) sitePsmsByStudy.set(study.id, []);
      sitePsmsByStudy.get(study.id).push(site_psm);
    }
    const ck = `${org}||${country}`;
    if (!concurrentByOrgCountry.has(ck)) concurrentByOrgCountry.set(ck, new Set());
    if (study && isActiveLifecycle(study.lifecycle_state) && study.study_number) {
      concurrentByOrgCountry.get(ck).add(study.study_number);
    }
  }

  for (const study of studies) {
    const psms = sitePsmsByStudy.get(study.id) || [];
    if (!psms.length) {
      study.psm = null;
      continue;
    }
    psms.sort((a, b) => a - b);
    const m = Math.floor(psms.length / 2);
    study.psm = psms.length % 2 ? psms[m] : Math.round(((psms[m - 1] + psms[m]) / 2) * 1000) / 1000;
    study.n_psm_sites = psms.length;
  }

  for (const site of sites) {
    site.concurrent_studies = concurrentByOrgCountry.get(`${site.org_clean}||${site.country}`)?.size || 0;
  }

  return { studies, sites };
}

async function loadLivePack() {
  const now = Date.now();
  if (cache.pack && now - cache.at < TTL_MS) return cache.pack;
  const pack = await buildPack();
  cache = { at: now, pack };
  return pack;
}

module.exports = { loadLivePack, LIVE, vaultIndicationLabel };
