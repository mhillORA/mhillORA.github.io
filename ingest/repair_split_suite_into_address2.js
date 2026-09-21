/**
 * One-time: peel Suite/Unit/# off address1 onto address2 when line 2 is empty.
 *
 *   node ingest/repair_split_suite_into_address2.js
 *   node ingest/repair_split_suite_into_address2.js --apply
 */
const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs');
const path = require('path');
const { splitStreetAndUnit } = require('../api/lib/site-field-map.js');

const APPLY = process.argv.includes('--apply');
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
  const { resources } = await sitesC.items.query('SELECT * FROM c').fetchAll();
  const rows = [];
  let applied = 0;

  for (const site of resources) {
    const before1 = String(site.address1 || '').trim();
    const before2 = String(site.address2 || '').trim();
    const { address1, address2 } = splitStreetAndUnit(before1, before2);
    if (address1 === before1 && address2 === before2) continue;
    if (!address2 || address2 === before2) continue;

    const row = {
      id: site.id,
      name: site.name,
      before: { address1: before1, address2: before2 },
      after: { address1, address2 },
    };
    rows.push(row);
    console.log(
      `${APPLY ? 'APPLY' : 'DRY'} ${site.name}: "${before1}" / "${before2}" -> "${address1}" / "${address2}"`
    );

    if (APPLY) {
      site.address1 = address1;
      site.address2 = address2;
      site.address = address1;
      site.suiteSplitAt = new Date().toISOString();
      await sitesC.items.upsert(site);
      applied += 1;
    }
  }

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(
    REPORT,
    JSON.stringify({ applied: APPLY, changed: rows.length, upserted: applied, rows }, null, 2)
  );
  console.log(`changed ${rows.length} | upserted ${applied} | wrote ${REPORT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
