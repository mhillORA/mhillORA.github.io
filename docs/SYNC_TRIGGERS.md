# Data Lens sync triggers

Lens **Sources** can start the same Buddy ingest jobs:

| Button | Calls |
|--------|--------|
| Sync Veeva | `POST {BUDDY_API_BASE}/api/veeva/sync` |
| Sync Salesforce | `POST …/api/salesforce/sync` `{ tables: true, thenCrosswalk: true }` |
| Sync CT.gov | `POST …/api/ctgov/sync` |
| NetSuite study job | Optional `NETSUITE_JOB_WEBHOOK`, else use `az containerapp job start` |

## App settings on Data Lens Function App

```text
BUDDY_API_BASE=https://ora-buddy-api-hrdbgqh9cvaub5ft.eastus2-01.azurewebsites.net
BUDDY_COPILOT_KEY=<same as Buddy COPILOT_ASK_KEY>
```

Optional: `NETSUITE_JOB_WEBHOOK` = Logic App URL that runs `az containerapp job start … netsuite-pull-job`.

## Daily schedule (recommended)

1. **Logic App / Timer** (daily ET) with header `x-copilot-key`:
   - POST Veeva sync
   - POST Salesforce tables sync
   - POST CT.gov sync
2. **netsuite-pull-job** — keep Container Apps schedule (Monday study / or daily `STUDY_ONLY=1`) with `BUDDY_API_BASE` + `BUDDY_COPILOT_KEY` so Cosmos `ora_ns_study` upserts after Excel.
