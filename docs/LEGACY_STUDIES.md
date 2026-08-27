# Legacy Studies (ARTEMIS only)

Site–study outcomes from **Anterior Segment Overview.xlsx**, **Dry Eye Overview.xlsx** (Complete tabs), and **Completed Studies from Old ASO.xlsx** (Enrollment Done tabs), stored in the same Cosmos account as ARTEMIS (`ora-clinical-recruiting` / `crcscheduling`).

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

## Budget Buddy export

```powershell
python ingest/export_feasibility_for_budget_buddy.py --slim-answers
python ingest/push_feasibility_to_bd_budgets.py
```

See [`BUDGET_BUDDY_FEASIBILITY_INGEST.md`](./BUDGET_BUDDY_FEASIBILITY_INGEST.md). Pack lands in `exports/budget_buddy_feasibility_pack.json`.

## UI

- **Legacy Sites** — Overview / **Surveys** (same accordion as live Sites) / **Site profile**; filter by indication/TA
- **Feasibility Surveys** — list survey definitions → open one → site responses accordion (by survey, not by site)
- **Comms** — **Predefined surveys** library (`isPredefined` / `library: feasibility`) with Clone + Send; custom surveys separate; Send Survey dropdown groups predefined vs custom
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

# Dry Eye Overview — **Complete tabs only** (e.g. Aerie-Complete). Rebuilds dry-eye outcomes from those sheets.
# Prefer feasibility sites so surveys line up. Never overwrites existing anterior metrics/edits.
python ingest/legacy_dry_eye_overview.py --dry-run
python ingest/legacy_dry_eye_overview.py --apply
python ingest/legacy_dry_eye_overview.py --relink --apply

# Old ASO completed studies — **Enrollment Done** tabs only (PI = site label). Separate source from Dry Eye.
python ingest/legacy_old_aso_completed.py --dry-run
python ingest/legacy_old_aso_completed.py --apply

# Retarget dry-eye / old-aso outcomes onto feasibility/anterior legacy-sites (PI aliases)
python ingest/relink_legacy_outcomes.py --dry-run
python ingest/relink_legacy_outcomes.py --apply
```

Uses `COSMOS_ENDPOINT` / `COSMOS_KEY` / `DATABASE_ID` from env, or falls back to `data-api-connections.json` / `local.settings.json`.  
Re-ingest **preserves** manually edited study `name`, `title`, `oraProjectNumber`, `sponsor`, `phase`, `status`, `notes`, and site `name`, `siteCode`, `relationshipPreference`, `advantages`, `disadvantages`, `relationshipNotes`, `notes`. **`therapeuticArea` is kept in sync with `indication`** (TA = Indication). Dry Eye ingest reuses existing study/site ids when matched and does not overwrite anterior funnel numbers on colliding outcomes.
