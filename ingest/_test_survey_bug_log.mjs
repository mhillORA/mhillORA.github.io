/**
 * Verify survey bug logging writes to Cosmos and is queryable like Activity.
 * Simulates a deliberate client failure (draft_save_failed) with a disposable assignment.
 * Cleans up unless --keep.
 *
 *   node ingest/_test_survey_bug_log.mjs
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CosmosClient } = require('@azure/cosmos');
const { mintSurveyToken, defaultExpiresAt } = require('../api/lib/survey-tokens.js');
const {
  writeSurveyBugNotification,
  sanitizeSurveyLogContext,
} = require('../api/survey-secure-routes.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const RUN = `buglog_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;

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
const asg = db.container('site-survey-assignments');
const notes = db.container('site-survey-notifications');

const deps = {
  generateId: () => `note-${RUN}-${randomBytes(3).toString('hex')}`,
  getCosmosClient: () => ({ database: db }),
  getContainer: (name) => db.container(name),
};

async function main() {
  // Unit: sanitizer strips answers
  const cleaned = sanitizeSurveyLogContext({
    action: 'draft',
    pageIndex: 2,
    answers: ['SECRET'],
    href: '/site-survey.html?t=abc',
    ua: 'TestAgent/1.0',
  });
  if (cleaned.answers) throw new Error('sanitizer leaked answers');
  if (cleaned.action !== 'draft' || cleaned.pageIndex !== 2) throw new Error('sanitizer dropped safe fields');
  console.log('✓ sanitizer strips answers, keeps safe context');

  const { raw, hash, prefix } = mintSurveyToken();
  const asgId = `asg-buglog-${RUN}`;
  const now = new Date().toISOString();
  await asg.items.create({
    id: asgId,
    surveyId: 'survey-rebuild-mytx272am-201',
    siteId: `pressure-site-buglog-${RUN}`,
    targetRole: 'pi',
    status: 'opened',
    tokenHash: hash,
    tokenPrefix: prefix,
    expiresAt: defaultExpiresAt(7),
    openedAt: now,
    createdAt: now,
    updatedAt: now,
    _pressureTest: true,
    _bugLogTest: true,
    sendEmail: false,
  });
  console.log('✓ disposable assignment', asgId);

  // Deliberate failure payload (what the browser would send)
  const failMessage = `INTENTIONAL TEST FAILURE draft save boom [${RUN}]`;
  const doc = await writeSurveyBugNotification(deps, {
    level: 'client',
    code: 'draft_save_failed',
    message: failMessage,
    context: {
      action: 'draft',
      saveReason: 'autosave',
      pageIndex: 1,
      status: 500,
      path: '/site-survey.html',
      ua: 'buglog-test',
      answers: 'MUST_NOT_APPEAR',
    },
    assignment: {
      id: asgId,
      surveyId: 'survey-rebuild-mytx272am-201',
      siteId: `pressure-site-buglog-${RUN}`,
      targetRole: 'pi',
      tokenPrefix: prefix,
    },
    siteName: 'Buglog Test Site',
    ip: '127.0.0.1',
  });
  console.log('✓ wrote bug notification', doc.id);

  // Confirm readable like Activity (recent notifications)
  const { resources } = await notes.items
    .query(
      {
        query:
          'SELECT TOP 20 * FROM c WHERE c.kind = @k AND CONTAINS(c.errorMessage, @run) ORDER BY c.createdAt DESC',
        parameters: [
          { name: '@k', value: 'survey_client_error' },
          { name: '@run', value: RUN },
        ],
      },
      { enableCrossPartitionQuery: true }
    )
    .fetchAll();

  if (!resources.length) throw new Error('bug log not found in Cosmos after write');
  const hit = resources[0];
  console.log('✓ found in Cosmos:');
  console.log(JSON.stringify({
    id: hit.id,
    kind: hit.kind,
    summary: hit.summary,
    errorCode: hit.errorCode,
    errorMessage: hit.errorMessage,
    siteName: hit.siteName,
    assignmentId: hit.assignmentId,
    context: hit.context,
    read: hit.read,
  }, null, 2));

  if (hit.context?.answers) throw new Error('answers leaked into stored context');
  if (!String(hit.errorMessage).includes(RUN)) throw new Error('error message missing run id');
  if (hit.kind !== 'survey_client_error') throw new Error('wrong kind');

  // Also simulate server-side failure log
  const serverDoc = await writeSurveyBugNotification(deps, {
    level: 'server',
    code: 'public_post_failed',
    message: `INTENTIONAL SERVER FAILURE [${RUN}]`,
    context: { action: 'submit', source: 'server' },
    assignment: {
      id: asgId,
      surveyId: 'survey-rebuild-mytx272am-201',
      siteId: `pressure-site-buglog-${RUN}`,
      targetRole: 'pi',
      tokenPrefix: prefix,
    },
    siteName: 'Buglog Test Site',
    ip: '127.0.0.1',
  });
  console.log('✓ wrote server bug notification', serverDoc.id);

  if (!KEEP) {
    for (const id of [doc.id, serverDoc.id].filter(Boolean)) {
      try { await notes.item(id, id).delete(); } catch (_) {}
    }
    try { await asg.item(asgId, asgId).delete(); } catch (_) {}
    console.log('✓ cleanup done');
  } else {
    console.log('kept fixtures (--keep); open Feasibility → Activity to see them');
  }

  console.log('PASS');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
