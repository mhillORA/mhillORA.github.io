# Dummy steps: Salesforce → Cosmos, daily, 100% in Azure

Buddy’s Salesforce pull used a **user OAuth refresh token**. Those expire, get revoked, break when the Connected App policy changes, or fail when the person who clicked “Allow” leaves. That is why “the token doesn’t work.”

Do **not** fix Buddy’s token. Do **not** put Salesforce secrets on the Data Lens Static Web App.

Use a **new Azure Function** that gets a fresh access token every run with **Client Credentials** (server-to-server). It writes Cosmos container **`lens_sf_crosswalk`** (Data Lens owned). Leave Buddy’s `ora_sponsor_crosswalk` alone until we know it is good.

---

## Why this pattern

| Old (Buddy) | New (Data Lens) |
|-------------|-----------------|
| User clicks Allow once → refresh token | Client Credentials every morning |
| Token dies → job dies | Consumer Key + Secret in Function App settings |
| Writes `ora_sponsor_crosswalk` (shared / unclear) | Writes `lens_sf_crosswalk` (ours) |
| Runs somehow on Buddy / laptop | Timer in Azure only |

---

## A. Salesforce — integration user (once)

You need a Salesforce admin (or someone who can create users + Connected Apps).

1. Salesforce → **Setup**.
2. Search **Users** → **New User** (or reuse a dedicated integration user if you already have one).
3. Suggested:

| Field | Value |
|--------|--------|
| Last Name | `Data Lens Integration` |
| Alias | `odlsf` |
| Email | your work email (or a shared mailbox) |
| Username | something unique, e.g. `odl.sf.integration@YOURDOMAIN.com` |
| User License | **Salesforce** (or whatever your org uses for API-only users) |
| Profile | start with **Minimum Access** or a locked-down custom profile |

4. After create: open the user → **Permission Set Assignments** → assign a permission set that can **API Enabled** and **read** the objects you need (Account, Opportunity, and any custom Study / Project fields). Do **not** give Modify All Data.
5. Note the **username**. You will pick this user as the Connected App “run as” user later.

---

## B. Salesforce — Connected App with Client Credentials (once)

1. Setup → search **App Manager** → **New Connected App**.
   - If your org only offers **External Client App**, use that and enable the same OAuth options below.
2. Fill:

| Field | Value |
|--------|--------|
| Connected App Name | `Ora Data Lens SF Ingest` |
| API Name | `Ora_Data_Lens_SF_Ingest` |
| Contact Email | you |

3. Check **Enable OAuth Settings**.
4. Callback URL (required even for Client Credentials — paste anything valid):

```text
https://localhost/callback
```

5. Selected OAuth Scopes — add at least:

- **Manage user data via APIs (`api`)**
- **Perform requests at any time (`refresh_token`, `offline_access`)** — Salesforce still wants this scope on many apps even when you use Client Credentials

6. Check **Enable Client Credentials Flow**.
7. Save. Click **Continue**. Wait 2–10 minutes (Salesforce is slow to activate new apps).
8. Open the Connected App → **Manage Consumer Details** (verify with MFA/email if asked).
9. Copy and store offline (password manager, not chat):

- **Consumer Key** (= client id)
- **Consumer Secret** (= client secret)

10. Still on the app → **Manage** → **Edit Policies**:

| Policy | Value |
|--------|--------|
| Permitted Users | **Admin approved users are pre-authorized** (recommended) |
| IP Relaxation | **Relax IP restrictions** (Azure Function outbound IPs change) **or** allowlist Function outbound IPs later |
| Refresh Token Policy | does not matter for Client Credentials |

11. **Client Credentials Flow** section → **Run As** → pick the integration user from step A → Save.
12. If Permitted Users = Admin approved: **Manage Profiles** / **Manage Permission Sets** → add the integration user’s profile or permission set.

---

## C. Prove the token works (5 minutes, before Azure)

On a machine that can reach Salesforce (work PC is fine for this test only).

1. Find your **My Domain** login host, e.g. `https://ora--something.my.salesforce.com` or `https://login.salesforce.com` for prod / `https://test.salesforce.com` for sandbox.
2. In PowerShell:

