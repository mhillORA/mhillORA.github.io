import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const site = fs.readFileSync(new URL('../site-survey.html', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../api/survey-secure-routes.js', import.meta.url), 'utf8');

const checks = [
  ['index', html, 'Survey page field', /name="q_section_\$\{idx\}"/, true],
  ['index', html, 'New page button', /q-new-page/, true],
  ['index', html, 'Same as above', /q-same-page/, true],
  ['index', html, 'section sync', /q\.section = \(card\.querySelector/, true],
  ['index', html, 'section in save return', /section,\s*\n\s*knockout/, true],
  ['index', html, 'no unlink class', /q-unlink-library/, false],
  ['index', html, 'pages overview host', /site-survey-pages-overview/, true],
  ['index', html, 'choice logic dropdown', /Select a choice…/, true],
  ['index', html, 'bottom add library', /add-from-library-question-btn-bottom/, true],
  ['index', html, 'scoring category label', /Scoring category/, true],
  ['index', html, 'end survey early UI', /End survey early/, true],
  ['index', html, 'end enable checkbox', /q_end_enable_\$\{idx\}/, true],
  ['index', html, 'equals stickiness (hasOwnProperty)', /hasOwnProperty\.call\(showIfObj, 'equals'\)/, true],
  ['index', html, 'no notEmpty coerce on blank', /if \(!canon\) logicOp = 'notEmpty'/, false],
  ['index', html, 'clone showIf remap', /idMap\.get\(String\(dep\)\)/, true],
  ['index', html, 'library options all choice types', /options: isChoiceQuestionType\(type\) \? options : \[\]/, true],
  ['index', html, 'chart drill-through', /chartClickLabel/, true],
  ['index', html, 'includesAny no stale backup', /never fall back to stale hidden backup/, true],
  ['site', site, 'radio-aware readLogicCurrent', /Radio \(Yes\/No and choice grids\)/, true],
  ['site', site, 'endSurveyIf eval', /function evalEndSurveyIf/, true],
  ['site', site, 'end-skipped class', /end-skipped/, true],
  ['site', site, 'section preferred in resolveSectionKey', /const section = String\(q\.section/, true],
  ['api', api, 'explicit section paging', /anyExplicitSection/, true],
  ['api', api, 'section not overwritten by category', /category: q\.category \|\| undefined/, true],
];

let fail = 0;
for (const [, src, name, re, expectPresent] of checks) {
  const hit = re.test(src);
  const ok = hit === expectPresent;
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name}`);
  if (!ok) fail += 1;
}
if (fail) {
  console.error(`FAILED ${fail} checks`);
  process.exit(1);
}
console.log('PASS: static audit');
