/**
 * Pressure-test: First/Last name helpers + builder "Add choice" option sync.
 *
 * Pure logic + optional Cosmos round-trip (disposable definition, cleaned up).
 *
 *   node ingest/_pressure_builder_add_choice.mjs
 *   node ingest/_pressure_builder_add_choice.mjs --cosmos
 *   node ingest/_pressure_builder_add_choice.mjs --cosmos --keep
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  parsePersonName,
  formatPersonNameFirstLast,
  personNameMatchesEmail,
  normalizeSiteFields,
} = require(path.join(ROOT, 'api/lib/site-field-map.js'));

const args = new Set(process.argv.slice(2));
const DO_COSMOS = args.has('--cosmos');
const KEEP = args.has('--keep');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('OK:', msg);
  }
}

// --- Mirror builder helpers (must stay in sync with index.html) ---
function coerceOptionList(raw, { keepBlank = false } = {}) {
  if (raw == null || raw === '') return [];
  if (typeof raw === 'string') {
    const lines = raw.split(/\r?\n/).map((s) => s.trim());
    return keepBlank ? lines : lines.filter(Boolean);
  }
  if (!Array.isArray(raw)) return [];
  const mapped = raw.map((o) => {
    if (typeof o === 'string' || typeof o === 'number') return String(o).trim();
    if (o && typeof o === 'object') return String(o.label ?? o.value ?? '').trim();
    return '';
  });
  return keepBlank ? mapped : mapped.filter(Boolean);
}
const finalizeChoiceOptions = (raw) => coerceOptionList(raw, { keepBlank: false });

function nextNewChoiceLabel(existing) {
  const opts = coerceOptionList(existing, { keepBlank: true }).map((o) => String(o).trim().toLowerCase());
  let n = 1;
  let label = 'New choice';
  while (opts.includes(label.toLowerCase())) {
    n += 1;
    label = `New choice ${n}`;
  }
  return label;
}

function resolveBuilderOptions(q, { keepBlank = false } = {}) {
  const type = String(q?.type || '').toLowerCase();
  const isChoice = type === 'select' || type === 'radio' || type === 'multiselect';
  if (!isChoice) return [];
  let opts = coerceOptionList(q?.options, { keepBlank });
  if (!opts.length && (type === 'radio' || type === 'select')) opts = ['Yes', 'No'];
  return opts;
}

function alignScoringOptionsToChoices(options, prevScoring, { scoreOn = false } = {}) {
  const opts = coerceOptionList(options, { keepBlank: true });
  const prev = Array.isArray(prevScoring) ? prevScoring : [];
  if (!scoreOn) return [];
  return opts.map((val, oi) => {
    const trimmed = String(val || '').trim();
    const byValue = trimmed ? prev.find((o) => String(o?.value || '').trim() === trimmed) : null;
    const byIndex = prev[oi] && typeof prev[oi] === 'object' ? prev[oi] : null;
    const match = byValue || byIndex;
    const pts = match && typeof match.points === 'number' ? match.points : 0;
    const base = { value: trimmed, points: pts };
    if (!trimmed) return null;
    if (match && (match.notInterested === true || String(match.disposition || '').toLowerCase() === 'not_interested')) {
      return { ...base, knockout: true, notInterested: true, disposition: 'not_interested' };
    }
    if (match && (match.knockout || match.fail)) return { ...base, knockout: true };
    return base;
  }).filter(Boolean);
}

function addChoice(q) {
  const opts = coerceOptionList(q.options, { keepBlank: true });
  const label = nextNewChoiceLabel(opts);
  const next = { ...q, options: [...opts, label] };
  const scoreOn = (q.scoringWeight || 0) > 0 || (q.scoringOptions || []).length > 0 || q.knockout;
  if (scoreOn) {
    next.scoringOptions = alignScoringOptionsToChoices(next.options, q.scoringOptions, { scoreOn: true });
  }
  return next;
}

function removeChoice(q, oi) {
  const before = coerceOptionList(q.options, { keepBlank: true });
  const prevScore = Array.isArray(q.scoringOptions) ? q.scoringOptions : [];
  const options = resolveBuilderOptions({ ...q, options: before.filter((_, i) => i !== oi) }, { keepBlank: true });
  const scoringOptions = prevScore.length
    ? alignScoringOptionsToChoices(options, prevScore.filter((_, i) => i !== oi), { scoreOn: true })
    : [];
  return { ...q, options, scoringOptions };
}

// ========== 1) First / Last names ==========
{
  const a = parsePersonName('Adam Murtaza');
  assert(a.first === 'Adam' && a.last === 'Murtaza' && a.display === 'Adam Murtaza', 'bare First Last kept');

  const b = parsePersonName('Murtaza, Adam');
  assert(b.display === 'Adam Murtaza' && b.first === 'Adam' && b.last === 'Murtaza', 'comma Last, First flips');

  const c = parsePersonName('Murtaza Adam', { firstName: 'Adam', lastName: 'Murtaza' });
  assert(c.display === 'Adam Murtaza', 'explicit first/last wins over raw order');

  const d = parsePersonName('Joondeph, Brian MD');
  assert(d.display === 'Brian Joondeph' || d.first.includes('Brian'), 'credentials stripped on comma form');

  assert(personNameMatchesEmail('Adam Murtaza', 'madam@colorado.com'), 'madam matches Adam Murtaza');
  assert(personNameMatchesEmail('Murtaza, Adam', 'madam@colorado.com'), 'madam matches comma form');
  assert(!personNameMatchesEmail('Brian Joondeph', 'madam@colorado.com'), 'madam does NOT match Brian');

  const site = normalizeSiteFields({
    name: 'Colorado Retina',
    pi: 'Murtaza Adam',
    piFirstName: 'Adam',
    piLastName: 'Murtaza',
    piEmail: 'madam@colorado.com',
  });
  assert(site.pi === 'Adam Murtaza', 'normalizeSiteFields → Adam Murtaza');
  assert(formatPersonNameFirstLast(site.pi) === 'Adam Murtaza', 'formatPersonNameFirstLast');
}

// ========== 2) Add choice to existing MCQ ==========
{
  let q = {
    type: 'multiselect',
    options: ['Too busy', 'Not a fit', 'Other'],
    scoringWeight: 10,
    scoringOptions: [
      { value: 'Too busy', points: 0, knockout: true, notInterested: true, disposition: 'not_interested' },
      { value: 'Not a fit', points: 0, knockout: true, notInterested: true, disposition: 'not_interested' },
      { value: 'Other', points: 0 },
    ],
    knockout: true,
  };

  q = addChoice(q);
  assert(q.options.length === 4 && q.options[3] === 'New choice', 'add choice appends New choice');
  assert(q.scoringOptions.length === 4, 'scoring rows grow with new choice');
  assert(q.scoringOptions[0].notInterested === true, 'prior not_interested preserved after add');
  assert(q.scoringOptions[3].value === 'New choice', 'new choice has scoring row');

  q = addChoice(q);
  assert(q.options[4] === 'New choice 2', 'second add gets New choice 2');

  // Mid-edit blank slot survives keepBlank resolve, stripped on finalize
  q.options = ['Too busy', '', 'Other', 'New choice'];
  const mid = resolveBuilderOptions(q, { keepBlank: true });
  assert(mid.length === 4 && mid[1] === '', 'keepBlank preserves empty mid-edit slot');
  const saved = finalizeChoiceOptions(mid);
  assert(JSON.stringify(saved) === JSON.stringify(['Too busy', 'Other', 'New choice']), 'finalize strips blanks');

  // Empty string add must NOT be the strategy — placeholder required
  assert(coerceOptionList(['Yes', 'No', ''], { keepBlank: false }).length === 2, 'coerce strips blank (legacy bug)');
  assert(nextNewChoiceLabel(['New choice']) === 'New choice 2', 'unique placeholder');

  // Remove middle choice + scoring
  q = {
    type: 'select',
    options: ['A', 'B', 'C'],
    scoringOptions: [
      { value: 'A', points: 10 },
      { value: 'B', points: 5, knockout: true },
      { value: 'C', points: 0 },
    ],
    scoringWeight: 10,
  };
  q = removeChoice(q, 1);
  assert(JSON.stringify(q.options) === JSON.stringify(['A', 'C']), 'remove middle choice');
  assert(q.scoringOptions.length === 2 && !q.scoringOptions.some((o) => o.value === 'B'), 'scoring pruned on remove');
  assert(q.scoringOptions[0].points === 10 && q.scoringOptions[1].points === 0, 'remaining scoring by index');

  // Reorder/sync guard: don't wipe to Yes/No when prev had real options
  const wiped = resolveBuilderOptions({ type: 'radio', options: [] });
  assert(JSON.stringify(wiped) === JSON.stringify(['Yes', 'No']), 'empty radio falls back Yes/No');
  const kept = resolveBuilderOptions({ type: 'radio', options: ['Interested', 'Not interested'] }, { keepBlank: true });
  assert(kept.length === 2, 'existing options never replaced by Yes/No');

  // Rapid add x12
  let rapid = { type: 'select', options: ['Yes', 'No'], scoringWeight: 0, scoringOptions: [] };
  for (let i = 0; i < 12; i++) rapid = addChoice(rapid);
  assert(rapid.options.length === 14, 'rapid add 12 choices');
  assert(new Set(rapid.options).size === rapid.options.length, 'all choice labels unique');
  assert(finalizeChoiceOptions(rapid.options).length === 14, 'finalize keeps placeholders');
}

// ========== 3) Object / scoring option shapes ==========
{
  const fromObj = coerceOptionList([{ label: 'Alpha' }, { value: 'Beta' }, { label: '', value: '' }]);
  assert(JSON.stringify(fromObj) === JSON.stringify(['Alpha', 'Beta']), 'object options coerce');
  const scored = alignScoringOptionsToChoices(
    ['Alpha', 'Gamma'],
    [{ value: 'Alpha', points: 7, knockout: true }],
    { scoreOn: true }
  );
  assert(scored[0].points === 7 && scored[0].knockout === true, 'align by value keeps knockout');
  assert(scored[1].value === 'Gamma' && scored[1].points === 0, 'new choice padded in scoring');
}

async function cosmosRoundTrip() {
  const { CosmosClient } = require('@azure/cosmos');
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'data-api-connections.json'), 'utf8'));
  const conn = cfg['cosmosdb-connection'].connectionString;
  const parts = Object.fromEntries(conn.replace(/;$/, '').split(';').filter(Boolean).map((x) => x.split('=')));
  const db = new CosmosClient({ endpoint: parts.AccountEndpoint, key: parts.AccountKey }).database('crcscheduling');
  const defs = db.container('site-survey-definitions');
  const liveId = 'survey-rebuild-mytx272am-201';
  const live = (await defs.item(liveId, liveId).read()).resource;
  const stamp = randomBytes(4).toString('hex');
  const testId = `survey_pressure_addchoice_${stamp}`;

  const qIdx = (live.questions || []).findIndex((q) => {
    const t = String(q.type || '').toLowerCase();
    return (t === 'select' || t === 'radio' || t === 'multiselect') && (q.options || []).length >= 2;
  });
  assert(qIdx >= 0, 'live ReBUILD has a choice question');
  if (qIdx < 0) return;

  const clone = JSON.parse(JSON.stringify(live));
  clone.id = testId;
  clone.title = `[PRESSURE] add-choice ${stamp}`;
  clone._pressureTest = true;
  clone.status = 'draft';
  delete clone._rid;
  delete clone._self;
  delete clone._etag;
  delete clone._attachments;
  delete clone._ts;

  let q = clone.questions[qIdx];
  const before = finalizeChoiceOptions(q.options);
  q = addChoice({ ...q, options: before, scoringOptions: q.scoringOptions || [], scoringWeight: q.scoringWeight || 0 });
  q = addChoice(q);
  q.options[q.options.length - 1] = `Pressure option ${stamp}`;
  q.scoringOptions = alignScoringOptionsToChoices(q.options, q.scoringOptions, {
    scoreOn: (q.scoringWeight || 0) > 0 || (q.scoringOptions || []).length > 0,
  });
  clone.questions[qIdx] = { ...clone.questions[qIdx], options: finalizeChoiceOptions(q.options), scoringOptions: q.scoringOptions };

  await defs.items.create(clone);
  const readBack = (await defs.item(testId, testId).read()).resource;
  const rbOpts = finalizeChoiceOptions(readBack.questions[qIdx].options);
  assert(rbOpts.includes(`Pressure option ${stamp}`), 'Cosmos round-trip kept added option');
  assert(rbOpts.length === before.length + 2, `Cosmos option count ${before.length}+2 → ${rbOpts.length}`);

  // Colorado PI check (live site)
  const sites = db.container('sites');
  const coloradoId = '1a0908a7c621f7958cd';
  try {
    const site = (await sites.item(coloradoId, coloradoId).read()).resource;
    const n = normalizeSiteFields(site);
    console.log('Colorado live PI:', site.pi, '| normalized:', n.pi, '| email:', site.piEmail);
    if (String(site.piFirstName || '') === 'Adam' || /adam/i.test(String(n.pi || ''))) {
      assert(personNameMatchesEmail(n.pi, site.piEmail), 'Colorado PI matches email after First Last');
    }
  } catch (e) {
    console.warn('Colorado site read skipped:', e.message);
  }

  if (!KEEP) {
    await defs.item(testId, testId).delete();
    console.log('Cleaned up', testId);
  } else {
    console.log('Kept', testId);
  }

  const outDir = path.join(ROOT, '.firecrawl');
  mkdirSync(outDir, { recursive: true });
  const report = {
    at: new Date().toISOString(),
    testId,
    beforeCount: before.length,
    afterCount: rbOpts.length,
    sample: rbOpts.slice(-3),
    failed,
  };
  writeFileSync(path.join(outDir, `pressure-add-choice-${stamp}.json`), JSON.stringify(report, null, 2));
}

console.log('\n=== Builder add-choice + First/Last pressure ===\n');
if (DO_COSMOS) {
  await cosmosRoundTrip();
} else {
  console.log('(skip Cosmos — pass --cosmos for live round-trip)');
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed');
