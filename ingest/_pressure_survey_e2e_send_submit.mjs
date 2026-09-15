/**
 * End-to-end Cosmos pressure: create template → fake send → fill → submit.
 *
 * No email. Disposable docs tagged `_pressureTest: true` (deleted unless --keep).
 *
 *   node ingest/_pressure_survey_e2e_send_submit.mjs
 *   node ingest/_pressure_survey_e2e_send_submit.mjs --keep
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CosmosClient } = require('@azure/cosmos');
const {
  mintSurveyToken,
  defaultExpiresAt,
  buildInviteUrl,
  hashSurveyToken,
} = require('../api/lib/survey-tokens.js');
const {
  scoreAnswers,
  writeSurveyResponse,
} = require('../api/lib/survey-response-service.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const KEEP = args.keep === true || args.keep === 'true';
const RUN_ID = `e2e_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const SURVEY_ID = `survey-e2e-${RUN_ID}`;
const SITE_ID = `site-e2e-${RUN_ID}`;

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
const defs = db.container('site-survey-definitions');
const asg = db.container('site-survey-assignments');
const rsp = db.container('site-survey-responses');
const sitesC = db.container('sites');

const report = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  sendEmail: false,
  steps: [],
  failures: [],
  created: { definitions: [], assignments: [], responses: [], sites: [] },
};

function ok(step, detail = {}) {
  report.steps.push({ ok: true, step, ...detail });
  console.log(`✓ ${step}`, detail.summary || '');
}
function fail(step, err, detail = {}) {
  const message = err?.message || String(err);
  report.failures.push({ step, message, ...detail });
  console.error(`✗ ${step}:`, message);
}
function assert(cond, step, msg) {
  if (!cond) throw new Error(`${step}: ${msg}`);
}
function stripMeta(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const { _rid, _self, _etag, _attachments, _ts, ...rest } = doc;
  return rest;
}
function generateId() {
  return `id_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function buildTemplate() {
  return {
    id: SURVEY_ID,
    title: `[E2E PRESSURE — DO NOT SEND] Branching + scoring ${RUN_ID}`,
    description: 'Disposable end-to-end pressure template',
    status: 'draft',
    audience: ['pi', 'coordinator'],
    isPredefined: false,
    passThreshold: 70,
    borderlineThreshold: 50,
    scoring: { passThreshold: 70, borderlineThreshold: 50 },
    _pressureTest: true,
    _pressureRunId: RUN_ID,
    source: 'e2e-pressure',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questions: [
      {
        id: 'q_gate',
        label: 'Do you want to continue this survey?',
        type: 'radio',
        options: ['Yes', 'No'],
        required: true,
        section: 'Page 1',
        category: 'General',
        scoringWeight: 10,
        scoringOptions: [
          { value: 'Yes', points: 10 },
          { value: 'No', points: 0, knockout: true },
        ],
        knockout: true,
        logic: { endSurveyIf: { equals: 'No' } },
      },
      {
        id: 'q_detail',
        label: 'Briefly describe site capacity',
        type: 'text',
        options: [],
        required: true,
        section: 'Page 1',
        category: 'Patient access',
        scoringWeight: 0,
        scoringOptions: [],
        logic: { showIf: { questionId: 'q_gate', equals: 'Yes' } },
      },
      {
        id: 'q_multi',
        label: 'Which modalities can you support?',
        type: 'multiselect',
        options: ['OCT', 'FA', 'Both', 'None'],
        required: true,
        section: 'Page 2',
        category: 'Infrastructure',
        scoringWeight: 20,
        scoringOptions: [
          { value: 'OCT', points: 10 },
          { value: 'FA', points: 10 },
          { value: 'Both', points: 20 },
          { value: 'None', points: 0, knockout: true },
        ],
        knockout: true,
        logic: { showIf: { questionId: 'q_gate', equals: 'Yes' } },
      },
      {
        id: 'q_follow',
        label: 'OCT device model',
        type: 'text',
        options: [],
        required: true,
        section: 'Page 2',
        category: 'Infrastructure',
        scoringWeight: 0,
        scoringOptions: [],
        logic: { showIf: { questionId: 'q_multi', includesAny: ['OCT', 'Both'] } },
      },
    ],
  };
}

function answersForPath(pathName) {
  if (pathName === 'end_early') {
    return [
      { questionId: 'q_gate', label: 'Do you want to continue this survey?', type: 'radio', value: 'No', skipped: false, confirmed: true },
      { questionId: 'q_detail', label: 'Briefly describe site capacity', type: 'text', value: null, skipped: true, confirmed: false },
      { questionId: 'q_multi', label: 'Which modalities can you support?', type: 'multiselect', value: null, skipped: true, confirmed: false },
      { questionId: 'q_follow', label: 'OCT device model', type: 'text', value: null, skipped: true, confirmed: false },
    ];
  }
  // Full happy path
  return [
    { questionId: 'q_gate', label: 'Do you want to continue this survey?', type: 'radio', value: 'Yes', skipped: false, confirmed: true },
    { questionId: 'q_detail', label: 'Briefly describe site capacity', type: 'text', value: 'E2E capacity note', skipped: false, confirmed: true },
    { questionId: 'q_multi', label: 'Which modalities can you support?', type: 'multiselect', value: 'Both', skipped: false, confirmed: true },
    { questionId: 'q_follow', label: 'OCT device model', type: 'text', value: 'Spectralis E2E', skipped: false, confirmed: true },
  ];
}

async function cleanup() {
  if (KEEP) {
    ok('cleanup.skipped', { summary: `--keep; fixtures under ${SURVEY_ID}` });
    return;
  }
  for (const id of report.created.responses) {
    try { await rsp.item(id, id).delete(); } catch (_) {}
  }
  for (const id of report.created.assignments) {
    try { await asg.item(id, id).delete(); } catch (_) {}
  }
  for (const id of report.created.definitions) {
    try { await defs.item(id, id).delete(); } catch (_) {}
  }
  for (const id of report.created.sites) {
    try { await sitesC.item(id, id).delete(); } catch (_) {}
  }
  ok('cleanup.done', {
    summary: `removed def/asg/rsp/site for ${RUN_ID}`,
  });
}

async function main() {
  console.log(`E2E pressure ${RUN_ID}`);
  console.log('flow: create template → fake send → draft → submit (pass + knockout paths)');

  // --- 1) Create disposable site ---
  const siteDoc = {
    id: SITE_ID,
    name: `E2E Pressure Site ${RUN_ID}`,
    status: 'Active',
    _pressureTest: true,
    _pressureRunId: RUN_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await sitesC.items.create(siteDoc);
  report.created.sites.push(SITE_ID);
  ok('site.create', { summary: SITE_ID });

  // --- 2) Create template (builder save shape) ---
  const template = buildTemplate();
  await defs.items.create(template);
  report.created.definitions.push(SURVEY_ID);
  const saved = (await defs.item(SURVEY_ID, SURVEY_ID).read()).resource;
  assert(saved?.questions?.length === 4, 'definition.create', 'expected 4 questions');
  assert(saved.questions[0].logic?.endSurveyIf?.equals === 'No', 'definition.create', 'endSurveyIf missing');
  assert(saved.questions[1].logic?.showIf?.equals === 'Yes', 'definition.create', 'showIf missing');
  ok('definition.create', { summary: `${SURVEY_ID} · 4 questions · branching+scoring` });

  // Simulate a builder edit: bump title + reorder last two, upsert
  const qs = [...saved.questions];
  [qs[2], qs[3]] = [qs[3], qs[2]];
  // Invalid order for follow before multi — restore valid order for send
  const restored = [
    qs.find((q) => q.id === 'q_gate'),
    qs.find((q) => q.id === 'q_detail'),
    qs.find((q) => q.id === 'q_multi'),
    qs.find((q) => q.id === 'q_follow'),
  ];
  await defs.items.upsert({
    ...stripMeta(saved),
    title: `${template.title} (edited)`,
    questions: restored,
    status: 'active',
    updatedAt: new Date().toISOString(),
  });
  ok('definition.update', { summary: 'title edit + status active' });

  const defLive = (await defs.item(SURVEY_ID, SURVEY_ID).read()).resource;

  // --- 3) Fake send (mint tokens, no email) ---
  const minted = [];
  for (const targetRole of ['pi', 'coordinator']) {
    const { raw, hash, prefix } = mintSurveyToken();
    const id = `asg-e2e-${RUN_ID}-${targetRole}`;
    const now = new Date().toISOString();
    const doc = {
      id,
      surveyId: SURVEY_ID,
      siteId: SITE_ID,
      targetRole,
      targetEmail: undefined,
      status: 'sent',
      allowResubmit: true,
      generalFeasibilityVariant: 'none',
      tokenHash: hash,
      tokenPrefix: prefix,
      expiresAt: defaultExpiresAt(7),
      inviteCreatedAt: now,
      createdAt: now,
      updatedAt: now,
      _pressureTest: true,
      _pressureRunId: RUN_ID,
      sendEmail: false,
      emailSkipped: true,
      emailSkipReason: 'e2e-pressure-no-send',
    };
    await asg.items.create(doc);
    report.created.assignments.push(id);
    minted.push({
      id,
      raw,
      targetRole,
      inviteUrl: buildInviteUrl('https://pressure.local', raw),
      hash,
    });
  }
  ok('send.fake', {
    summary: `minted ${minted.length} assignments (sendEmail=false)`,
    invites: minted.map((m) => ({ role: m.targetRole, url: m.inviteUrl })),
  });

  // Token lookup (public load path)
  for (const m of minted) {
    const found = (
      await asg.items
        .query({
          query: 'SELECT * FROM c WHERE c.tokenHash = @h',
          parameters: [{ name: '@h', value: hashSurveyToken(m.raw) }],
        }, { enableCrossPartitionQuery: true })
        .fetchAll()
    ).resources;
    assert(found.length === 1 && found[0].id === m.id, 'token.lookup', `miss for ${m.id}`);
  }
  ok('public.token_lookup', { summary: 'both invite tokens resolve' });

  // Public payload shape
  const pubQs = (defLive.questions || []).map((q, idx) => ({
    id: q.id || `q_${idx}`,
    label: q.label,
    type: q.type,
    options: q.options,
    logic: q.logic,
    required: q.required !== false,
    section: q.section,
  }));
  assert(pubQs.filter((q) => q.type === 'radio' || q.type === 'multiselect').every((q) => (q.options || []).length >= 2),
    'public.payload', 'choice questions missing options');
  ok('public.payload', { summary: `${pubQs.length} questions with logic+options` });

  const getContainer = (name) => db.container(name);
  const deps = { getContainer, generateId, validateSurveyResponsesSchema: null };

  // --- 4) Fake fill + draft + submit: knockout / end-early path (PI) ---
  {
    const m = minted.find((x) => x.targetRole === 'pi');
    const assignment = (await asg.item(m.id, m.id).read()).resource;
    const answers = answersForPath('end_early');

    const draft = await writeSurveyResponse(deps, {
      assignment,
      answers,
      displayName: 'E2E PI Draft',
      isDraft: true,
    });
    assert(draft.draft === true, 'draft.end_early', 'draft flag missing');
    ok('fill.draft.end_early', { summary: 'PI drafted No (end early)' });

    const freshAsg = (await asg.item(m.id, m.id).read()).resource;
    const submitted = await writeSurveyResponse(deps, {
      assignment: freshAsg,
      answers,
      displayName: 'E2E PI',
      isDraft: false,
    });
    report.created.responses.push(submitted.resource.id);
    assert(submitted.created === true || submitted.resubmitted === true, 'submit.end_early', 'no response written');
    const score = submitted.resource.score || scoreAnswers(defLive, answers);
    assert(score?.outcome === 'fail', 'submit.end_early', `expected fail knockout, got ${score?.outcome}`);
    assert(score.knockouts?.some((k) => k.questionId === 'q_gate'), 'submit.end_early', 'gate knockout missing');
    const asgAfter = (await asg.item(m.id, m.id).read()).resource;
    assert(String(asgAfter.status).toLowerCase() === 'submitted', 'submit.end_early', 'assignment not submitted');
    ok('fill.submit.end_early', {
      summary: `PI submitted · outcome=${score.outcome} · knockouts=${score.knockouts.length}`,
      responseId: submitted.resource.id,
    });
  }

  // --- 5) Fake fill + submit: full pass path (Coordinator) ---
  {
    const m = minted.find((x) => x.targetRole === 'coordinator');
    const assignment = (await asg.item(m.id, m.id).read()).resource;
    const answers = answersForPath('full_pass');

    await writeSurveyResponse(deps, {
      assignment,
      answers,
      displayName: 'E2E Coord Draft',
      isDraft: true,
    });
    ok('fill.draft.full_pass', { summary: 'Coordinator drafted Yes/Both path' });

    const freshAsg = (await asg.item(m.id, m.id).read()).resource;
    const submitted = await writeSurveyResponse(deps, {
      assignment: freshAsg,
      answers,
      displayName: 'E2E Coordinator',
      isDraft: false,
    });
    report.created.responses.push(submitted.resource.id);
    const score = submitted.resource.score || scoreAnswers(defLive, answers);
    assert(score?.outcome === 'pass', 'submit.full_pass', `expected pass, got ${score?.outcome} pct=${score?.pct}`);
    assert(!score.knockouts?.length, 'submit.full_pass', 'unexpected knockouts');
    assert(score.pct >= 70, 'submit.full_pass', `pct ${score.pct} < 70`);
    ok('fill.submit.full_pass', {
      summary: `Coordinator submitted · outcome=${score.outcome} · pct=${score.pct}`,
      responseId: submitted.resource.id,
    });
  }

  // --- 6) Resubmit coordinator with knockout modality ---
  {
    const m = minted.find((x) => x.targetRole === 'coordinator');
    const assignment = (await asg.item(m.id, m.id).read()).resource;
    const answers = [
      { questionId: 'q_gate', type: 'radio', value: 'Yes', skipped: false, confirmed: true },
      { questionId: 'q_detail', type: 'text', value: 'Updated capacity', skipped: false, confirmed: true },
      { questionId: 'q_multi', type: 'multiselect', value: 'None', skipped: false, confirmed: true },
      { questionId: 'q_follow', type: 'text', value: null, skipped: true, confirmed: false },
    ];
    const submitted = await writeSurveyResponse(deps, {
      assignment,
      answers,
      displayName: 'E2E Coordinator Resubmit',
      isDraft: false,
    });
    if (submitted.resource?.id && !report.created.responses.includes(submitted.resource.id)) {
      report.created.responses.push(submitted.resource.id);
    }
    assert(submitted.resubmitted === true, 'resubmit', 'expected resubmit path');
    const score = submitted.resource.score;
    assert(score?.outcome === 'fail', 'resubmit', `expected fail on None, got ${score?.outcome}`);
    ok('fill.resubmit.knockout', {
      summary: `resubmit → outcome=${score.outcome}`,
      responseId: submitted.resource.id,
    });
  }

  await cleanup();

  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  mkdirSync(path.join(REPO, '.firecrawl'), { recursive: true });
  const out = path.join(REPO, '.firecrawl', `pressure-e2e-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nReport:', out);
  console.log(report.ok ? 'PASS: e2e template → send → fill → submit' : 'FAIL');
  if (!report.ok) process.exitCode = 1;
}

main().catch(async (e) => {
  fail('fatal', e);
  try { await cleanup(); } catch (_) {}
  report.finishedAt = new Date().toISOString();
  report.ok = false;
  mkdirSync(path.join(REPO, '.firecrawl'), { recursive: true });
  const out = path.join(REPO, '.firecrawl', `pressure-e2e-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(e);
  process.exit(1);
});
