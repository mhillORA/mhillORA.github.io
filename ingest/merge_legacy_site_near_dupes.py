"""
Merge near-duplicate legacy-sites (e.g. Aesthetic Eye vs Aesthetic Eye Care).

Finds pairs by:
  - normalized name (strip LLC/Inc/&/punctuation)
  - one name is a prefix of the other (Aesthetic Eye ⊂ Aesthetic Eye Care)
  - same PI + same city (when both present)

Keeper preference: more survey responses → has profile → richer address/PI →
feasibility source over empty anterior stub → shorter id.

On --apply:
  - retarget site-survey-responses / assignments siteId → keeper
  - merge site-profiles into keeper (then delete orphan profile)
  - retarget legacy-study-site-outcomes siteId / siteName
  - merge relationship + indication fields onto keeper
  - delete orphan legacy-site

Usage:
  python ingest/merge_legacy_site_near_dupes.py
  python ingest/merge_legacy_site_near_dupes.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_feasibility_for_budget_buddy as m  # noqa: E402

LEGAL = re.compile(
    r"\b(llc|inc|incorporated|ltd|limited|pc|p\.c|pa|p\.a|sc|s\.c|pllc|llp|dba|the|of|and|&)\b",
    re.I,
)
LOCATION_SUFFIX = re.compile(
    r"\s+[-–—]\s+(?P<loc>[A-Za-z .'-]+)$|\s+\((?P<loc2>[A-Za-z .'-]+)\)$"
)
# Known typo / alt spellings that should merge (wrong → prefer correct if present)
TYPO_PAIRS = [
    ("cataline eye care", "catalina eyecare"),
    ("loam linda", "loma linda"),
]


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def norm_name(s: str) -> str:
    t = (s or "").strip().lower().replace("&", " and ")
    t = LEGAL.sub(" ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def norm_pi(s: str) -> str:
    t = (s or "").strip().lower()
    t = re.sub(r"\b(md|phd|do|od|mba|rn|fnp|pa-c|jr|sr|ii|iii|iv|dr)\b\.?", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def fetch_all(container, query="SELECT * FROM c", parameters=None):
    kwargs = {"query": query, "enable_cross_partition_query": True}
    if parameters:
        kwargs["parameters"] = parameters
    return list(container.query_items(**kwargs))


def count_by_site(db, container_id: str, archived_filter: bool = False) -> dict[str, int]:
    """One scan → {siteId: count}."""
    q = "SELECT c.siteId FROM c"
    if archived_filter:
        q = "SELECT c.siteId FROM c WHERE NOT IS_DEFINED(c._archived) OR c._archived != true"
    counts: dict[str, int] = defaultdict(int)
    for row in fetch_all(db.get_container_client(container_id), q):
        sid = row.get("siteId")
        if sid:
            counts[sid] += 1
    return counts


def strip_location_suffix(name: str) -> tuple[str, str | None]:
    m = LOCATION_SUFFIX.search(name or "")
    if not m:
        return name, None
    loc = (m.group("loc") or m.group("loc2") or "").strip()
    return (name or "")[: m.start()].strip(), loc


def is_stubby_name(name: str) -> bool:
    n = (name or "").lower()
    return (
        "(site)" in n
        or n.endswith(" site")
        or bool(re.search(r"\d{3,}", n))
        or "loam linda" in n
        or "cataline" in n
    )


def richness(site: dict, rsp: int, has_profile: bool, outcomes: int) -> tuple:
    """Higher = better keeper."""
    name = site.get("name") or ""
    filled = sum(
        1
        for k in ("pi", "city", "state", "address1", "zip", "relationshipPreference", "advantages")
        if site.get(k) not in (None, "")
    )
    feas = 1 if (site.get("source") or "").startswith("feasibility") else 0
    addressy = 1 if re.search(r"\d{3,}", name) or "(site)" in name.lower() else 0
    typo = 1 if ("loam linda" in name.lower() or "cataline" in name.lower()) else 0
    return (rsp, outcomes, int(has_profile), filled, feas, -addressy, -typo, -len(site.get("id") or ""))


def names_near_match(a: str, b: str) -> str | None:
    """Conservative near-dupe check — prefer false negatives over bad merges."""
    if not a or not b:
        return None
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return None
    if na == nb:
        return "normalized_equal"

    # Never merge two different city/location suffixes of the same brand
    a_head, a_loc = strip_location_suffix(a)
    b_head, b_loc = strip_location_suffix(b)
    if a_loc and b_loc and a_loc.lower() != b_loc.lower() and norm_name(a_head) == norm_name(b_head):
        return None
    # Parent brand must not swallow city-specific sites
    if a_loc and not b_loc and norm_name(b) == norm_name(a_head):
        return None
    if b_loc and not a_loc and norm_name(a) == norm_name(b_head):
        return None

    # Safe extension only: Aesthetic Eye → Aesthetic Eye Care; CORE → CORE Inc.
    for short, long_ in ((a, b), (b, a)):
        ns, nl = norm_name(short), norm_name(long_)
        if len(ns) < 6:
            continue
        if nl.startswith(ns + " "):
            rest = nl[len(ns) + 1 :]
            if re.fullmatch(
                r"((eye\s+)?(care|center|centre|clinic|associates|research|partners|institute|"
                r"group|medical\s+group|eyecare|p\s*c|llc|inc|ltd|pllc)"
                r"(\s+(eye\s+)?(care|center|centre|clinic|associates|research|partners|institute|"
                r"group|medical\s+group|eyecare|p\s*c|llc|inc|ltd|pllc))*|"
                r"an\s+nvision\s+(company|eye\s+center)|"
                r"dba\s+\w+(?:\s+\w+){0,6}|"
                r"trials|management|overview)",
                rest,
            ):
                return "safe_name_extension"

    # PI site twins: "David Brown (site)" vs "David Brown Site"
    def site_stub(n: str) -> str | None:
        t = re.sub(r"\s*\((site)\)\s*$", "", n, flags=re.I)
        t = re.sub(r"\s+site\s*\([^)]*\)\s*$", "", t, flags=re.I)
        t = re.sub(r"\s+site\s*$", "", t, flags=re.I)
        t2 = norm_name(t)
        return t2 if t2 and t2 != norm_name(n) else None

    sa, sb = site_stub(a), site_stub(b)
    if sa and sb and sa == sb:
        return "pi_site_twin"
    if sa and sa == nb:
        return "pi_site_twin"
    if sb and sb == na:
        return "pi_site_twin"

    # Known typo pairs
    al, bl = a.lower(), b.lower()
    for wrong, right in TYPO_PAIRS:
        if (wrong in al and right in bl) or (wrong in bl and right in al):
            return "known_typo"

    return None


def find_pairs(sites: list[dict]) -> list[tuple[dict, dict, str]]:
    pairs: dict[tuple[str, str], str] = {}
    by_id = {s["id"]: s for s in sites}

    def add(x, y, reason):
        if x["id"] == y["id"]:
            return
        key = tuple(sorted([x["id"], y["id"]]))
        pairs.setdefault(key, reason)

    by_norm: dict[str, list] = defaultdict(list)
    for s in sites:
        k = norm_name(s.get("name") or "")
        if k:
            by_norm[k].append(s)
    for group in by_norm.values():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                add(group[i], group[j], "normalized_equal")

    for i in range(len(sites)):
        for j in range(i + 1, len(sites)):
            reason = names_near_match(sites[i].get("name") or "", sites[j].get("name") or "")
            if reason:
                add(sites[i], sites[j], reason)

    # same PI + city only for stubby / address-like twins
    by_pi_city: dict[tuple[str, str], list] = defaultdict(list)
    for s in sites:
        pi = norm_pi(s.get("pi") or "")
        city = (s.get("city") or "").strip().lower()
        if pi and city and len(pi) > 4:
            by_pi_city[(pi, city)].append(s)
    for group in by_pi_city.values():
        if len(group) < 2:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                if is_stubby_name(a.get("name") or "") or is_stubby_name(b.get("name") or ""):
                    add(a, b, "same_pi_city")
                elif names_near_match(a.get("name") or "", b.get("name") or ""):
                    add(a, b, "same_pi_city")

    return [(by_id[a], by_id[b], reason) for (a, b), reason in pairs.items()]


def pick_keeper(a: dict, b: dict, stats: dict) -> tuple[dict, dict]:
    ra = richness(a, stats[a["id"]]["rsp"], stats[a["id"]]["profile"], stats[a["id"]]["outcomes"])
    rb = richness(b, stats[b["id"]]["rsp"], stats[b["id"]]["profile"], stats[b["id"]]["outcomes"])
    if ra >= rb:
        return a, b
    return b, a


def merge_site_fields(keeper: dict, orphan: dict) -> dict:
    out = dict(keeper)
    for k in (
        "pi",
        "city",
        "state",
        "zip",
        "address1",
        "siteCode",
        "relationshipPreference",
        "advantages",
        "disadvantages",
        "relationshipNotes",
        "notes",
        "linkedArtemisSiteId",
    ):
        if out.get(k) in (None, "") and orphan.get(k) not in (None, ""):
            out[k] = orphan[k]
    inds = sorted(
        set(out.get("indicationsCovered") or [])
        | set(orphan.get("indicationsCovered") or [])
        | set(out.get("therapeuticAreas") or [])
        | set(orphan.get("therapeuticAreas") or [])
    )
    if inds:
        out["indicationsCovered"] = inds
        out["therapeuticAreas"] = inds
    # Prefer longer / more specific display name when orphan is clearly an expansion
    kn, on = (keeper.get("name") or ""), (orphan.get("name") or "")
    if on and kn and norm_name(on).startswith(norm_name(kn) + " ") and len(on) > len(kn):
        out["name"] = on
    out["mergedFrom"] = sorted(set((out.get("mergedFrom") or []) + [orphan["id"]]))
    out["updatedAt"] = iso_now()
    return out


def merge_profiles(keeper_prof: dict | None, orphan_prof: dict | None, keeper_id: str, display_name: str) -> dict | None:
    if not keeper_prof and not orphan_prof:
        return None
    base = dict(keeper_prof or orphan_prof or {})
    other = orphan_prof if keeper_prof else None
    base["id"] = keeper_id
    base["siteId"] = keeper_id
    if not base.get("institution_name"):
        base["institution_name"] = display_name
    if other:
        for k, v in other.items():
            if str(k).startswith("_") or k in ("id", "siteId", "study_responses", "indication", "investigators", "contacts"):
                continue
            if base.get(k) in (None, "", [], {}) and v not in (None, "", [], {}):
                base[k] = v
        # merge study_responses by surveyId
        blobs = list(base.get("study_responses") or [])
        seen = {b.get("surveyId") for b in blobs}
        for b in other.get("study_responses") or []:
            if b.get("surveyId") not in seen:
                blobs.append(b)
                seen.add(b.get("surveyId"))
        base["study_responses"] = blobs
        ind = dict(base.get("indication") or {})
        for ta, fields in (other.get("indication") or {}).items():
            ind.setdefault(ta, {}).update({k: v for k, v in (fields or {}).items() if v not in (None, "")})
        base["indication"] = ind
    base["updatedAt"] = iso_now()
    return base


def retarget_responses(db, orphan_id: str, keeper_id: str, dry: bool) -> int:
    rsp_c = db.get_container_client("site-survey-responses")
    asg_c = db.get_container_client("site-survey-assignments")
    n = 0
    for r in fetch_all(
        rsp_c,
        "SELECT * FROM c WHERE c.siteId = @s",
        [{"name": "@s", "value": orphan_id}],
    ):
        # Avoid colliding with an existing keeper response for same survey
        existing = fetch_all(
            rsp_c,
            "SELECT c.id FROM c WHERE c.siteId = @s AND c.surveyId = @sv AND c.id != @id",
            [
                {"name": "@s", "value": keeper_id},
                {"name": "@sv", "value": r.get("surveyId")},
                {"name": "@id", "value": r["id"]},
            ],
        )
        if existing:
            # keep richer answer set
            try:
                keep_doc = rsp_c.read_item(existing[0]["id"], existing[0]["id"])
            except Exception:
                keep_doc = None
            orphan_answers = len(r.get("answers") or [])
            keep_answers = len((keep_doc or {}).get("answers") or [])
            if not dry:
                if orphan_answers > keep_answers and keep_doc:
                    # replace keeper answers with orphan's, then delete orphan
                    keep_doc["answers"] = r.get("answers")
                    keep_doc["displayName"] = keep_doc.get("displayName") or r.get("displayName")
                    keep_doc["updatedAt"] = iso_now()
                    keep_doc["mergedFromResponseId"] = r["id"]
                    rsp_c.upsert_item(keep_doc)
                rsp_c.delete_item(r["id"], r["id"])
            n += 1
            continue
        r["siteId"] = keeper_id
        r["updatedAt"] = iso_now()
        r["mergedFromSiteId"] = orphan_id
        if not dry:
            rsp_c.upsert_item(r)
        n += 1
    for a in fetch_all(
        asg_c,
        "SELECT * FROM c WHERE c.siteId = @s",
        [{"name": "@s", "value": orphan_id}],
    ):
        existing = fetch_all(
            asg_c,
            "SELECT c.id FROM c WHERE c.siteId = @s AND c.surveyId = @sv AND c.id != @id",
            [
                {"name": "@s", "value": keeper_id},
                {"name": "@sv", "value": a.get("surveyId")},
                {"name": "@id", "value": a["id"]},
            ],
        )
        if existing:
            if not dry:
                asg_c.delete_item(a["id"], a["id"])
            continue
        a["siteId"] = keeper_id
        a["updatedAt"] = iso_now()
        if not dry:
            asg_c.upsert_item(a)
    return n


def retarget_outcomes(db, orphan_id: str, keeper_id: str, keeper_name: str, dry: bool) -> int:
    out_c = db.get_container_client("legacy-study-site-outcomes")
    n = 0
    for o in fetch_all(
        out_c,
        "SELECT * FROM c WHERE c.siteId = @s",
        [{"name": "@s", "value": orphan_id}],
    ):
        o["siteId"] = keeper_id
        if keeper_name:
            o["siteName"] = keeper_name
        o["updatedAt"] = iso_now()
        o["mergedFromSiteId"] = orphan_id
        if not dry:
            out_c.upsert_item(o)
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--report", default="", help="Write JSON report path")
    args = ap.parse_args()

    m.load_key()
    if not m.KEY:
        raise SystemExit("COSMOS_KEY missing")

    client = CosmosClient(m.ENDPOINT, credential=m.KEY)
    db = client.get_database_client(m.DATABASE_ID)
    legacy_c = db.get_container_client("legacy-sites")
    prof_c = db.get_container_client("site-profiles")

    sites = fetch_all(legacy_c)
    print(f"legacy-sites: {len(sites)}")

    profile_ids = set()
    for p in fetch_all(prof_c, "SELECT c.id FROM c"):
        if p.get("id"):
            profile_ids.add(p["id"])

    print("Scanning responses + outcomes ...")
    rsp_by_site = count_by_site(db, "site-survey-responses", archived_filter=True)
    out_by_site = count_by_site(db, "legacy-study-site-outcomes")

    stats = {}
    for s in sites:
        sid = s["id"]
        stats[sid] = {
            "rsp": rsp_by_site.get(sid, 0),
            "outcomes": out_by_site.get(sid, 0),
            "profile": sid in profile_ids,
        }

    raw_pairs = find_pairs(sites)
    merges = []
    seen_orphan = set()
    # Sort so richer conflicts resolve first
    scored = []
    for a, b, reason in raw_pairs:
        keeper, orphan = pick_keeper(a, b, stats)
        scored.append((stats[keeper["id"]]["rsp"] + stats[orphan["id"]]["rsp"], keeper, orphan, reason))
    scored.sort(key=lambda x: -x[0])

    for _, keeper, orphan, reason in scored:
        if orphan["id"] in seen_orphan:
            continue
        if keeper["id"] in seen_orphan:
            # Keeper was already dropped into someone else — skip to avoid writing to a deleted id
            continue
        seen_orphan.add(orphan["id"])
        merges.append(
            {
                "reason": reason,
                "keeper": {
                    "id": keeper["id"],
                    "name": keeper.get("name"),
                    "pi": keeper.get("pi"),
                    "city": keeper.get("city"),
                    "state": keeper.get("state"),
                    "source": keeper.get("source"),
                    "responses": stats[keeper["id"]]["rsp"],
                    "outcomes": stats[keeper["id"]]["outcomes"],
                    "hasProfile": stats[keeper["id"]]["profile"],
                },
                "orphan": {
                    "id": orphan["id"],
                    "name": orphan.get("name"),
                    "pi": orphan.get("pi"),
                    "city": orphan.get("city"),
                    "state": orphan.get("state"),
                    "source": orphan.get("source"),
                    "responses": stats[orphan["id"]]["rsp"],
                    "outcomes": stats[orphan["id"]]["outcomes"],
                    "hasProfile": stats[orphan["id"]]["profile"],
                },
            }
        )

    print(f"merge pairs: {len(merges)}")
    for row in merges:
        k, o = row["keeper"], row["orphan"]
        print(
            f"\n[{row['reason']}] KEEP {k['name']!r} ({k['id']}) "
            f"rsp={k['responses']} out={k['outcomes']} prof={k['hasProfile']}"
        )
        print(
            f"           DROP {o['name']!r} ({o['id']}) "
            f"rsp={o['responses']} out={o['outcomes']} prof={o['hasProfile']}"
        )

    report_path = Path(args.report) if args.report else Path(__file__).resolve().parents[1] / "exports" / "legacy_site_merge_plan.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps({"generatedAt": iso_now(), "apply": bool(args.apply), "merges": merges}, indent=2),
        encoding="utf-8",
    )
    print(f"\nWrote {report_path}")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to merge.")
        return

    by_id = {s["id"]: s for s in sites}
    for row in merges:
        kid, oid = row["keeper"]["id"], row["orphan"]["id"]
        keeper = by_id[kid]
        orphan = by_id[oid]
        print(f"\nMerging {oid} -> {kid} ...")

        n_rsp = retarget_responses(db, oid, kid, dry=False)
        n_out = retarget_outcomes(db, oid, kid, keeper.get("name") or "", dry=False)
        print(f"  retargeted responses~{n_rsp}, outcomes={n_out}")

        keeper_prof = None
        orphan_prof = None
        try:
            keeper_prof = prof_c.read_item(kid, kid)
        except Exception:
            pass
        try:
            orphan_prof = prof_c.read_item(oid, oid)
        except Exception:
            pass
        merged_prof = merge_profiles(keeper_prof, orphan_prof, kid, keeper.get("name") or "")
        if merged_prof:
            if orphan_prof and (not keeper_prof or orphan_prof.get("institution_name")):
                # prefer longer institution name when expanding
                on = (orphan_prof or {}).get("institution_name") or ""
                kn = merged_prof.get("institution_name") or ""
                if on and kn and norm_name(on).startswith(norm_name(kn) + " "):
                    merged_prof["institution_name"] = on
            prof_c.upsert_item(merged_prof)
            if orphan_prof and oid != kid:
                try:
                    prof_c.delete_item(oid, oid)
                except Exception as e:
                    print(f"  warn: could not delete orphan profile: {e}")

        merged_site = merge_site_fields(keeper, orphan)
        merged_site["feasibilitySurveyCount"] = (
            stats[kid]["rsp"] + stats[oid]["rsp"]
        )  # approx; exact after retarget
        # exact count for this site only
        exact = list(
            db.get_container_client("site-survey-responses").query_items(
                query=(
                    "SELECT VALUE COUNT(1) FROM c WHERE c.siteId = @s "
                    "AND (NOT IS_DEFINED(c._archived) OR c._archived != true)"
                ),
                parameters=[{"name": "@s", "value": kid}],
                enable_cross_partition_query=True,
            )
        )
        if exact:
            merged_site["feasibilitySurveyCount"] = exact[0]
        legacy_c.upsert_item(merged_site)
        stats[kid]["rsp"] = merged_site["feasibilitySurveyCount"]
        stats[kid]["outcomes"] = stats[kid]["outcomes"] + stats[oid]["outcomes"]
        stats[kid]["profile"] = True if merged_prof else stats[kid]["profile"]
        by_id[kid] = merged_site
        try:
            legacy_c.delete_item(oid, oid)
            print(f"  deleted orphan site {oid}")
        except Exception as e:
            print(f"  warn: could not delete orphan site: {e}")

    print("\nDone. Re-export + push to bd-budgets next:")
    print("  python ingest/export_feasibility_for_budget_buddy.py --slim-answers")
    print("  python ingest/push_feasibility_to_bd_budgets.py")


if __name__ == "__main__":
    main()
