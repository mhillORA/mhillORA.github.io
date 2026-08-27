# Budget Buddy — Feasibility master ingest

Package of **ARTEMIS feasibility** data (site profiles, survey defs/responses, legacy sites) for Study Bid Workbench / Budget Buddy.

**Source:** Cosmos `ora-clinical-recruiting` / `crcscheduling` (ARTEMIS-only).  
**Target:** Cosmos `bd-budgets` / `bd-budgets` — **new containers only** (never overwrite budget / Ora intelligence tables).

`siteId` values are **legacy-site ids** (same keys as ARTEMIS `legacy-sites` / `site-profiles`). They are **not** Chaos shared `sites` ids.

**TA = Indication** in this dataset.

---

## What’s in the pack

File (generated):

```text
exports/budget_buddy_feasibility_pack.json
```

| Section | Contents |
|---------|----------|
| `sites` | Legacy site rollups: name, PI, address, relationship preference / pros / cons, `indicationsCovered`, funnel `metrics` when present |
| `profiles` | Site Profile Master docs (stable profile layer + nested `indication` map + `study_responses` blobs) |
| `surveyDefinitions` | One doc per feasibility survey (title, indication/TA, questions, response/site counts) |
| `surveyResponses` | Per-site answers (`answers[]` with `questionId` / `label` / `value`) |
| `indicationIndex` | Rollup by indication/TA → siteIds, surveyIds, counts |

Field definitions: [`Site_Profile_Field_List.md`](./Site_Profile_Field_List.md) and `ingest/Site_Profile_Field_Schema.json`.

---

## Generate the file (from ARTEMIS DB)

```powershell
cd C:\Users\shue1\Projects\artemis-legacy-studies
pip install azure-cosmos python-dotenv
python ingest/export_feasibility_for_budget_buddy.py --slim-answers
```

Options:

| Flag | Effect |
|------|--------|
| `--slim-answers` | Drop empty/skipped answers (recommended for Buddy) |
| `--split-responses` | Put responses in sibling `.responses.ndjson` if the JSON is too large |
| `--out path.json` | Custom output path |

Creds: `data-api-connections.json` or `COSMOS_KEY` / `COSMOS_ENDPOINT` (ARTEMIS account).

---

## Push into bd-budgets (Budget Buddy Cosmos)

```powershell
python ingest/push_feasibility_to_bd_budgets.py --dry-run
python ingest/push_feasibility_to_bd_budgets.py
```

Creds: `study_bid_workbench/.env` → `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE` (`bd-budgets`).

### New containers (created if missing)

| Container | Partition key | Use |
|-----------|---------------|-----|
| `feasibility_sites` | `/siteId` | Site rollup + relationship + indications |
| `feasibility_site_profiles` | `/siteId` | Full site profile master |
| `feasibility_survey_definitions` | `/id` | Survey defs (+ pack meta doc `feasibility_pack_meta`) |
| `feasibility_survey_responses` | `/siteId` | Answers; filter by `surveyId` / `indication` |

Also related (already used by Buddy for anterior-segment funnel history):

| Container | Notes |
|-----------|--------|
| `legacy_sites` / `legacy_studies` / `legacy_*_outcomes` | From `push_legacy_to_bd_budgets.py` — enrollment history, not survey answers |

---

## Buddy query patterns

**Sites for an indication (TA)**

```sql
SELECT c.siteId, c.siteName, c.relationshipPreference, c.indicationsCovered
FROM c
WHERE ARRAY_CONTAINS(c.indicationsCovered, @indication)
-- container: feasibility_sites
```

**Site profile (equipment, IRB, staffing, indication layer)**

```sql
SELECT * FROM c WHERE c.siteId = @siteId
-- container: feasibility_site_profiles
```

**All responses for a survey**

```sql
SELECT c.siteId, c.displayName, c.indication, c.answers, c.submittedAt
FROM c
WHERE c.surveyId = @surveyId
-- container: feasibility_survey_responses
```

**Responses for a site across surveys**

```sql
SELECT c.surveyId, c.indication, c.answerCount, c.submittedAt
FROM c
WHERE c.siteId = @siteId
-- container: feasibility_survey_responses
```

**List surveys (by indication)**

```sql
SELECT c.id, c.title, c.indication, c.responseCount, c.siteCount
FROM c
WHERE c.docType = "feasibilitySurveyDefinition"
-- optional: AND c.indication = @indication
-- container: feasibility_survey_definitions
```

---

## Doc shape (Buddy context)

Prefer attaching a **trimmed** pack slice rather than the full export:

```json
{
  "source": "artemis_feasibility_master",
  "indication": "Dry Eye",
  "sites": [{ "siteId": "…", "siteName": "…", "relationshipPreference": "prefer" }],
  "profiles": [{ "siteId": "…", "institution_name": "…", "indication": { "Dry Eye": { } } }],
  "surveys": [{ "id": "…", "title": "…", "indication": "Dry Eye" }],
  "responses": [{ "siteId": "…", "surveyId": "…", "answers": [/* non-empty only */] }]
}
```

Rules for Buddy:

1. Treat `siteId` as the join key across `feasibility_*` and (when present) `legacy_*` containers.
2. Prefer `feasibility_site_profiles` for capabilities / IRB / staffing; use survey `answers` for study-specific estimates.
3. Do **not** invent Chaos/`sites` links unless `linkedArtemisSiteId` is set.
4. Indication filter: match `indicationsCovered`, response `indication`, or definition `indication` (TA = Indication).
5. Relationship fields (`relationshipPreference`, `advantages`, `disadvantages`) are ops judgment — surface them on site feasibility reads.

---

## Re-export / re-push

```powershell
python ingest/export_feasibility_for_budget_buddy.py --slim-answers
python ingest/push_feasibility_to_bd_budgets.py
```

Upserts by id. Safe to re-run. Does **not** touch existing budget study/version/line-item containers.

---

## Related

- Anterior-segment funnel → bd-budgets: [`LEGACY_TO_BD_BUDGETS.md`](./LEGACY_TO_BD_BUDGETS.md)
- ARTEMIS feasibility UI / containers: [`LEGACY_STUDIES.md`](./LEGACY_STUDIES.md)
