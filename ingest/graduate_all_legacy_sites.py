"""
Graduate ALL unlinked legacy-sites into live `sites`.

- Unique name match → link (no field overwrite on live)
- No match → create live stub from legacy fields only
- Ambiguous name → create live stub (so nothing stays master-list-only)
- Does NOT write survey answers
- Does NOT patch Stealth / force-overwrite live site contact fields

Usage:
  python ingest/graduate_all_legacy_sites.py
  python ingest/graduate_all_legacy_sites.py --apply
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from ingest_mike_rebuild_pack import cosmos_db, iso_now, norm_name

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / ".firecrawl" / "graduate-all-legacy-report.json"
OPERATOR = "graduate-all-legacy"

# Name won't match "AVRUC" — pin this one.
FORCE_LINKS = {
    "legacy-site-feas-associated-vitreoretinal-and-uveitis-consultant": "1a0a1404d032e59e111",
}


def new_id() -> str:
    return f"1a{int(time.time() * 1000):x}{int(time.time() * 1_000_000) % 0xFFFFFF:06x}"[-19:]


def stub_from_legacy(leg: dict, now: str) -> dict:
    return {
        "id": new_id(),
        "name": leg.get("name") or leg.get("institution_name") or "Graduated site",
        "status": "Active",
        "siteCode": leg.get("siteCode") or None,
        "address1": leg.get("address1") or leg.get("address") or None,
        "address2": leg.get("address2") or None,
        "city": leg.get("city") or None,
        "state": leg.get("state") or None,
        "zip": leg.get("zip") or leg.get("zipCode") or None,
        "zipCode": leg.get("zipCode") or leg.get("zip") or None,
        "country": leg.get("country") or None,
        "pi": leg.get("pi") or leg.get("piName") or None,
        "piName": leg.get("piName") or leg.get("pi") or None,
        "piEmail": leg.get("piEmail") or None,
        "siteCoordinator": leg.get("siteCoordinator") or None,
        "siteCoordinatorEmail": leg.get("siteCoordinatorEmail") or None,
        "source": "promoted-from-legacy",
        "promotedFromLegacySiteId": leg["id"],
        "legacySiteIds": [leg["id"]],
        "createdAt": now,
        "updatedAt": now,
        "graduatedAt": now,
        "graduatedBy": OPERATOR,
    }


def link(leg_c, live_c, leg, live, now: str, dry: bool, action: str) -> dict:
    rec = {
        "legacySiteId": leg["id"],
        "name": leg.get("name"),
        "action": action,
        "liveSiteId": live["id"],
    }
    if dry:
        return rec
    ids = set(str(x) for x in (live.get("legacySiteIds") or []))
    ids.add(str(leg["id"]))
    live["legacySiteIds"] = sorted(ids)
    live["updatedAt"] = now
    live_c.upsert_item(live)
    leg["linkedArtemisSiteId"] = live["id"]
    leg["promoteStatus"] = action
    leg["graduatedAt"] = now
    leg["graduatedBy"] = OPERATOR
    leg["updatedAt"] = now
    leg_c.upsert_item(leg)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    dry = not args.apply
    db = cosmos_db()
    now = iso_now()
    leg_c = db.get_container_client("legacy-sites")
    live_c = db.get_container_client("sites")

    legacy_all = list(
        leg_c.query_items("SELECT * FROM c", enable_cross_partition_query=True)
    )
    unlinked = [x for x in legacy_all if not str(x.get("linkedArtemisSiteId") or "").strip()]
    live_rows = [
        s
        for s in live_c.query_items("SELECT * FROM c", enable_cross_partition_query=True)
        if str(s.get("status") or "").lower() != "merged"
    ]
    by_name: dict[str, list] = {}
    by_id = {s["id"]: s for s in live_rows}
    for s in live_rows:
        k = norm_name(s.get("name") or "")
        if k:
            by_name.setdefault(k, []).append(s)

    results = []
    linked = created = forced = 0

    # Force pins first
    remaining = []
    for leg in unlinked:
        pin = FORCE_LINKS.get(leg["id"])
        if pin and pin in by_id:
            results.append(link(leg_c, live_c, leg, by_id[pin], now, dry, "forced_link"))
            forced += 1
        else:
            remaining.append(leg)

    for leg in remaining:
        key = norm_name(leg.get("name") or leg.get("institution_name") or "")
        hits = by_name.get(key) or []
        if len(hits) == 1:
            results.append(link(leg_c, live_c, leg, hits[0], now, dry, "linked"))
            linked += 1
            continue

        # No match OR ambiguous → create stub so nothing stays master-list-only
        new_live = stub_from_legacy(leg, now)
        action = "created_ambiguous" if len(hits) > 1 else "created"
        rec = {
            "legacySiteId": leg["id"],
            "name": leg.get("name"),
            "action": action,
            "liveSiteId": None if dry else new_live["id"],
            "ambiguousCandidates": [h["id"] for h in hits] if len(hits) > 1 else None,
        }
        if not dry:
            live_c.create_item(new_live)
            leg["linkedArtemisSiteId"] = new_live["id"]
            leg["promoteStatus"] = action
            leg["graduatedAt"] = now
            leg["graduatedBy"] = OPERATOR
            leg["updatedAt"] = now
            leg_c.upsert_item(leg)
            k2 = norm_name(new_live["name"])
            if k2:
                by_name.setdefault(k2, []).append(new_live)
            by_id[new_live["id"]] = new_live
        created += 1
        results.append(rec)

    # Verify
    still = []
    if not dry:
        still = [
            x["id"]
            for x in leg_c.query_items(
                "SELECT c.id FROM c WHERE NOT IS_DEFINED(c.linkedArtemisSiteId) OR c.linkedArtemisSiteId = null OR c.linkedArtemisSiteId = \"\"",
                enable_cross_partition_query=True,
            )
        ]

    report = {
        "status": "dry-run" if dry else "applied",
        "unlinkedBefore": len(unlinked),
        "forced": forced,
        "linked": linked,
        "created": created,
        "unlinkedAfter": len(still) if not dry else None,
        "stillUnlinkedIds": still,
        "results": results,
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"{'DRY' if dry else 'APPLY'}: unlinked={len(unlinked)} "
        f"forced={forced} linked={linked} created={created} "
        f"still={len(still) if not dry else 'n/a'}"
    )
    print("Report:", REPORT)
    if dry:
        print("Re-run with --apply to write.")


if __name__ == "__main__":
    main()
