# CORS notes (Ora Data Lens + Buddy)

## Why “CORS isn’t working”

Browser → `ora-buddy-api` (Veeva/SF ingest, study-sync status) is **cross-origin**. Azure Function Apps need **platform CORS** (Portal) **and** matching app allow-list.

Typical failure: Portal CORS missing the SWA origin → `Failed to fetch` / 405 / canned “lost Function App connection.”

## Fix (you do this in Portal — once)

### `ora-buddy-api`

1. Portal → Function App **`ora-buddy-api`** → **CORS**
2. Allowed origins (no trailing slash):
   - `https://white-river-0de1aed0f.7.azurestaticapps.net` (Study Bid / Buddy)
   - `https://black-stone-03061770f.7.azurestaticapps.net` (Data Lens)
3. Credentials: **off**
4. Save → hard-refresh the site

App setting (comma-separated):

```
BUDDY_CORS_ORIGIN=https://white-river-0de1aed0f.7.azurestaticapps.net,https://black-stone-03061770f.7.azurestaticapps.net
```

Deploy workflow also runs `az functionapp cors add` for both.

### Data Lens SWA API

Same-origin `/api/*` from `black-stone-…` usually needs no Portal CORS. Code now answers **OPTIONS** on every route and echoes `Origin` / `LENS_CORS_ORIGIN` for local Vite or cross-host tests.

## Not CORS

- SWA gateway ~45s on long Veeva pulls → use Actions / one-object-per-call (already wired)
- Missing `BUDDY_SESSION_SECRET` → session mint fails (looks like CORS in the UI)
- `BUDDY_API_BASE` without `https://` → relative URL → 405
