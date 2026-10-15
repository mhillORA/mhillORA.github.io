"""Remap Cavalry identity/equipment libraryQuestionIds onto shared canon used by bridges."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_cavalry_nk_survey import cosmos_db  # noqa: E402

SURVEY_ID = "survey-cavalry-nk-feasibility"
APPLY = "--apply" in sys.argv

# Cavalry questionId → shared canonical libraryQuestionId
REMAP_BY_ID = {
    "cav_adm-1_date": "ql-gf-01-date-of-response",
    "cav_adm-2a_first-last-name-of-respondent": "ql-gf-00-name",
    "cav_adm-2b_phone-number-of-respondent-with-area-code": "ql-form-filler-phone",
    "cav_adm-2c_title-position-of-respondent": "ql-form-filler-role",
    "cav_adm-2d_email-address-of-respondent": "ql-form-filler-email",
    "cav_adm-4d_pi-credentials": "ql-pi-credentials",
    "cav_adm-4e_pi-specialty-focus": "ql-pi-specialty",
    "cav_stu-6a_does-your-site-have-a-slit-lamp-camera": "ql-slit-lamp-camera",
    # slit-lamp make/model (NOT AS-OCT make/model at cav_stu-8b)
    "cav_stu-6b_if-yes-what-is-the-make-and-model": "ql-slit-lamp-camera-model",
    "cav_stu-3_has-your-site-collected-tear-samples-using-schir": "ql-schirmer-tear-samples",
    "cav_stu-2_are-your-pi-and-or-sub-investigators-familiar-wi": "ql-mackie-criteria-nk",
    "cav_stu-4a_the-protocol-requires-corneal-sensitivity-to-be-": "ql-cochet-bonnet-esthesiometer",
    "cav_lab-1a_does-your-site-have-a-certified-phlebotomist-or-": "ql-phlebotomist-lab-samples",
    # undo mistaken AS-OCT → slit-lamp-model remap if present
    "cav_stu-8b_if-yes-what-is-the-make-and-model": "ql-as-oct-make-model",
}


def main() -> None:
    db = cosmos_db()
    c = db.get_container_client("site-survey-definitions")
    s = c.read_item(SURVEY_ID, SURVEY_ID)
    qs = list(s.get("questions") or [])
    changes = []
    for q in qs:
        qid = str(q.get("id") or "")
        want = REMAP_BY_ID.get(qid)
        if not want:
            continue
        prev = q.get("libraryQuestionId")
        if prev == want:
            continue
        q["libraryQuestionId"] = want
        changes.append((qid, prev, want, (q.get("label") or "")[:70]))

    print(f"Remaps needed: {len(changes)}")
    for qid, prev, want, lab in changes:
        print(f"  {qid}\n    {prev!r} -> {want!r}\n    {lab}")

    if not changes:
        print("Already aligned.")
        return
    if not APPLY:
        print("\nDry-run only. Re-run with --apply.")
        return

    s["questions"] = qs
    s["updatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    c.upsert_item(s)
    print(f"\nApplied {len(changes)} remaps on {SURVEY_ID}")


if __name__ == "__main__":
    main()
