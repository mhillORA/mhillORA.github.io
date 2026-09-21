/**
 * Repair sites where house number is on address1 and street name on address2,
 * and normalize phones to 555-555-5555.
 *
 *   node ingest/repair_split_addresses_phones.js
 *   node ingest/repair_split_addresses_phones.js --apply
 */
const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs');
const path = require('path');
const {
  normalizeSiteFields,
  normalizePhone,
  looksLikeHouseNumberOnly,
  looksLikeUnitLine,
} = require('../api/lib/site-field-map.js');

const APPLY = process.argv.includes('--apply');
const REPO = path.resolve(__dirname, '..');
const REPORT = path.join(REPO, 'ingest', 'data', 'sites_split_address_phone_repair_report.json');

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
const client = new CosmosClient({ endpoint: parts.AccountEndpoint, key: parts.AccountKey });
const sitesC = client.database('crcscheduling').container('sites');

const PHONE_KEYS = [
  ['phone', 'phone'],
  ['sitePhone', 'phone'],
  ['mainPhone', 'phone'],
  ['piPhone', 'piPhone'],
  ['pi_phone', 'piPhone'],
  ['siteCoordinatorPhone', 'siteCoordinatorPhone'],
  ['coordinatorPhone', 'siteCoordinatorPhone'],
  ['contractsPhone', 'contractsPhone'],
  ['contractContactPhone', 'contractsPhone'],
];

function digPhone(site, key) {
  return String(site[key] || '').trim();
}

(async () => {
  const { resources } = await sitesC.items.query('SELECT * FROM c').fetchAll();
  const rows = [];
  let applied = 0;

  for (const site of resources) {
    const a1 = String(site.address1 || '').trim();
    const a2 = String(site.address2 || '').trim();
    const addrFix = looksLikeHouseNumberOnly(a1) && a2 && !looksLikeUnitLine(a2);

    const phoneUpdates = {};
    for (const [srcKey, normKey] of PHONE_KEYS) {
      const raw = digPhone(site, srcKey);
      if (!raw) continue;
      const next = normalizePhone(raw);
      if (next && next !== raw) {
        phoneUpdates[srcKey] = next;
        // also mirror primary aliases
        if (normKey === 'phone') {
          phoneUpdates.phone = next;
          phoneUpdates.sitePhone = next;
        } else {
          phoneUpdates[normKey] = next;
        }
      }
    }
    const phoneFix = Object.keys(phoneUpdates).length > 0;
    if (!addrFix && !phoneFix) continue;

    const n = normalizeSiteFields(site);
    const afterAddr1 = addrFix ? n.address1 : a1;
    const afterAddr2 = addrFix ? n.address2 : a2;

    const row = {
      id: site.id,
      name: site.name,
      addrFix,
      phoneFix,
      before: {
        address1: a1,
        address2: a2,
        phones: Object.fromEntries(
          ['phone', 'piPhone', 'siteCoordinatorPhone', 'contractsPhone']
            .map((k) => [k, digPhone(site, k)])
            .filter(([, v]) => v)
        ),
      },
      after: {
        address1: afterAddr1,
        address2: afterAddr2,
        phones: phoneUpdates,
      },
    };
    rows.push(row);
    console.log(
      `${APPLY ? 'APPLY' : 'DRY'} ${site.name}`
      + (addrFix ? ` | a1 "${a1}" + a2 "${a2}" -> "${afterAddr1}"` : '')
      + (phoneFix ? ` | phones ${JSON.stringify(phoneUpdates)}` : '')
    );

    if (APPLY) {
      if (addrFix) {
        site.address1 = afterAddr1;
        site.address2 = afterAddr2;
        site.address = afterAddr1;
      }
      Object.assign(site, phoneUpdates);
      site.addressPhoneNormalizedAt = new Date().toISOString();
      await sitesC.items.upsert(site);
      applied += 1;
    }
  }

  const report = {
    applied: APPLY,
    changed: rows.length,
    upserted: applied,
    addrMerges: rows.filter((r) => r.addrFix).length,
    phoneNorms: rows.filter((r) => r.phoneFix).length,
    rows,
  };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(
    `changed ${rows.length} (addr ${report.addrMerges}, phone ${report.phoneNorms}) | upserted ${applied}`
  );
  console.log(`wrote ${REPORT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
