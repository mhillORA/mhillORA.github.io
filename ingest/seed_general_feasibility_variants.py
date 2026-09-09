"""Create General Feasibility Short (+ rename Long) in Cosmos from existing GF questions."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

# Same IDs as long so prefill/deltas keep working
SHORT_IDS = [
    "gf_02_site-name",
    "gf_03_address",
    "gf_04_phone",
    "gf_05_practice-setting",
    "gf_06_investigators",
    "gf_07_investigator-1",
    "gf_08_inv-1-credentials",
    "gf_09_inv-1-email",
    "gf_10_inv-1-specialties",
    "gf_11_experience-yrs",
    "gf_15_research-contact",
    "gf_16_poc-email",
    "gf_17_poc-role",
    "gf_18_site-coordinators",
    "gf_19_research-experience",
    "gf_20_please-indicate-the-types-of-ophthalmic-studies-your-sit",
    "gf_25_equipment",
    "gf_29_central-irb",
    "gf_30_contracting-contact",
    "gf_31_trials-last-12-mo",
    "gf_32_enrolled-last-12-mo",
]

LONG_ID = "survey-general-feasibility"
SHORT_ID = "survey-general-feasibility-short"


def main():
    data = json.loads(Path("data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    c = (
        CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
        .get_database_client("crcscheduling")
        .get_container_client("site-survey-definitions")
    )
    long_def = c.read_item(LONG_ID, LONG_ID)
    qs = list(long_def.get("questions") or [])
    by_id = {str(q.get("id")): q for q in qs if q.get("id")}
    short_qs = []
    missing = []
    for qid in SHORT_IDS:
        if qid in by_id:
            short_qs.append(dict(by_id[qid]))
        else:
            missing.append(qid)

    now = datetime.now(timezone.utc).isoformat()
    long_def["title"] = "General Feasibility (Long)"
    long_def["description"] = (
        "Full site profile questionnaire. Auto-prepended (Long or Short) on top of study-specific surveys. "
        "Same question IDs are used in Short so answers prefill across both."
    )
    long_def["generalFeasibilityVariant"] = "long"
    long_def["tags"] = list(
        dict.fromkeys((long_def.get("tags") or []) + ["general-feasibility", "general-feasibility-long", "predefined"])
    )
    long_def["updatedAt"] = now
    c.upsert_item(long_def)

    short_def = {
        "id": SHORT_ID,
        "title": "General Feasibility (Short)",
        "description": (
            "Compact site profile (subset of Long, same question IDs). "
            "Choose Short when sending a study survey to auto-prepend these at the top."
        ),
        "status": "active",
        "questions": short_qs,
        "generalFeasibilityVariant": "short",
        "predefined": True,
        "tags": ["general-feasibility", "general-feasibility-short", "predefined"],
        "source": "general-feasibility-short-seed",
        "createdAt": now,
        "updatedAt": now,
        "indication": long_def.get("indication"),
        "therapeuticArea": long_def.get("therapeuticArea"),
    }
    c.upsert_item(short_def)
    print(f"Long: {LONG_ID} title={long_def['title']} questions={len(qs)}")
    print(f"Short: {SHORT_ID} questions={len(short_qs)} missing={missing}")


if __name__ == "__main__":
    main()
