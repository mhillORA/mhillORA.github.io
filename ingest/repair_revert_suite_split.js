/**
 * Restore address1/address2 from a prior suite-split repair report, then
 * optionally re-apply the current splitter.
 *
 *   node ingest/repair_revert_suite_split.js
 *   node ingest/repair_revert_suite_split.js --apply
 *   node ingest/repair_revert_suite_split.js --apply --resplit
 */
const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs');
const path = require('path');
const { splitStreetAndUnit } = require('../api/lib/site-field-map.js');

const APPLY = process.argv.includes('--apply');
const RESPLIT = process.argv.includes('--resplit');
const REPO = path.resolve(__dirname, '..');
const REPORT = path.join(REPO, 'ingest', 'data', 'sites_suite_split_repair_report.json');

const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'data-api-connections.json'), 'utf8'));
const conn = cfg['cosmosdb-connection'].connectionString;
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
const sitesC = new CosmosClient({
  endpoint: parts.AccountEndpoint,
  key: parts.AccountKey,
})
  .database('crcscheduling')
  .container('sites');

(async () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  let restored = 0;
  let resplit = 0;
  const rows = [];

  for (const row of report.rows || []) {
    const { resource: site } = await sitesC.item(row.id, row.id).read();
    if (!site) {
      console.warn('missing', row.id, row.name);
      continue;
    }
    const before1 = String(row.before.address1 || '').trim();
    const before2 = String(row.before.address2 || '').trim();
    let address1 = before1;
    let address2 = before2;
    if (RESPLIT) {
      ({ address1, address2 } = splitStreetAndUnit(before1, before2));
    }
    rows.push({
      id: row.id,
      name: row.name,
      restored: { address1: before1, address2: before2 },
      final: { address1, address2 },
      changedFromLive:
        String(site.address1 || '') !== address1 || String(site.address2 || '') !== address2,
    });
    console.log(
      `${APPLY ? 'APPLY' : 'DRY'} ${row.name}: live="${site.address1}"/"${site.address2}" -> "${address1}"/"${address2}"`
    );
    if (APPLY) {
      site.address1 = address1;
      site.address2 = address2;
      site.address = address1;
      if (RESPLIT && address2 && address2 !== before2) {
        site.suiteSplitAt = new Date().toISOString();
        resplit += 1;
      } else {
        delete site.suiteSplitAt;
      }
      await sitesC.items.upsert(site);
      restored += 1;
    }
  }

  console.log(
    `rows ${rows.length} | upserted ${restored} | resplit ${resplit} | apply=${APPLY} resplit=${RESPLIT}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
