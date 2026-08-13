# Gold layer → Cosmos (shared `bd-budgets`)

Ora Data Lens uses the **same Cosmos account and database** as Study Bid Workbench.

| Setting | Value |
|---------|--------|
| Account | `bd-budgets.documents.azure.com` |
| Database | `bd-budgets` |
| Env vars | `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE` (copy from the bid-workbench SWA App Settings) |

## Do not collide

Bid Workbench already owns these containers. Data Lens **reads** some of them and **never writes** them.

| Container | Owner | Data Lens |
|-----------|--------|-----------|
| `studies`, `versions`, `lineItems`, `sections`, `quarantine` | Bid budgets | read-only if needed |
| `ora_fact_study`, `ora_fact_site`, `ora_trialhub_trials`, `ora_ctgov_trials`, `ora_sponsor_crosswalk` | Intelligence pack | **read now for Ask today |
| `syncState`, `parseLearnings` | Bid / CT.gov jobs | leave alone |

Gold-layer snapshots land in **new** containers:

| Container | Partition key | Grain |
|-----------|---------------|--------|
| `lens_studies` | `/studyCode` | 1 doc / study |
| `lens_visits` | `/studyCode` | 1 doc / visit instance |
| `lens_metrics` | `/metricType` | 1 doc / chart metric grain |
| `lens_sources` | `/sourceId` | 1 doc / source catalog row |
| `lens_syncRuns` | `/runDate` | 1 doc / daily run |

`api/src/cosmos.js` refuses upserts to anything except `lens_*`.

## Why not query the warehouse from the browser?

The static app has no secrets. Daily job (or `/api/gold/sync`) pulls **narrow, named marts** from gold and upserts documents. Ask reads Cosmos. Same pattern as the CT.gov weekday sync on the bid workbench.

## Normalize in gold (not in the LLM)

Create views (or dbt models) whose columns match `api/src/goldQueries.js`:

- `lens.v_studies`
- `lens.v_study_visits`
- `lens.v_chart_metrics`
- `lens.v_source_catalog`

Rules:

1. **Business names** — `study_code`, `visit_status`, not source-system junk.
2. **Stable grain** — one visit occurrence = one Cosmos doc. `id` = natural key (`study_code`, `visit_id`).
3. **Pre-join** what people ask together (study name, indication, site on the visit row).
4. **Codes + labels** on the same row (`visit_status` = `Completed`, not `7`).
5. **Keep docs small** — no 2MB dumps. Cosmos practical limit is well under that; bid workbench already hit this on sheet harvest.

SQL stubs: `ingest/sql/lens_views.sql`.

## Daily schedule

Timer in `api/src/index.js`: `0 0 11 * * *` (11:00 UTC ≈ 7:00 ET).

Also callable like CT.gov:

```http
POST /api/gold/sync
Header: x-sync-key: <GOLD_SYNC_KEY>
```

GitHub Actions (optional ping, no Cosmos secrets in GitHub — same as bid workbench):

`.github/workflows/gold-daily-sync.yml`

## Job steps

1. Ensure `lens_*` containers exist (`createIfNotExists` only those ids).
2. `SELECT` each gold view (read-only SQL user).
3. Map row → document (`docType`, `syncedAt`, partition field).
4. Upsert by `id` (idempotent daily reload).
5. Write `lens_syncRuns` with counts.

Deletes: if gold drops a study, either tombstone (`active: false`) or run a reconcile that deletes Cosmos ids missing from gold. Start with upsert-only.

## App settings on the Data Lens SWA

Copy from Study Bid Workbench:

- `COSMOS_ENDPOINT`
- `COSMOS_KEY`
- `COSMOS_DATABASE=bd-budgets`

Add:

- `SQL_SERVER`, `SQL_DATABASE`, `SQL_USER`, `SQL_PASSWORD` (gold read)
- `GOLD_SYNC_KEY` (HTTP trigger)

Networking: same Cosmos firewall as the bid-workbench API (allow Azure datacenters).

## What Ask uses on day one

Before gold views exist, `/api/ask` already reads:

- `ora_fact_study` — enrollment-style questions
- `ora_trialhub_trials` + `ora_ctgov_trials` — competitive / registry
- `lens_visits` / `lens_studies` — after the first gold sync

If Cosmos is unreachable, the static UI falls back to the canned mock.
