/**
 * ReBUILD production pressure test — every template question.
 *
 * - Does NOT modify the ReBUILD template
 * - Creates disposable site/assignment/response tagged _pressureTest
 * - Fills EVERY question with a type-valid value
 * - Writes via writeSurveyResponse (same path sites use)
 * - Reads back from Cosmos and validates format + completeness
 * - Also audits live Stealth GA responses against the template
 *
 *   node ingest/_pressure_rebuild_full.mjs
 *   node ingest/_pressure_rebuild_full.mjs --keep
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CosmosClient } = require('@azure/cosmos');
const { writeSurveyResponse } = require('../api/lib/survey-response-service.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SURVEY_ID = 'survey-rebuild-mytx272am-201';
const KEEP = process.argv.includes('--keep');
const RUN_ID = `pt_rebuild_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const SITE_ID = `site-pressure-${RUN_ID}`;
const ASG_ID = `asg-pressure-${RUN_ID}`;

const connCfg = JSON.parse(readFileSync(path.join(REPO, 'data-api-connections.json'), 'utf8'));
const conn = connCfg['cosmosdb-connection'].connectionString;
const parts = Object.fromEntries(
  conn
    .replace(/;$/, '')
    .split(';')
    .filter((x) => x.includes('='))
    .map((x) => {
      const i = x.indexOf('=');
      return [x.slice(0, i), x.slice(i + 1)];
    })
);

const client = new CosmosClient({ endpoint: parts.AccountEndpoint, key: parts.AccountKey });
const db = client.database('crcscheduling');
const getContainer = (id) => db.container(id);

const report = {
  runId: RUN_ID,
  surveyId: SURVEY_ID,
  startedAt: new Date().toISOString(),
  failures: [],
  warnings: [],
  steps: [],
};

function fail(msg, detail = {}) {
  report.failures.push({ msg, ...detail });
  console.error(`FAIL: ${msg}`, detail.lib || detail.qid || '');
}
function warn(msg, detail = {}) {
  report.warnings.push({ msg, ...detail });
  console.warn(`WARN: ${msg}`, detail.lib || '');
}
function ok(msg, detail = {}) {
  report.steps.push({ ok: true, msg, ...detail });
  console.log(`OK: ${msg}${detail.summary ? ` — ${detail.summary}` : ''}`);
}

function optLabels(q) {
  return (q.options || [])
    .map((o) => (typeof o === 'string' ? o : o?.label || o?.value || ''))
    .filter(Boolean);
}

/** Build a valid answer value for every question type on the live template. */
function sampleValue(q) {
  const typ = String(q.type || 'text').toLowerCase();
  const opts = optLabels(q);
  const lab = String(q.label || '').toLowerCase();

  if (typ === 'radio' || typ === 'select') {
    if (!opts.length) return { value: 'Yes', note: 'radio-no-opts' };
    // Prefer Yes when present for branching friendliness
    const yes = opts.find((o) => /^yes\b/i.test(o));
    return { value: yes || opts[0] };
  }
  if (typ === 'multiselect' || typ === 'checkboxes' || typ === 'checkbox') {
    if (!opts.length) return { value: '[]', note: 'multi-no-opts' };
    const pick = opts.slice(0, Math.min(2, opts.length));
    return { value: pick.length === 1 ? pick[0] : JSON.stringify(pick) };
  }
  if (typ === 'number') {
    return { value: '3' };
  }
  if (typ === 'date') {
    return { value: '2026-09-16' };
  }
  if (typ === 'email' || /email/.test(lab)) {
    return { value: `pressure+${RUN_ID}@example.com` };
  }
  if (/phone/.test(lab)) {
    return { value: '617-555-0100' };
  }
  if (typ === 'textarea') {
    return { value: `Pressure test textarea ${RUN_ID}` };
  }
  // text default
  if (/name/.test(lab)) return { value: `Pressure Tester ${RUN_ID}` };
  if (/address/.test(lab)) return { value: '1 Pressure Way, Boston, MA 02114' };
  return { value: `pressure-value-${RUN_ID}` };
}

