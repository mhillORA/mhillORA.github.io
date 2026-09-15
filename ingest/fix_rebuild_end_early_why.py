"""
Wire rebuild not-interested flow:
  1) Select reason checkbox(es)
  2) Show short-text "why not"
  3) End survey only when reason selected AND why text is filled

Usage:
  python ingest/fix_rebuild_end_early_why.py --apply
"""
from __future__ import annotations

import argparse
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
SURVEY_ID = "survey-rebuild-mytx272am-201"
INTEREST_ID = "rebuild_013_has-the-investigator-reviewed-the-protoc"
REASON_ID = "rebuild_014_if-not-interested-what-is-the-reason"
WHY_ID = "rebuild_016_do-you-have-any-additional-comments-you-"
WHY_LABEL = "Please briefly explain why you are not interested"


def cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    parts = dict(
        x.split("=", 1)
        for x in data["cosmosdb-connection"]["connectionString"].rstrip(";").split(";")
        if "=" in x
    )
    return (
        CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
        .get_database_client("crcscheduling")
        .get_container_client("site-survey-definitions")
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    c = cosmos()
    doc = c.read_item(SURVEY_ID, SURVEY_ID)
    qs = deepcopy(doc.get("questions") or [])
    by_id = {str(q.get("id") or ""): q for q in qs}

    reason = by_id.get(REASON_ID)
    why = by_id.get(WHY_ID)
    if not reason:
        raise SystemExit(f"missing reason question {REASON_ID}")
    if not why:
        # Insert why text right after reason
        why = {
            "id": WHY_ID,
            "label": WHY_LABEL,
            "type": "text",
            "required": True,
            "options": [],
            "section": reason.get("section") or "SECTION 1: CONTACT INFORMATION",
            "category": reason.get("category") or "CONTACT INFORMATION",
            "libraryQuestionId": None,
        }
        idx = next(i for i, q in enumerate(qs) if str(q.get("id")) == REASON_ID)
        qs.insert(idx + 1, why)
        by_id[WHY_ID] = why
        print(f"INSERT why question after reason at {idx+1}")
    else:
        why["label"] = WHY_LABEL
        why["type"] = "text"  # short text, not long textarea
        why["required"] = True
        why["section"] = reason.get("section") or why.get("section")
        print(f"UPDATE why question {WHY_ID}")

    opts = [str(o).strip() for o in (reason.get("options") or []) if str(o).strip()]
    reason["logic"] = {
        "showIf": {"questionId": INTEREST_ID, "equals": "No"},
        "endSurveyIf": {
            "includesAny": opts,
            "requireFilledQuestionId": WHY_ID,
        },
    }
    why["logic"] = {
        "showIf": {"questionId": INTEREST_ID, "equals": "No"},
    }
    # Keep why visible while ending reasons are being filled — public form won't hide it
    # until requireFilledQuestionId has data.

    print("reason endSurveyIf:", json.dumps(reason["logic"]["endSurveyIf"], indent=2)[:500])
    print("why label:", why["label"], "type:", why["type"], "required:", why["required"])

    if not args.apply:
        print("Dry run only. Re-run with --apply.")
        return

    doc["questions"] = qs
    doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
    doc["endEarlyWhyWiredAt"] = doc["updatedAt"]
    c.upsert_item(doc)
    print("APPLIED")


if __name__ == "__main__":
    main()
