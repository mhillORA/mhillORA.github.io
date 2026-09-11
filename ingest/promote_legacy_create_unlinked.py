"""
Promote every unlinked legacy-sites row into live `sites`.

- Already linked: skip
- Exact/normalized name match to one live site: link only (no Chaos field overwrite)
- Ambiguous name: skip (report)
- No live twin: create inert live stub + set linkedArtemisSiteId

Usage:
  python ingest/promote_legacy_create_unlinked.py
  python ingest/promote_legacy_create_unlinked.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import time
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


def generate_id() -> str:
    # Same spirit as api/index.js generateId
    return f"{int(time.time() * 1000):x}{secrets.token_hex(4)}"


def fetch(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def build_live_from_legacy(legacy: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    name = str(legacy.get("name") or "").strip() or "Promoted site"
    return {
        "id": generate_id(),
        "name": name,
        "status": "Active",
        "address": legacy.get("address") or legacy.get("street") or legacy.get("address1") or "",
        "address1": legacy.get("address1") or legacy.get("address") or legacy.get("street") or "",
        "address2": legacy.get("address2") or "",
        "city": legacy.get("city") or "",
        "state": legacy.get("state") or "",
        "zip": legacy.get("zip") or legacy.get("postalCode") or "",
        "zipCode": legacy.get("zipCode") or legacy.get("zip") or "",
        "pi": legacy.get("pi") or legacy.get("piName") or "",
        "piEmail": legacy.get("piEmail") or "",
        "siteCoordinator": legacy.get("siteCoordinator") or legacy.get("coordinator") or "",
        "siteCoordinatorEmail": legacy.get("siteCoordinatorEmail")
        or legacy.get("coordinatorEmail")
        or "",
        "notes": legacy.get("notes") or "",
        "source": "promoted-from-legacy",
        "promotedFromLegacySiteId": legacy["id"],
        "legacySiteIds": [legacy["id"]],
        "createdAt": now,
        "updatedAt": now,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    legacy_c = db.get_container_client("legacy-sites")
    live_c = db.get_container_client("sites")
    legacy = fetch(legacy_c)
    live = fetch(live_c)

    by_exact: dict[str, list] = {}
    by_norm: dict[str, list] = {}
    for s in live:
        name = str(s.get("name") or "").strip()
        if not name:
            continue
        by_exact.setdefault(name.lower(), []).append(s)
        n = norm_name(name)
        if n:
            by_norm.setdefault(n, []).append(s)

    skipped = []
    linked = []
    created = []
    ambiguous = []

    for leg in legacy:
        if leg.get("linkedArtemisSiteId"):
            skipped.append({"legacyId": leg["id"], "legacyName": leg.get("name")})
            continue
        name = str(leg.get("name") or "").strip()
        hits = by_exact.get(name.lower()) or []
        reason = "exact"
        if not hits:
            n = norm_name(name)
            hits = by_norm.get(n) or []
            reason = "normalized"
        uniq = {h["id"]: h for h in hits}
        hits = list(uniq.values())
        if len(hits) > 1:
            ambiguous.append(
                {
                    "legacyId": leg["id"],
                    "legacyName": name,
                    "candidates": [{"id": h["id"], "name": h.get("name")} for h in hits],
                }
            )
            continue
        if len(hits) == 1:
            linked.append(
                {
                    "legacyId": leg["id"],
                    "legacyName": name,
                    "liveId": hits[0]["id"],
                    "liveName": hits[0].get("name"),
                    "reason": reason,
                }
            )
            continue
        created.append({"legacyId": leg["id"], "legacyName": name})

    report = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "liveBefore": len(live),
        "legacyCount": len(legacy),
        "alreadyLinked": len(skipped),
        "wouldLink": len(linked),
        "wouldCreate": len(created),
        "ambiguous": len(ambiguous),
        "link": linked,
        "create": created[:50],
        "ambiguousRows": ambiguous,
        "apply": bool(args.apply),
    }
    out = REPO / "exports" / "promote_legacy_create_unlinked_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)

    print(
        f"already={len(skipped)} link={len(linked)} create={len(created)} ambiguous={len(ambiguous)}"
    )

    if not args.apply:
        report["status"] = "dry-run"
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Dry-run only. Re-run with --apply to write.")
        print("Report:", out)
        return

    now = datetime.now(timezone.utc).isoformat()
    applied_link = 0
    applied_create = 0

    for row in linked:
        leg = next(x for x in legacy if x["id"] == row["legacyId"])
        live_doc = next(x for x in live if x["id"] == row["liveId"])
        leg["linkedArtemisSiteId"] = row["liveId"]
        leg["promoteStatus"] = "linked"
        leg["promotedAt"] = now
        leg["promotedBy"] = "promote_legacy_create_unlinked"
        leg["updatedAt"] = now
        legacy_c.upsert_item(leg)
        ids = list(live_doc.get("legacySiteIds") or [])
        if row["legacyId"] not in ids:
            ids.append(row["legacyId"])
        live_doc["legacySiteIds"] = ids
        live_doc["updatedAt"] = now
        live_c.upsert_item(live_doc)
        applied_link += 1

    for row in created:
        leg = next(x for x in legacy if x["id"] == row["legacyId"])
        new_live = build_live_from_legacy(leg)
        live_c.create_item(new_live)
        live.append(new_live)
        # keep maps warm if later rows collide by name
        nm = str(new_live.get("name") or "").strip()
        if nm:
            by_exact.setdefault(nm.lower(), []).append(new_live)
            n = norm_name(nm)
            if n:
                by_norm.setdefault(n, []).append(new_live)
        leg["linkedArtemisSiteId"] = new_live["id"]
        leg["promoteStatus"] = "created"
        leg["promotedAt"] = now
        leg["promotedBy"] = "promote_legacy_create_unlinked"
        leg["updatedAt"] = now
        legacy_c.upsert_item(leg)
        applied_create += 1
        if applied_create % 50 == 0:
            print(f"  created {applied_create}/{len(created)}…")

    # verify
    legacy2 = fetch(legacy_c, "SELECT c.id, c.linkedArtemisSiteId FROM c")
    live2 = fetch(live_c, "SELECT c.id FROM c")
    unlinked = sum(1 for l in legacy2 if not l.get("linkedArtemisSiteId"))
    report.update(
        {
            "status": "applied",
            "appliedLink": applied_link,
            "appliedCreate": applied_create,
            "liveAfter": len(live2),
            "legacyUnlinkedAfter": unlinked,
        }
    )
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Applied link={applied_link} create={applied_create}")
    print(f"liveAfter={len(live2)} legacyUnlinkedAfter={unlinked}")
    print("Report:", out)


if __name__ == "__main__":
    main()
