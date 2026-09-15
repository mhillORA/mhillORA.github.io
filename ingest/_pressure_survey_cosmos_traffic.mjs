/**
 * Pressure-test survey save / assign / public-load / draft / submit against Cosmos.
 *
 * DOES NOT send email. DOES NOT email sites. Creates disposable docs tagged
 * `_pressureTest: true` and deletes them at the end (unless --keep).
 *
 * Emulates the same document shapes as:
 *  - PUT /site-survey-definitions (builder save after reorder)
 *  - POST /site-survey-send with sendEmail:false (assignment mint)
 *  - GET  /public/site-survey (option payload for radios/multiselect)
 *  - POST /public/site-survey action=draft|submit
 *
 * Usage:
 *   node ingest/_pressure_survey_cosmos_traffic.mjs
 *   node ingest/_pressure_survey_cosmos_traffic.mjs --count=36 --reorder=12
 *   node ingest/_pressure_survey_cosmos_traffic.mjs --keep   # leave fixtures for inspection
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const COUNT = Math.max(4, Math.min(500, Number(args.count || 36) || 36));
const REORDER_ROUNDS = Math.max(2, Math.min(40, Number(args.reorder || 12) || 12));
const KEEP = args.keep === true || args.keep === 'true';
const SOURCE_SURVEY = String(args.survey || 'survey-rebuild-mytx272am-201');
const RUN_ID = `pt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const FIXTURE_SURVEY_ID = `survey-pressure-${RUN_ID}`;

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
const lib = db.container('site-survey-question-library');
const asg = db.container('site-survey-assignments');
const rsp = db.container('site-survey-responses');
const sitesC = db.container('sites');

const report = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  sendEmail: false,
  notes: 'No email / no real site outreach — Cosmos traffic only',
  steps: [],
  failures: [],
  created: { definitions: [], assignments: [], responses: [] },
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

function coerceOptions(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw === 'string') {
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      if (typeof o === 'string' || typeof o === 'number') return String(o).trim();
      if (o && typeof o === 'object') return String(o.label ?? o.value ?? '').trim();
      return '';
    })
    .filter(Boolean);
}

function isChoiceType(t) {
  const x = String(t || '').toLowerCase();
  return x === 'select' || x === 'radio' || x === 'multiselect';
}

/** Emulate the OLD buggy builder sync: empty choice DOM → wipe options. */
function buggySyncWipeOptions(questions) {
  return questions.map((q) => {
    if (!isChoiceType(q.type)) return { ...q, options: [] };
    // Simulate empty-state UI (no text inputs) overwriting memory
    return { ...q, options: [] };
  });
}

/** Emulate FIXED sync: never wipe prior options when DOM choice inputs are absent. */
function fixedSyncPreserveOptions(questions, previous) {
  return questions.map((q, i) => {
    if (!isChoiceType(q.type)) return { ...q, options: [] };
    const prev = coerceOptions(previous[i]?.options);
    const cur = coerceOptions(q.options);
    let options = cur.length ? cur : prev;
    if (!options.length && (q.type === 'radio' || q.type === 'select')) options = ['Yes', 'No'];
    return { ...q, options };
  });
}

function publicQuestionsFromList(questions) {
  return (questions || []).map((q, idx) => ({
    id: q.id || `q_${idx}`,
    label: q.label || q.title || `Question ${idx + 1}`,
    type: String(q.type || 'text').toLowerCase(),
    required: q.required !== false,
    options: Array.isArray(q.options) ? q.options : undefined,
    libraryQuestionId: q.libraryQuestionId || undefined,
  }));
}

function choiceGaps(questions) {
  return (questions || [])
    .map((q, i) => ({ i, id: q.id, type: q.type, label: (q.label || '').slice(0, 60), n: coerceOptions(q.options).length }))
    .filter((r) => isChoiceType(r.type) && r.n < 2);
}

function stripMeta(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const { _rid, _self, _etag, _attachments, _ts, ...rest } = doc;
  return rest;
}

async function loadLibMap() {
  const items = (
    await lib.items
      .query({ query: 'SELECT c.id, c.options, c.type, c.label FROM c' }, { enableCrossPartitionQuery: true })
      .fetchAll()
  ).resources;
  return new Map(items.map((x) => [x.id, x]));
}

