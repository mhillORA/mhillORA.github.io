# Site survey security (staff PII)

ARTEMIS site feasibility surveys collect **site-staff PII** (names, emails, operational answers). They must **not** collect patient PHI.

## Flow

1. Ops picks a survey template + sites + roles (PI / Coordinator) in **Comms → Send Survey**.
2. API mints a unique opaque invite token per site+role, stores only `tokenHash`, emails (or returns) `site-survey.html?t=…`.
3. Respondent opens the link → `GET /api/public/site-survey?t=…` returns questions + **prefill from latest live response** (and any draft).
4. Save draft / Submit → `POST /api/public/site-survey` → Cosmos `site-survey-responses` (+ archive on resubmit).
5. Ops sees **Survey activity** on Comms and question analytics on **Reporting**.

Resubmit is allowed by default (`allowResubmit: true`). Blank fields on submit keep prior answers.

## Public vs ops

| Surface | Auth | Endpoints |
|---------|------|-----------|
| Public form | Invite token only | `GET/POST /api/public/site-survey` |
| Bulk send / resend | ARTEMIS UI (same API host) | `POST /api/site-survey-send`, `…/assignments/{id}/resend` |
| Inbox | ARTEMIS UI | `GET/POST /api/site-survey-notifications` |

Public payloads never include `siteId`, `tokenHash`, or other sites’ responses.

Legacy links `?assignmentId=` are rejected on the public page — use **Resend**.

## Env

| Variable | Purpose |
|----------|---------|
| `SURVEY_TOKEN_PEPPER` | Pepper for token hashing (falls back to `PRIVACY_OPS_KEY` / `COSMOS_KEY`) |
| `SURVEY_EMAIL_WEBHOOK` | POST JSON invites `{to,subject,text,meta}` |
| `SURVEY_OPS_NOTIFY_EMAIL` | Optional ops alert on submit (via same webhook) |
| `SURVEY_CORS_ORIGINS` / `STATIC_WEB_APP_URL` | Narrow CORS when set to a single origin |
| `PRIVACY_CONTACT_EMAIL` | Shown on the public privacy notice |

## Token model

- Mint: 32-byte `base64url` secret
- Store: `SHA-256(pepper:raw)` as `tokenHash`, plus `tokenPrefix` for ops display
- Raw token returned **once** at send/resend; rotate on resend
- `expiresAt` default 30 days; `revokedAt` supported

## Files

- `api/lib/survey-tokens.js` — mint / hash / redact
- `api/lib/survey-response-service.js` — prefill merge + submit/resubmit write
- `api/lib/survey-email.js` — webhook delivery + copy
- `api/survey-secure-routes.js` — public + send + notifications
- `site-survey.html` — respondent UI
- Comms / Reporting in `index.html`

## Reporting

Use **Reporting → Feasibility** for per-question distributions and site drill-down (existing `buildFeasibilityQuestionReport`). Comms **Responses** lists latest submissions; activity feed flags new submits.
