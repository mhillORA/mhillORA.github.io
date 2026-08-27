"""
Push ARTEMIS feasibility pack into Study Bid Workbench Cosmos (bd-budgets).

NEW CONTAINERS ONLY — does not read/write existing budget / Ora intelligence tables.

Containers (created if missing):
  feasibility_site_profiles       PK /siteId
  feasibility_survey_definitions  PK /id
  feasibility_survey_responses    PK /siteId
  feasibility_sites               PK /siteId   (legacy-site rollup + relationship)

Usage:
  python ingest/export_feasibility_for_budget_buddy.py --slim-answers
  python ingest/push_feasibility_to_bd_budgets.py --dry-run
  python ingest/push_feasibility_to_bd_budgets.py
  python ingest/push_feasibility_to_bd_budgets.py --pack exports/budget_buddy_feasibility_pack.json

Credentials: study_bid_workbench/.env (COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey
from dotenv import load_dotenv

WB_ENV = Path(r"C:\Users\shue1\Projects\study_bid_workbench\.env")
REPO = Path(__file__).resolve().parents[1]
DEFAULT_PACK = REPO / "exports" / "budget_buddy_feasibility_pack.json"

NEW_CONTAINERS = [
    ("feasibility_site_profiles", "/siteId"),
    ("feasibility_survey_definitions", "/id"),
    ("feasibility_survey_responses", "/siteId"),
    ("feasibility_sites", "/siteId"),
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_client_and_db():
    load_dotenv(WB_ENV)
    endpoint = (os.getenv("COSMOS_ENDPOINT") or "").strip()
    key = (os.getenv("COSMOS_KEY") or "").strip()
    db_name = (os.getenv("COSMOS_DATABASE") or "bd-budgets").strip()
    if not endpoint or not key or "YOUR_" in endpoint or "YOUR_" in key:
        raise SystemExit(
            f"Missing bd-budgets Cosmos creds. Set COSMOS_ENDPOINT / COSMOS_KEY in {WB_ENV}"
        )
    client = CosmosClient(endpoint, credential=key)
    db = client.create_database_if_not_exists(id=db_name)
    return client, db, db_name, endpoint


def ensure_containers(db):
    for cid, pk in NEW_CONTAINERS:
        db.create_container_if_not_exists(id=cid, partition_key=PartitionKey(path=pk))
        print(f"  ensured {cid} ({pk})")


def load_pack(path: Path) -> dict:
    pack = json.loads(path.read_text(encoding="utf-8"))
    responses = list(pack.get("surveyResponses") or [])
    ref = pack.get("surveyResponsesFile")
    if ref and ref.get("path"):
        nd = path.parent / ref["path"]
        if not nd.exists():
            raise SystemExit(f"Missing responses file: {nd}")
        with nd.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    responses.append(json.loads(line))
        pack["surveyResponses"] = responses
    return pack


def upsert_many(container, docs: list[dict], label: str):
    n = len(docs)
    for i, doc in enumerate(docs, 1):
        container.upsert_item(doc)
        if i % 50 == 0 or i == n:
            print(f"  {label}: {i}/{n}")


def stamp(doc: dict, imported_at: str) -> dict:
    out = dict(doc)
    out["importedAt"] = imported_at
    out["updatedAt"] = imported_at
    return out


def prune_container(container, keep_ids: set[str], id_field: str, label: str):
    """Delete docs whose id_field is not in keep_ids."""
    deleted = 0
    for doc in container.query_items(query="SELECT c.id, c.siteId FROM c", enable_cross_partition_query=True):
        key = doc.get(id_field) or doc.get("id")
        if not key or key in keep_ids:
            continue
        # never delete pack meta
        if doc.get("id") == "feasibility_pack_meta":
            continue
        try:
            container.delete_item(doc["id"], doc.get("siteId") or doc["id"])
            deleted += 1
        except Exception:
            try:
                container.delete_item(doc["id"], doc["id"])
                deleted += 1
            except Exception as e:
                print(f"  warn: could not delete {label} {doc.get('id')}: {e}")
    print(f"  pruned {label}: deleted {deleted}")


def main():
    ap = argparse.ArgumentParser(description="Push feasibility pack into bd-budgets (new containers only)")
    ap.add_argument("--pack", default=str(DEFAULT_PACK), help="Path to export JSON pack")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--prune",
        action="store_true",
        help="Delete feasibility_* docs whose siteId/id is not in this pack (removes merged orphans)",
    )
    args = ap.parse_args()

    pack_path = Path(args.pack)
    if not pack_path.exists():
        raise SystemExit(
            f"Pack not found: {pack_path}\n"
            "Run: python ingest/export_feasibility_for_budget_buddy.py --slim-answers"
        )

    pack = load_pack(pack_path)
    imported_at = now_iso()
    profiles = [stamp(p, imported_at) for p in (pack.get("profiles") or []) if p.get("siteId")]
    sites = [stamp(s, imported_at) for s in (pack.get("sites") or []) if s.get("siteId")]
    defs = [stamp(d, imported_at) for d in (pack.get("surveyDefinitions") or []) if d.get("id")]
    responses = [
        stamp(r, imported_at)
        for r in (pack.get("surveyResponses") or [])
        if r.get("id") and r.get("siteId")
    ]

    print("Pack counts:", pack.get("counts"))
    print(
        f"Will upsert profiles={len(profiles)} sites={len(sites)} "
        f"defs={len(defs)} responses={len(responses)}"
        + (" + prune orphans" if args.prune else "")
    )

    if args.dry_run:
        print("Dry-run only — no writes.")
        inds = (pack.get("indicationIndex") or {}).get("byIndication") or []
        for row in inds[:10]:
            print(f"  {row['indication']}: sites={row['siteCount']} responses={row['responseCount']}")
        return

    _, db, db_name, endpoint = get_client_and_db()
    print(f"Writing to {endpoint} / {db_name}")
    ensure_containers(db)

    upsert_many(db.get_container_client("feasibility_sites"), sites, "feasibility_sites")
    upsert_many(db.get_container_client("feasibility_site_profiles"), profiles, "feasibility_site_profiles")
    upsert_many(db.get_container_client("feasibility_survey_definitions"), defs, "feasibility_survey_definitions")
    upsert_many(db.get_container_client("feasibility_survey_responses"), responses, "feasibility_survey_responses")

    if args.prune:
        site_ids = {s["siteId"] for s in sites}
        def_ids = {d["id"] for d in defs} | {"feasibility_pack_meta"}
        rsp_ids = {r["id"] for r in responses}
        print("Pruning orphaned feasibility docs ...")
        prune_container(db.get_container_client("feasibility_sites"), site_ids, "siteId", "feasibility_sites")
        prune_container(
            db.get_container_client("feasibility_site_profiles"), site_ids, "siteId", "feasibility_site_profiles"
        )
        prune_container(
            db.get_container_client("feasibility_survey_definitions"), def_ids, "id", "feasibility_survey_definitions"
        )
        # responses: keep by id; also drop any whose siteId was merged away
        rsp_c = db.get_container_client("feasibility_survey_responses")
        deleted = 0
        for doc in rsp_c.query_items(query="SELECT c.id, c.siteId FROM c", enable_cross_partition_query=True):
            if doc.get("id") in rsp_ids and doc.get("siteId") in site_ids:
                continue
            try:
                rsp_c.delete_item(doc["id"], doc.get("siteId") or doc["id"])
                deleted += 1
            except Exception:
                try:
                    rsp_c.delete_item(doc["id"], doc["id"])
                    deleted += 1
                except Exception as e:
                    print(f"  warn: could not delete response {doc.get('id')}: {e}")
        print(f"  pruned feasibility_survey_responses: deleted {deleted}")

    meta = {
        "id": "feasibility_pack_meta",
        "docType": "feasibilityPackMeta",
        "dataset": pack.get("dataset"),
        "schemaVersion": pack.get("schemaVersion"),
        "source": pack.get("source"),
        "exportedAt": pack.get("exportedAt"),
        "importedAt": now_iso(),
        "counts": {
            "profiles": len(profiles),
            "sites": len(sites),
            "surveyDefinitions": len(defs),
            "surveyResponses": len(responses),
            "indications": (pack.get("counts") or {}).get("indications"),
        },
        "indicationIndex": pack.get("indicationIndex"),
        "notes": pack.get("notes"),
        "pruned": bool(args.prune),
    }
    db.get_container_client("feasibility_survey_definitions").upsert_item(meta)
    print("Done. Existing budget containers were not modified.")


if __name__ == "__main__":
    main()
