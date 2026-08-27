"""
Relink dry-eye / old-aso outcomes onto real legacy-sites (prefer feasibility)
and ensure every outcome studyId exists in legacy-studies.

Does not overwrite funnel metrics. Only retargets siteId/siteName (and fixes
orphan study pointers). Merges empty PI stubs after retarget.

Usage:
  python ingest/relink_legacy_outcomes.py --dry-run
  python ingest/relink_legacy_outcomes.py --apply
"""
from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

_INGEST = Path(__file__).resolve().parent
sys.path.insert(0, str(_INGEST))
sys.path.insert(0, str(_INGEST.parent))

from azure.cosmos import CosmosClient

import legacy_dry_eye_overview as de

SOURCES = {"dry-eye-overview", "old-aso-completed"}
STUB_SOURCES = {"dry-eye-overview", "old-aso-completed"}

# Explicit PI / stub label → preferred legacy site id (feasibility / anterior)
KNOWN_SITE_ALIASES = {
    "zimmer": "legacy-site-feas-scott-and-christie-eyecare-associates",
    "kenyon": "legacy-site-feas-eye-health-vision-center-claris-vision",
    "kenyon ma": "legacy-site-feas-eye-health-vision-center-claris-vision",
    "kenyon ri": "legacy-site-feas-claris-vision-llc-dba-eye-health-vision-center",
    "segal-cx": "legacy-site-feas-segal-drug-trials",
    "segal cx": "legacy-site-feas-segal-drug-trials",
    "vollmer": "legacy-site-feas-core-inc",
    "cline": "legacy-site-feas-core-inc",
    "cline/vollmer": "legacy-site-feas-core-inc",
}


def iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def alias_key(label: str) -> str:
    t = de.norm_name(label or "")
    t = re.sub(r"\s*g\d+\s*$", "", t).strip()
    return t


def resolve_target(label: str, matchable, pi_index, sites_by):
    key = alias_key(label)
    if key in KNOWN_SITE_ALIASES:
        sid = KNOWN_SITE_ALIASES[key]
        if sid in sites_by:
            return sites_by[sid]
    # Try head surname for "Kenyon MA"
    head = re.sub(r"\s+(ma|ri|ny|tx|fl|cx)\s*$", "", key).strip()
    if head and head in KNOWN_SITE_ALIASES:
        sid = KNOWN_SITE_ALIASES[head]
        if sid in sites_by:
            return sites_by[sid]
    hit = de.match_site(label, matchable, pi_index)
    if hit and hit.get("id") in sites_by:
        return sites_by[hit["id"]]
    return None


