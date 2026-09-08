# Survey email setup (ARTEMIS → site PI / Coordinator)

When you **Send survey** and check **Attempt email delivery**, ARTEMIS looks up:

| Role checked | Email used |
|---|---|
| PI | `sites.piEmail`, else PI on `site-staff` |
| Coordinator | `sites.siteCoordinatorEmail`, else coordinator on `site-staff` |

Then it emails the unique `site-survey.html?t=…` link.

## Pick one delivery method

Priority order in code: **Webhook → Microsoft Graph → SendGrid → manual (copy links)**.

### Option A — Microsoft Graph (recommended with your Entra app)

Uses the same SWA app registration (SMOScheduler).

1. In **Entra ID → App registrations → SMOScheduler → API permissions**:
   - Add **Application** permission: `Microsoft Graph` → `Mail.Send`
   - Click **Grant admin consent**
2. Pick a mailbox that can send (shared mailbox or user), e.g. `artemis-surveys@oraclinical.com`
3. On SWA **ARTEMIS** → Configuration → Application settings, set:

| Setting | Value |
|---------|--------|
| `AZURE_CLIENT_ID` | (already set) |
| `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_SECRET_APP_SETTING_NAME` | app secret **value** (already used for Entra login) |
| `AZURE_TENANT_ID` | `2f298692-acc9-4632-b71b-841d51376914` (optional; code defaults to this) |
| `SURVEY_EMAIL_FROM` | mailbox UPN that sends, e.g. `artemis-surveys@oraclinical.com` |
| `SURVEY_EMAIL_FROM_NAME` | optional display name |

4. Redeploy / restart is not required for app settings — wait ~1 min and **Send survey** again.

**Delivery column** in the results modal should show `graph` when mail went out.

### Option B — SendGrid

| Setting | Value |
|---------|--------|
| `SENDGRID_API_KEY` | SendGrid API key with Mail Send |
| `SURVEY_EMAIL_FROM` | verified sender (or `SENDGRID_FROM_EMAIL`) |

### Option C — Power Automate / Logic Apps webhook

| Setting | Value |
|---------|--------|
| `SURVEY_EMAIL_WEBHOOK` | HTTPS URL that accepts JSON |

POST body:

```json
{
  "type": "site_survey_invite",
  "to": "pi@site.com",
  "subject": "ORA site survey — action requested",
  "text": "...",
  "html": "...",
  "meta": { "assignmentId": "...", "siteId": "...", "surveyId": "...", "targetRole": "pi" }
}
```

### Optional ops alert on submit

| Setting | Value |
|---------|--------|
| `SURVEY_OPS_NOTIFY_EMAIL` | your ops inbox |

## Checklist before send

1. Site has **PI email** and/or **Coordinator email** filled in (Sites → edit).
2. Send modal roles match those people (PI / Coordinator checkboxes).
3. One of the email settings above is configured.
4. After send, open results: **Delivery** = `graph` / `sendgrid` / `webhook`, not `no_email_provider` or `missing_recipient`.

If delivery is `manual` / `no_email_provider`, links still work — use **Copy link** or **Resend** after email is configured.
