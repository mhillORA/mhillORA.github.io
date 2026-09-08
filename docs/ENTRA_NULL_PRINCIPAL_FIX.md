# ARTEMIS Entra — fix null clientPrincipal

## What’s broken

Symptoms match **SWA token exchange failure**:

1. Microsoft login / MFA succeeds  
2. Browser returns to `/.auth/login/aad/callback`  
3. SWA **does not** set `StaticWebAppsAuthCookie`  
4. `/.auth/me` → `{ "clientPrincipal": null }`

So Entra is fine; **SWA cannot finish the code↔token swap** (almost always secret / app-reg shape / redirect URI).

Working reference: **Ora Data Lens** (`black-stone-03061770f`) uses the same tenant + same config shape with client id `ee526c2f-…`.  
ARTEMIS uses SMOScheduler client id `cc33a488-…`.

---

## Do this exactly (portal)

### A) SWA application settings (ARTEMIS → Configuration)

Create **both** of these (same secret value in both — kills name-mismatch):

| Name | Value |
|------|--------|
| `AZURE_CLIENT_ID` | SMOScheduler **Application (client) ID** |
| `AZURE_CLIENT_SECRET_APP_SETTING_NAME` | Client secret **Value** (long string, **not** Secret ID) |
| `AZURE_CLIENT_SECRET` | **Same** client secret **Value** again |

Save. Wait 1–2 minutes.

Config in repo now points at `AZURE_CLIENT_SECRET_APP_SETTING_NAME` (Data Lens style). Extra `AZURE_CLIENT_SECRET` is only a safety duplicate.

### B) Entra app SMOScheduler → Authentication

1. Platform = **Web** (not SPA)  
2. Redirect URIs (exact):

```text
https://smostrategy.oraclinical.com/.auth/login/aad/callback
https://calm-desert-04019df0f.3.azurestaticapps.net/.auth/login/aad/callback
```

3. **ID tokens** (Implicit grant and hybrid flows) = **On** → Save  

SWA authorize URL uses `response_type=code+id_token` — ID tokens must be on.

### C) Enterprise app → Users and groups

Your account assigned (if Assignment required = Yes).

### D) Test order

1. Incognito  
2. First try **default host** (isolates custom domain):

```text
https://calm-desert-04019df0f.3.azurestaticapps.net/.auth/login/aad
```

3. Then:

```text
https://calm-desert-04019df0f.3.azurestaticapps.net/.auth/me
```

4. Then custom domain the same way.

**Success** = `clientPrincipal` object with your email.  
**Still null** = callback still failing (wrong secret, SPA platform, or ID tokens off).

---

## While Entra is broken

Use **password Sign in** on the ARTEMIS login modal. APIs are temporarily open to anonymous so the app loads.

---

## Names

| Thing | Value |
|-------|--------|
| SWA | ARTEMIS |
| Custom domain | smostrategy.oraclinical.com |
| Default host | calm-desert-04019df0f.**3**.azurestaticapps.net |
| Entra app | SMOScheduler |
| Tenant | 2f298692-acc9-4632-b71b-841d51376914 |
