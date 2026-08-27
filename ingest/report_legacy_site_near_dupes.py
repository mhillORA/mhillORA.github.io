"""Fuzzy / near-duplicate legacy site names + profile institution names."""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_feasibility_for_budget_buddy as m
from azure.cosmos import CosmosClient

LEGAL = re.compile(
    r"\b(llc|inc|incorporated|ltd|limited|pc|p\.c|pa|p\.a|sc|s\.c|pllc|llp|dba|the|of|and|&)\b",
    re.I,
)


def norm(s: str) -> str:
    t = (s or "").strip().lower().replace("&", " and ")
    t = LEGAL.sub(" ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def main():
    m.load_key()
    client = CosmosClient(m.ENDPOINT, credential=m.KEY)
    db = client.get_database_client(m.DATABASE_ID)

    sites = list(
        db.get_container_client("legacy-sites").query_items(
            "SELECT c.id, c.name, c.pi, c.city, c.state, c.source, c.feasibilitySurveyCount FROM c",
            enable_cross_partition_query=True,
        )
    )
    profiles = list(
        db.get_container_client("site-profiles").query_items(
            "SELECT c.id, c.institution_name FROM c",
            enable_cross_partition_query=True,
        )
    )

    by_norm: dict[str, list] = defaultdict(list)
    for s in sites:
        key = norm(s.get("name") or "")
        if key:
            by_norm[key].append(s)

    near = {k: v for k, v in by_norm.items() if len(v) > 1}
    print(f"legacy-sites={len(sites)}  normalized keys={len(by_norm)}  near-dupe groups={len(near)}")
    print(f"extra near-dupe docs={sum(len(v)-1 for v in near.values())}")

    ranked = sorted(near.items(), key=lambda x: -len(x[1]))
    for k, v in ranked[:40]:
        names = sorted({(x.get("name") or "") for x in v})
        print(f"\n=== norm={k!r}  ({len(v)} docs) ===")
        for n in names:
            print(f"  display: {n}")
        for s in v:
            print(
                f"    {s['id']}  source={s.get('source')}  "
                f"pi={s.get('pi')!r}  {s.get('city')},{s.get('state')}  "
                f"surveys={s.get('feasibilitySurveyCount')}"
            )

    # PI - City pattern clusters (same PI, different sites?)
    by_pi = defaultdict(list)
    for s in sites:
        pi = (s.get("pi") or "").strip().lower()
        if pi and len(pi) > 3:
            by_pi[pi].append(s)
    pi_multi = {k: v for k, v in by_pi.items() if len(v) > 1}
    print(f"\n\nPIs with 2+ sites: {len(pi_multi)}")
    for k, v in sorted(pi_multi.items(), key=lambda x: -len(x[1]))[:15]:
        print(f"\nPI={v[0].get('pi')!r} ({len(v)})")
        for s in v:
            print(f"  {s.get('name')}  [{s['id']}]  {s.get('city')},{s.get('state')}  src={s.get('source')}")

    # profile institution vs site name mismatches / dupes
    inst_counts = defaultdict(list)
    for p in profiles:
        inst = (p.get("institution_name") or "").strip()
        if inst:
            inst_counts[inst.lower()].append(p)
    inst_dupes = {k: v for k, v in inst_counts.items() if len(v) > 1}
    print(f"\n\nprofile institution_name exact dupes: {len(inst_dupes)}")
    for k, v in sorted(inst_dupes.items(), key=lambda x: -len(x[1]))[:20]:
        print(f"  {v[0].get('institution_name')} x{len(v)} -> {[x['id'] for x in v]}")


if __name__ == "__main__":
    main()
