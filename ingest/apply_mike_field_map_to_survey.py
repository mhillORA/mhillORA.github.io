"""
Stamp Mike canonical metadata onto Mighty survey questions (no label overwrite).
Uses ingest/data/mike_mighty_field_map.json.

Dry-run by default. Apply with --apply.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
MAP = REPO / "ingest" / "data" / "mike_mighty_field_map.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"


def cosmos_db():
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    if not MAP.exists():
        raise SystemExit(f"Run build_mike_mighty_map.py first: {MAP}")

    map_doc = json.loads(MAP.read_text(encoding="utf-8"))
    by_lib = {}
    for f in map_doc.get("fields") or []:
        lib = f.get("libraryQuestionId")
        if lib and f.get("canonicalId"):
            by_lib[lib] = f

    def_c = cosmos_db().get_container_client("site-survey-definitions")
    survey = def_c.read_item(SURVEY_ID, SURVEY_ID)
    qs = survey.get("questions") or []
    stamped = 0
    for q in qs:
        lib = q.get("libraryQuestionId")
        hit = by_lib.get(lib) if lib else None
        if not hit:
            continue
        q["mikeCanonicalId"] = hit["canonicalId"]
        q["mikePackPath"] = hit["packPath"]
        q["mikeLabel"] = hit["mikeLabel"]
        q["mikeFormField"] = hit.get("formField")
        stamped += 1

    print(f"Would stamp {stamped}/{len(qs)} Mighty questions with Mike metadata")
    print(f"Map coverage: {map_doc.get('mappedPct')}% of pack paths ({map_doc.get('mappedPackPaths')}/{map_doc.get('packPathCount')})")
    if not args.apply:
        print("Dry run. Re-run with --apply to write survey definition.")
        return

    survey["questions"] = qs
    survey["mikeFieldMapAt"] = datetime.now(timezone.utc).isoformat()
    survey["mikeFieldMapPct"] = map_doc.get("mappedPct")
    def_c.upsert_item(survey)
    print(f"Applied mike metadata on {SURVEY_ID}")


if __name__ == "__main__":
    main()
