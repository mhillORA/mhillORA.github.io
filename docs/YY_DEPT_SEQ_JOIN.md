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
- Exact string match — no mapping table
- GM feed `lens_ns_projects` uses the same project number family (job grain; US/AU can share a number)

## Data Lens Data Sync Status

Sources → **Data sync status** calls `GET /api/sync-status` (read-only).

Reports Cosmos counts + `syncState` watermarks, including:

- `ora_ns_study` / `ora_ns_task` (sync id `netsuite_study_intel`)
- `lens_ns_projects` (GM)
- Veeva / SF / CT.gov / TrialHub / InsightsRM

Study intel is **written** by Buddy `POST /api/netsuite/study-sync` (from netsuite-pull-job after SuiteQL + Excel). Data Lens only **reads** status.
