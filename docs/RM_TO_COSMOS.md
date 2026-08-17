# Dummy steps: InsightsRM xlsx → Cosmos, 100% in Azure

This is **not** NetSuite.

The workbook is a **real** Ora resource-management extract (assignments, timesheet actuals, projections, headcount). Put the whole production domain in Cosmos (`lens_rm_*`) so Ask can query it. Gold / the data warehouse later is only a different writer into those same containers — not a reason to skip the database.

Do **not** use Function App `ora-lens-ns-ingest`.
Do **not** use blob container `netsuite`.
Do **not** use setting `NETSUITE_STORAGE`.
Do **not** write `lens_ns_projects`.

A **new Function App** watches container **`insightsrm`**. Drop any of:

- `landing/yyyy/MM/dd/HHmm/*.xlsx` (star schema workbook)
- `landing/yyyy/MM/dd/HHmm/*.zip` (Staffing-By-* grids and/or RM-employees / RM-assignments / RM-Sch_*.csv)
- those CSVs loose in the same landing path

the function writes Cosmos `bd-budgets` / `lens_rm_*`. Domain **200** only from the workbook. Calendar sheet `Dim_Date` is skipped. WorkItem-Role.csv is a duplicate of WorkItem-Activity — only one is loaded. Assignment `Value` is percent (11 → 0.11 FTE).

Ask in Data Lens uses purpose **RM**. Finance stays on NetSuite.

When DW/gold is ready, swap this Function for that writer. Keep the same `lens_rm_*` containers so Ask does not change.

---

## What lands in Cosmos

| Workbook | Cosmos container | Partition |
|----------|------------------|-----------|
| Dim_Study | `lens_rm_studies` | `/studyKey` |
| Dim_Role | `lens_rm_roles` | `/roleId` |
| Dim_Employee | `lens_rm_employees` | `/employeeKey` |
| Dim_Activity | `lens_rm_activities` | `/activityId` |
| Dim_Department | `lens_rm_departments` | `/departmentId` |
| Dim_Organization | `lens_rm_organizations` | `/organizationId` |
| Dim_Domain | `lens_rm_domains` | `/domainId` |
| Dim_User | `lens_rm_users` | `/userId` |
| Fact_Actuals | `lens_rm_actuals` | `/studyKey` |
| Fact_Assignments | `lens_rm_assignments` | `/studyKey` |
| Fact_Projections | `lens_rm_projections` | `/studyKey` |
| Fact_Headcount | `lens_rm_headcount` | `/roleId` |
| RM-Staffing-By-Employee.csv | `lens_rm_staffing_employee` | `/nameKey` |
| RM-Staffing-By-WorkItem-*.csv | `lens_rm_staffing_workitem` | `/studyKey` |
| RM-employees.csv | `lens_rm_roster` | `/employeeNumber` |
| RM-assignments.csv | `lens_rm_export_assignments` | `/studyKey` |
| RM-Sch_*.csv | `lens_rm_schedule` | `/studyKey` |
| (ingest log) | `lens_rm_runs` | `/runDate` |

Same Cosmos account/database as everything else (`bd-budgets`). Different containers from NetSuite.

---

## A. Portal — blob container (once)

1. Open the storage account you want (the NetSuite account is fine **if** you add a **new** container).
2. **Containers** → **+ Container**.
3. Name: **`insightsrm`** (exact, lowercase).
4. Public access: **Private**.
5. Create.

Do **not** upload into `netsuite`.

---

## B. Portal — create the Function App (once)