```powershell
$login = "https://login.salesforce.com"   # sandbox: https://test.salesforce.com
$clientId = "PASTE_CONSUMER_KEY"
$clientSecret = "PASTE_CONSUMER_SECRET"

$body = @{
  grant_type    = "client_credentials"
  client_id     = $clientId
  client_secret = $clientSecret
}

$token = Invoke-RestMethod -Method Post -Uri "$login/services/oauth2/token" -Body $body
$token.access_token
$token.instance_url
```

3. If you get `access_token` + `instance_url`, auth is fixed. Buddy’s refresh token problem is irrelevant now.
4. Quick SOQL smoke test:

```powershell
$q = [uri]::EscapeDataString("SELECT Id, Name FROM Account LIMIT 5")
Invoke-RestMethod -Headers @{ Authorization = "Bearer $($token.access_token)" } `
  -Uri "$($token.instance_url)/services/data/v61.0/query?q=$q"
```

If this fails with `invalid_grant` / `invalid_client`:

- Wait 10 minutes after creating the Connected App
- Confirm Client Credentials is enabled and **Run As** is set
- Confirm Consumer Key/Secret are from **Manage Consumer Details**, not the wrong app
- Sandbox vs prod login host mismatch

---

## D. Decide what to pull (you must fill API names)

Data Lens needs a **crosswalk**, not the whole CRM. Minimum useful fields for Finance + ClinOps:

| Purpose | Typical Salesforce place | Notes |
|---------|--------------------------|--------|
| Sponsor / customer name | `Account.Name` | Match NetSuite `customer_name` |
| Study / protocol code | Custom on Opportunity / custom object | Must match or map to `ora_fact_study.study_number` |
| NetSuite project number | Custom field if it exists | Gold for join — `NN-NNN-NNNN` |
| Opportunity name / stage | `Opportunity.Name`, `StageName` | BD context |
| Salesforce Ids | `Account.Id`, `Opportunity.Id` | Stable Cosmos `id` |

In Salesforce → **Object Manager** → open Account / Opportunity / your Study object → **Fields & Relationships**. Write down the **API Names** (not labels).

Example SOQL (replace custom fields with yours):

```sql
SELECT
  Id,
  Name,
  AccountId,
  Account.Name,
  StageName,
  Amount,
  CloseDate,
  /* REPLACE these with real API names from Object Manager */
  Study_Number__c,
  NetSuite_Project_Number__c,
  Indication__c
FROM Opportunity
WHERE IsClosed = false
ORDER BY LastModifiedDate DESC
LIMIT 2000
```

If study/project live on Account or a custom object, change the `FROM` / joins. Paste the final SOQL into Function App setting `SF_SOQL` later.

---

## E. Portal — Cosmos container (once)

1. Cosmos **bd-budgets** → Data Explorer.
2. **New Container**:

| Field | Value |
|--------|--------|
| Database | `bd-budgets` (existing) |
| Container id | `lens_sf_crosswalk` |
| Partition key | `/docType` |

3. Networking: same as NetSuite ingest — allow Azure datacenters / Function outbound.

Do **not** wipe `ora_sponsor_crosswalk`. We can read it later if it ever gets good data.

---

## F. Portal — Function App (once)

Same pattern as NetSuite ingest. Prefer a **separate** app so SF secrets stay out of the NetSuite function.

1. Function App → **Create**.

| Field | What to pick |
|--------|----------------|
| Resource group | Same group as `ora-lens-ns-ingest` if possible |
| Function App name | `ora-lens-sf-ingest` (add initials if taken) |
| Publish | **Code** |
| Runtime | **Node.js** **22** |
| OS | **Linux** |
| Plan | **Flex Consumption** 512 MB is fine (same as NS), or Consumption |

2. After create → **Environment variables** → add:

| Name | Value |
|------|--------|
| `SF_LOGIN_URL` | `https://login.salesforce.com` (sandbox: `https://test.salesforce.com`) |
| `SF_CLIENT_ID` | Consumer Key |
| `SF_CLIENT_SECRET` | Consumer Secret |
| `SF_API_VERSION` | `v61.0` |
| `SF_SOQL` | Your SOQL from section D (one line) |
| `COSMOS_ENDPOINT` | Cosmos URI |
| `COSMOS_KEY` | Cosmos primary key |
| `COSMOS_DATABASE` | `bd-budgets` |
| `SF_COSMOS_CONTAINER` | `lens_sf_crosswalk` |