def main():
    dry = "--apply" not in sys.argv
    de.load_key_from_local_settings()
    if not de.KEY:
        raise SystemExit("COSMOS_KEY missing")
    client = CosmosClient(de.ENDPOINT, credential=de.KEY)
    db = client.get_database_client(de.DATABASE_ID)
    studies_c = db.get_container_client(de.STUDIES_CONTAINER)
    sites_c = db.get_container_client(de.SITES_CONTAINER)
    outcomes_c = db.get_container_client(de.OUTCOMES_CONTAINER)

    studies = list(studies_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    sites = list(sites_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    outcomes = list(outcomes_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    studies_by = {s["id"]: s for s in studies}
    sites_by = {s["id"]: s for s in sites}

    pi_index = de.build_pi_site_index(outcomes, sites)
    matchable = [s for s in sites if (s.get("source") or "") not in STUB_SOURCES]

    print(f"Cosmos: {len(studies)} studies, {len(sites)} sites, {len(outcomes)} outcomes")

    retargets = []
    for o in outcomes:
        if o.get("source") not in SOURCES:
            continue
        site = sites_by.get(o.get("siteId") or "")
        # Retarget if missing site OR currently on a stub
        on_stub = bool(site and (site.get("source") or "") in STUB_SOURCES)
        missing = not site
        if not on_stub and not missing:
            continue
        label = o.get("workbookSiteLabel") or o.get("pi") or (site or {}).get("name") or o.get("siteName")
        target = resolve_target(label, matchable, pi_index, sites_by)
        if not target:
            continue
        if site and target["id"] == site["id"]:
            continue
        retargets.append((o, target, label))

    print(f"Outcomes to retarget onto legacy/feasibility sites: {len(retargets)}")
    seen = set()
    for o, target, label in retargets:
        key = (o.get("siteId"), target["id"], label)
        if key in seen:
            continue
        seen.add(key)
        print(
            f"  [{o.get('source')}] {label!r}: "
            f"{o.get('siteName')!r} -> {target.get('name')!r}"
        )

    # Study fixes: missing study doc
    study_fixes = []
    for o in outcomes:
        if o.get("studyId") in studies_by:
            continue
        # Try rematch by studyName
        hit = de.match_study(o.get("studyName") or "", studies)
        if hit:
            study_fixes.append((o, hit))
    print(f"Outcomes with missing study to fix: {len(study_fixes)}")

    # Annotate matched studies/sites with sources list (additive)
    if dry:
        print("\nDRY RUN — no writes. Re-run with --apply")
        # Also report remaining stubs that cannot rematch
        still = []
        for o in outcomes:
            if o.get("source") not in SOURCES:
                continue
            site = sites_by.get(o.get("siteId") or "")
            if not site or (site.get("source") or "") not in STUB_SOURCES:
                continue
            label = o.get("workbookSiteLabel") or o.get("pi") or site.get("name")
            if not resolve_target(label, matchable, pi_index, sites_by):
                still.append((label, site.get("name"), site["id"]))
        uniq = {(a, b, c) for a, b, c in still}
        print(f"Stub sites with no rematch (remain as legacy-sites): {len(uniq)}")
        for a, b, c in sorted(uniq):
            print(f"  keep stub {b!r} (label {a!r})")
        return

    now = iso_now()
    touched_sites = set()
    touched_studies = set()

    for o, target, label in retargets:
        o["siteId"] = target["id"]
        o["siteName"] = target.get("name") or o.get("siteName")
        o["updatedAt"] = now
        o["relinkedAt"] = now
        outcomes_c.upsert_item(o)
        touched_sites.add(target["id"])

    for o, hit in study_fixes:
        o["studyId"] = hit["id"]
        o["studyName"] = hit.get("name") or o.get("studyName")
        o["updatedAt"] = now
        outcomes_c.upsert_item(o)
        touched_studies.add(hit["id"])

    # Tag targets
    for tid in touched_sites:
        full = sites_c.read_item(tid, partition_key=tid)
        sources = full.get("sources") or []
        if not isinstance(sources, list):
            sources = [sources] if sources else []
        if full.get("source") and full["source"] not in sources:
            sources.append(full["source"])
        changed = False
        for src in SOURCES:
            # only add if any retarget from that source
            if any(o.get("source") == src for o, t, _ in retargets if t["id"] == tid):
                if src not in sources:
                    sources.append(src)
                    changed = True
        if changed:
            full["sources"] = sources
            full["updatedAt"] = now
            sites_c.upsert_item(full)

    # Delete empty stubs
    remaining = list(
        outcomes_c.query_items("SELECT c.siteId FROM c", enable_cross_partition_query=True)
    )
    used = {r.get("siteId") for r in remaining if r.get("siteId")}
    deleted = 0
    for site in sites:
        if (site.get("source") or "") not in STUB_SOURCES:
            continue
        if site["id"] in used:
            continue
        sites_c.delete_item(site["id"], partition_key=site["id"])
        deleted += 1
        print(f"  deleted empty stub {site.get('name')!r}")
    print(f"Relink done. Retargeted={len(retargets)}, studyFixes={len(study_fixes)}, stubsDeleted={deleted}")


if __name__ == "__main__":
    main()
