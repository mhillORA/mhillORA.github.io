"""
Upsert settled feasibility questions into Cosmos site-survey-question-library,
then backfill libraryQuestionId on site-survey-definitions by alias/label match.

Usage:
  python ingest/push_question_library.py
  python ingest/push_question_library.py --apply
  python ingest/push_question_library.py --apply --link-defs
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from azure.cosmos import CosmosClient, PartitionKey
except ImportError:
    print("Install: pip install azure-cosmos")
    sys.exit(1)

REPO = Path(__file__).resolve().parents[1]
SEED = Path(__file__).resolve().parent / "feasibility_question_library_seed.json"
CONTAINER = "site-survey-question-library"
DEFS = "site-survey-definitions"
SOURCE = "feasibility-question-library-seed"

ENDPOINT = os.environ.get("COSMOS_ENDPOINT", "https://ora-clinical-recruiting.documents.azure.com:443/")
KEY = os.environ.get("COSMOS_KEY", "")
DATABASE_ID = os.environ.get("DATABASE_ID", "crcscheduling")


def load_key():
    global KEY, ENDPOINT, DATABASE_ID
    if KEY:
        return
    for p in (
        REPO / "data-api-connections.json",
        REPO / "api" / "local.settings.json",
        Path(r"C:\Users\shue1\OneDrive\Desktop\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
    ):
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        vals = data.get("Values") or {}
        KEY = vals.get("COSMOS_KEY") or KEY
        ENDPOINT = vals.get("COSMOS_ENDPOINT") or ENDPOINT
        DATABASE_ID = vals.get("DATABASE_ID") or DATABASE_ID
        conn = (data.get("cosmosdb-connection") or {}).get("connectionString") or ""
        if conn and ("AccountKey=" in conn or not KEY):
            parts = {}
            for chunk in conn.rstrip(";").split(";"):
                if "=" in chunk:
                    k, v = chunk.split("=", 1)
                    parts[k.strip()] = v.strip()
            KEY = parts.get("AccountKey") or KEY
            ENDPOINT = parts.get("AccountEndpoint") or ENDPOINT
            DATABASE_ID = (data.get("cosmosdb-connection") or {}).get("database") or DATABASE_ID
        if KEY:
            return


def norm_label(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def client_db():
    load_key()
    if not KEY:
        raise SystemExit("No COSMOS_KEY found")
    client = CosmosClient(ENDPOINT, KEY)
    db = client.get_database_client(DATABASE_ID)
    try:
        db.create_container_if_not_exists(id=CONTAINER, partition_key=PartitionKey(path="/id"))
    except Exception as e:
        print(f"ensure container warn: {e}")
    return db


def upsert_library(db, questions, apply: bool):
    c = db.get_container_client(CONTAINER)
    existing = list(c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    by_id = {e["id"]: e for e in existing if e.get("id")}
    created = updated = skipped = 0
    now = datetime.now(timezone.utc).isoformat()
    for q in questions:
        qid = q["id"]
        doc = {
            "id": qid,
            "label": q["label"],
            "type": q.get("type") or "text",
            "options": q.get("options") or [],
            "category": q.get("category") or "General",
            "required": q.get("required") is not False,
            "scoringWeight": q.get("scoringWeight") or 0,
            "scoringOptions": q.get("scoringOptions") or [],
            "knockout": bool(q.get("knockout")),
            "knockoutOnBlank": bool(q.get("knockoutOnBlank")),
            "knockoutFailValues": q.get("knockoutFailValues") or [],
            "status": q.get("status") or "active",
            "tags": list(dict.fromkeys((q.get("tags") or []) + ["settled-seed", SOURCE])),
            "aliases": q.get("aliases") or [],
            "mapsToProfile": q.get("mapsToProfile"),
            "matrixMode": q.get("matrixMode"),
            "snapshotRetention": bool(q.get("snapshotRetention")),
            "rowCatalogHint": q.get("rowCatalogHint"),
            "companionFields": q.get("companionFields") or [],
            "source": SOURCE,
            "updatedAt": now,
        }
        prev = by_id.get(qid)
        if prev:
            doc["createdAt"] = prev.get("createdAt") or now
            # preserve scoring if already tuned in UI
            if prev.get("scoringWeight"):
                doc["scoringWeight"] = prev["scoringWeight"]
            if prev.get("scoringOptions"):
                doc["scoringOptions"] = prev["scoringOptions"]
            action = "update"
        else:
            doc["createdAt"] = now
            action = "create"
        print(f"  [{action}] {qid}: {doc['label'][:70]}")
        if apply:
            c.upsert_item(doc)
            if action == "create":
                created += 1
            else:
                updated += 1
        else:
            skipped += 1
    return {"created": created, "updated": updated, "dryRun": skipped, "total": len(questions)}


def build_alias_map(questions):
    m = {}
    for q in questions:
        for a in [q["label"], *(q.get("aliases") or [])]:
            k = norm_label(a)
            if k and k not in m:
                m[k] = q["id"]
        # also strip trailing colon variants
        for a in [q["label"], *(q.get("aliases") or [])]:
            k = norm_label(a.rstrip(":"))
            if k and k not in m:
                m[k] = q["id"]
    return m


def link_definitions(db, questions, apply: bool):
    alias_map = build_alias_map(questions)
    c = db.get_container_client(DEFS)
    defs = list(c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    defs_touched = q_linked = 0
    for d in defs:
        qs = d.get("questions") or []
        if not isinstance(qs, list) or not qs:
            continue
        changed = False
        for q in qs:
            if not isinstance(q, dict):
                continue
            if q.get("libraryQuestionId") and str(q.get("libraryQuestionId")).startswith("ql-"):
                continue
            label = str(q.get("label") or q.get("title") or "").strip()
            hit = alias_map.get(norm_label(label)) or alias_map.get(norm_label(label.rstrip(":")))
            if hit:
                q["libraryQuestionId"] = hit
                changed = True
                q_linked += 1
        if changed:
            defs_touched += 1
            print(f"  link def {d.get('id')}: {d.get('name') or d.get('title') or ''}")
            if apply:
                d["updatedAt"] = datetime.now(timezone.utc).isoformat()
                d["libraryLinkedAt"] = d["updatedAt"]
                d["libraryLinkedSource"] = SOURCE
                c.upsert_item(d)
    return {"defsTouched": defs_touched, "questionsLinked": q_linked}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--link-defs", action="store_true", help="Also backfill libraryQuestionId on survey definitions")
    args = ap.parse_args()
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    questions = seed.get("questions") or []
    print(f"Seed: {len(questions)} questions from {SEED.name}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    db = client_db()
    stats = upsert_library(db, questions, args.apply)
    print("Library:", stats)
    if args.link_defs:
        link = link_definitions(db, questions, args.apply)
        print("Defs link:", link)
    if not args.apply:
        print("\nRe-run with --apply to write. Add --link-defs to assign library ids on existing templates.")


if __name__ == "__main__":
    main()
