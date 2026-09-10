"""
Apply yellow-highlight Branch Logic from GSF DOCX onto Cosmos GF Long/Short.

Yellow rules (from DOCX highlight):
  1. Q21=No → hide Q22–Q26 (research-naïve)
  2. Q27 investigator count → Inv #1 always; Inv #2+ when count is 4–6 or 7–10
  3. Q81 includes Anterior segment or Both → show Q82–Q83
  4. Q32 has any option other than "None commonly observed" → show Q33
  5. Q37 has any population selected → show % estimate follow-up

Usage:
  python ingest/apply_gsf_branch_logic.py
  python ingest/apply_gsf_branch_logic.py --apply
"""
from __future__ import annotations

import argparse
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from sync_gsf_from_docx import LONG_ID, SHORT_ID, cosmos

REPO = Path(__file__).resolve().parents[1]


def by_docx(questions):
    return {q.get("docxNum"): q for q in questions if isinstance(q.get("docxNum"), int)}


def qid(questions, num):
    q = by_docx(questions).get(num)
    return q.get("id") if q else None


def set_logic(q, show_if: dict):
    q["logic"] = {"showIf": show_if}
    help_bits = [str(q.get("help") or "").strip()]
    note = "Shown only when branch conditions are met."
    if note not in " ".join(help_bits):
        help_bits.append(note)
    q["help"] = " ".join(x for x in help_bits if x).strip()


def ensure_question(questions, *, after_num, new_q):
    """Insert new_q after docxNum after_num if id not already present."""
    if any(q.get("id") == new_q["id"] for q in questions):
        # update in place
        for i, q in enumerate(questions):
            if q.get("id") == new_q["id"]:
                merged = {**q, **new_q}
                questions[i] = merged
                return questions
    out = []
    inserted = False
    for q in questions:
        out.append(q)
        if not inserted and q.get("docxNum") == after_num:
            out.append(new_q)
            inserted = True
    if not inserted:
        out.append(new_q)
    return out


