# Dummy steps: Project Profitability → Cosmos

Do this on the **work PC** (the one that already runs `netsuite-pull-job`). Do **not** run it on the Cursor laptop. Do **not** put these settings on the Data Lens website.

The website never sees the blob. This script reads blob and writes Cosmos.

---

## 0. What “done” looks like

After a pull folder exists (`netsuite/landing/2026/08/13/1011/…`), you run one command and it prints something like:

```json
{
  "blob": "landing/2026/08/13/1011/netsuite_project_profitability.csv",
  "upserted": 83,
  "deleted": 0,
  "container": "lens_ns_projects",
  "database": "bd-budgets"
}
```

Then Cosmos has container `lens_ns_projects`. Data Lens can read it later. You are only doing the load today.

---

## 1. Get the script onto the work PC

Repo: `https://github.com/mhillORA/mhillORA.github.io.git`  
Branch: `ora-data-lens`

**If that repo is already cloned on the work PC:**

```bat
git fetch
git checkout ora-data-lens
git pull
```

You want a folder named `ingest` with `nsBlobToCosmos.js` and `package.json`.

**If it is not cloned:**

1. Install Git if needed.
2. In a folder you like (example `C:\ora`):

```bat
git clone -b ora-data-lens https://github.com/mhillORA/mhillORA.github.io.git
cd mhillORA.github.io\ingest
```

---

## 2. Install Node (once)

1. [https://nodejs.org](https://nodejs.org) → LTS → install.
2. Close and reopen Command Prompt.
3. Check:

```bat
node -v
```

You want `v20` or higher.

---

## 3. Install script packages (once)

```bat
cd <repo>\ingest
npm install
```

Wait until it finishes with no red error. A `node_modules` folder appears. Do not commit that.

---

## 4. Copy three values out of Azure (do not paste them in chat)

### A. Storage connection string (you already have this on the pull job)

1. Portal → Storage account that holds container **`netsuite`**.
2. Left: **Security + networking** → **Access keys**.
3. **key1** → **Connection string** → Show → Copy.

That is `AZURE_STORAGE_CONNECTION_STRING`.

(If the pull job already has this in a `.env` or Function setting, copy it from there. Same string.)

### B. Cosmos URI

1. Portal → **Azure Cosmos DB** → account **`bd-budgets`**.
2. Left: **Settings** → **Keys**.
3. Copy **URI**. It looks like `https://bd-budgets.documents.azure.com:443/`.

That is `COSMOS_ENDPOINT`.

### C. Cosmos primary key

Same **Keys** blade → **PRIMARY KEY** → copy.

That is `COSMOS_KEY`. This can write. Keep it on the pull job only. Not in GitHub. Not in chat. Not on the Data Lens SWA if you later split reader/writer.

---

## 5. Put those values in a local env file on the work PC

In `ingest`, create a file named `.env` (Windows Notepad is fine). Paste this and fill the three copies:

```
BLOB_CONTAINER=netsuite
AZURE_STORAGE_CONNECTION_STRING=paste-connection-string-here
COSMOS_ENDPOINT=https://bd-budgets.documents.azure.com:443/
COSMOS_KEY=paste-primary-key-here
COSMOS_DATABASE=bd-budgets
```

No quotes. No spaces around `=`. Save.

The script does **not** auto-load `.env`. You will load it in the next step with a one-liner, **or** set them on the Azure job. Pick one.

### Easy test on the work PC (PowerShell)

From `ingest`:

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k,$v = $_.Split('=',2)
  Set-Item -Path "Env:$k" -Value $v
}
node nsBlobToCosmos.js
```

If Cosmos firewall blocks this PC, the error will mention **403** / **Request blocked by network**. Then the script must run **inside Azure** (same place as the pull job), not on the desktop. Same env vars, on that job’s configuration.

---

## 6. Hook it to the pull so it runs every drop

After the job has written `landing/yyyy/MM/dd/HHmm/`.

### If the pull is a `.py` / `.ps1` / `.bat` you already run

Add this at the **end** (after blob upload succeeds). Change `C:\ora\mhillORA.github.io` to your real repo path.

**PowerShell:**

```powershell
Set-Location "C:\ora\mhillORA.github.io\ingest"
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k,$v = $_.Split('=',2)
  Set-Item -Path "Env:$k" -Value $v
}
node nsBlobToCosmos.js
if ($LASTEXITCODE -ne 0) { throw "Cosmos load failed" }
```

**Python** (end of the pull script):

```python
import subprocess, sys
ingest = r"C:\ora\mhillORA.github.io\ingest"
raise SystemExit(subprocess.call(["node", "nsBlobToCosmos.js"], cwd=ingest))
```

(If you use Python, set the env vars in the process environment before `subprocess.call`, same names as the `.env` file.)

### If the pull is an Azure Function

1. Function App → **Settings** → **Environment variables**.
2. Add the same five names as in step 5. Save.
3. At the end of the function that writes landing files, add:

```js
const { spawnSync } = require("child_process");
const path = require("path");
const r = spawnSync("node", ["nsBlobToCosmos.js"], {
  cwd: path.join(__dirname, "ingest"),
  env: process.env,
  encoding: "utf8"
});
if (r.status !== 0) throw new Error(r.stderr || r.stdout);
```

Copy the `ingest` folder **into that Function App repo** and deploy it with the function. Do not deploy `ingest` to the Data Lens SWA.

### If the pull is ADF

1. Add an **Azure Function** or **Web** activity after the copy-to-blob activities (harder).
2. Faster: keep ADF as the blob writer, and schedule this Node script on the work PC / a Function 15 minutes after each pull.

---

## 7. Check Cosmos

1. Portal → Cosmos **bd-budgets** → Data Explorer.
2. Database `bd-budgets` → container **`lens_ns_projects`**.
3. New SQL query:

```sql
SELECT VALUE COUNT(1) FROM c WHERE c.docType = "lens_ns_project"
```

You want ~83.

4. Peek one doc. You should see `budgeted_gm_pct`, `project_manager`, `sourceBlob` like `landing/2026/08/13/1011/...`.

Blank GM in the CSV shows as missing/`null`, not `0`.

---

## 8. If it breaks

| What you see | What you do |
|--------------|-------------|
| `No landing/**/netsuite_project_profitability*.csv` | Pull has not written today’s folder, or container name is not `netsuite`, or the CSV is named something else. Open Storage Explorer and copy the **full blob path**. |
| `403` / firewall / `Request originated from IP` | Script ran on a blocked PC. Run it where the pull job already runs in Azure. |
| `COSMOS_ENDPOINT / COSMOS_KEY required` | Env vars did not load. Re-run the PowerShell `Get-Content .env` block, then `node`. |
| `401` / `Unauthorized` on blob | Wrong storage connection string (different account than container `netsuite`). |
| `upserted: 0` | CSV header names changed. File must start with `actual_gm_pct_prior_month,budgeted_gm_pct,...` |

Do not put the keys in a Teams message or this chat.

---

## 9. After the first successful load

Tell me. I will point Data Lens Ask at `lens_ns_projects`. The website still does not get blob access.
