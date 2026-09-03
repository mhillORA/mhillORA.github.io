# ARTEMIS GDPR hardening checklist

ARTEMIS-only. Does **not** change NASA/CHAOS wiring, shared `users` auth, or scheduling payloads.

This is an engineering checklist — not legal advice. Have counsel confirm lawful basis, notices, and DPIA needs for your use of site staff PII and any patient data.

---

## Current product facts

| Area | Reality today |
|------|----------------|
| Personal data | Site PI/coordinator names & emails; survey answers; optional response `email`/`displayName`; patient enrollment records |
| Public survey links | `site-survey.html?t=…` opaque invite token (hash at rest); legacy `assignmentId` rejected |
| Admin UI | Gated by ARTEMIS login (session in browser); Azure Functions routes are still `authLevel: anonymous` |
| Cross-origin | API returns `Access-Control-Allow-Origin: *` |
| Chaos/NASA | Shared Cosmos + username auth; leave those contracts alone |

---

## Phase 0 — Org / legal (outside the app)

- [ ] Record of processing (RoPA) for ARTEMIS purposes
- [ ] Lawful basis for staff surveys (usually contract / legitimate interest) and for patients (clinical + privacy rules)
- [ ] Privacy notice text for survey respondents (staff)
- [ ] Azure DPA / SCCs if any EU personal data is processed
- [ ] Confirm Cosmos region and transfer story
- [ ] Named owner for access / erasure requests (ops + legal)

---

## Phase 1 — Shipped in this repo (foundation)

Implemented:

1. **Survey privacy notice** on `site-survey.html` (purpose + contact placeholder)
2. **Privacy API** (`api/privacy-routes.js`):
   - `GET /api/privacy/export?email=` — subject access export for survey responses (+ matching assignments)
   - `POST /api/privacy/erase` — erase / redact survey PII by email (requires `confirm: true`)
   - `POST /api/privacy/retention/purge-archived` — delete `_archived` survey responses older than N days
   - `GET /api/privacy/audit` — recent privacy audit events
3. **`privacy-audit-log` Cosmos container** (created on first use, partition `/id`)
4. **Comms → Privacy tools** panel to run export / erase / purge from the logged-in ARTEMIS UI

Env knobs:

| Variable | Purpose |
|----------|---------|
| `PRIVACY_OPS_KEY` | Optional. If set, privacy write/export routes require header `X-Artemis-Privacy-Key` |
| `SURVEY_ARCHIVE_RETENTION_DAYS` | Default days for purge when body omits `olderThanDays` (default `365`) |
| `PRIVACY_CONTACT_EMAIL` | Shown on public survey notice (fallback text if unset) |

---

## Phase 2 — Access control (next)

- [x] Public responder uses opaque token (`/api/public/site-survey`) — not raw assignment list access from the form
- [x] Invite token hashed at rest; raw shown once; expiry + resend rotation
- [x] Rate-limit public survey GET/POST (in-function best-effort)
- [x] Narrow CORS when `SURVEY_CORS_ORIGINS` / `STATIC_WEB_APP_URL` is a single origin
- [ ] Require Function key **or** session token for list-all survey definitions / assignments / responses
- [ ] Stop shipping a hardcoded admin backdoor in the client
- [ ] Front Door / APIM hard rate limits for public survey POST

See also `docs/SITE_SURVEY_SECURITY.md`.

**Do not** put Function keys in CHAOS/NASA clients.

---

## Phase 3 — Retention & minimization

- [ ] Document retention for live responses vs `_archived` copies
- [ ] Schedule `POST /api/privacy/retention/purge-archived` (Timer Function or Logic App)
- [ ] Minimize survey fields collected; avoid free-text that invites special-category data
- [ ] Separate patient identifiers from marketing/survey stores where possible

---

## Phase 4 — Data subject rights ops

- [ ] Runbook: intake → verify identity → export → erase → confirm
- [ ] Use Privacy tools (or API) and file the audit log entry
- [ ] Extend erase to site staff emails on `sites` / `site-staff` only when legally required (careful with shared operational records)
- [ ] Patient erasure is usually a clinical-records process — do not casually delete from CTMS without SOP

---

## Phase 5 — Security hygiene

- [ ] Cosmos private endpoint / firewall where feasible
- [ ] Key Vault for secrets; rotate `COSMOS_KEY` / `PRIVACY_OPS_KEY`
- [ ] Remove or gate debug `console.log` of request bodies with PII
- [ ] Annual access review of ARTEMIS operators

---

## Explicit non-goals (protect Chaos / NASA)

- No changes to `notifyNasaOfUpdate`, schedules schema, or CHAOS shift fields
- No changes to shared `users` password hashing / Entra authenticate contracts beyond what ARTEMIS already uses
- No writes from privacy erase into NASA/CHAOS codepaths

---

## Quick test plan

1. Open a survey link → notice visible; submit still works  
2. Comms → Privacy tools → export by a known response email → JSON download  
3. Erase with `confirm` → responses redacted; audit row appears  
4. Create an archived response older than retention → purge removes it  
5. If `PRIVACY_OPS_KEY` set → requests without header return 401  
