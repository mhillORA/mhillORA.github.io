"""
Push Anterior Segment legacy outcomes into Study Bid Workbench Cosmos (bd-budgets).

NEW CONTAINERS ONLY — does not read/write or alter existing budget tables
(studies, versions, lineItems, ora_*, etc.).

Containers created if missing:
  legacy_studies              PK /studyId
  legacy_sites                PK /siteId
  legacy_study_site_outcomes  PK /studyId   (includes siteId for filters)
  legacy_site_study_outcomes  PK /siteId    (same rows, site-partitioned queries)

Queryable for budget / trust / feasibility:
  - By study:  SELECT * FROM c WHERE c.studyId = @id  (legacy_studies / legacy_study_site_outcomes)
  - By site:   SELECT * FROM c WHERE c.siteId = @id   (legacy_sites / legacy_site_study_outcomes)

Usage (from this repo):
  pip install azure-cosmos openpyxl python-dotenv
  python ingest/push_legacy_to_bd_budgets.py --dry-run
  python ingest/push_legacy_to_bd_budgets.py

Credentials: study_bid_workbench/.env  (COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE)
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey
from dotenv import load_dotenv

DATASET = "legacy_anterior_segment"
SCHEMA_VERSION = 1
SOURCE = "anterior-segment-overview"

# NEW containers only — never touch existing bd-budgets containers
NEW_CONTAINERS = [
    ("legacy_studies", "/studyId"),
    ("legacy_sites", "/siteId"),
    ("legacy_study_site_outcomes", "/studyId"),
    ("legacy_site_study_outcomes", "/siteId"),
]

WB_ENV = Path(r"C:\Users\shue1\Projects\study_bid_workbench\.env")
DEFAULT_XLSX = Path(r"c:\Users\shue1\Downloads\Anterior Segment Overview.xlsx")
THIS_DIR = Path(__file__).resolve().parent


def load_legacy_module():
    path = THIS_DIR / "legacy_anterior_segment.py"
    spec = importlib.util.spec_from_file_location("legacy_anterior_segment", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


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


def ensure_new_containers(db):
    created = []
    for cid, pk in NEW_CONTAINERS:
        db.create_container_if_not_exists(id=cid, partition_key=PartitionKey(path=pk))
        created.append(f"{cid} ({pk})")
    return created


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def map_study(doc: dict, imported_at: str) -> dict:
    study_id = doc["id"]  # legacy-study-...
    return {
        "id": study_id,
        "docType": "legacyStudy",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "studyId": study_id,
        "studyName": doc.get("name") or doc.get("title"),
        "name": doc.get("name"),
        "title": doc.get("title"),
        "therapeuticArea": doc.get("therapeuticArea"),
        "indication": doc.get("indication"),
        "sponsor": doc.get("sponsor"),
        "phase": doc.get("phase"),
        "status": doc.get("status"),
        "notes": doc.get("notes"),
        "metrics": doc.get("metrics") or {},
        "source": SOURCE,
        "sourceFile": doc.get("sourceFile"),
        "artemisStudyId": study_id,
        "importedAt": imported_at,
        "updatedAt": imported_at,
    }


def map_site(doc: dict, imported_at: str) -> dict:
    site_id = doc["id"]  # legacy-site-...
    return {
        "id": site_id,
        "docType": "legacySite",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "siteId": site_id,
        "siteName": doc.get("name"),
        "name": doc.get("name"),
        "siteCode": doc.get("siteCode"),
        "status": doc.get("status"),
        "notes": doc.get("notes"),
        "relationshipPreference": doc.get("relationshipPreference"),
        "advantages": doc.get("advantages"),
        "disadvantages": doc.get("disadvantages"),
        "relationshipNotes": doc.get("relationshipNotes"),
        "linkedArtemisSiteId": doc.get("linkedArtemisSiteId"),
        "metrics": doc.get("metrics") or {},
        "source": SOURCE,
        "sourceFile": doc.get("sourceFile"),
        "artemisSiteId": site_id,
        "importedAt": imported_at,
        "updatedAt": imported_at,
    }


def map_outcome_for_study_pk(doc: dict, imported_at: str) -> dict:
    study_id = doc.get("studyId")
    site_id = doc.get("siteId")
    oid = doc.get("id") or f"{study_id}__{site_id}__{doc.get('group')}"
    return {
        "id": oid,
        "docType": "legacyStudySiteOutcome",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "studyId": study_id,
        "siteId": site_id,
        "studyName": doc.get("studyName"),
        "siteName": doc.get("siteName"),
        "group": doc.get("group"),
        "pi": doc.get("pi"),
        "visit1Start": doc.get("visit1Start"),
        "lplv": doc.get("lplv"),
        "targetScheduled": doc.get("targetScheduled"),
        "scheduled": doc.get("scheduled"),
        "screened": doc.get("screened"),
        "enrolled": doc.get("enrolled"),
        "uniqueId": doc.get("uniqueId"),
        "source": SOURCE,
        "artemisOutcomeId": doc.get("id"),
        "importedAt": imported_at,
        "updatedAt": imported_at,
    }


def map_outcome_for_site_pk(doc: dict, imported_at: str) -> dict:
    """Same facts, partitioned by siteId for site-scoped budget queries."""
    row = map_outcome_for_study_pk(doc, imported_at)
    row["id"] = f"by-site__{row['id']}"
    row["docType"] = "legacySiteStudyOutcome"
    return row


def upsert_many(container, docs: list[dict], label: str):
    n = len(docs)
    for i, doc in enumerate(docs, 1):
        container.upsert_item(doc)
        if i % 100 == 0 or i == n:
            print(f"  {label}: {i}/{n}")


def preserve_site_relationship(existing: dict | None, mapped: dict) -> dict:
    if not existing:
        return mapped
    for k in (
        "relationshipPreference",
        "advantages",
        "disadvantages",
        "relationshipNotes",
        "notes",
        "status",
        "siteCode",
    ):
        if existing.get(k) not in (None, ""):
            mapped[k] = existing[k]
    if existing.get("createdAt"):
        mapped["createdAt"] = existing["createdAt"]
    elif existing.get("importedAt"):
        mapped["createdAt"] = existing["importedAt"]
    return mapped


def main():
    ap = argparse.ArgumentParser(description="Push legacy anterior-segment data to bd-budgets (new containers only)")
    ap.add_argument("xlsx", nargs="?", default=str(DEFAULT_XLSX), help="Path to Anterior Segment Overview.xlsx")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    xlsx = Path(args.xlsx)
    if not xlsx.exists():
        raise SystemExit(f"File not found: {xlsx}")

    las = load_legacy_module()
    print(f"Parsing {xlsx} ...")
    records, indications = las.parse_workbook(xlsx)
    studies, sites, outcomes = las.build_docs(records, indications, str(xlsx))
    print(f"Built {len(studies)} studies, {len(sites)} sites, {len(outcomes)} outcomes")

    imported_at = now_iso()
    study_docs = [map_study(s, imported_at) for s in studies]
    site_docs = [map_site(s, imported_at) for s in sites]
    out_by_study = [map_outcome_for_study_pk(o, imported_at) for o in outcomes]
    out_by_site = [map_outcome_for_site_pk(o, imported_at) for o in outcomes]

    if args.dry_run:
        print("DRY RUN — would ensure NEW containers only:")
        for cid, pk in NEW_CONTAINERS:
            print(f"  {cid}  PK {pk}")
        print(f"Would upsert: {len(study_docs)} studies, {len(site_docs)} sites,")
        print(f"  {len(out_by_study)} outcomes (by study), {len(out_by_site)} outcomes (by site)")
        print("Sample study:", study_docs[0] if study_docs else None)
        print("Sample site:", site_docs[0] if site_docs else None)
        print("Sample outcome:", out_by_study[0] if out_by_study else None)
        return

    _, db, db_name, endpoint = get_client_and_db()
    print(f"Target: {endpoint} / database {db_name}")
    print("Ensuring NEW containers only (existing containers untouched)...")
    for line in ensure_new_containers(db):
        print(f"  OK {line}")

    studies_c = db.get_container_client("legacy_studies")
    sites_c = db.get_container_client("legacy_sites")
    out_study_c = db.get_container_client("legacy_study_site_outcomes")
    out_site_c = db.get_container_client("legacy_site_study_outcomes")

    # Preserve relationship edits on re-run
    existing_sites = {}
    try:
        for item in sites_c.query_items(
            query=(
                "SELECT c.id, c.relationshipPreference, c.advantages, c.disadvantages, "
                "c.relationshipNotes, c.notes, c.status, c.siteCode, c.createdAt, c.importedAt FROM c"
            ),
            enable_cross_partition_query=True,
        ):
            existing_sites[item["id"]] = item
    except Exception as e:
        print("Note: could not read existing legacy_sites (first run?):", e)

    site_docs = [preserve_site_relationship(existing_sites.get(d["id"]), d) for d in site_docs]

    print(f"Upserting {len(study_docs)} -> legacy_studies ...")
    upsert_many(studies_c, study_docs, "studies")
    print(f"Upserting {len(site_docs)} -> legacy_sites ...")
    upsert_many(sites_c, site_docs, "sites")
    print(f"Upserting {len(out_by_study)} -> legacy_study_site_outcomes ...")
    upsert_many(out_study_c, out_by_study, "outcomes@study")
    print(f"Upserting {len(out_by_site)} -> legacy_site_study_outcomes ...")
    upsert_many(out_site_c, out_by_site, "outcomes@site")

    print("Done. Existing bd-budgets containers were not modified.")
    print("Example queries:")
    print('  SELECT * FROM c WHERE c.studyId = "legacy-study-alcon-c003"')
    print('  SELECT * FROM c WHERE c.siteId = "legacy-site-andover"')
    print('  SELECT c.siteName, SUM(c.enrolled) FROM c GROUP BY c.siteName')


if __name__ == "__main__":
    main()
