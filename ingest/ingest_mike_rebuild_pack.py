"""
Ingest Mike's ReBUILD 39-site partnership pack into Cosmos.

Writes (no local-file dependency for runtime):
  1) site-survey-definitions / mike-mighty-field-map   (field map)
  2) site-survey-assignments + site-survey-responses   (per matched site)
  3) site-profiles.mikePack                            (canonical answers on profile)

Matches pack sites -> live sites (preferred) or legacy-sites (then linkedArtemisSiteId).
Hand aliases cover known PI/practice renames; remaining unmatched rows get inert live
stubs on --apply so all 39 pack sites land in Cosmos.

Does NOT overwrite Chaos scheduling fields on live sites.
Does NOT delete existing survey responses; upserts dedicated Mike response docs.

Usage:
  python ingest/ingest_mike_rebuild_pack.py
  python ingest/ingest_mike_rebuild_pack.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey

REPO = Path(__file__).resolve().parents[1]
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
FIELD_MAP = REPO / "ingest" / "data" / "mike_mighty_field_map.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"
SOURCE = "mike-rebuild-39-pack"
FIELD_MAP_DOC_ID = "mike-mighty-field-map"
REPORT = REPO / ".firecrawl" / "mike-pack-cosmos-ingest-report.json"

# Confirmed live-site links (Mike pack id → Artemis sites.id). Do not map
# Gary Lane → Richard Lane (RCOT) or Jeremiah Brown → Michael Singer.
HAND_ALIASES: dict[str, dict] = {
    "REBUILD-004": {
        "siteId": "mpybtwssq8bk2t93cb",
        "note": "Charles Wykoff / Retina Consultants of Texas (same org as Brown; separate Mike response)",
    },
    "REBUILD-010": {
        "siteId": "1a0908afddb8383bb62",
        "note": "Western Carolina Retinal Associates, division of Asheville Eye / William Bridges",
    },
    "REBUILD-011": {
        "siteId": "1a0908a4d5117212421",
        "note": "Carl Danzig - Deerfield Beach",
    },
    "REBUILD-015": {
        "siteId": "1a0908a38d914190d24",
        "note": "John Thordsen Site",
    },
    "REBUILD-039": {
        "siteId": "mpybmg4prfu37clg7ls",
        "note": "Duke (institution; pack PI Eleonora Lad)",
    },
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


def norm_name(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc|the|center|institute|associates|assoc)\b", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def flatten_answers(obj, prefix=""):
    if isinstance(obj, dict):
        if "value" in obj or "pre_populate" in obj:
            yield prefix, obj.get("value"), bool(obj.get("pre_populate")), obj.get("source_study")
            return
        for k, v in obj.items():
            yield from flatten_answers(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from flatten_answers(v, f"{prefix}[{i}]")


def is_filled(val) -> bool:
    if val is None:
        return False
    s = str(val).strip()
    return s not in ("", "null", "None", "none", "n/a", "N/A", "-")


def slug(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")
    return t[:48] or "site"


def generate_id() -> str:
    return f"{int(time.time() * 1000):x}{secrets.token_hex(4)}"


def parse_location(loc: str) -> tuple[str, str]:
    text = str(loc or "").strip()
    if "," in text:
        city, state = text.rsplit(",", 1)
        return city.strip(), state.strip()
    return text, ""


def build_live_stub(pack_site: dict) -> dict:
    now = iso_now()
    city, state = parse_location(pack_site.get("location") or "")
    practice = str(pack_site.get("practice_name") or "").strip() or "Mike pack site"
    pi = str(pack_site.get("pi_name") or "").strip()
    return {
        "id": generate_id(),
        "name": practice,
        "status": "Active",
        "address": "",
        "address1": "",
        "address2": "",
        "city": city,
        "state": state,
        "zip": "",
        "zipCode": "",
        "pi": pi,
        "piName": pi,
        "piEmail": "",
        "siteCoordinator": "",
        "siteCoordinatorEmail": "",
        "notes": f"Created from Mike ReBUILD pack {pack_site.get('site_id')}",
        "source": SOURCE,
        "mikeRebuildPriorityId": pack_site.get("site_id"),
        "createdAt": now,
        "updatedAt": now,
    }


def match_site(practice: str, pi: str, live_sites: list, legacy_sites: list):
    """Return (siteId, how, score, matchName). Prefer live id."""
    target = norm_name(practice)
    pi_n = norm_name(pi)
    best = None  # dict with score, kind, site, how

    def consider(score, kind, site, how):
        nonlocal best
        if score < 0.72 or not site:
            return
        cand = {"score": float(score), "kind": kind, "site": site, "how": how}
        if best is None:
            best = cand
            return
        # Higher score wins; tie → prefer live
        if cand["score"] > best["score"] + 0.02:
            best = cand
            return
        if abs(cand["score"] - best["score"]) <= 0.02:
            if kind == "live" and best["kind"] != "live":
                best = cand

    for site in live_sites:
        nn = norm_name(site.get("name") or "")
        if not nn or not target:
            continue
        if nn == target:
            consider(1.0, "live", site, "exact-name")
        elif len(target) >= 12 and len(nn) >= 12 and (target in nn or nn in target):
            shorter, longer = (target, nn) if len(target) <= len(nn) else (nn, target)
            if len(shorter) / max(len(longer), 1) >= 0.55:
                consider(0.92, "live", site, "contains-name")
        else:
            r = SequenceMatcher(None, target, nn).ratio()
            if r >= 0.88:
                consider(r, "live", site, "fuzzy-name")
        if pi_n:
            for key in ("piName", "pi", "principalInvestigator"):
                if norm_name(site.get(key) or "") == pi_n:
                    # PI match alone is weak unless practice shares a token
                    tokens = [t for t in target.split() if len(t) >= 4]
                    overlap = any(t in nn for t in tokens)
                    consider(0.93 if overlap else 0.7, "live", site, "pi-name" if overlap else "pi-only")

    for site in legacy_sites:
        nn = norm_name(site.get("name") or "")
        if not nn or not target:
            continue
        score = 0.0
        how = ""
        if nn == target:
            score, how = 0.98, "legacy-exact-name"
        elif len(target) >= 12 and len(nn) >= 12 and (target in nn or nn in target):
            shorter, longer = (target, nn) if len(target) <= len(nn) else (nn, target)
            if len(shorter) / max(len(longer), 1) >= 0.55:
                score, how = 0.9, "legacy-contains-name"
        else:
            r = SequenceMatcher(None, target, nn).ratio()
            if r >= 0.88:
                score, how = r * 0.95, "legacy-fuzzy-name"
        if pi_n and norm_name(site.get("piName") or site.get("pi") or "") == pi_n:
            tokens = [t for t in target.split() if len(t) >= 4]
            overlap = any(t in nn for t in tokens)
            if overlap:
                score = max(score, 0.9)
                how = how or "legacy-pi"
            elif score < 0.72:
                score, how = 0.7, "legacy-pi-only"
        if score:
            linked = site.get("linkedArtemisSiteId")
            if linked:
                live = next((s for s in live_sites if s.get("id") == linked), None)
                if live:
                    consider(min(1.0, score + 0.01), "live", live, how + "+linked")
                    continue
            consider(score, "legacy", site, how)

    if not best:
        return None, None, 0.0, None
    site = best["site"]
    return site.get("id"), best["how"], round(best["score"], 3), site.get("name")


def build_answers(pack_site: dict, field_map: dict, survey_qs: list) -> list:
    path_meta = {f["packPath"]: f for f in field_map.get("fields") or [] if f.get("packPath")}
    q_by_lib = {
        q.get("libraryQuestionId"): q
        for q in survey_qs
        if q.get("libraryQuestionId")
    }
    answers = []
    seen_libs = set()
    for sec in ("section_1_site_profile", "section_2_indication_history"):
        for path, val, pre, src in flatten_answers(pack_site.get(sec) or {}):
            if not is_filled(val):
                continue
            meta = path_meta.get(path) or {}
            lib = meta.get("libraryQuestionId")
            cid = meta.get("canonicalId")
            mq = q_by_lib.get(lib) if lib else None
            # one answer per library id (first filled wins; pack usually one)
            if lib and lib in seen_libs:
                continue
            if lib:
                seen_libs.add(lib)
            answers.append(
                {
                    "questionId": (mq or {}).get("id") or cid or path,
                    "libraryQuestionId": lib,
                    "label": (mq or {}).get("label") or meta.get("mikeLabel") or path,
                    "type": (mq or {}).get("type") or "text",
                    "value": val if not isinstance(val, (dict, list)) else json.dumps(val),
                    "mikeCanonicalId": cid,
                    "mikePackPath": path,
                    "mikeLabel": meta.get("mikeLabel"),
                    "mikeFormField": meta.get("formField"),
                    "mikePrePopulate": pre,
                    "mikeSourceStudy": src,
                    "source": SOURCE,
                }
            )
    return answers


def build_profile_mike_pack(pack_site: dict, field_map: dict, answers: list) -> dict:
    by_canon = {}
    for a in answers:
        cid = a.get("mikeCanonicalId")
        if not cid:
            continue
        by_canon[cid] = {
            "value": a.get("value"),
            "packPath": a.get("mikePackPath"),
            "libraryQuestionId": a.get("libraryQuestionId"),
            "label": a.get("mikeLabel") or a.get("label"),
            "sourceStudy": a.get("mikeSourceStudy"),
        }
    return {
        "priorityId": pack_site.get("site_id"),
        "practiceName": pack_site.get("practice_name"),
        "piName": pack_site.get("pi_name"),
        "location": pack_site.get("location"),
        "hasGaData": bool(pack_site.get("has_ga_data")),
        "indicationsCovered": pack_site.get("indications_covered") or [],
        "source": SOURCE,
        "fieldMapId": FIELD_MAP_DOC_ID,
        "answerCount": len(answers),
        "canonicalAnswers": by_canon,
        "updatedAt": iso_now(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--pack", default=str(PACK))
    ap.add_argument("--map", default=str(FIELD_MAP))
    args = ap.parse_args()

    pack_path = Path(args.pack)
    map_path = Path(args.map)
    if not pack_path.exists():
        raise SystemExit(f"Pack missing: {pack_path}")
    if not map_path.exists():
        raise SystemExit(f"Field map missing — run build_mike_mighty_map.py first: {map_path}")

    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    field_map = json.loads(map_path.read_text(encoding="utf-8"))
    db = cosmos_db()
    pk = PartitionKey(path="/id")

    defs_c = db.create_container_if_not_exists(id="site-survey-definitions", partition_key=pk)
    asg_c = db.create_container_if_not_exists(id="site-survey-assignments", partition_key=pk)
    rsp_c = db.create_container_if_not_exists(id="site-survey-responses", partition_key=pk)
    profiles_c = db.create_container_if_not_exists(id="site-profiles", partition_key=pk)
    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")

    live_sites = list(
        sites_c.query_items(
            "SELECT c.id, c.name, c.piName, c.pi, c.principalInvestigator FROM c",
            enable_cross_partition_query=True,
        )
    )
    legacy_sites = list(
        legacy_c.query_items(
            "SELECT c.id, c.name, c.piName, c.pi, c.linkedArtemisSiteId FROM c",
            enable_cross_partition_query=True,
        )
    )

    survey = defs_c.read_item(SURVEY_ID, SURVEY_ID)
    survey_qs = survey.get("questions") or []

    now = iso_now()
    live_by_id = {s.get("id"): s for s in live_sites if s.get("id")}
    rows = []
    for pack_site in pack.get("sites") or []:
        priority_id = pack_site.get("site_id") or ""
        alias = HAND_ALIASES.get(priority_id)
        if alias and alias.get("siteId") in live_by_id:
            site = live_by_id[alias["siteId"]]
            site_id, how, score, match_name = (
                site["id"],
                "hand-alias",
                1.0,
                site.get("name"),
            )
        else:
            site_id, how, score, match_name = match_site(
                pack_site.get("practice_name") or "",
                pack_site.get("pi_name") or "",
                live_sites,
                legacy_sites,
            )
        answers = build_answers(pack_site, field_map, survey_qs)
        with_lib = sum(1 for a in answers if a.get("libraryQuestionId"))
        rows.append(
            {
                "priorityId": priority_id,
                "practiceName": pack_site.get("practice_name"),
                "piName": pack_site.get("pi_name"),
                "matchedSiteId": site_id,
                "matchedSiteName": match_name,
                "matchHow": how,
                "matchScore": score,
                "answerCount": len(answers),
                "answersWithLibraryId": with_lib,
                "unmatched": site_id is None,
                "willCreateStub": site_id is None,
            }
        )

    matched = [r for r in rows if r["matchedSiteId"]]
    unmatched = [r for r in rows if not r["matchedSiteId"]]
    print(f"Pack sites: {len(rows)}  matched: {len(matched)}  unmatched: {len(unmatched)}")
    print(
        f"Field map: {field_map.get('mappedPackPaths')}/{field_map.get('packPathCount')} "
        f"({field_map.get('mappedPct')}%)"
    )
    for r in matched:
        if r["matchHow"] == "hand-alias" or r["matchScore"] >= 0.9:
            print(
                f"  {r['matchScore']:.2f} {r['matchHow']:22s}  "
                f"{(r['practiceName'] or '')[:36]:36s} -> {(r['matchedSiteName'] or '')[:36]}  "
                f"({r['answerCount']} ans, {r['answersWithLibraryId']} lib)"
            )
    if unmatched:
        print(f"Unmatched (will create live stubs on --apply): {len(unmatched)}")
        for r in unmatched:
            print(f"  {r['priorityId']}  {r['practiceName']} ({r['piName']})")

    report = {
        "generatedAt": now,
        "source": SOURCE,
        "surveyId": SURVEY_ID,
        "matched": len(matched),
        "unmatched": len(unmatched),
        "handAliases": list(HAND_ALIASES.keys()),
        "rows": rows,
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {REPORT}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write Cosmos.")
        return

    # 1) Field map lives in Cosmos
    map_doc = {
        **field_map,
        "id": FIELD_MAP_DOC_ID,
        "type": "fieldMap",
        "isConfig": True,
        "status": "config",
        "title": "Mike Mighty / ReBUILD field map",
        "source": SOURCE,
        "updatedAt": now,
    }
    # avoid showing in survey pickers
    map_doc.pop("questions", None)
    defs_c.upsert_item(map_doc)
    print(f"Upserted field map doc {FIELD_MAP_DOC_ID}")

    # 2) Create live stubs for still-unmatched pack sites
    created_stubs = []
    pack_by_id = {s.get("site_id"): s for s in (pack.get("sites") or [])}
    for row in rows:
        if row["matchedSiteId"]:
            continue
        pack_site = pack_by_id.get(row["priorityId"])
        if not pack_site:
            continue
        stub = build_live_stub(pack_site)
        sites_c.create_item(stub)
        live_sites.append(stub)
        live_by_id[stub["id"]] = stub
        row["matchedSiteId"] = stub["id"]
        row["matchedSiteName"] = stub.get("name")
        row["matchHow"] = "created-stub"
        row["matchScore"] = 1.0
        row["unmatched"] = False
        row["willCreateStub"] = False
        created_stubs.append(
            {
                "priorityId": row["priorityId"],
                "siteId": stub["id"],
                "name": stub.get("name"),
                "pi": stub.get("pi"),
            }
        )
        print(f"Created stub {stub['id']} for {row['priorityId']} {stub.get('name')}")

    written = 0
    for pack_site, row in zip(pack.get("sites") or [], rows):
        site_id = row["matchedSiteId"]
        if not site_id:
            continue
        answers = build_answers(pack_site, field_map, survey_qs)
        # Key by Mike priority id so two pack PIs at one Artemis site never overwrite each other
        priority_slug = slug(pack_site.get("site_id") or row["priorityId"] or site_id)
        asg_id = f"asg-mike-rebuild-{priority_slug}"
        rsp_id = f"rsp-mike-rebuild-{priority_slug}"
        assignment = {
            "id": asg_id,
            "surveyId": SURVEY_ID,
            "siteId": site_id,
            "targetRole": "pi",
            "status": "submitted",
            "source": SOURCE,
            "mikePriorityId": pack_site.get("site_id"),
            "createdAt": now,
            "updatedAt": now,
            "submittedAt": now,
        }
        response = {
            "id": rsp_id,
            "assignmentId": asg_id,
            "surveyId": SURVEY_ID,
            "siteId": site_id,
            "targetRole": "pi",
            "displayName": pack_site.get("pi_name") or pack_site.get("practice_name"),
            "answers": answers,
            "source": SOURCE,
            "mikePriorityId": pack_site.get("site_id"),
            "mikePracticeName": pack_site.get("practice_name"),
            "answerCount": len(answers),
            "answersWithLibraryId": sum(1 for a in answers if a.get("libraryQuestionId")),
            "createdAt": now,
            "updatedAt": now,
            "submittedAt": now,
        }
        asg_c.upsert_item(assignment)
        rsp_c.upsert_item(response)

        # site-profiles: one profile per Artemis site; merge Mike packs by priority id
        profile_id = site_id
        try:
            profile = profiles_c.read_item(profile_id, profile_id)
        except Exception:
            profile = {
                "id": profile_id,
                "siteId": site_id,
                "schemaVersion": "1.1",
                "createdAt": now,
                "source": SOURCE,
            }
        mike_pack = build_profile_mike_pack(pack_site, field_map, answers)
        packs = dict(profile.get("mikePacks") or {})
        packs[str(pack_site.get("site_id") or priority_slug)] = mike_pack
        profile["mikePacks"] = packs
        # Keep latest as mikePack for back-compat
        profile["mikePack"] = mike_pack
        profile["updatedAt"] = now
        if pack_site.get("practice_name") and not profile.get("institution_name"):
            profile["institution_name"] = pack_site.get("practice_name")
        inds = list(profile.get("indicationsCovered") or [])
        for ind in pack_site.get("indications_covered") or []:
            if ind and ind not in inds:
                inds.append(ind)
        profile["indicationsCovered"] = inds
        profiles_c.upsert_item(profile)
        written += 1

    report.update(
        {
            "status": "applied",
            "createdStubs": created_stubs,
            "written": written,
            "matchedAfter": sum(1 for r in rows if r.get("matchedSiteId")),
            "unmatchedAfter": sum(1 for r in rows if not r.get("matchedSiteId")),
            "rows": rows,
        }
    )
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Applied: {written} site responses + profiles; "
        f"created {len(created_stubs)} stubs. Field map in Cosmos."
    )
    print("No Chaos scheduling fields were modified.")


if __name__ == "__main__":
    main()
