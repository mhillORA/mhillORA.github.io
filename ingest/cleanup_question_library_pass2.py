"""
Pass 2 library cleanup for survey builder:

  1) Archive orphan junk (mu* imports + unreferenced ql-ms-* collapses)
     Keep: anything referenced by defs/responses, settled seeds, and ql-* canons
  2) Strip boilerplate help text (Yes/No, Short Response, Shown when…) from
     library + survey definition questions
  3) Ensure keepers have status=active so they appear in Add from library

Usage:
  python ingest/cleanup_question_library_pass2.py
  python ingest/cleanup_question_library_pass2.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / ".firecrawl" / "question-library-cleanup-pass2-report.json"
SOURCE = "question-library-cleanup-pass2"

KEEP_TAGS = {
    "settled-seed",
    "feasibility-question-library-seed",
    "settled",
    "canonical",
    "equipment",
}
EQUIPMENT_CANON_ID = "ql-site-equipment-inventory"

BOILERPLATE_EXACT = {
    "yes/no",
    "yes / no",
    "short response",
    "long response",
    "multi-select",
    "multiselect",
    "single select",
    "range select",
    "numeric entry",
    "select all that apply",
    "select all that apply.",
    "shown when the condition above is met.",
    "shown when the condition above is met",
    "shown only when branch conditions are met.",
    "shown only when branch conditions are met",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def fetch_all(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def meaningful_help(raw) -> str | None:
    t = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not t:
        return None
    n = t.lower().replace("–", "-").replace("—", "-")
    if n in BOILERPLATE_EXACT:
        return None
    if re.match(r"^shown (when|only when)\b", n):
        return None
    if re.match(
        r"^(yes/no|short response|long response|multi-?select|single select|range select|numeric entry)\b",
        n,
    ) and re.search(r"shown (when|only when)", n):
        return None
    if re.match(r"^(select all that apply\.?\s*)+(shown (when|only when).*)?$", n):
        return None
    return t


def is_real_survey_def(d: dict) -> bool:
    if d.get("isConfig") or d.get("type") == "fieldMap" or d.get("status") == "config":
        return False
    return True


def should_keep(doc: dict, referenced: set[str]) -> bool:
    oid = str(doc.get("id") or "")
    if not oid:
        return False
    if oid in referenced or oid == EQUIPMENT_CANON_ID:
        return True
    tags = {str(t) for t in (doc.get("tags") or [])}
    if tags & KEEP_TAGS:
        return True
    # Keep canonical ql-* bank (not collapsed ql-ms-* one-offs) for survey picker
    if oid.startswith("ql-") and not oid.startswith("ql-ms-"):
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos_db()
    lib_c = db.create_container_if_not_exists(
        id="site-survey-question-library", partition_key=PartitionKey(path="/id")
    )
    defs_c = db.get_container_client("site-survey-definitions")
    try:
        resp_c = db.get_container_client("site-survey-responses")
    except Exception:
        resp_c = None

    library = fetch_all(lib_c)
    defs = fetch_all(defs_c)
    referenced: set[str] = set()
    for d in defs:
        if not is_real_survey_def(d):
            continue
        for q in d.get("questions") or []:
            lid = str(q.get("libraryQuestionId") or "").strip()
            if lid:
                referenced.add(lid)

    if resp_c is not None:
        for r in fetch_all(resp_c, "SELECT c.answers, c._archived FROM c"):
            if r.get("_archived"):
                continue
            for a in r.get("answers") or []:
                if isinstance(a, dict):
                    lid = str(a.get("libraryQuestionId") or "").strip()
                    if lid:
                        referenced.add(lid)

    active = [d for d in library if str(d.get("status") or "active") == "active"]
    keep_ids = {d["id"] for d in active if should_keep(d, referenced)}
    archive_ids = {d["id"] for d in active if d["id"] not in keep_ids}

    help_lib_clear = 0
    help_def_clear = 0
    for d in library:
        if d["id"] in archive_ids:
            continue
        for key in ("help", "context", "description"):
            if key not in d:
                continue
            cleaned = meaningful_help(d.get(key))
            if cleaned is None and d.get(key):
                help_lib_clear += 1

    for d in defs:
        if not is_real_survey_def(d):
            continue
        for q in d.get("questions") or []:
            for key in ("help", "context", "description"):
                if key not in q:
                    continue
                cleaned = meaningful_help(q.get(key))
                if cleaned is None and q.get(key):
                    help_def_clear += 1

    report = {
        "generatedAt": iso_now(),
        "activeBefore": len(active),
        "referencedIds": len(referenced),
        "keepActive": len(keep_ids),
        "archiveOrphans": len(archive_ids),
        "helpLibWouldClear": help_lib_clear,
        "helpDefWouldClear": help_def_clear,
        "sampleArchive": sorted(archive_ids)[:20],
        "sampleKeep": sorted(keep_ids)[:20],
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write Cosmos.")
        return

    now = iso_now()
    by_id = {d["id"]: d for d in library}

    archived = 0
    for oid in archive_ids:
        doc = by_id.get(oid)
        if not doc:
            continue
        doc = {**doc}
        doc["status"] = "archived"
        doc["archivedAt"] = now
        doc["archivedBy"] = SOURCE
        doc["updatedAt"] = now
        lib_c.upsert_item(doc)
        archived += 1
        if archived % 100 == 0:
            print(f"  archived {archived}/{len(archive_ids)}…")

    activated = 0
    help_cleared = 0
    for oid in keep_ids:
        doc = by_id.get(oid)
        if not doc:
            continue
        changed = False
        live = {**doc}
        if live.get("status") != "active":
            live["status"] = "active"
            changed = True
            activated += 1
        for key in ("help", "context", "description"):
            if key not in live:
                continue
            cleaned = meaningful_help(live.get(key))
            if cleaned is None:
                if live.get(key):
                    del live[key]
                    changed = True
                    help_cleared += 1
            elif cleaned != live.get(key):
                live[key] = cleaned
                changed = True
        if changed:
            live["updatedAt"] = now
            lib_c.upsert_item(live)

    defs_touched = 0
    def_help_cleared = 0
    for d in defs:
        if not is_real_survey_def(d):
            continue
        changed = False
        for q in d.get("questions") or []:
            for key in ("help", "context", "description"):
                if key not in q:
                    continue
                cleaned = meaningful_help(q.get(key))
                if cleaned is None:
                    if q.get(key):
                        del q[key]
                        changed = True
                        def_help_cleared += 1
                elif cleaned != q.get(key):
                    q[key] = cleaned
                    changed = True
        if changed:
            d["updatedAt"] = now
            defs_c.upsert_item(d)
            defs_touched += 1

    report.update(
        {
            "status": "applied",
            "archivedWritten": archived,
            "keepersActivated": activated,
            "helpClearedOnLibrary": help_cleared,
            "helpClearedOnDefs": def_help_cleared,
            "defsTouched": defs_touched,
            "activeAfter": len(keep_ids),
        }
    )
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Applied: archived {archived}; keepers active {len(keep_ids)}; "
        f"cleared help on {help_cleared} library + {def_help_cleared} def fields "
        f"across {defs_touched} surveys."
    )


if __name__ == "__main__":
    main()
