"""
Ensure every General Feasibility question has a libraryQuestionId.
- Map obvious ones to settled ql-* ids
- Create ql-gf-* for the rest (unique)
- Sync Short from Long (same ids)
- Upsert library aliases so prefill/deltas work
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
LONG_ID = "survey-general-feasibility"
SHORT_ID = "survey-general-feasibility-short"
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

# Manual map: GF question id -> settled library id (unique concepts)
MANUAL_MAP = {
    "gf_02_site-name": "ql-site-name",
    "gf_03_address": "ql-site-address",
    "gf_04_phone": "ql-site-phone",
    "gf_07_investigator-1": "ql-pi-name",
    "gf_09_inv-1-email": "ql-pi-email",
    "gf_15_research-contact": "ql-coord-name",
    "gf_16_poc-email": "ql-coord-email",
    "gf_17_poc-role": "ql-primary-contact-role",
    "gf_30_contracting-contact": "ql-contracts-name",
}


def norm(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def load_db():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return CosmosClient(parts["AccountEndpoint"], parts["AccountKey"]).get_database_client(
        "crcscheduling"
    )


def main():
    apply = "--apply" in __import__("sys").argv
    db = load_db()
    defs = db.get_container_client("site-survey-definitions")
    lib = db.get_container_client("site-survey-question-library")
    now = datetime.now(timezone.utc).isoformat()

    long_def = defs.read_item(LONG_ID, LONG_ID)
    qs = list(long_def.get("questions") or [])

    live = {i["id"]: i for i in lib.query_items("SELECT * FROM c", enable_cross_partition_query=True)}

    created = updated_lib = linked = 0
    for q in qs:
        qid = str(q.get("id") or "")
        label = str(q.get("label") or "").strip()
        lib_id = MANUAL_MAP.get(qid) or f"ql-{qid}"
        # normalize ql-gf_00_name style
        if lib_id.startswith("ql-gf_"):
            lib_id = "ql-" + qid.replace("_", "-")

        qtype = str(q.get("type") or "text").lower()
        if qtype not in {"text", "textarea", "number", "date", "select"}:
            qtype = "text"
        options = q.get("options") or []
        if qtype == "select" and len(options) < 2:
            qtype = "text"
            options = []

        existing = live.get(lib_id)
        aliases = list(
            dict.fromkeys(
                [
                    label,
                    *(existing.get("aliases") if existing else []),
                    qid,
                ]
            )
        )
        doc = {
            "id": lib_id,
            "label": (existing or {}).get("label") or label,
            "type": (existing or {}).get("type") or qtype,
            "options": (existing or {}).get("options") or options,
            "category": (existing or {}).get("category") or "General Feasibility",
            "required": True if (existing or {}).get("required") is None else existing.get("required"),
            "scoringWeight": (existing or {}).get("scoringWeight") or 0,
            "scoringOptions": (existing or {}).get("scoringOptions") or [],
            "knockout": bool((existing or {}).get("knockout")),
            "knockoutOnBlank": bool((existing or {}).get("knockoutOnBlank")),
            "knockoutFailValues": (existing or {}).get("knockoutFailValues") or [],
            "status": "active",
            "tags": list(
                dict.fromkeys(
                    ((existing or {}).get("tags") or [])
                    + ["general-feasibility", "settled-seed" if lib_id in MANUAL_MAP.values() else "gf-unique"]
                )
            ),
            "aliases": aliases,
            "mapsToProfile": (existing or {}).get("mapsToProfile"),
            "source": "general-feasibility-library-link",
            "createdAt": (existing or {}).get("createdAt") or now,
            "updatedAt": now,
        }
        # Prefer settled canonical label if this is a mapped settled id
        if existing and existing.get("id") in MANUAL_MAP.values():
            doc["label"] = existing.get("label") or doc["label"]
            # still add GF label as alias
            if label and label not in doc["aliases"]:
                doc["aliases"].append(label)

        print(f"  lib {lib_id} <- {qid}: {label[:60]}")
        if apply:
            lib.upsert_item(doc)
            live[lib_id] = doc
            if existing:
                updated_lib += 1
            else:
                created += 1

        if q.get("libraryQuestionId") != lib_id:
            q["libraryQuestionId"] = lib_id
            linked += 1

    long_def["questions"] = qs
    long_def["title"] = "General Feasibility (Long)"
    long_def["updatedAt"] = now

    # rebuild short from long
    by_id = {str(q.get("id")): q for q in qs}
    short_qs = [dict(by_id[i]) for i in SHORT_IDS if i in by_id]
    try:
        short_def = defs.read_item(SHORT_ID, SHORT_ID)
    except Exception:
        short_def = {"id": SHORT_ID, "createdAt": now}
    short_def.update(
        {
            "id": SHORT_ID,
            "title": "General Feasibility (Short)",
            "description": (
                "Compact site profile — subset of Long with the same question IDs/library ids. "
                "Auto-prepend on study surveys when Short is selected."
            ),
            "status": "active",
            "questions": short_qs,
            "generalFeasibilityVariant": "short",
            "predefined": True,
            "tags": ["general-feasibility", "general-feasibility-short", "predefined"],
            "updatedAt": now,
        }
    )

    print(f"\nLong qs={len(qs)} linked_changed={linked} short_qs={len(short_qs)}")
    print(f"Library create={created} update={updated_lib} mode={'APPLY' if apply else 'DRY'}")
    if apply:
        defs.upsert_item(long_def)
        defs.upsert_item(short_def)
        print("Upserted Long + Short definitions")

    # verify
    unmatched = [q for q in qs if not q.get("libraryQuestionId")]
    print(f"GF questions without libraryQuestionId: {len(unmatched)}")


if __name__ == "__main__":
    main()
