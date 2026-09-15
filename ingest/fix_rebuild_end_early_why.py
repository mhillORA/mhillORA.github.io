"""
Keep existing additional-comments visible when end-early reason is selected.
No new field — restore original comments label/type and wire show-through.

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
COMMENTS_ID = "rebuild_016_do-you-have-any-additional-comments-you-"
COMMENTS_LABEL = "Do you have any additional comments you would like to provide?"


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
    comments = by_id.get(COMMENTS_ID)
    if not reason or not comments:
        raise SystemExit("missing reason or comments question")

    opts = [str(o).strip() for o in (reason.get("options") or []) if str(o).strip()]
    reason["logic"] = {
        "showIf": {"questionId": INTEREST_ID, "equals": "No"},
        "endSurveyIf": {
            "includesAny": opts,
            # Keep the existing comments box visible; hide only what follows it.
            "showThroughQuestionId": COMMENTS_ID,
        },
    }
    comments["label"] = COMMENTS_LABEL
    comments["type"] = "textarea"
    comments["required"] = False
    comments["section"] = reason.get("section") or comments.get("section")
    comments["logic"] = {
        "showIf": {"questionId": INTEREST_ID, "equals": "No"},
    }

    print("reason endSurveyIf:", json.dumps(reason["logic"]["endSurveyIf"], indent=2))
    print("comments:", comments["label"], comments["type"])

    if not args.apply:
        print("Dry run only.")
        return

    doc["questions"] = qs
    doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
    doc["endEarlyCommentsWiredAt"] = doc["updatedAt"]
    c.upsert_item(doc)
    print("APPLIED")


if __name__ == "__main__":
    main()
