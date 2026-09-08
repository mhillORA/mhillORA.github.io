# ARTEMIS Entra ID setup (Ora Data Lens model)

**Goal:** Same login pattern as **Ora Data Lens**:

- Azure Static Web Apps Easy Auth  
- Separate Entra app named **SMOScheduler** (same Ora tenant, not the Data Lens app)  
- Staff must sign in with Microsoft  
- Site survey links stay public (no Entra)

---

## Big dummy steps (do these in order)

Do one step at a time. Don’t skip ahead.

### STEP 1 — Write down your ARTEMIS website address

1. Open **Azure Portal** → search **Static Web Apps**.
2. Click the ARTEMIS app (branch `ARTEMIS` / calm-desert).
3. On Overview, copy the **URL** (like `https://something.azurestaticapps.net`).
4. If you have a custom domain, write that down too.

```text
ARTEMIS URL (primary): https://smostrategy.oraclinical.com
SWA default host (optional 2nd URI): https://calm-desert-04019df0f.azurestaticapps.net
```

---

### STEP 2 — Make a new Entra app called SMOScheduler

1. Open [https://entra.microsoft.com](https://entra.microsoft.com).
2. Left menu → **Applications** → **App registrations**.
3. Click **+ New registration**.
4. Fill in:
   - **Name:** `SMOScheduler`
   - **Supported account types:** “Accounts in this organizational directory only”
5. Click **Register**.
6. On Overview, copy:

```text
Application (client) ID: ________________________________
Directory (tenant) ID:   2f298692-acc9-4632-b71b-841d51376914
```

Tenant should already be that Ora ID. If it isn’t, stop and ask.

**Do not open / edit the Data Lens app.** Brand-new SMOScheduler-only app.

---

### STEP 3 — Tell Entra where login comes back

1. Still in the SMOScheduler app registration.
2. Left → **Authentication**.
3. **Add a platform** → **Web**.
4. Redirect URI — paste this first (your real site):

```text
https://smostrategy.oraclinical.com/.auth/login/aad/callback
```

5. Optional but smart — also add the SWA default host so either URL can log in:

```text
https://calm-desert-04019df0f.azurestaticapps.net/.auth/login/aad/callback
```

6. Save.
7. If you see **ID tokens**, turn it **on**, then Save.

---

### STEP 4 — Make a secret for the app

1. Left → **Certificates & secrets**.
2. **Client secrets** → **+ New client secret**.
3. Description: `SMOScheduler SWA` → **Add**.
4. Copy the **Value** column right away (not Secret ID).

```text
Client secret Value: ________________________________
```

Leave without copying → make a new secret.

---

### STEP 5 — Only assigned people can sign in

1. Entra → **Applications** → **Enterprise applications**.
2. Open **SMOScheduler**.
3. **Properties** → **Assignment required?** → **Yes** → Save.
4. **Users and groups** → **+ Add user/group**.
5. Pick who should use SMO / ARTEMIS → Assign.

Not assigned = cannot get in. Good.

---

### STEP 6 — Put IDs into the ARTEMIS Static Web App

1. Azure Portal → **ARTEMIS Static Web App**.
2. **Configuration** (Application settings).
3. Add / fix exactly these names:

| Name | Value |
|------|--------|
| `AZURE_CLIENT_ID` | Client ID from Step 2 (`cc33a488-…` for SMOScheduler) |
| `AZURE_CLIENT_SECRET` | Secret **Value** from Step 4 (long string — **not** Secret ID) |

4. If you still have an old setting named `AZURE_CLIENT_SECRET_APP_SETTING_NAME`, you can delete it after `AZURE_CLIENT_SECRET` is set.
5. Save / Apply.
6. Wait a minute.

**Also check (common “couldn’t sign you in” causes):**

- SWA **Hosting plan** = **Standard** (custom Entra does not work on Free)
- Entra app → Authentication → **ID tokens** = On
- Enterprise app SMOScheduler → you are in **Users and groups**
- Password protection on SWA = Disabled (or staging only)

Secrets stay in Azure. Not in GitHub.

---

### STEP 7 — Code is wired (deploy)

Repo now has:

1. `staticwebapp.config.json` — Entra + public survey carve-outs (no GetRoles / rolesSource)  
2. `/api/users/me` — maps SWA principal → Cosmos `users`  
3. UI Login → `/.auth/login/aad`, Logout → `/.auth/logout`  

**Push / merge the `ARTEMIS` branch** so GitHub Actions deploys to `smostrategy.oraclinical.com`, then do Step 8.

---

### STEP 8 — Test after deploy

1. Open ARTEMIS URL → Microsoft login → you’re in.  
2. Open `https://smostrategy.oraclinical.com/.auth/me` → see your user JSON.  
3. Sign out (`/.auth/logout`) → home page asks for login again.  
4. Someone **not** assigned in Step 5 tries → blocked.  
5. **Critical — Incognito survey link:**

```text
https://smostrategy.oraclinical.com/site-survey.html?t=SOME_VALID_TOKEN
```

Sites must open this **without** Ora Microsoft login.

If 8.5 forces Entra, stop — public survey carve-out is wrong.

---

## Cheat sheet

```text
[ ] Step 1  Wrote down ARTEMIS URL
[ ] Step 2  Created NEW app registration named SMOScheduler
[ ] Step 2  Copied Client ID
[ ] Step 3  Added /.auth/login/aad/callback redirect
[ ] Step 4  Created secret and copied Value
[ ] Step 5  Assignment required = Yes + assigned users
[ ] Step 6  Set AZURE_CLIENT_ID on SWA
[ ] Step 6  Set AZURE_CLIENT_SECRET_APP_SETTING_NAME on SWA
[ ] Step 7  Code wired + ARTEMIS branch deployed
[ ] Step 8  Login works
[ ] Step 8  Logout works
[ ] Step 8  Unassigned user blocked
[ ] Step 8  Site survey works WITHOUT login
```

---

## Picture of what happens

```text
You open ARTEMIS
   → not signed in → Microsoft login
   → come back signed in
   → app loads

Site opens survey link
   → NO Microsoft login
   → fills survey
```

---

## Extra detail (after the dummy steps)

### Tenant (same as Data Lens)

`2f298692-acc9-4632-b71b-841d51376914`

### Must stay open (no Entra)

| Path | Why |
|------|-----|
| `/site-survey.html` | Sites fill surveys |
| `/api/public/*` | Survey API |
| `/.auth/*` | Login/logout plumbing |
| `/api/GetRoles` | SWA needs it during login |

### Everyone else

Staff UI + other APIs → must be signed in.

### Target `staticwebapp.config.json` (eng wires this)

```json
{
  "platform": {
    "apiRuntime": "node:18"
  },
  "auth": {
    "identityProviders": {
      "azureActiveDirectory": {
        "registration": {
          "openIdIssuer": "https://login.microsoftonline.com/2f298692-acc9-4632-b71b-841d51376914/v2.0",
          "clientIdSettingName": "AZURE_CLIENT_ID",
          "clientSecretSettingName": "AZURE_CLIENT_SECRET"
        }
      }
    }
  },
  "routes": [
    { "route": "/.auth/*", "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/login", "rewrite": "/.auth/login/aad" },
    { "route": "/api/public/*", "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/site-survey.html", "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/api/*", "allowedRoles": ["authenticated"] },
    { "route": "/*", "allowedRoles": ["authenticated"] }
  ],
  "responseOverrides": {
    "401": {
      "redirect": "/.auth/login/aad",
      "statusCode": 302
    }
  }
}
```

Note: we do **not** use `rolesSource` / GetRoles. Entra assignment gates who can sign in; Cosmos `users.permissionLevel` gates what they can do in the app.

### Day-2 ops

- **Add user:** Enterprise app SMOScheduler → Users and groups → Assign.  
- **Remove user:** Remove assignment.  
- **Make Manager:** After first login, set Cosmos `users.permissionLevel` to `Manager`.  
- **New secret:** New Entra secret → update SWA setting → delete old secret.

### Don’t

- Don’t put secrets in git.  
- Don’t reuse the Data Lens app.  
- Don’t lock site surveys behind Entra.  
- Don’t forget custom-domain callback URI if you use one.

**Names:** Entra app = **SMOScheduler**. Site URL = **smostrategy.oraclinical.com**. Git branch / SWA slot may still say ARTEMIS — that’s fine.

When Steps 1–6 are done and this code is on `ARTEMIS`, deploy then run Step 8.
