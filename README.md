# Ora Data Lens

Internal ask + charts over Ora data. Azure Static Web Apps + Functions. Cosmos database `bd-budgets`.

## Run (production UI)

```powershell
# UI
npx --yes serve . -p 4173

# API
cd api
npm install
func start
```

Copy `api/local.settings.json.example` → `local.settings.json` and set `COSMOS_*` (same account as Study Bid Workbench).

## React spike (Ask page only)

Same CSS and shell, Vite + React under `web/`. Other nav items are disabled on purpose.

```powershell
cd web
npm install
npm run dev
```

Open http://localhost:5173 — proxies `/api` to Functions on :7071 if running.

## Docs

- [Gold → Cosmos](docs/GOLD_TO_COSMOS.md)
- [RM ingest](docs/RM_TO_COSMOS.md)
- [NetSuite blob](docs/NS_BLOB_TO_COSMOS.md)
- [Salesforce](docs/SF_TO_COSMOS.md)
- [Entra](docs/ENTRA.md)
