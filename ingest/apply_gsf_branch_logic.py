"""
Apply yellow-highlight Branch Logic from GSF DOCX onto Cosmos GF Long/Short.

Preserves 103 numbered DOCX questions + any describe/comment follow-up cards.
Does not insert investigator/% extra cards (those stay as help on Q27/Q37).

Yellow rules applied as showIf on existing numbered questions:
  1. Q21=No → hide Q22–Q26 (research-naïve)
  2. Q27 options fixed to investigator count bands (details in Q27 help)
  3. Q81 includes Anterior segment or Both → show Q82–Q83
  4. Q32 has any option other than "None commonly observed" → show Q33
  5. Q37 population note kept as help (no extra % question card)

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
    """Primary numbered question per docxNum (skip describe follow-ups)."""
    out = {}
    for q in questions:
        n = q.get("docxNum")
        if not isinstance(n, int):
            continue
        if q.get("followUpOf") or "_fu_" in str(q.get("id") or "") or q.get("followUpSource"):
            continue
        if n not in out:
            out[n] = q
    return out


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
    # Keep numbered parents (first per docxNum) + describe/comment follow-ups.
    # Drop investigator / % estimate extras that are not followUpOf docx notes.
    seen_primary = set()
    qs = []
    for q in deepcopy(questions):
        qid_s = str(q.get("id") or "")
        if q.get("followUpOf") or "_fu_" in qid_s or q.get("followUpSource"):
            qs.append(q)
            continue
        num = q.get("docxNum")
        if not isinstance(num, int):
            continue
        # Skip legacy inv / 037b cards if re-synced with them present
        if qid_s.startswith(("gsf_027a_", "gsf_027b_", "gsf_027c_", "gsf_027d_", "gsf_027e_", "gsf_027f_", "gsf_027g_", "gsf_037b_")):
            continue
        if num in seen_primary:
            continue
        seen_primary.add(num)
        qs.append(q)

    id21 = qid(qs, 21)
    id32 = qid(qs, 32)
    id33 = qid(qs, 33)
    id37 = qid(qs, 37)
    id81 = qid(qs, 81)
    id82 = qid(qs, 82)
    id83 = qid(qs, 83)

    # Fix Q27 options — count only (investigator sub-fields stay as help, not extra cards)
    q27 = by_docx(qs).get(27)
    if q27:
        q27["options"] = ["1–3", "4–6", "7–10"]
        q27["type"] = "radio"
        help_bits = [str(q27.get("help") or "").strip()]
        help_bits.append(
            "Include Investigator #1 name, email, phone, credentials (MD/OD/DO), and years of "
            "clinical research experience in the site profile / comments as applicable. "
            "For 4+ investigators, also include Investigator #2 name and email."
        )
        q27["help"] = " ".join(x for x in help_bits if x).strip()

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
            "If No, Q22–Q26 are skipped and the site is flagged as research-naïve."
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

    # 5) Population % guidance stays on Q37 help (no extra numbered/unnumbered card)
    if id37:
        q37 = by_docx(qs).get(37)
        if q37:
            help_bits = [str(q37.get("help") or "").strip()]
            note = (
                "If any group is selected, estimate approximate % of your patient population "
                "for each selected group (total may be approximate) in comments if requested."
            )
            if note not in " ".join(help_bits):
                help_bits.append(note)
            q37["help"] = " ".join(x for x in help_bits if x).strip()

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
    long_def["pages"] = []
    for q in new_qs:
        title = (q.get("category") or q.get("section") or "General").strip() or "General"
        if not long_def["pages"] or long_def["pages"][-1]["title"] != title:
            long_def["pages"].append(
                {"id": f"page-{len(long_def['pages']) + 1}", "title": title, "questionIds": []}
            )
        long_def["pages"][-1]["questionIds"].append(q["id"])
    long_def["docxQuestionCount"] = len(new_qs)
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
    short_def["pages"] = [
        {
            "id": "page-short",
            "title": "General Feasibility (Short)",
            "questionIds": [q["id"] for q in short_qs if q.get("id")],
        }
    ]
    short_def["docxQuestionCount"] = len(short_qs)
    short_def["updatedAt"] = now
    short_def["branchLogicSource"] = "gsf-docx-yellow-highlights-10sep2026"
    def_c.upsert_item(short_def)
    print("Applied to Long + Short in Cosmos.")


if __name__ == "__main__":
    main()
