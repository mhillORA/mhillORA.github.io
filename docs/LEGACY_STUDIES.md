# Legacy Studies (ARTEMIS only)

Site–study outcomes from **Anterior Segment Overview.xlsx**, stored in the same Cosmos account as ARTEMIS (`ora-clinical-recruiting` / `crcscheduling`).

## Containers (NEW — do not touch existing ARTEMIS tables)

| Container | Partition key | Purpose |
|-----------|---------------|---------|
| `legacy-studies` | `/id` | One doc per study + rolled-up metrics + **editable** metadata (`name`, `oraProjectNumber`, `therapeuticArea`, `indication`, `sponsor`, `phase`, `status`, `notes`). **TA = Indication** in this workbook. |
| `legacy-sites` | `/id` | One doc per unique site, funnel metrics + optional `linkedArtemisSiteId` + relationship fields + **feasibility** `indicationsCovered` / `therapeuticAreas` |
| `legacy-study-site-outcomes` | `/studyId` | One doc per study × site × group (scheduled / screened / enrolled / dates); includes `siteId` |
| `site-profiles` | `/id` | Feasibility site profile master (keyed by **legacy site id**). ARTEMIS-only; for Budget Buddy later. |
| `site-survey-*` | `/id` | Feasibility survey defs/assignments/responses; **`siteId` = legacy site id** so Chaos shared `sites` is untouched |

**Never written:** live `sites`, `studies`, `patients`, `crcs`, `events`, `schedules`, etc.

**Not shipped to:** CHAOS or NASA branches — this lives on the ARTEMIS Static Web App only.

## Feasibility master ingest

```powershell
python ingest/feasibility_master_ingest.py
python ingest/feasibility_master_ingest.py --apply
```

Source: `Ora_Feasibility_Data_All_Sites.json` (SurveyMonkey + Monday tabs). Matches existing ARTEMIS/legacy sites by email/name/PI/address, then upserts **legacy-sites only**. Indication/TA is stored on survey defs, responses, profiles, and `legacy-sites.indicationsCovered`.

## UI

- **Legacy Sites** — Overview / **Surveys** (same accordion as live Sites) / **Site profile**; filter by indication/TA
- **Feasibility Surveys** — list survey definitions → open one → site responses accordion (by survey, not by site)
- **Legacy Reporting** — funnel KPIs + **Feasibility by indication/TA** table + indication filter
- **Legacy Studies** — list → open study → site table + edit metadata; sort A→Z / Z→A / enrolled
- **Dashboard** — live ops charts + legacy overview panel at bottom

## API routes

- `GET/POST/PATCH/DELETE /api/legacy-studies/{id?}`
- `GET/POST/PATCH/DELETE /api/legacy-sites/{id?}`
- `GET/POST /api/legacy-study-site-outcomes?studyId=`
- `GET /api/legacy-reporting/summary`
- `GET /api/site-profiles/{id?}` (optional `?indication=`)

## Re-ingest

```powershell
pip install azure-cosmos openpyxl
python ingest/legacy_anterior_segment.py
# or
python ingest/legacy_anterior_segment.py "C:\path\to\Anterior Segment Overview.xlsx"
```

Uses `COSMOS_ENDPOINT` / `COSMOS_KEY` / `DATABASE_ID` from env, or falls back to `HoldAll\CHAOS\azure-api-fixed\local.settings.json`.  
Re-ingest **preserves** manually edited study `name`, `title`, `oraProjectNumber`, `sponsor`, `phase`, `status`, `notes`, and site `name`, `siteCode`, `relationshipPreference`, `advantages`, `disadvantages`, `relationshipNotes`, `notes`. **`therapeuticArea` is kept in sync with `indication`** (TA = Indication).
