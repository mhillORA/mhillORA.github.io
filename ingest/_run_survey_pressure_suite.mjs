/**
 * Run the full survey/template regression + pressure suite.
 *
 *   node ingest/_run_survey_pressure_suite.mjs
 *   node ingest/_run_survey_pressure_suite.mjs --rounds=200
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roundsArg = process.argv.find((a) => a.startsWith('--rounds=')) || '--rounds=120';

const jobs = [
  ['hardening', 'ingest/_test_survey_builder_hardening.mjs'],
  ['reorder', 'ingest/_test_builder_reorder.mjs'],
  ['static audit', 'ingest/_audit_survey_builder_static.mjs'],
  ['pressure + regressions', 'ingest/_pressure_survey_builder_logic.mjs', [roundsArg]],
];

let failed = 0;
for (const [name, script, extra = []] of jobs) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [script, ...extra], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${name} (exit ${r.status})`);
  }
}

if (failed) {
  console.error(`\nSUITE FAILED (${failed} job(s))`);
  process.exit(1);
}
console.log('\nSUITE PASS: all survey pressure / regression jobs green');
