# Ora Data Lens

Ask the warehouse. Get tables and charts on a static page. Same hosting pattern as NASA and Study Bid Workbench: **Azure Static Web Apps** + Functions API.

## Feasibility

The boss mock is a **product demo**, not a live query engine. Recreating the UI is straightforward. Making every question true is the hard part.

| Piece | Verdict |
|-------|---------|
| Static UI (Ask, sources, charts, trace) | Yes — this repo |
| Host on Azure SWA + Entra | Yes — same as bid workbench |
| Same Cosmos (`bd-budgets`) | Yes — **new `lens_*` containers**, read existing `ora_*` |
| Daily gold → Cosmos | Yes — timer + `/api/gold/sync` |
| Open-ended NLQ over the whole warehouse | Not v1 — constrain to marts + canned recipes |

## Same Cosmos as Study Bid Workbench

```
Account:  bd-budgets.documents.azure.com
Database: bd-budgets
```

Copy `COSMOS_ENDPOINT` / `COSMOS_KEY` / `COSMOS_DATABASE` from the bid-workbench SWA.

**This app only reads Cosmos.** No create / upsert / delete from the SWA. Gold ETL is a separate writer later. Do not give the website the account primary key if you can avoid it — prefer Cosmos **Data Reader** on the SWA identity. The bid-workbench primary key is full access; using it still means the *app* will not write, but the key itself could.

Ask already reads `ora_fact_study`, `ora_trialhub_trials`, and `ora_ctgov_trials` so you can demo against data that is already in the account.

Details: [docs/GOLD_TO_COSMOS.md](docs/GOLD_TO_COSMOS.md).

## Local UI (no Azure)

```powershell
cd C:\Users\shue1\OneDrive\Desktop\ora_data_lens
npx --yes serve . -p 4173
```

Open http://localhost:4173 — canned answers from the mock. `/api/ask` is skipped until Functions + Cosmos are wired.

## API

```powershell
cd api
copy local.settings.json.example local.settings.json
# paste COSMOS_* from bid workbench
npm install
func start
```
