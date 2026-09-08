# Feasibility scoring & Site Ops ranking — how to use it

Ora Clinical · ARTEMIS

This guide is the operating manual for the **per-site feasibility loop**:

**define questionnaire → send to site → site answers / updates (prefilled) → score & weight → Pass / Fail / Borderline → Site Ops HTML**

---

## What you get

| Artifact | Where | Purpose |
|----------|--------|---------|
| Scored survey template | Comms → New / Edit survey | Weights, knockouts, pass thresholds |
| Secure site link | Comms → Send survey | Prefill + draft + resubmit |
| Ranked board | Reporting → Feasibility | Pass / Fail / Borderline / Unscored |
| **Site Ops HTML** | Reporting → **Site Ops HTML** button | Hand to leadership / Site Ops |

---

## 1. Configure a scored questionnaire

1. Open **Comms** → create or **edit** a survey (or **Clone** a predefined template).
2. In **Feasibility scoring (Site Ops)** set:
   - **Pass threshold (%)** — default `70`
   - **Borderline threshold (%)** — default `50` (must be ≤ pass)
3. For each scored question (prefer **select** dropdowns):
   - Open **Scoring & knockouts**
   - **Category** — e.g. Patient access, Staffing, Infrastructure
   - **Max points (weight)** — contribution to the percentage
   - **Scoring options** — one per line:
     - `Yes | 10`
     - `No | 0 | knockout` ← auto-fails the site
   - Optional: check **Treat listed fail values as knockouts** and list fail values
   - Optional: **Blank answer fails knockout** for required gates
4. Set status to **active** and save.

### Outcome rules

1. Any **knockout** → **Fail** (even if % is high).
2. Else if score **≥ pass** → **Pass**.
3. Else if score **≥ borderline** → **Borderline**.
4. Else → **Fail**.
5. If the template has **no** weights and **no** knockouts → responses stay **Unscored** (badge shown clearly).

Unanswered weighted questions are **excluded** from the denominator (same as before). Prefer required select questions for critical items.

---

## 2. Send per site (with prior answers)

1. **Comms** → **Send survey** (or Send from a site’s Surveys tab).
2. Pick template, roles, sites.
3. Review **Previous answers for selected sites** on the right before sending.
4. Send secure links. Sites open `site-survey.html?t=…` only — no internal ids.

### Site experience

- Prior answers are shown / prefilled.
- Draft autosaves; submit stores a scored response.
- Resubmit: blanks keep prior values; previous live response is **archived**; score recomputed on the merged answers.

---

## 3. Rank & export for Site Ops

1. **Reporting** → **Feasibility** panel.
2. Select the survey (+ role filter if needed).
3. Top of the report: **Site Ops ranking** table (Pass → Borderline → Fail → Unscored, then by %).
4. Click **Site Ops HTML** (toolbar or board header) → downloads a print-ready HTML pack:
   - Rank, site, outcome, score, role, submitted time, knockout reasons
   - Ora branding banner for leadership handoff

Sponsor PDF / Excel remain for sponsor review (Include/Exclude, Feedback, Notes). **Site Ops HTML** is the internal pass/fail artifact.

---

## 4. Making historical / library surveys score

Many ingested templates have **no scoring rules** yet. Until you edit them:

- Ranking shows **Unscored**
- Board warns that scoring is not configured

**To activate scoring on an existing library survey:**

1. Prefer **Clone** (keeps the original library intact), then add weights/knockouts, **or**
2. Edit the active survey carefully (new submits/resubmits pick up new rules; old stored `score` objects stay as-is until resubmit).

Ask sites that already submitted to **resubmit** (or open their link and submit again) so Pass/Fail reflects the new rules.

---

## 5. Recommended scoring pattern (leadership-ready)

| Layer | Use |
|-------|-----|
| Knockouts | Hard gates (equipment, license, “cannot do procedure”) |
| Weighted selects | Patient volume bands, staff FTE bands, experience |
| Categories | Roll up Patient access / Staffing / Infrastructure for narrative |
| Pass 70 / Borderline 50 | Adjust per protocol; publish thresholds on the HTML pack |

Keep questionnaires **short**. Industry practice favors fewer, higher-signal questions and prefill from prior answers — both are supported.

---

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Everything Unscored | Add weights + scoring options (or knockouts) on the definition; have sites resubmit |
| High % but Fail | Check knockout answers on the ranking table |
| Wrong site name | Live site display name / promote link; sponsor packs hide internal ids |
| Old score after edit | Resubmit from the secure link; archived history remains |

---

## Technical notes (for builders)

- Server: `api/lib/survey-response-service.js` → `scoreAnswers` / `computeScore`
- Score shape on responses: `{ earned, totalWeight, pct, outcome, passThreshold, borderlineThreshold, knockouts[], byCategory, scoredAt }`
- Definition fields: `passThreshold`, `borderlineThreshold`, `scoring`, per-question `scoringWeight`, `scoringOptions`, `category`, `knockout`, `knockoutFailValues`, `knockoutOnBlank`
- UI: Reporting feasibility board + `exportSiteOpsRankHtml`

See also: `docs/SITE_SURVEY_SECURITY.md`, strategy canvas **Feasibility System Strategy**.
