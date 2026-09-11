"""
Safe-auto promote: link legacy-sites → live sites by exact / normalized name.
Ambiguous or weak matches go to a confirm report (do not auto-apply).

Usage:
  python ingest/promote_legacy_safe_auto.py
  python ingest/promote_legacy_safe_auto.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]


def cosmos():
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


def norm_name(s: str) -> str:
    t = (s or "").strip().lower()
    t = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc|and|&|the)\b", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def fetch(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    legacy_c = db.get_container_client("legacy-sites")
    live_c = db.get_container_client("sites")
    legacy = fetch(legacy_c)
    live = fetch(live_c)

    by_exact = {}
    by_norm = {}
    for s in live:
        name = str(s.get("name") or "").strip()
        if not name:
            continue
        by_exact.setdefault(name.lower(), []).append(s)
        n = norm_name(name)
        if n:
            by_norm.setdefault(n, []).append(s)

    already = []
    link = []
    ambiguous = []
    no_match = []

    for leg in legacy:
        if leg.get("linkedArtemisSiteId"):
            already.append(
                {
                    "legacyId": leg["id"],
                    "legacyName": leg.get("name"),
                    "liveId": leg.get("linkedArtemisSiteId"),
                }
            )
            continue
        name = str(leg.get("name") or "").strip()
        hits = by_exact.get(name.lower()) or []
        reason = "exact"
        if not hits:
            n = norm_name(name)
            hits = by_norm.get(n) or []
            reason = "normalized"
        # de-dupe hit list by id
        uniq = {h["id"]: h for h in hits}
        hits = list(uniq.values())
        if len(hits) == 1:
            link.append(
                {
                    "legacyId": leg["id"],
                    "legacyName": name,
                    "liveId": hits[0]["id"],
                    "liveName": hits[0].get("name"),
                    "reason": reason,
                }
            )
        elif len(hits) > 1:
            ambiguous.append(
                {
                    "legacyId": leg["id"],
                    "legacyName": name,
                    "candidates": [{"id": h["id"], "name": h.get("name")} for h in hits],
                    "reason": reason,
                }
            )
        else:
            no_match.append({"legacyId": leg["id"], "legacyName": name})

    report = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "liveCount": len(live),
        "legacyCount": len(legacy),
        "alreadyLinked": len(already),
        "safeToLink": len(link),
        "ambiguous": len(ambiguous),
        "noMatch": len(no_match),
        "link": link,
        "ambiguousRows": ambiguous,
        "noMatchSample": no_match[:40],
    }
    out = REPO / "exports" / "promote_legacy_safe_auto_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"already={len(already)} safe_link={len(link)} ambiguous={len(ambiguous)} no_match={len(no_match)}"
    )
    print("Report:", out)
    if ambiguous:
        print("AMBIGUOUS (need your confirm):")
        for row in ambiguous[:20]:
            print(f"  - {row['legacyName']} → {[c['name'] for c in row['candidates']]}")

    if not args.apply:
        print("Dry-run only. Re-run with --apply to write links.")
        return

    now = datetime.now(timezone.utc).isoformat()
    applied = 0
    for row in link:
        leg = next(x for x in legacy if x["id"] == row["legacyId"])
        live_doc = next(x for x in live if x["id"] == row["liveId"])
        leg["linkedArtemisSiteId"] = row["liveId"]
        leg["promoteStatus"] = "linked"
        leg["promotedAt"] = now
        leg["promotedBy"] = "promote_legacy_safe_auto"
        leg["updatedAt"] = now
        legacy_c.upsert_item(leg)

        ids = list(live_doc.get("legacySiteIds") or [])
        if row["legacyId"] not in ids:
            ids.append(row["legacyId"])
        live_doc["legacySiteIds"] = ids
        live_doc["updatedAt"] = now
        live_c.upsert_item(live_doc)
        applied += 1
    print(f"Applied {applied} safe links.")


if __name__ == "__main__":
    main()
