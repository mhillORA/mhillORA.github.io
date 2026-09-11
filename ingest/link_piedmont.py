"""Link Piedmont (legacy) → Piedmont Eye (live)."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
cfg = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
cs = cfg["cosmosdb-connection"]["connectionString"]
endpoint = re.search(r"AccountEndpoint=([^;]+)", cs).group(1)
key = re.search(r"AccountKey=([^;]+)", cs).group(1)
db = CosmosClient(endpoint, key).get_database_client("crcscheduling")
leg_c = db.get_container_client("legacy-sites")
live_c = db.get_container_client("sites")

legs = list(
    leg_c.query_items(
        "SELECT * FROM c WHERE CONTAINS(LOWER(c[\"name\"]), @n)",
        parameters=[{"name": "@n", "value": "piedmont"}],
        enable_cross_partition_query=True,
    )
)
lives = list(
    live_c.query_items(
        "SELECT * FROM c WHERE CONTAINS(LOWER(c[\"name\"]), @n)",
        parameters=[{"name": "@n", "value": "piedmont"}],
        enable_cross_partition_query=True,
    )
)
print("legacy:", [(x["id"], x.get("name"), x.get("linkedArtemisSiteId")) for x in legs])
print("live:", [(x["id"], x.get("name"), x.get("legacySiteIds")) for x in lives])

leg = next(
    (
        x
        for x in legs
        if str(x.get("name") or "").strip().lower() == "piedmont"
        or (
            "piedmont" in str(x.get("name") or "").lower()
            and "eye" not in str(x.get("name") or "").lower()
        )
    ),
    None,
)
if not leg:
    leg = next((x for x in legs if not x.get("linkedArtemisSiteId")), legs[0] if legs else None)
live = next((x for x in lives if "eye" in str(x.get("name") or "").lower()), lives[0] if lives else None)
if not leg or not live:
    raise SystemExit("Could not find Piedmont docs")

print("LINK", leg.get("name"), leg["id"], "->", live.get("name"), live["id"])
now = datetime.now(timezone.utc).isoformat()
leg["linkedArtemisSiteId"] = live["id"]
leg["promoteStatus"] = "linked"
leg["promotedAt"] = now
leg["promotedBy"] = "user-confirm-piedmont"
leg["updatedAt"] = now
leg_c.upsert_item(leg)

ids = list(live.get("legacySiteIds") or [])
if leg["id"] not in ids:
    ids.append(leg["id"])
live["legacySiteIds"] = ids
live["updatedAt"] = now
live_c.upsert_item(live)
print("done", leg.get("name"), "->", live.get("name"), live.get("legacySiteIds"))
