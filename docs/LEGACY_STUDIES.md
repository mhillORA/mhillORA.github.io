# Legacy Studies (ARTEMIS only)

Site–study outcomes from **Anterior Segment Overview.xlsx**, stored in the same Cosmos account as ARTEMIS (`ora-clinical-recruiting` / `crcscheduling`).

## Containers (NEW — do not touch existing ARTEMIS tables)

| Container | Partition key | Purpose |
|-----------|---------------|---------|
| `legacy-studies` | `/id` | One doc per study + rolled-up metrics + **editable** metadata (`therapeuticArea`, `indication`, `sponsor`, `phase`, `status`, `notes`) |
| `legacy-study-site-outcomes` | `/studyId` | One doc per study × site × group (scheduled / screened / enrolled / dates) |

**Never written:** `studies`, `sites`, `patients`, `crcs`, `events`, `schedules`, etc.

**Not shipped to:** CHAOS or NASA branches — this lives on the ARTEMIS Static Web App only.

## API routes

- `GET/POST/PATCH/DELETE /api/legacy-studies/{id?}`
- `GET/POST /api/legacy-study-site-outcomes?studyId=`
- `GET /api/legacy-reporting/summary`

## UI

- **Legacy Studies** — list → open study → site table + edit TA/metadata  
- **Legacy Reporting** — KPIs, charts, by-study / by-site tables, CSV export  

## Re-ingest

```powershell
pip install azure-cosmos openpyxl
python ingest/legacy_anterior_segment.py
# or
python ingest/legacy_anterior_segment.py "C:\path\to\Anterior Segment Overview.xlsx"
```

Uses `COSMOS_ENDPOINT` / `COSMOS_KEY` / `DATABASE_ID` from env, or falls back to `HoldAll\CHAOS\azure-api-fixed\local.settings.json`.  
Re-ingest **preserves** manually edited `therapeuticArea`, `sponsor`, `phase`, `status`, `notes`.
