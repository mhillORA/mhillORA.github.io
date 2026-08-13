# Project Profitability blob → Cosmos (easiest path)

Data Lens does **not** read the blob. This writer does. Run it **in Azure** as the last step of `netsuite-pull-job` (same place that already writes `landing/`).

```
netsuite/landing/yyyy/MM/dd/HHmm/netsuite_project_profitability*.csv
        → Cosmos bd-budgets / lens_ns_projects
```

Full rewrite each run: upsert every CSV row, delete Cosmos docs that dropped off the file.

## On the work PC / pull job

1. Copy the `ingest` folder from this repo next to the pull job (or clone this branch there).
2. `cd ingest && npm install`
3. After the job finishes writing `landing/…`, run:

```bash
node nsBlobToCosmos.js
```

4. Set these on **that job** (not on the Data Lens SWA):

| Name | Value |
|------|--------|
| `AZURE_STORAGE_CONNECTION_STRING` | same string the pull job already uses **or** |
| `BLOB_ACCOUNT_NAME` | storage account name, if you use managed identity instead |
| `BLOB_CONTAINER` | `netsuite` |
| `COSMOS_ENDPOINT` | `https://bd-budgets.documents.azure.com:443/` |
| `COSMOS_KEY` | **writer** key (or a restricted key). Do not put this on the website if you can avoid it |
| `COSMOS_DATABASE` | `bd-budgets` |

5. First run creates container `lens_ns_projects` (partition `/project_number`) if missing.

`id` = `project_number` + `__` + slug of `project_name` so US/AU rows do not overwrite each other.

Empty GM / cost cells stay `null`. Not `0`.

## Do not

- Add blob settings to the Data Lens SWA
- Run this from your IP-locked laptop against Cosmos
- Write `studies` or `ora_*`

## After a successful log line

`upserted: 83` (or whatever the CSV row count is). Then we point Ask at `lens_ns_projects`.
