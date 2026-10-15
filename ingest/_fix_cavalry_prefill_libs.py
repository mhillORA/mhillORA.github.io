"""
Remap Cavalry NK identity questions to canonical libraryQuestionIds
used by buildSiteRecordPrefill (same aliases as GF / ReBUILD).
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_cavalry_nk_survey import cosmos_db  # noqa: E402

SURVEY_ID = "survey-cavalry-nk-feasibility"
APPLY = "--apply" in sys.argv

# questionId -> canonical libraryQuestionId
REMAP_BY_ID = {
    "cav_adm-3a_site-name": "ql-site-name",
    "cav_adm-3b_full-site-address-city-state-postal-code-suite-n": "ql-site-address",
    "q_mv1af5bd_cp2x": "ql-site-city",  # City
    "q_mv1ah439_18ck": "ql-site-state",  # State
    "q_mv1af5bd_rrgf": "ql-site-zip",  # Zip/Postal Code
    "cav_adm-3c_site-phone-number": "ql-site-phone",
    "cav_adm-4a_principal-investigator-s-pi-first-last-name": "ql-pi-name",
    "cav_adm-4b_pi-phone-number": "ql-pi-phone",
    "cav_adm-4c_pi-email-address": "ql-pi-email",
    "cav_adm-5a_site-coordinator-first-last-name": "ql-coord-name",
    "cav_adm-5b_site-coordinator-email-address": "ql-coord-email",
    "cav_adm-5c_site-coordinator-phone-number": "ql-coord-phone",
}

# Fallback by exact label (normalized) if ids drift
REMAP_BY_LABEL = {
    "site name": "ql-site-name",
    "site street address": "ql-site-address",
    "city": "ql-site-city",
    "state": "ql-site-state",
    "zip/postal code": "ql-site-zip",
    "zip postal code": "ql-site-zip",
    "site phone number": "ql-site-phone",
    "principal investigator's (pi) first & last name": "ql-pi-name",
    "principal investigators (pi) first & last name": "ql-pi-name",
    "pi phone number": "ql-pi-phone",
    "pi email address": "ql-pi-email",
    "site coordinator first & last name": "ql-coord-name",
    "site coordinator email address": "ql-coord-email",
    "site coordinator phone number": "ql-coord-phone",
}


def norm_label(s: str) -> str:
    return " ".join(str(s or "").lower().replace("&", "and").replace("'", "").split())


def main() -> None:
    db = cosmos_db()
    c = db.get_container_client("site-survey-definitions")
    s = c.read_item(SURVEY_ID, SURVEY_ID)
    qs = list(s.get("questions") or [])
    changes = []
    for q in qs:
        qid = str(q.get("id") or "")
        lab = norm_label(q.get("label") or "")
        want = REMAP_BY_ID.get(qid) or REMAP_BY_LABEL.get(lab)
        if not want:
            continue
        prev = q.get("libraryQuestionId")
        if prev == want:
            continue
        q["libraryQuestionId"] = want
        changes.append((qid, prev, want, (q.get("label") or "")[:60]))

    print(f"Survey questions: {len(qs)}")
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
    print(f"\nApplied {len(changes)} libraryQuestionId remaps on {SURVEY_ID}")


if __name__ == "__main__":
    main()