async function hydrateQuestionsFromLibrary(questions, libById) {
  return (questions || []).map((q) => {
    if (!isChoiceType(q.type)) return { ...q, options: coerceOptions(q.options) };
    let options = coerceOptions(q.options);
    if (options.length < 2 && q.libraryQuestionId && libById.has(q.libraryQuestionId)) {
      options = coerceOptions(libById.get(q.libraryQuestionId).options);
    }
    if (options.length < 2 && (q.type === 'radio' || q.type === 'select')) options = ['Yes', 'No'];
    return { ...q, options };
  });
}

async function pickSites(n) {
  const rows = (
    await sitesC.items
      .query(
        {
          query: 'SELECT TOP @n c.id, c.name, c.siteName FROM c WHERE IS_DEFINED(c.id)',
          parameters: [{ name: '@n', value: n }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll()
  ).resources;
  if (rows.length < n) {
    // Fabricate disposable site ids if catalog is thin — never emailed
    while (rows.length < n) {
      const id = `pressure-site-${RUN_ID}-${rows.length}`;
      rows.push({ id, name: `Pressure Site ${rows.length}`, siteName: `Pressure Site ${rows.length}` });
    }
  }
  return rows.slice(0, n);
}

async function cleanup() {
  if (KEEP) {
    ok('cleanup.skipped', { summary: `--keep set; fixtures remain under ${FIXTURE_SURVEY_ID}` });
    return;
  }
  for (const id of report.created.responses) {
    try {
      await rsp.item(id, id).delete();
    } catch (_) {}
  }
  for (const id of report.created.assignments) {
    try {
      await asg.item(id, id).delete();
    } catch (_) {}
  }
  for (const id of report.created.definitions) {
    try {
      await defs.item(id, id).delete();
    } catch (_) {}
  }
  ok('cleanup.done', {
    summary: `removed ${report.created.definitions.length} defs, ${report.created.assignments.length} asg, ${report.created.responses.length} rsp`,
  });
}

async function main() {
  console.log(`Pressure run ${RUN_ID}`);
  console.log(`sendEmail=false | assignments=${COUNT} | reorderRounds=${REORDER_ROUNDS}`);
  console.log(`fixture survey: ${FIXTURE_SURVEY_ID}`);

  const libById = await loadLibMap();

  // --- 1) Clone source survey into disposable fixture (hydrated options) ---
  let source;
  try {
    source = (await defs.item(SOURCE_SURVEY, SOURCE_SURVEY).read()).resource;
  } catch (e) {
    fail('load.source', e);
    throw e;
  }
  const hydrated = await hydrateQuestionsFromLibrary(source.questions || [], libById);
  const gapsBefore = choiceGaps(source.questions || []);
  const gapsHydrated = choiceGaps(hydrated);
  ok('hydrate.options', {
    summary: `source choice gaps ${gapsBefore.length} → hydrated ${gapsHydrated.length}`,
    gapsBefore: gapsBefore.length,
    gapsHydrated: gapsHydrated.length,
  });
  if (gapsHydrated.length) {
    fail('hydrate.options', new Error(`${gapsHydrated.length} choice questions still <2 options`), {
      sample: gapsHydrated.slice(0, 5),
    });
  }

  // Demonstrate old bug would wipe on "reorder sync"
  const wiped = buggySyncWipeOptions(hydrated);
  const wipeGaps = choiceGaps(wiped);
  ok('bug.repro.wipe', {
    summary: `buggy sync would empty ${wipeGaps.length}/${hydrated.filter((q) => isChoiceType(q.type)).length} choice questions`,
  });
  const preserved = fixedSyncPreserveOptions(wiped, hydrated);
  const preserveGaps = choiceGaps(preserved);
  if (preserveGaps.length) fail('bug.fix.preserve', new Error('fixed sync still lost options'), { preserveGaps });
  else ok('bug.fix.preserve', { summary: 'fixed sync restored options after empty-DOM sync' });

  const fixture = {
    ...stripMeta(source),
    id: FIXTURE_SURVEY_ID,
    title: `[PRESSURE TEST — DO NOT SEND] ${source.title || SOURCE_SURVEY}`,
    status: 'draft',
    isPredefined: false,
    _pressureTest: true,
    _pressureRunId: RUN_ID,
    sendEmail: false,
    questions: hydrated,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'pressure-test',
  };
  await defs.items.create(fixture);
  report.created.definitions.push(FIXTURE_SURVEY_ID);
  ok('definition.create', { summary: FIXTURE_SURVEY_ID });

  // --- 2) Emulate builder reorder + PUT save N times (Cosmos upsert) ---
  let working = (await defs.item(FIXTURE_SURVEY_ID, FIXTURE_SURVEY_ID).read()).resource;
  for (let r = 0; r < REORDER_ROUNDS; r++) {
    const prev = working.questions.map((q) => ({ ...q, options: coerceOptions(q.options) }));
    // Rotate a block of questions (simulate move up/down bursts)
    const qs = [...prev];
    if (qs.length > 3) {
      const i = (r % (qs.length - 1)) + 1;
      [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]];
      if (qs.length > 5) {
        const j = (i + 2) % qs.length;
        const k = (j + 1) % qs.length;
        [qs[j], qs[k]] = [qs[k], qs[j]];
      }
    }
    // Simulate: sync from DOM then save — use FIXED path (and assert)
    const afterSync = fixedSyncPreserveOptions(qs, prev);
    const gaps = choiceGaps(afterSync);
    if (gaps.length) {
      fail('reorder.save', new Error(`options lost on reorder round ${r + 1}`), { gaps: gaps.slice(0, 8) });
      break;
    }
    working = {
      ...stripMeta(working),
      questions: afterSync,
      updatedAt: new Date().toISOString(),
      _pressureReorderRound: r + 1,
    };
    await defs.items.upsert(working);
  }
  const afterReorder = (await defs.item(FIXTURE_SURVEY_ID, FIXTURE_SURVEY_ID).read()).resource;
  const reorderGaps = choiceGaps(afterReorder.questions);
  if (reorderGaps.length) fail('reorder.verify', new Error('choice options missing after reorder PUTs'), { reorderGaps });
  else ok('reorder.verify', { summary: `${REORDER_ROUNDS} reorder+save cycles; options intact` });

  // --- 3) Emulate site-survey-send with sendEmail:false (dozens of assignments) ---
  const siteRows = await pickSites(COUNT);
  const minted = [];
  const now = new Date().toISOString();
  for (const site of siteRows) {
    for (const targetRole of ['pi', 'coordinator']) {
      const { raw, hash, prefix } = mintSurveyToken();
      const id = `asg-pressure-${RUN_ID}-${minted.length}`;
      const doc = {
        id,
        surveyId: FIXTURE_SURVEY_ID,
        siteId: String(site.id),
        targetRole,
        targetEmail: undefined, // intentionally blank — no outbound
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
        emailSkipReason: 'pressure-test-no-send',
      };
      await asg.items.create(doc);
      report.created.assignments.push(id);
      minted.push({
        id,
        siteId: doc.siteId,
        targetRole,
        raw,
        inviteUrl: buildInviteUrl('https://pressure.local', raw),
      });
    }
  }
  ok('assignments.mint', {
    summary: `created ${minted.length} assignments (sendEmail=false, no targetEmail)`,
  });

  // Verify token lookup shape matches API (hash equality)
  let tokenHits = 0;
  for (const m of minted.slice(0, Math.min(10, minted.length))) {
    const found = (
      await asg.items
        .query({
          query: 'SELECT * FROM c WHERE c.tokenHash = @h',
          parameters: [{ name: '@h', value: hashSurveyToken(m.raw) }],
        }, { enableCrossPartitionQuery: true })
        .fetchAll()
    ).resources;
    if (found.length === 1 && found[0].id === m.id) tokenHits += 1;
    else fail('token.lookup', new Error(`token miss for ${m.id}`), { found: found.length });
  }
  ok('token.lookup', { summary: `${tokenHits} sample token hashes resolved` });

  // --- 4) Emulate public GET payload — every choice q must expose ≥2 options ---
  const pubQs = publicQuestionsFromList(afterReorder.questions);
  const pubGaps = pubQs.filter((q) => isChoiceType(q.type) && coerceOptions(q.options).length < 2);
  if (pubGaps.length) fail('public.payload.options', new Error('public payload missing choices'), { pubGaps: pubGaps.slice(0, 8) });
  else ok('public.payload.options', { summary: `${pubQs.filter((q) => isChoiceType(q.type)).length} choice questions have options for sites` });

  // --- 5) Emulate draft + submit writes for a subset (no email) ---
  const sample = minted.slice(0, Math.min(24, minted.length));
  let drafts = 0;
  let submits = 0;
  for (const m of sample) {
    const answers = pubQs.slice(0, 8).map((q) => {
      const opts = coerceOptions(q.options);
      let value = 'pressure-ok';
      if (isChoiceType(q.type) && opts.length) {
        value = q.type === 'multiselect' ? [opts[0]] : opts[0];
      } else if (q.type === 'number') value = '1';
      return { questionId: q.id, value, confirmed: true };
    });
    const draftId = `rsp-pressure-draft-${m.id}`;
    const draftDoc = {
      id: draftId,
      surveyId: FIXTURE_SURVEY_ID,
      siteId: m.siteId,
      assignmentId: m.id,
      targetRole: m.targetRole,
      status: 'draft',
      isDraft: true,
      answers,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draftSavedAt: new Date().toISOString(),
      _pressureTest: true,
      _pressureRunId: RUN_ID,
      source: 'pressure-test',
    };
    await rsp.items.upsert(draftDoc);
    report.created.responses.push(draftId);
    drafts += 1;

    // Assignment draft stamp (API merge PUT)
    const existingAsg = (await asg.item(m.id, m.id).read()).resource;
    await asg.items.upsert({
      ...stripMeta(existingAsg),
      draftAnswers: answers,
      draftSavedAt: new Date().toISOString(),
      status: existingAsg.status === 'submitted' ? 'submitted' : 'opened',
      openedAt: existingAsg.openedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (sample.indexOf(m) % 2 === 0) {
      const submitId = `rsp-pressure-submit-${m.id}`;
      const submitDoc = {
        ...draftDoc,
        id: submitId,
        status: 'submitted',
        isDraft: false,
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await rsp.items.upsert(submitDoc);
      report.created.responses.push(submitId);
      await asg.items.upsert({
        ...stripMeta((await asg.item(m.id, m.id).read()).resource),
        status: 'submitted',
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      submits += 1;
    }
  }
  ok('draft.submit', { summary: `${drafts} drafts, ${submits} submits written (no email)` });

  // --- 6) Concurrent-ish burst: 12 parallel assignment reads + definition reads ---
  const burst = minted.slice(0, 12);
  await Promise.all(
    burst.map(async (m) => {
      const [a, d] = await Promise.all([
        asg.item(m.id, m.id).read(),
        defs.item(FIXTURE_SURVEY_ID, FIXTURE_SURVEY_ID).read(),
      ]);
      const gaps = choiceGaps(d.resource.questions);
      if (gaps.length) throw new Error(`options missing during burst for ${m.id}`);
      if (!a.resource?.tokenHash) throw new Error(`assignment missing tokenHash ${m.id}`);
    })
  );
  ok('burst.read', { summary: '12 parallel assignment+definition reads OK' });

  // Final definition still healthy
  const finalDef = (await defs.item(FIXTURE_SURVEY_ID, FIXTURE_SURVEY_ID).read()).resource;
  const finalGaps = choiceGaps(finalDef.questions);
  if (finalGaps.length) fail('final.options', new Error('fixture lost options'), { finalGaps });
  else ok('final.options', { summary: 'fixture definition still has all choice options' });

  await cleanup();

  report.finishedAt = new Date().toISOString();
  report.ok = report.failures.length === 0;
  const out = path.join(REPO, '.firecrawl', `pressure-survey-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nReport:', out);
  console.log(report.ok ? 'PASS' : 'FAIL');
  if (!report.ok) process.exitCode = 1;
}

main().catch(async (e) => {
  fail('fatal', e);
  try {
    await cleanup();
  } catch (_) {}
  report.finishedAt = new Date().toISOString();
  report.ok = false;
  const out = path.join(REPO, '.firecrawl', `pressure-survey-${RUN_ID}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.error(e);
  process.exit(1);
});
