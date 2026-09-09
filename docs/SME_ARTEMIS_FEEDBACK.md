# ARTEMIS SME feedback backlog

Captured 2026-09-09. Status: `done` | `partial` | `todo` | `later` | `needs-spec`.

---

## Cross-cutting

| ID | Ask | Status | Notes |
|----|-----|--------|-------|
| X1 | Unique identifier for each site (immutable) | partial | Site Code exists; make required, immutable, used as UID everywhere |
| X2 | Rename Past Studies → Completed Studies everywhere | todo | UI copy sweep |
| X3 | Past Sites → Master Site List | todo | Incl. back-button copy |
| X4 | Whole numbers only (screened/scheduled/enrolled) | todo | No decimals |
| X5 | Lookup tables (10 lists) | needs-spec | SME to provide list values |
| X6 | New nav: I/E Criteria Repository | todo | Header/placeholder first |

---

## Dashboard

| ID | Ask | Status |
|----|-----|--------|
| D1 | Clickable tiles → filtered target tab (e.g. 48 live sites → Sites filtered) | todo |
| D2 | Role-specific dashboard (Ops / Monitoring / Exec Leadership) | todo |
| D3 | 30-day trend sparklines on key tiles (e.g. patients enrolled) | todo |

---

## Studies

| ID | Ask | Status |
|----|-----|--------|
| ST1 | Add Study: remove Groups | todo |
| ST2 | Add Sponsor Name, Indication, Phase | todo |
| ST3 | Title block shows Sponsor + Indication + Phase | todo |
| ST4 | Timeline milestones: Start-up, Conduct (%), DB Lock | later |
| ST5 | FPFV/LPLV vs budget + ahead/behind | later |
| ST6 | Flag assumed enrollment progress vs actual | later |
| ST7 | Budget / SF rate vs actual + flags | later |
| ST8 | Link study ↔ feasibility survey + I/E criteria | todo |

---

## Sites

| ID | Ask | Status |
|----|-----|--------|
| SI1 | Add Site: PI/Coordinators from feasibility responses | todo |
| SI2 | Add Unique Identifier; remove site name abbreviation | todo |
| SI3 | Mailing address = same as site address checkbox | todo |
| SI4 | Indication Experience block (indication, # studies, pts enrolled, pts/site/month, SF%) | todo |
| SI5 | Flag stale feasibility + prompt to send recurring | todo |

### Site Profile

| ID | Ask | Status |
|----|-----|--------|
| SP1 | Remove Past Studies block; Completed Studies only | todo |
| SP2 | Total Studies → Completed Studies | todo |
| SP3 | Enrolled (Live) → Patients Currently Enrolled In Trials | todo |
| SP4 | Legacy Enrolled → Total Patients Enrolled All Time | todo |
| SP5 | Surveys → Study Specific Feasibility Questionnaires (click-through) | todo |
| SP6 | Swap Site Information / Historical Performance order | todo |
| SP7 | Historical Performance → Historic Performance Metrics (click-through; close parent modal) | todo |
| SP8 | Drop summed historical performance; keep count + link | todo |
| SP9 | Site Preferences → Site Status | todo |
| SP10 | Relationship → Site Status (tie to report cards) | todo |
| SP11 | Header: Screened, Enrolled, Target Enrolled, Enrolled vs Target % | todo |
| SP12 | Back button: Master Site List (not All Legacy Sites) | todo |
| SP13 | Site Code required + immutable UID | todo |
| SP14 | Remove Target schedule; Screen/Sched → Scheduled to Screened Rate %; Enroll/Screen → Enrollment %; remove Enroll/Sched | todo |
| SP15 | Studies at this site → Completed Studies table columns: Study, Indication, PI, Groups, Scheduled, Screened, Enrolled, SF%, Enrollment Ranking | todo |
| SP16 | Clarify “every study × group row” meaning | needs-spec |
| SP17 | “Site Profile (Is this needed)” | needs-spec |

---

## Feasibility *(active workstream)*

| ID | Ask | Status | Notes |
|----|-----|--------|-------|
| F0 | Comms → Feasibility; remove subtitle under “Send secure…” | partial | Tab rename done; scrub remaining Comms + subtitle |
| F1 | Question bank with scoring notes + ranking guidance | partial | Seed JSON ready; push + scoring notes TBD |
| F2 | Question types + dropdown responses | partial | text/select/number/date; multiselect/matrix designed |
| F3 | Default all questions required (except branching when hidden) | done | |
| F4 | Templates pull **only** from question bank | todo | |
| F5 | Templates: remove words under Survey name | todo | |
| F6 | Backfill legacy responses into surveys | partial | Ingest exists; library link + assign next |
| F7 | Per-study questionnaire status dashboard (sent / recommended / need review / DNR / unanswered) | todo | |
| F8 | Sponsor rollup: scores + ranks + full answers | todo | |
| F9 | Rename surveys in Responses UI | todo | |
| F10 | Move Links + Responses elsewhere (IA) | needs-spec | |
| F11 | Settled questions → library → assign to prior studies/surveys | in-progress | `ingest/feasibility_question_library_seed.json` |

---

## People

| ID | Ask | Status |
|----|-----|--------|
| P1 | Remove PI/Coordinator tab; manage on Sites | todo |

---

## Reporting

| ID | Ask | Status |
|----|-----|--------|
| R1 | Combine feasibility outcome + enrollment into one sponsor export per study | todo |
| R2 | Portfolio management report (funnel, slippage, budget variance, workload, pipeline) | later |
| R3 | PDF/Excel export + generation date on every export | todo |

---

## History

| ID | Ask | Status |
|----|-----|--------|
| H1 | Past Studies → Completed Studies | todo |
| H2 | Past Sites → Master Site List | todo |

---

## I/E Criteria Repository (new)

| ID | Ask | Status |
|----|-----|--------|
| IE1 | Add nav header/page shell | todo |
| IE2 | Content model | needs-spec |

---

## Lookup tables (SME to supply values)

1. Study Statuses  
2. Study Phases  
3. Site Statuses  
4. Site Type  
5. Question Categories  
6. Survey Outcomes  
7. Site Status By Study  
8. Indications  
9. Services (update Add Study)  
10. Sponsor (profiles + link studies by sponsor)

---

## Suggested build order

1. **Feasibility bank** — push seed → link templates/legacy → scoring notes (F1–F6, F11)  
2. **Copy + IA quick wins** — Feasibility subtitle, Completed Studies / Master Site List, Site Profile labels (F0, X2–X3, SP*, H*)  
3. **Site UID** — immutable Site Code (X1, SP13, SI2)  
4. **Dashboard click-through tiles** (D1)  
5. **Studies title block** Sponsor/Indication/Phase; remove Groups (ST1–ST3)  
6. **Feasibility study status board** (F7)  
7. **Reporting combine + exports** (R1, R3)  
8. **Lookups + I/E shell** (X5, X6, IE1)  
9. **Timeline / budget / Veeva** (ST4–ST7) — later  

---

## Open questions for SME

- Confirm meaning of study × group rows (SP16)  
- Keep separate Site Profile entity or fold into Sites? (SP17)  
- Where Links + Responses should live (F10)  
- Provide the 10 lookup value lists  
- I/E Criteria repository fields  
