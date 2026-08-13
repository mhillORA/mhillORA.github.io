# Dummy steps: blob → Cosmos, 100% in Azure

Nothing runs on the work PC. Nothing on the Data Lens website.

A **separate Function App** watches container `netsuite`. When `netsuite-pull-job` drops a new

`landing/yyyy/MM/dd/HHmm/*project_profitability*.csv`

the function overwrites Cosmos `bd-budgets` / `lens_ns_projects`. Other JSON/CSV in that folder are ignored.

---

## A. Portal — create the Function App (once)

1. [portal.azure.com](https://portal.azure.com)
2. Search **Function App** → **Create**.
3. Fill:

| Field | What to pick |
|--------|----------------|
| Resource group | **Same group as the `netsuite` storage account** |
| Function App name | `ora-lens-ns-ingest` (must be globally unique; add your initials if taken) |
| Publish | **Code** |
| Runtime stack | **Node.js** |
| Version | **22 LTS** (not 20 — Node 20 EOL was 30 Apr 2026) |
| Region | Same region as the `netsuite` storage account |
| Operating system | **Linux** |
| Hosting plan | **Consumption (Serverless)** |

Node 22 is the last Node version on Linux Consumption (Azure support through Apr 2027). Node 24 needs **Flex Consumption** — skip that unless you already use Flex.

4. On **Storage**: it will create or pick a storage account for the **function host**. That can be a new small account. It does **not** have to be the netsuite account.
5. Review + create → Create. Wait until **Go to resource**.

If you already created it on Node 20: Function App → **Settings** → **Configuration** → **General settings** → Stack version → **Node.js 22** → Save. Then continue from B.

---

## B. Portal — application settings (once)

Open the Function App → left **Settings** → **Environment variables** (or Configuration).

**+ Add** these. Save / Apply when all are in.

| Name | Value |
|------|--------|
| `NETSUITE_STORAGE` | Connection string of the storage account that **has container `netsuite`**. Storage account → Access keys → key1 → Connection string. Same string the pull job already uses. |
| `COSMOS_ENDPOINT` | Cosmos `bd-budgets` → Keys → **URI** (`https://bd-budgets.documents.azure.com:443/`) |
| `COSMOS_KEY` | Cosmos `bd-budgets` → Keys → **PRIMARY KEY** |
| `COSMOS_DATABASE` | `bd-budgets` |

Do **not** put these on the Data Lens Static Web App. Do not paste them in chat.

`AzureWebJobsStorage` and `FUNCTIONS_WORKER_RUNTIME` are already there. Leave them.

---

## C. Portal — let Cosmos accept this function

1. Cosmos **bd-budgets** → **Networking**.
2. If you use a firewall: enable **Accept connections from within public Azure datacenters** (or add the Function App’s outbound IPs).
3. Save.

The Cursor laptop can stay blocked. The Function App is inside Azure.

---

## D. Cloud Shell — deploy the code (bash)

1. Portal → **Cloud Shell** (top bar, `>_`). Choose **Bash**.
2. First time it asks for a shell storage account. OK.
3. Paste this **whole block**. Change `RG` if your resource group name is not obvious — it must be the group from step A.

```bash
set -euo pipefail
FUNC=ora-lens-ns-ingest
# If create-name was taken, put the real Function App name here:
# FUNC=ora-lens-ns-ingest-YOURINITIALS

echo "Looking up resource group for $FUNC ..."
RG=$(az functionapp list --query "[?name=='$FUNC'].resourceGroup | [0]" -o tsv)
if [ -z "$RG" ]; then
  echo "Function App $FUNC not found. Fix FUNC= to the name from the portal."
  exit 1
fi
echo "RG=$RG"

cd $HOME
rm -rf mhillORA.github.io
git clone --branch ora-data-lens --single-branch https://github.com/mhillORA/mhillORA.github.io.git
cd mhillORA.github.io/ingest/azure-func

az functionapp config appsettings set -g "$RG" -n "$FUNC" --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true

zip -r /tmp/ns-ingest.zip . -x "*.git*" -x "local.settings.json"
az functionapp deployment source config-zip \
  -g "$RG" \
  -n "$FUNC" \
  --src /tmp/ns-ingest.zip \
  --build-remote true

echo "Deployed. Next landing *project_profitability*.csv will load Cosmos."
```

Wait until it prints `Deployed`.

---

## E. Prove it

**Option 1 — wait for the next pull** (3–4x/day). Then:

Function App → **Log stream** (or Monitor → Invocations). You want a line like `{"upserted":83,"deleted":0,...}`.

**Option 2 — kick it now  
Storage Explorer: copy today’s profitability CSV to a **new** folder  
`landing/2026/08/13/9999/netsuite_project_profitability.csv`  
(use today’s date, a fake time). That create event fires the function.

Then Cosmos Data Explorer → database `bd-budgets` → container `lens_ns_projects`:

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_ns_project"
```

~83 is success.

---

## If it fails

| Symptom | Fix |
|---------|-----|
| Function never runs | `NETSUITE_STORAGE` is the wrong storage account (not the one with container `netsuite`). Name must be exactly `NETSUITE_STORAGE`. |
| Runs on every JSON too | Should `skip` non-matching names. Only `*project_profitability*.csv` loads. |
| 403 Cosmos | Networking: allow Azure datacenters. |
| 401 Cosmos | `COSMOS_KEY` is wrong or truncated. |
| `ora-lens-ns-ingest` name taken | Create the Function App with a suffix; set `FUNC=` in the bash block to that name. |

---

## Do not

- Add blob settings to Data Lens SWA
- Run this on the work PC
- Write `studies` or `ora_*`

After ~83 docs exist, say so. Ask gets wired to `lens_ns_projects` next.