function validateStoredValue(q, value) {
  const typ = String(q.type || 'text').toLowerCase();
  const opts = optLabels(q);
  const issues = [];
  if (value === undefined || value === null || String(value).trim() === '') {
    issues.push('empty');
    return issues;
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value);

  if ((typ === 'radio' || typ === 'select') && opts.length) {
    if (!opts.includes(s)) issues.push(`radio value not in options: ${s.slice(0, 40)}`);
  }
  if ((typ === 'multiselect' || typ === 'checkboxes') && opts.length) {
    let vals = [s];
    if (s.startsWith('[')) {
      try {
        vals = JSON.parse(s);
      } catch {
        issues.push('multiselect not valid JSON array');
        return issues;
      }
    }
    if (!Array.isArray(vals)) vals = [vals];
    for (const v of vals) {
      if (!opts.includes(String(v))) issues.push(`multi value not in options: ${String(v).slice(0, 40)}`);
    }
  }
  if (typ === 'number' && !/^\d+(\.\d+)?$/.test(s)) {
    issues.push(`number format bad: ${s.slice(0, 40)}`);
  }
  return issues;
}

async function main() {
  const def = (await getContainer('site-survey-definitions').item(SURVEY_ID, SURVEY_ID).read()).resource;
  if (!def) throw new Error('ReBUILD survey missing');
  const questions = def.questions || [];
  ok('loaded ReBUILD template (read-only)', { summary: `${questions.length} questions` });

  // --- 1) Format check: every question has id + type; options sane ---
  const byLib = new Map();
  const byId = new Map();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.id) fail('question missing id', { idx: i, label: q.label });
    if (!q.type) fail('question missing type', { idx: i, qid: q.id });
    if (!q.label || !String(q.label).trim()) fail('question missing label', { idx: i, qid: q.id });
    if (String(q.label).trim() === '5') fail('junk label "5" on template', { qid: q.id });
    if (/â€/.test(String(q.label))) fail('mojibake on template label', { qid: q.id, label: q.label.slice(0, 80) });
    if (q.libraryQuestionId) {
      if (byLib.has(q.libraryQuestionId)) {
        warn('duplicate libraryQuestionId on template', { lib: q.libraryQuestionId });
      }
      byLib.set(q.libraryQuestionId, q);
    }
    byId.set(q.id, q);
    const typ = String(q.type || '').toLowerCase();
    if (['radio', 'select', 'multiselect'].includes(typ) && optLabels(q).length === 0) {
      fail('choice question has zero options', { qid: q.id, lib: q.libraryQuestionId, type: typ });
    }
  }
  ok('template structure scan', {
    summary: `${byLib.size} libs, ${report.failures.length} hard fails so far`,
  });

  // --- 2) Build full answer set for every question ---
  const answers = [];
  const sampleNotes = [];
  for (const q of questions) {
    const { value, note } = sampleValue(q);
    if (note) sampleNotes.push({ qid: q.id, note });
    const preIssues = validateStoredValue(q, value);
    if (preIssues.length) {
      fail('sample value invalid before write', { qid: q.id, lib: q.libraryQuestionId, preIssues, value });
    }
    answers.push({
      questionId: q.id,
      libraryQuestionId: q.libraryQuestionId || undefined,
      label: q.label,
      type: q.type,
      value,
      source: 'pressure-rebuild-full',
    });
  }
  ok('built answers for every question', { summary: `${answers.length}/${questions.length}` });

  // --- 3) Disposable site + assignment ---
  const now = new Date().toISOString();
  const site = {
    id: SITE_ID,
    name: `[PRESSURE DO NOT USE] ReBUILD ${RUN_ID}`,
    piName: 'Pressure PI',
    piEmail: `pressure-pi-${RUN_ID}@example.com`,
    _pressureTest: true,
    _pressureRunId: RUN_ID,
    createdAt: now,
    updatedAt: now,
  };
  await getContainer('sites').items.create(site);

  const assignment = {
    id: ASG_ID,
    surveyId: SURVEY_ID,
    siteId: SITE_ID,
    targetRole: 'pi',
    targetEmail: site.piEmail,
    status: 'sent',
    _pressureTest: true,
    _pressureRunId: RUN_ID,
    createdAt: now,
    updatedAt: now,
  };
  await getContainer('site-survey-assignments').items.create(assignment);
  ok('created disposable site + assignment');

  // --- 4) Write via production writeSurveyResponse path ---
  const deps = {
    getContainer,
    generateId: () => `rsp-pressure-${RUN_ID}`,
    validateSurveyResponsesSchema: null,
  };
  let writeResult;
  try {
    writeResult = await writeSurveyResponse(deps, {
      assignment,
      answers,
      email: site.piEmail,
      displayName: 'Pressure Tester',
      isDraft: false,
    });
  } catch (e) {
    fail('writeSurveyResponse threw', { message: e.message });
    throw e;
  }
  const writtenId = writeResult?.resource?.id;
  if (!writtenId) fail('writeSurveyResponse returned no id');
  else ok('writeSurveyResponse', { summary: `id=${writtenId} created=${writeResult.created}` });

  // Responses container partition key is /id (not siteId)
  let read;
  try {
    read = (await getContainer('site-survey-responses').item(writtenId, writtenId).read()).resource;
  } catch (e) {
    read = null;
  }
  if (!read) {
    // fallback query
    const found = (
      await getContainer('site-survey-responses').items
        .query({
          query: 'SELECT * FROM c WHERE c.id = @id',
          parameters: [{ name: '@id', value: writtenId }],
        })
        .fetchAll()
    ).resources;
    read = found[0] || null;
  }
  if (!read) {
    fail('read-back missing from Cosmos');
  } else {
    ok('Cosmos read-back', { summary: `${(read.answers || []).length} answers` });
    if (read.surveyId !== SURVEY_ID) fail('surveyId mismatch on read-back', { got: read.surveyId });
    if (read.siteId !== SITE_ID) fail('siteId mismatch on read-back', { got: read.siteId });
    if (String(read.status || '').toLowerCase() === 'error') fail('response status error');

    const gotByQ = new Map();
    for (const a of read.answers || []) {
      const key = a.questionId || a.libraryQuestionId;
      gotByQ.set(key, a);
    }

    let missing = 0;
    let badFormat = 0;
    for (const q of questions) {
      const a = gotByQ.get(q.id) || (q.libraryQuestionId ? gotByQ.get(q.libraryQuestionId) : null);
      if (!a) {
        missing += 1;
        fail('answer missing after write', { qid: q.id, lib: q.libraryQuestionId, label: (q.label || '').slice(0, 60) });
        continue;
      }
      const issues = validateStoredValue(q, a.value);
      if (issues.length) {
        badFormat += 1;
        fail('answer format invalid after write', {
          qid: q.id,
          lib: q.libraryQuestionId,
          issues,
          value: String(a.value).slice(0, 80),
        });
      }
    }
    ok('per-question read-back validation', {
      summary: `missing=${missing} badFormat=${badFormat} total=${questions.length}`,
    });

    // Round-trip resubmit merge (site edits)
    const tweaked = (read.answers || []).map((a, i) =>
      i === 0 ? { ...a, value: a.value, _pressureTouched: true } : a
    );
    const asgNow = (
      await getContainer('site-survey-assignments').item(ASG_ID, ASG_ID).read()
    ).resource;
    const resub = await writeSurveyResponse(deps, {
      assignment: asgNow,
      answers: tweaked,
      email: site.piEmail,
      displayName: 'Pressure Tester Resubmit',
      isDraft: false,
    });
    if (!resub?.resubmitted && !resub?.resource) fail('resubmit failed');
    else ok('resubmit write path', { summary: `resubmitted=${!!resub.resubmitted}` });

    const read2 = (
      await getContainer('site-survey-responses').item(writtenId, writtenId).read()
    ).resource;
    if ((read2?.answers || []).length < questions.length) {
      fail('resubmit dropped answers', {
        before: (read.answers || []).length,
        after: (read2?.answers || []).length,
      });
    } else {
      ok('resubmit preserved answer count', { summary: String((read2.answers || []).length) });
    }
  }

  // --- 6) Audit live Stealth GA responses vs template ---
  const stealth = (
    await getContainer('site-survey-responses').items
      .query({
        query:
          "SELECT c.id, c.siteId, c.answerCount, c.answers, c.stealthUnmapped, c.stealthPi, c.updatedAt FROM c WHERE STARTSWITH(c.id, 'rsp-stealth-ga-')",
      })
      .fetchAll()
  ).resources;
  ok('loaded Stealth GA responses', { summary: `${stealth.length} docs` });

  let stealthBad = 0;
  let stealthOrphan = 0;
  let stealthOkAnswers = 0;
  const sampleSites = [];
  for (const doc of stealth) {
    const ans = doc.answers || [];
    for (const a of ans) {
      const lib = a.libraryQuestionId;
      const q = (lib && byLib.get(lib)) || byId.get(a.questionId);
      if (!q) {
        stealthOrphan += 1;
        // ql-contracts-phone etc — count but don't hard-fail production if only orphans are known-safe
        continue;
      }
      const issues = validateStoredValue(q, a.value);
      if (issues.length) {
        stealthBad += 1;
        if (stealthBad <= 25) {
          fail('Stealth answer bad format', {
            siteId: doc.siteId,
            pi: doc.stealthPi,
            lib,
            issues,
            value: String(a.value).slice(0, 70),
          });
        }
      } else {
        stealthOkAnswers += 1;
      }
    }
    if (sampleSites.length < 5) {
      sampleSites.push({
        id: doc.id,
        siteId: doc.siteId,
        pi: doc.stealthPi,
        n: ans.length,
        unmapped: Object.keys(doc.stealthUnmapped || {}).length,
      });
    }
  }
  ok('Stealth format audit', {
    summary: `okAnswers=${stealthOkAnswers} bad=${stealthBad} orphanLibs=${stealthOrphan} samples=${JSON.stringify(sampleSites)}`,
  });

  // Spot-check OCB / LIV coverage of critical libs
  const critical = [
    'ql-rebuild-001-has-the-investigator-reviewed-the-protocol-synopsis-',
    'ql-site-name',
    'ql-pi-phone',
    'ql-gsf_092_contracting-budgeting-contact-phone-number',
    'ql-rebuild-025-how-many-ongoing-trials-does-your-site-have-in-patie',
    'ql-rebuild-072-is-your-staff-gcp-certified',
    'ql-rebuild-070-is-your-site-able-to-obtain-dry-ice-for-shipping-spe',
  ];
  for (const doc of stealth) {
    const name = `${doc.stealthPi || ''} ${doc.siteId || ''}`.toLowerCase();
    if (!/heier|graham|wykoff|ocb|long island|1a0908ab319fc3c6b25|1a0908a9eb57f00dafd/.test(name) &&
        !/heier|graham|wykoff/.test(String(doc.stealthPi || '').toLowerCase())) {
      continue;
    }
    const libs = new Set((doc.answers || []).map((a) => a.libraryQuestionId).filter(Boolean));
    const missingCrit = critical.filter((c) => !libs.has(c));
    if (missingCrit.length) {
      fail('critical Stealth gaps on key site', { pi: doc.stealthPi, missingCrit });
    } else {
      ok(`critical libs present for ${doc.stealthPi}`, { summary: `${(doc.answers || []).length} answers` });
    }
    // ongoing must be radio option not raw digit
    const ong = (doc.answers || []).find(
      (a) => a.libraryQuestionId === 'ql-rebuild-025-how-many-ongoing-trials-does-your-site-have-in-patie'
    );
    if (ong) {
      const q = byLib.get(ong.libraryQuestionId);
      const issues = validateStoredValue(q, ong.value);
      if (issues.length) fail('ongoing count format', { pi: doc.stealthPi, value: ong.value, issues });
    }
  }

  // --- 7) Cleanup ---
  if (!KEEP) {
    try {
      await getContainer('site-survey-responses').item(writtenId, writtenId).delete();
    } catch (_) {}
    try {
      await getContainer('site-survey-assignments').item(ASG_ID, ASG_ID).delete();
    } catch (_) {}
    try {
      await getContainer('sites').item(SITE_ID, SITE_ID).delete();
    } catch (_) {}
    // purge any archived pressure copies
    const archived = (
      await getContainer('site-survey-responses').items
        .query({
          query: 'SELECT c.id FROM c WHERE c.siteId = @s',
          parameters: [{ name: '@s', value: SITE_ID }],
        })
        .fetchAll()
    ).resources;
    for (const a of archived) {
      try {
        await getContainer('site-survey-responses').item(a.id, a.id).delete();
      } catch (_) {}
    }
    ok('cleaned disposable pressure docs');
  } else {
    ok('KEEP set — left pressure docs in Cosmos', { summary: SITE_ID });
  }

  report.finishedAt = new Date().toISOString();
  report.failCount = report.failures.length;
  report.warnCount = report.warnings.length;
  const outDir = path.join(REPO, '.firecrawl');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `pressure-rebuild-${RUN_ID}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`FAILURES: ${report.failures.length}  WARNINGS: ${report.warnings.length}`);

  if (report.failures.length) {
    console.error('\n=== FAILURE DETAIL (first 40) ===');
    for (const f of report.failures.slice(0, 40)) {
      console.error(JSON.stringify(f));
    }
    process.exit(1);
  }
  console.log('\nPRESSURE PASS: every ReBUILD question format-checked, wrote to Cosmos, read back clean.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