def apply_to_questions(questions: list) -> list:
    qs = deepcopy(questions)
    id21 = qid(qs, 21)
    id27 = qid(qs, 27)
    id32 = qid(qs, 32)
    id33 = qid(qs, 33)
    id37 = qid(qs, 37)
    id81 = qid(qs, 81)
    id82 = qid(qs, 82)
    id83 = qid(qs, 83)

    # Fix Q27 options — count only (investigator fields were mis-parsed as options)
    q27 = by_docx(qs).get(27)
    if q27:
        q27["options"] = ["1–3", "4–6", "7–10"]
        q27["type"] = "radio"
        q27["help"] = (
            "Investigator #1 details are required below. "
            "If your site has 4+ investigators, Investigator #2 fields also appear."
        )

    # 1) Research experience: Q22–26 only if Q21 = Yes
    if id21:
        for num in (22, 23, 24, 25, 26):
            q = by_docx(qs).get(num)
            if q:
                set_logic(q, {"questionId": id21, "equals": "Yes"})
                q["required"] = True

    # Mark Q21 help with research-naïve note
    q21 = by_docx(qs).get(21)
    if q21:
        q21["help"] = (
            'If No, Q22–Q26 are skipped and the site is flagged as research-naïve.'
        )
        q21["flags"] = {"researchNaiveWhen": "No"}

    # 3) Anterior CAE questions only if Anterior / Both selected on Q81
    if id81:
        for qid_target, num in ((id82, 82), (id83, 83)):
            q = by_docx(qs).get(num)
            if q and qid_target:
                set_logic(
                    q,
                    {
                        "questionId": id81,
                        "includesAny": ["Anterior segment", "Both"],
                    },
                )

    # 4) Q33 only if Q32 has something other than "None commonly observed"
    if id32 and id33:
        q33 = by_docx(qs).get(33)
        if q33:
            set_logic(
                q33,
                {
                    "questionId": id32,
                    "notOnly": "None commonly observed",
                },
            )

    # 5) Population % follow-up after Q37
    if id37:
        pct_q = {
            "id": "gsf_037b_estimate-percent-by-selected-population",
            "libraryQuestionId": "ql-gsf_037b_estimate-percent-by-selected-population",
            "label": (
                "For each racial/ethnic group you selected, estimate the approximate "
                "percentage of your patient population (total may be approximate)."
            ),
            "type": "textarea",
            "required": False,
            "category": "SECTION 7: DIVERSITY, EQUITY & INCLUSION IN RESEARCH",
            "section": "SECTION 7: DIVERSITY, EQUITY & INCLUSION IN RESEARCH",
            "docxNum": 37,
            "help": "Shown when at least one population group is selected above.",
            "logic": {"showIf": {"questionId": id37, "notEmpty": True}},
        }
        qs = ensure_question(qs, after_num=37, new_q=pct_q)

    # 2) Investigator detail blocks driven by Q27 count
    if id27:
        inv1 = [
            {
                "id": "gsf_027a_investigator-1-name",
                "libraryQuestionId": "ql-pi-name",
                "label": "Investigator #1 — First and Last Name",
                "type": "text",
                "required": True,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
            },
            {
                "id": "gsf_027b_investigator-1-email",
                "libraryQuestionId": "ql-pi-email",
                "label": "Investigator #1 — Email",
                "type": "text",
                "required": True,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
            },
            {
                "id": "gsf_027c_investigator-1-phone",
                "libraryQuestionId": "ql-pi-phone",
                "label": "Investigator #1 — Phone",
                "type": "text",
                "required": True,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
            },
            {
                "id": "gsf_027d_investigator-1-credentials",
                "libraryQuestionId": "ql-gf-08-inv-1-credentials",
                "label": "Investigator #1 — Credentials (MD / OD / DO)",
                "type": "text",
                "required": True,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
            },
            {
                "id": "gsf_027e_investigator-1-years",
                "libraryQuestionId": "ql-gf-11-experience-yrs",
                "label": "Investigator #1 — Years of clinical research experience",
                "type": "number",
                "required": True,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
            },
        ]
        inv2 = [
            {
                "id": "gsf_027f_investigator-2-name",
                "libraryQuestionId": "ql-gf-12-investigator-2",
                "label": "Investigator #2 — First and Last Name",
                "type": "text",
                "required": False,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
                "logic": {
                    "showIf": {
                        "questionId": id27,
                        "includesAny": ["4–6", "7–10"],
                    }
                },
                "help": "Shown when investigator count is 4 or more.",
            },
            {
                "id": "gsf_027g_investigator-2-email",
                "libraryQuestionId": "ql-gf-12-investigator-2-email",
                "label": "Investigator #2 — Email",
                "type": "text",
                "required": False,
                "category": "SECTION 4: INVESTIGATORS",
                "section": "SECTION 4: INVESTIGATORS",
                "docxNum": 27,
                "logic": {
                    "showIf": {
                        "questionId": id27,
                        "includesAny": ["4–6", "7–10"],
                    }
                },
            },
        ]
        # Insert after Q27 in reverse so order stays inv1 then inv2
        for block in (inv2[::-1] + inv1[::-1]):
            qs = ensure_question(qs, after_num=27, new_q=block)

    return qs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    def_c = db.get_container_client("site-survey-definitions")
    long_def = def_c.read_item(LONG_ID, LONG_ID)
    short_def = def_c.read_item(SHORT_ID, SHORT_ID)

    before = len(long_def.get("questions") or [])
    new_qs = apply_to_questions(long_def.get("questions") or [])
    branched = [q for q in new_qs if (q.get("logic") or {}).get("showIf")]
    print(f"Long questions: {before} -> {len(new_qs)}")
    print(f"Questions with showIf: {len(branched)}")
    for q in branched:
        sif = (q.get("logic") or {}).get("showIf") or {}
        print(f"  {q.get('docxNum')} {q.get('id')}: {sif}")

    report = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "longBefore": before,
        "longAfter": len(new_qs),
        "branched": [
            {"id": q.get("id"), "docxNum": q.get("docxNum"), "showIf": (q.get("logic") or {}).get("showIf")}
            for q in branched
        ],
    }
    out = REPO / ".firecrawl" / "gsf-branch-logic-report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Report:", out)

    if not args.apply:
        print("Dry run only. Re-run with --apply to write Cosmos.")
        return

    now = datetime.now(timezone.utc).isoformat()
    long_def["questions"] = new_qs
    long_def["updatedAt"] = now
    long_def["branchLogicSource"] = "gsf-docx-yellow-highlights-10sep2026"
    def_c.upsert_item(long_def)

    # Short: keep subset ids; re-apply logic only for questions that remain
    short_ids = {q.get("id") for q in (short_def.get("questions") or [])}
    short_qs = [deepcopy(q) for q in new_qs if q.get("id") in short_ids]
    # If short still uses old 17 ids, rebuild from SHORT_NUMS via sync module
    if len(short_qs) < 10:
        from sync_gsf_from_docx import SHORT_NUMS

        by_num = {q.get("docxNum"): q for q in new_qs}
        short_qs = [deepcopy(by_num[n]) for n in SHORT_NUMS if n in by_num]
    short_def["questions"] = short_qs
    short_def["updatedAt"] = now
    short_def["branchLogicSource"] = "gsf-docx-yellow-highlights-10sep2026"
    def_c.upsert_item(short_def)
    print("Applied to Long + Short in Cosmos.")


if __name__ == "__main__":
    main()