Do not put these on the SWA. Do not paste secrets in chat.

3. Cosmos networking already allows Azure → same as NS function.

---

## G. Deploy the ingest code (Cloud Shell)

After the Function code is on branch `ora-data-lens` under `ingest/sf-azure-func` (see repo), Cloud Shell **Bash**:

```bash
set -euo pipefail
FUNC=ora-lens-sf-ingest
# FUNC=ora-lens-sf-ingest-YOURINITIALS

RG=$(az functionapp list --query "[?name=='$FUNC'].resourceGroup | [0]" -o tsv)
echo "RG=$RG"

az functionapp config appsettings delete -g "$RG" -n "$FUNC" --setting-names SCM_DO_BUILD_DURING_DEPLOYMENT ENABLE_ORYX_BUILD || true

cd $HOME
rm -rf mhillORA.github.io
git clone --branch ora-data-lens --single-branch https://github.com/mhillORA/mhillORA.github.io.git
cd mhillORA.github.io/ingest/sf-azure-func
npm install --omit=dev

rm -f /tmp/sf-ingest.zip
zip -r /tmp/sf-ingest.zip . -x "*.git*"
az functionapp deployment source config-zip -g "$RG" -n "$FUNC" --src /tmp/sf-ingest.zip
```

Flex does **not** support remote Oryx build. Zip must include `node_modules` (same lesson as NetSuite).

---

## H. Schedule + prove it

Default timer in the Function: **6:20 AM Eastern** daily (staggered after NetSuite 6:05).

1. Function App → **Functions** → open the timer → **Code + Test** / **Test/Run** → Run.
2. **Monitor** / Log stream: look for `upserted N docs into lens_sf_crosswalk`.
3. Cosmos Data Explorer → `lens_sf_crosswalk` → should show docs with `docType = lens_sf_row`.

If auth fails in Azure but worked on your PC:

- Wrong `SF_LOGIN_URL` (prod vs sandbox)
- Client secret truncated in App Setting (no quotes, no trailing space)
- Connected App not finished propagating
- IP policies not relaxed

---

## I. What Data Lens does after data lands

1. Ask / Finance will read **`lens_sf_crosswalk`**, not Buddy’s container.
2. Join path (once field names are confirmed):

`lens_ns_projects.project_number`  
→ Salesforce `NetSuite_Project_Number__c` (or whatever you named it)  
→ Salesforce `Study_Number__c`  
→ `ora_fact_study.study_number`

That is how we fix the “only a few Veeva matches” problem without a hand-built mapping table.

Until those custom API names are real in `SF_SOQL`, the Function still loads Accounts/Opportunities for BD Ask, but the study↔project bridge stays weak.

---

## J. Buddy cleanup (optional)

- Leave Buddy’s old SF job disabled so it stops failing on the dead refresh token.
- Do not share this Function’s Client Secret with Buddy.
- If someone asks “why didn’t Buddy work”: refresh tokens are for people; daily jobs need Client Credentials or JWT.

---

## Checklist

- [ ] Integration user + permission set (API + read)
- [ ] Connected App, Client Credentials on, Run As = that user
- [ ] PowerShell token test returns `access_token`
- [ ] SOQL smoke test returns rows
- [ ] Custom field API names written down (study + NetSuite project if they exist)
- [ ] Cosmos `lens_sf_crosswalk` created
- [ ] Function App settings filled
- [ ] Zip deploy from Cloud Shell
- [ ] Test/Run upserts docs
- [ ] Tell me the real field API names so Ask can join NetSuite ↔ Salesforce ↔ Veeva

---

## Send me next

1. One successful SOQL result row (redact names if needed) **or** Object Manager screenshots of the study/project custom fields.  
2. Whether you are on **prod** (`login.salesforce.com`) or **sandbox** (`test.salesforce.com`).  
3. Function App name if it is not `ora-lens-sf-ingest`.

Then we wire Ask to `lens_sf_crosswalk` and fix the Veeva join properly.
