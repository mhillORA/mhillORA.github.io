# Project number join (YY-DEPT-SEQ)

Ora NetSuite study numbers look like **`25-150-0005`**:

| Part | Example | Meaning |
|------|---------|---------|
| YY | `25` | Study year (2025) |
| DEPT | `150` | Department code |
| SEQ | `0005` | Nth study that year (sequence) |

## Join

- NetSuite / Cosmos study intel: `ora_ns_study.project_number`
- Veeva live: `ora_veeva_study.study_number`
- Sites / PIs: `ora_veeva_site` (match study_number or `ora_project_code__c`; PI = `principal_investigator__v`)
- Exact / prefix / token match — no mapping table
- GM feed `lens_ns_projects` uses the same project number family (job grain; US/AU can share a number)

### Investigator fees

| Field | Grain | Source |
|-------|-------|--------|
| `inv_fee_budget` / `ptc_budget` | Study rollup | NetSuite → `ora_ns_study` |
| `principal_investigator__v` | Site PI name | Veeva → `ora_veeva_site` |
| Per-PI fee lines | **Not in Cosmos yet** | Needs SuiteQL line items or Vault fee object |

Ask: `Full dossier for 25-150-0005` · `Short answer for …` · `Investigators on …`

## Data Lens Data Sync Status

Sources → **Data sync status** calls `GET /api/sync-status` (read-only).

Reports Cosmos counts + `syncState` watermarks, including:

- `ora_ns_study` / `ora_ns_task` (sync id `netsuite_study_intel`)
- `lens_ns_projects` (GM)
- Veeva / SF / CT.gov / TrialHub / InsightsRM

Study intel is **written** by Buddy `POST /api/netsuite/study-sync` (from netsuite-pull-job after SuiteQL + Excel). Data Lens only **reads** status.
