# Ora Data Lens

Internal ask + charts over Ora data. Azure Static Web Apps + Functions. Cosmos database `bd-budgets`.

## Run

```powershell
# UI
npx --yes serve . -p 4173

# API
cd api
npm install
func start
```

Copy `api/local.settings.json.example` → `local.settings.json` and set `COSMOS_*` (same account as Study Bid Workbench).

## Docs

- [Gold → Cosmos](docs/GOLD_TO_COSMOS.md)
- [RM ingest](docs/RM_TO_COSMOS.md)
- [NetSuite blob](docs/NS_BLOB_TO_COSMOS.md)
- [Salesforce](docs/SF_TO_COSMOS.md)
- [Entra](docs/ENTRA.md)