1. [portal.azure.com](https://portal.azure.com)
2. Search **Function App** → **Create**.
3. Fill:

| Field | What to pick |
|--------|----------------|
| Resource group | Same group as the storage account with `insightsrm` |
| Function App name | `ora-lens-rm-ingest` (must be globally unique; add your initials if taken) |
| Publish | **Code** |
| Runtime stack | **Node.js** |
| Version | **22 LTS** |
| Region | Same region as that storage account |
| Operating system | **Linux** |
| Hosting plan | **Consumption (Serverless)** or Flex if that is already how NS ingest is hosted |

4. Storage for the **function host** can be a small new account. It does **not** have to be the InsightsRM account.
5. Review + create → Create. Wait until **Go to resource**.

This is a second Function App. Leave `ora-lens-ns-ingest` alone.

---

## C. Portal — application settings (once)

Open **ora-lens-rm-ingest** → **Settings** → **Environment variables**.

**+ Add** these. Save / Apply when all are in.

| Name | Value |
|------|--------|
| `INSIGHTSRM_STORAGE` | Connection string of the storage account that **has container `insightsrm`**. Storage account → Access keys → key1 → Connection string. **Storage**, not Cosmos. |
| `COSMOS_ENDPOINT` | Cosmos `bd-budgets` → Keys → **URI** |
| `COSMOS_KEY` | Cosmos `bd-budgets` → Keys → **PRIMARY KEY** |
| `COSMOS_DATABASE` | `bd-budgets` |
| `TZ` | `America/New_York` |

Do **not** put these on the Data Lens Static Web App.
Do **not** copy `NETSUITE_STORAGE` onto this app and rename nothing — the name must be `INSIGHTSRM_STORAGE`.

`AzureWebJobsStorage` and `FUNCTIONS_WORKER_RUNTIME` are already there. Leave them.

If a previous deploy failed, delete `SCM_DO_BUILD_DURING_DEPLOYMENT` and `ENABLE_ORYX_BUILD` if they exist.

---

## D. Portal — let Cosmos accept this function

1. Cosmos **bd-budgets** → **Networking**.
2. If you use a firewall: enable **Accept connections from within public Azure datacenters** (or add this Function App’s outbound IPs).
3. Save.

The Cursor laptop can stay blocked.

---

## E. Cloud Shell — deploy the code (bash)

1. Portal → **Cloud Shell** (top bar, `>_`). Choose **Bash**.
2. Paste this **whole block**. Flex / 512 MB does **not** support `SCM_DO_BUILD_DURING_DEPLOYMENT`. Zip includes `node_modules`.

```bash
set -euo pipefail
FUNC=ora-lens-rm-ingest
# If create-name was taken, put the real Function App name here:
# FUNC=ora-lens-rm-ingest-YOURINITIALS

echo "Looking up resource group for $FUNC ..."
RG=$(az functionapp list --query "[?name=='$FUNC'].resourceGroup | [0]" -o tsv)
if [ -z "$RG" ]; then
  echo "Function App $FUNC not found. Fix FUNC= to the name from the portal."
  exit 1
fi
echo "RG=$RG"

az functionapp config appsettings delete -g "$RG" -n "$FUNC" --setting-names SCM_DO_BUILD_DURING_DEPLOYMENT ENABLE_ORYX_BUILD || true

cd $HOME
rm -rf mhillORA.github.io
git clone --branch ora-data-lens --single-branch https://github.com/mhillORA/mhillORA.github.io.git
cd mhillORA.github.io/ingest/rm-azure-func
npm install --omit=dev

rm -f /tmp/rm-ingest.zip
zip -r /tmp/rm-ingest.zip . -x "*.git*" -x "local.settings.json" -x "*.xlsx"
az functionapp deployment source config-zip \
  -g "$RG" \
  -n "$FUNC" \
  --src /tmp/rm-ingest.zip

echo "Deployed. Next insightsrm landing *.xlsx will load lens_rm_*."
```

Wait until it prints `Deployed`.

---

## F. Upload the files (once, then whenever RM refreshes)

Storage Explorer or portal → container **`insightsrm`**. Create folders, then upload. Use today’s date and a 4-digit time (example `1730`).

**Workbook** (star schema):

```text
landing/2026/08/17/1730/Ora_Resource_Model_1.xlsx
```

**Staffing grids zip** (`RM-Staffing-By-Employee.csv` + work-item CSVs):

```text
landing/2026/08/17/1731/drive-download-staffing.zip
```

**Roster / assignments / schedule zip** (`RM-employees.csv`, `RM-assignments.csv`, `RM-Sch_4Aug2026.csv`):

```text
landing/2026/08/17/1732/drive-download-roster.zip
```

You can upload the CSVs loose in the same `landing/yyyy/MM/dd/HHmm/` shape instead of zips. Do **not** put them in container `netsuite`.

The blob trigger fires on create. First workbook load is ~20k docs and can take a few minutes. Cosmos containers (`lens_rm_*`) are created automatically on that run — do not add them in Data Explorer first.

Timer also runs **6:35 AM Eastern** daily and loads the latest landing files of each kind.

To kick without waiting: Function App → **Functions** → `rmLoadNow` → Test (POST), or:

```text
POST /api/rm/load
```

with the function key. That loads the latest xlsx **and** the latest RM csv/zip of each kind.

---

## G. Prove it

Cosmos Data Explorer → database `bd-budgets`:

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_rm_study"
```

in `lens_rm_studies` — about **107** is success.

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_rm_actual"
```

in `lens_rm_actuals` — about **13682**.

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_rm_roster"
```

in `lens_rm_roster` — about **470**.

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_rm_export_assignment"
```

in `lens_rm_export_assignments` — about **1300**.

```sql
SELECT * FROM c WHERE c.docType = "lens_rm_run" ORDER BY c.finishedAt DESC
```

in `lens_rm_runs` — one ok row with `source = "insightsrm"` and the blob path.

Then Data Lens → purpose **RM** → “Who is over-allocated?”

---

## If it fails

| Symptom | Fix |
|---------|-----|
| Function never runs | `INSIGHTSRM_STORAGE` is Cosmos or the NetSuite connection string. Must be **storage** for the account that has container **`insightsrm`**. |
| `No landing/...xlsx` | File is in `netsuite` or the path is not `landing/yyyy/MM/dd/HHmm/*.xlsx`. |
| 403 Cosmos | Networking: allow Azure datacenters. |
| 401 Cosmos | `COSMOS_KEY` wrong or truncated. |
| `ora-lens-rm-ingest` name taken | Create with a suffix; set `FUNC=` in the bash block. |
| Ask still talks NetSuite | You asked a GM question, or purpose is Finance. Switch to **RM**. |

---

## Do not

- Add blob settings to Data Lens SWA
- Run this on the work PC
- Deploy this zip onto `ora-lens-ns-ingest`
- Write `lens_ns_projects`, `studies`, or `ora_*`
- Mix the workbook into the NetSuite landing folder
