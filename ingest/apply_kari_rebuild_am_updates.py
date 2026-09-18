"""
Apply Kari / Stealth ReBUILD content + branching fixes for AM.

- introBlurb: Study Assumptions & Timelines
- confirmMessage: Stealth thank-you copy
- Q1/Q2 logic: showIf No + endSurveyIf on reason choices
- Q1 scoring: No → not_interested
- Colorado Retina site.pi → Adam Murtaza (First Last; email madam@…)

Usage:
  python ingest/apply_kari_rebuild_am_updates.py
  python ingest/apply_kari_rebuild_am_updates.py --apply
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
COLORADO_ID = "1a0908a7c621f7958cd"

# Allie's current reason choices (ops-owned wording — do not "fix" back to the old combined line).
REASON_OPTIONS = [
    "Lack of Patients",
    "Eligibility Criteria",
    "Competing studies, ongoing or planned",
    "Lack of time and/or research staff",
    "Lack of Equipment",
    "Protocol-related concerns",
    "Other",
]

ASSUMPTIONS = (
    "To support the planned study timelines across approximately 45 sites, "
    "each site should project to screen 2 patients per month and randomize at least "
    "1 patient per month. These expectations support the overall target of 300 "
    "randomized subjects, with First Patient First Visit planned for 16-Nov-2026 "
    "and Last Patient First Visit for 28-Aug-2027."
)
THANK_YOU = (
    "Thank you for your interest in the Stealth BioTherapeutics study and taking "
    "the time to answer this questionnaire. Your contact details and information "
    "will be retained by Stealth BioTherapeutics for possible future use."
)


def load_client():
    candidates = [
        Path(r"C:\Users\shue1\OneDrive\Desktop\New folder\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
        Path(r"C:\Users\shue1\OneDrive\Desktop\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
        REPO / "api" / "local.settings.json",
        REPO / "data-api-connections.json",
    ]
    endpoint = "https://ora-clinical-recruiting.documents.azure.com:443/"
    key = ""
    db = "crcscheduling"
    for p in candidates:
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        vals = data.get("Values") or {}
        key = vals.get("COSMOS_KEY") or key
        endpoint = vals.get("COSMOS_ENDPOINT") or endpoint
        db = vals.get("DATABASE_ID") or db
        conn = (data.get("cosmosdb-connection") or {}).get("connectionString") or ""
        if conn and not key:
            parts = {}
            for chunk in conn.rstrip(";").split(";"):
                if "=" in chunk:
                    k, v = chunk.split("=", 1)
                    parts[k.strip()] = v.strip()
            key = parts.get("AccountKey") or key
            endpoint = parts.get("AccountEndpoint") or endpoint
        if key:
            break
    if not key:
        raise SystemExit("COSMOS_KEY missing")
    return CosmosClient(endpoint, key).get_database_client(db)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = load_client()
    defs = db.get_container_client("site-survey-definitions")
    doc = defs.read_item(SURVEY_ID, SURVEY_ID)
    before = {
        "title": doc.get("title"),
        "introBlurb": (doc.get("introBlurb") or "")[:80],
        "confirmMessage": (doc.get("confirmMessage") or "")[:80],
    }

    doc = deepcopy(doc)
    doc["introBlurb"] = ASSUMPTIONS
    doc["confirmMessage"] = THANK_YOU
    doc["thankYouMessage"] = THANK_YOU
    doc["protocolLabel"] = "Stealth BioTherapeutics Protocol: MYTX272AM-201"
    doc["studyTitleFull"] = (
        "A Phase 2/3, Randomized, Double-Masked, Vehicle-Controlled, Dose-Ranging "
        "Clinical Trial to Evaluate the Efficacy and Safety of Once Daily Bevemipretide "
        "Ophthalmic Topical Solution in Subjects who have Dry Age-Related Macular Degeneration (Dry AMD)"
    )
    # Keep Artemis list title short; live header uses site-survey.html rebuild branding.
    doc["title"] = "ReBUILD Feasibility (MYTX272AM-201)"
    doc["studyCode"] = "MYTX272AM-201"
    doc["protocolName"] = "ReBUILD"

    qs = doc.get("questions") or []
    by_id = {str(q.get("id") or ""): q for q in qs}
    interest = by_id.get(INTEREST_ID)
    reason = by_id.get(REASON_ID)
    comments = by_id.get(COMMENTS_ID)
    if not interest or not reason:
        raise SystemExit("missing interest/reason questions")

    # Do NOT mark Q1 "No" as endSurveyIf / notInterested in scoring —
    # that would skip Q2 reasons. End-early happens when a reason is chosen.
    interest["scoringOptions"] = [
        {"value": "Yes", "points": 10},
        {"value": "No", "points": 0},
    ]
    interest["logic"] = interest.get("logic") if isinstance(interest.get("logic"), dict) else {}
    interest["logic"].pop("endSurveyIf", None)

    opts = list(REASON_OPTIONS)
    reason["options"] = opts
    reason["type"] = "multiselect"
    reason["scoringOptions"] = [
        {
            "value": o,
            "points": 0,
            "knockout": True,
            "notInterested": True,
            "disposition": "not_interested",
        }
        for o in opts
    ]
    reason["logic"] = {
        "showIf": {"questionId": INTEREST_ID, "equals": "No"},
        "endSurveyIf": {
            "includesAny": opts,
            "showThroughQuestionId": COMMENTS_ID,
        },
    }
    if comments:
        comments["required"] = False
        comments["type"] = "textarea"
        comments["logic"] = {
            "showIf": {"questionId": INTEREST_ID, "equals": "No"},
        }

    print("BEFORE", json.dumps(before, indent=2))
    print("AFTER introBlurb:", doc["introBlurb"][:120], "...")
    print("AFTER confirm:", doc["confirmMessage"][:100], "...")
    print("reason options:", reason["options"])
    print("reason logic:", json.dumps(reason["logic"], indent=2))

    sites = db.get_container_client("sites")
    site = sites.read_item(COLORADO_ID, COLORADO_ID)
    print("Colorado PI before:", site.get("pi"), site.get("piEmail"))

    if not args.apply:
        print("Dry run only — pass --apply to write.")
        return

    doc["questions"] = qs
    doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
    defs.upsert_item(doc)
    print("Upserted survey definition", SURVEY_ID)

    site["pi"] = "Adam Murtaza"
    site["piName"] = "Adam Murtaza"
    site["piFirstName"] = "Adam"
    site["piLastName"] = "Murtaza"
    site["updatedAt"] = datetime.now(timezone.utc).isoformat()
    sites.upsert_item(site)
    print("Updated Colorado Retina PI -> Adam Murtaza (First Last)")


if __name__ == "__main__":
    main()
