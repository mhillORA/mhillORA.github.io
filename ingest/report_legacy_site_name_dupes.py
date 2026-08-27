"""Report duplicate legacy-site names in ARTEMIS Cosmos."""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_feasibility_for_budget_buddy import DATABASE_ID, ENDPOINT, KEY, load_key  # noqa: E402

from azure.cosmos import CosmosClient


def main():
    load_key()
    # re-read after load_key mutates module globals
    import export_feasibility_for_budget_buddy as m

    m.load_key()
    client = CosmosClient(m.ENDPOINT, credential=m.KEY)
    db = client.get_database_client(m.DATABASE_ID)
    sites = list(
        db.get_container_client("legacy-sites").query_items(
            "SELECT c.id, c.name, c.pi, c.city, c.state, c.linkedArtemisSiteId, "
            "c.feasibilitySurveyCount, c.source FROM c",
            enable_cross_partition_query=True,
        )
    )
    print(f"legacy-sites: {len(sites)}")

    by_name: dict[str, list] = defaultdict(list)
    for s in sites:
        n = (s.get("name") or "").strip()
        if n:
            by_name[n.lower()].append(s)

    dupes = {k: v for k, v in by_name.items() if len(v) > 1}
    print(f"unique names: {len(by_name)}")
    print(f"names with 2+ docs: {len(dupes)}")
    print(f"extra duplicate docs: {sum(len(v) - 1 for v in dupes.values())}")

    ranked = sorted(dupes.items(), key=lambda x: -len(x[1]))
    print("\nTop duplicate names:")
    for _, v in ranked[:30]:
        print(f"\n=== {v[0].get('name')}  ({len(v)} docs) ===")
        for s in v:
            print(
                f"  id={s.get('id')}"
                f"  pi={s.get('pi')!r}"
                f"  {s.get('city')}, {s.get('state')}"
                f"  surveys={s.get('feasibilitySurveyCount')}"
                f"  source={s.get('source')}"
                f"  link={s.get('linkedArtemisSiteId')}"
            )

    out = Path(__file__).resolve().parents[1] / "exports" / "legacy_site_name_dupes.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "totalSites": len(sites),
        "uniqueNames": len(by_name),
        "dupeNameCount": len(dupes),
        "extraDocs": sum(len(v) - 1 for v in dupes.values()),
        "dupes": [
            {
                "name": v[0].get("name"),
                "count": len(v),
                "sites": v,
            }
            for _, v in ranked
        ],
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
