"""
One-shot cleanup: rename feasibility legacy-sites whose `name` is a raw street address.
Keeps id (survey siteId links stay valid). Sets name to \"PI — City\" when possible.
Also updates matching site-profiles.institution_name.

Usage:
  python ingest/fix_legacy_address_site_names.py
  python ingest/fix_legacy_address_site_names.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from azure.cosmos import CosmosClient
except ImportError:
    print("Install: pip install azure-cosmos")
    sys.exit(1)

# reuse helpers from master ingest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import feasibility_master_ingest as fmi  # noqa: E402
from feasibility_master_ingest import (  # noqa: E402
    is_address_like_name,
    parse_address_blob,
)

SOURCE = "feasibility-master-ingest"


def better_name(doc: dict) -> str | None:
    name = (doc.get("name") or "").strip()
    if not is_address_like_name(name):
        return None
    pi = (doc.get("pi") or "").strip()
    city = (doc.get("city") or "").strip()
    if not city and doc.get("address1"):
        city = (parse_address_blob(doc["address1"]).get("address_city") or "") or ""
    if not city and name:
        city = (parse_address_blob(name).get("address_city") or "") or ""
    if pi and city:
        return f"{pi} - {city}"
    if pi:
        return f"{pi} (site)"
    if city:
        return f"Site in {city}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--fix-dashes", action="store_true", help="Normalize em-dash names to ASCII ' - '")
    args = ap.parse_args()

    fmi.load_key()
    if not fmi.KEY:
        raise SystemExit("COSMOS_KEY missing")

    client = CosmosClient(fmi.ENDPOINT, credential=fmi.KEY)
    db = client.get_database_client(fmi.DATABASE_ID)
    legacy_c = db.get_container_client("legacy-sites")
    prof_c = db.get_container_client("site-profiles")

    sites = list(
        legacy_c.query_items(
            query="SELECT * FROM c WHERE c.source = @src",
            parameters=[{"name": "@src", "value": SOURCE}],
            enable_cross_partition_query=True,
        )
    )

    renames = []
    for s in sites:
        new = better_name(s)
        if not new and args.fix_dashes and s.get("name") and "\u2014" in s["name"]:
            new = s["name"].replace("\u2014", "-").replace("  ", " ")
        if new and new != s.get("name"):
            renames.append((s, new))

    print(f"feasibility legacy-sites: {len(sites)}")
    print(f"names to update: {len(renames)}")
    for s, new in renames[:25]:
        print(f"  {s.get('name')!r}")
        print(f"  -> {new!r}  ({s['id']})")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to rename.")
        return

    for s, new in renames:
        old = s.get("name")
        s["name"] = new
        if is_address_like_name(old or ""):
            s["nameWasAddress"] = True
            s["previousAddressName"] = old
        if not s.get("address1") and old and is_address_like_name(old):
            parsed = parse_address_blob(old)
            if parsed.get("address_street"):
                s["address1"] = parsed["address_street"]
            if parsed.get("address_city") and not s.get("city"):
                s["city"] = parsed["address_city"]
            if parsed.get("address_state") and not s.get("state"):
                s["state"] = parsed["address_state"]
            if parsed.get("address_zip") and not s.get("zip"):
                s["zip"] = parsed["address_zip"]
        legacy_c.upsert_item(s)
        try:
            prof = prof_c.read_item(s["id"], s["id"])
            inst = prof.get("institution_name") or ""
            if is_address_like_name(inst) or "\u2014" in inst or inst == old:
                prof["institution_name"] = new
                prof_c.upsert_item(prof)
        except Exception:
            pass

    print(f"Updated {len(renames)} legacy-sites (+ matching profiles where present).")


if __name__ == "__main__":
    main()
