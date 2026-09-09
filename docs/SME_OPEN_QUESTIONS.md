# SME open questions (blocking full delivery)

Updated 2026-09-09. Answer these so we can finish the remaining pieces.

## 1. Lookup values (need the lists)
Please paste options for each:
1. Study Statuses  
2. Study Phases (we temporarily used I / II / III / IV / Other — confirm or replace)  
3. Site Statuses  
4. Site Type  
5. Question Categories  
6. Survey Outcomes (Recommend / Needs review / Do Not Recommend / Unanswered — confirm names)  
7. Site Status By Study  
8. Indications (canonical list)  
9. Services (for Add Study — what replaces current services?)  
10. Sponsors — do you want Sponsor **profiles** (name, contacts, linked studies), or just a free-text / dropdown name for now?

## 2. I/E Criteria Repository
Shell page is in nav. What fields per criterion?
- Inclusion vs Exclusion?
- Indication / study link?
- Versioning?
- Free text only, or structured (category, operator, value)?

## 3. Feasibility Links + Responses placement
Keep under Feasibility panels, or move to:
- Reporting?
- Per-study page?
- A new “Questionnaire ops” area?

## 4. Study × group rows
On Completed Studies / site history tables, what does each “study × group” row mean?
- One row per study?
- One row per treatment group/arm?
- Something else?

## 5. Site Profile entity
Keep a separate Site Profile (Budget Buddy fields), or fold everything into the Sites record and drop the extra tab?

## 6. Role dashboards — exact tiles
Ops / Monitoring / Exec selector exists. What should each role see?
- Ops: ?
- Monitoring: ?
- Exec Leadership: ?

## 7. Scope confirmation (later)
Confirm these stay **later** (not this push):
- Veeva-linked milestones
- FPFV/LPLV vs budget + ahead/behind flags
- Assumed vs actual enrollment progress flags
- Budgeted SF vs actual SF flags
- Full portfolio management report
- PI/Coordinator auto-fill from feasibility on Add Site (we can do next if you want it now)

## 8. Site Unique Identifier format
Site Code is now required + immutable after set. Preferred format?
- Free text (e.g. `ANDOVER-01`)?
- Auto-generated?
- Must match an existing external ID (Veeva / Monday)?
