# Legacy anterior-segment data → bd-budgets (Study Bid Workbench)

**New containers only.** Existing budget / Ora intelligence containers are never written.

## Cosmos

| | |
|--|--|
| Account | `bd-budgets` |
| Database | `bd-budgets` |
| Creds | `study_bid_workbench/.env` (`COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE`) |

## New containers

| Container | Partition key | Use |
|-----------|---------------|-----|
| `legacy_studies` | `/studyId` | Study rollups + TA/indication |
| `legacy_sites` | `/siteId` | Site rollups + relationship preference / pros / cons |
| `legacy_study_site_outcomes` | `/studyId` | Funnel rows; filterable by `siteId` |
| `legacy_site_study_outcomes` | `/siteId` | Same facts, partitioned for site-scoped queries |

Every doc includes `docType`, `dataset` (`legacy_anterior_segment`), `schemaVersion`, `studyId` and/or `siteId`, and funnel metrics (`targetScheduled`, `scheduled`, `screened`, `enrolled`).

## Load

```powershell
cd C:\Users\shue1\Projects\artemis-legacy-studies
pip install azure-cosmos openpyxl python-dotenv
python ingest/push_legacy_to_bd_budgets.py --dry-run
python ingest/push_legacy_to_bd_budgets.py
```

## Query examples (Buddy / budgets / feasibility)

**Study history**

```sql
SELECT * FROM c WHERE c.studyId = @studyId
-- container: legacy_studies or legacy_study_site_outcomes
```

**Site history (trust / feasibility)**

```sql
SELECT * FROM c WHERE c.siteId = @siteId
-- container: legacy_sites or legacy_site_study_outcomes
```

**Site enrolled across studies**

```sql
SELECT c.studyName, c.enrolled, c.screened, c.scheduled
FROM c
WHERE c.siteId = @siteId
-- container: legacy_site_study_outcomes
```

**Sites by relationship preference**

```sql
SELECT c.siteName, c.relationshipPreference, c.metrics.enrolled
FROM c
WHERE c.relationshipPreference = "prefer"
-- container: legacy_sites
```

Re-ingest preserves manually edited site relationship fields.
