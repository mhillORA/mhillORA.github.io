"""
Build / refresh the Mike harmonization bridge:

  raw SurveyMonkey question text
    → PROF-### / IND-### / STUDY-###  (Question_Harmonization_Mapping.json)
    → Artemis libraryQuestionId (ql-*)

Also dry-runs coverage against Ora_Feasibility_Data_All_Sites*.json
WITHOUT writing any site documents to Cosmos.

Usage:
  python ingest/build_harmonization_bridge.py
  python ingest/build_harmonization_bridge.py --all-sites "c:\\Users\\...\\Ora_Feasibility_Data_All_Sites+12Sep26 Update2.json"
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "ingest" / "data"
DEFAULT_MAPPING = Path(r"c:\Users\shue1\Downloads\Question_Harmonization_Mapping.json")
DEFAULT_ALL_SITES = Path(r"c:\Users\shue1\Downloads\Ora_Feasibility_Data_All_Sites+12Sep26 Update2.json")
BRIDGE_OUT = DATA / "harmonization_bridge.json"
REPORT_OUT = REPO / ".firecrawl" / "harmonization-bridge-report.json"

# Hand seeds where form_field / label clearly maps to Artemis ql-* ids
SEED_BY_CANONICAL = {
    "PROF-001": "ql-site-name",  # Institution/Practice Name
    "PROF-002": "ql-site-address",  # Site Address
    "PROF-005": "ql-pi-name",  # PI Name
    "PROF-006": "ql-pi-email",
    "PROF-007": "ql-pi-phone",
    "PROF-008": "ql-coord-name",  # Preferred / primary contact
    "PROF-009": "ql-coord-email",
    "PROF-010": "ql-coord-phone",
    "PROF-011": "ql-primary-contact-role",  # Primary Contact Role
    "PROF-012": "ql-contracts-name",  # Contract/Budget Contact (name)
    "PROF-090": "ql-rebuild-080-on-average-how-long-will-it-take-to-execute-the-clin",  # CTA / budget timeline
    "PROF-013": "ql-gf-05-practice-setting",
    "PROF-029": "ql-gf-29-central-irb",  # may refine after label check
    "PROF-024": None,  # photographers count — match by label
}

SEED_BY_FORM_FIELD = {
    "s1.contact.institution_name": "ql-site-name",
    "s1.contact.address": "ql-site-address",
    "s1.contact.pi_name": "ql-pi-name",
    "s1.contact.pi_email": "ql-pi-email",
    "s1.contact.pi_phone": "ql-pi-phone",
    "s1.contact.primary_name": "ql-coord-name",
    "s1.contact.primary_email": "ql-coord-email",
    "s1.contact.primary_phone": "ql-coord-phone",
    "s1.irb.type": "ql-gf-29-central-irb",
    "s1.vendor.edc": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "s1.vendor.irt": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
}


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


def norm(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\(select all that apply.*?\)", "", t)
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load_library():
    db = cosmos_db()
    lib_c = db.get_container_client("site-survey-question-library")
    items = list(lib_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    by_id = {x["id"]: x for x in items if x.get("id")}
    by_label = {}
    for x in items:
        k = norm(x.get("label"))
        if k and k not in by_label:
            by_label[k] = x
    return by_id, by_label


def fuzzy_lib(label: str, by_label: dict, min_score: float = 0.88, min_len: int = 18):
    ln = norm(label)
    if not ln:
        return None, 0.0
    if ln in by_label:
        return by_label[ln], 1.0
    best = None
    best_s = 0.0
    for k, obj in by_label.items():
        s = SequenceMatcher(None, ln, k).ratio()
        if s > best_s:
            best_s = s
            best = obj
    if best and best_s >= min_score and (len(ln) >= min_len or best_s >= 0.95):
        return best, best_s
    return None, best_s


def build_bridge(mapping: dict, by_id: dict, by_label: dict) -> dict:
    canonical = mapping.get("canonical_fields") or {}
    qmap = mapping.get("question_mapping") or []

    # Aggregate raw question texts per canonical_id for richer matching
    raws_by_cid: dict[str, list[str]] = defaultdict(list)
    for row in qmap:
        cid = row.get("canonical_id")
        rq = row.get("raw_question")
        if cid and rq:
            raws_by_cid[cid].append(str(rq))

    bridges = {}
    unmatched = []

    for cid, meta in canonical.items():
        label = meta.get("label") or ""
        form_field = meta.get("form_field") or ""
        layer = meta.get("layer") or ""
        category = meta.get("category") or ""

        hit = None
        how = None
        score = None

        seed = SEED_BY_CANONICAL.get(cid) or SEED_BY_FORM_FIELD.get(form_field)
        if seed and seed in by_id:
            hit = by_id[seed]
            how = "seed"
            score = 1.0
        else:
            obj, s = fuzzy_lib(label, by_label)
            if obj:
                hit = obj
                how = "label-exact" if s >= 0.999 else f"label-fuzzy:{s:.2f}"
                score = s
            else:
                # try a few raw question stems (before |)
                for raw in raws_by_cid.get(cid, [])[:12]:
                    stem = raw.split("|")[0].strip()
                    obj, s = fuzzy_lib(stem, by_label, min_score=0.90, min_len=24)
                    if obj:
                        hit = obj
                        how = f"raw-fuzzy:{s:.2f}"
                        score = s
                        break

        entry = {
            "canonical_id": cid,
            "label": label,
            "layer": layer,
            "category": category,
            "form_field": form_field,
            "raw_question_count": len(raws_by_cid.get(cid, [])),
            "libraryQuestionId": hit["id"] if hit else None,
            "libraryLabel": hit.get("label") if hit else None,
            "matchHow": how,
            "matchScore": score,
        }
        bridges[cid] = entry
        if not hit:
            unmatched.append(entry)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceMapping": "Question_Harmonization_Mapping.json",
        "canonicalCount": len(canonical),
        "bridgedCount": sum(1 for v in bridges.values() if v["libraryQuestionId"]),
        "unbridgedCount": len(unmatched),
        "bridges": bridges,
        "unbridged": unmatched,
        # reverse index for ingest: raw question → {canonical_id, libraryQuestionId}
        "rawToLibrary": {},
    }


def attach_raw_index(mapping: dict, bridge_doc: dict) -> None:
    bridges = bridge_doc["bridges"]
    raw_index = {}
    for row in mapping.get("question_mapping") or []:
        raw = str(row.get("raw_question") or "").strip()
        cid = row.get("canonical_id")
        if not raw or not cid:
            continue
        b = bridges.get(cid) or {}
        raw_index[raw] = {
            "canonical_id": cid,
            "label": b.get("label") or row.get("label"),
            "layer": b.get("layer") or row.get("layer"),
            "form_field": b.get("form_field") or row.get("form"),
            "libraryQuestionId": b.get("libraryQuestionId"),
        }
    bridge_doc["rawToLibrary"] = raw_index
    bridge_doc["rawIndexCount"] = len(raw_index)
    bridge_doc["rawIndexedWithLibrary"] = sum(
        1 for v in raw_index.values() if v.get("libraryQuestionId")
    )


def dry_run_all_sites(all_sites_path: Path, bridge_doc: dict) -> dict:
    data = json.loads(all_sites_path.read_text(encoding="utf-8"))
    sites = data.get("sites") or {}
    raw_index = bridge_doc.get("rawToLibrary") or {}

    total_responses = 0
    hit_raw = 0
    hit_lib = 0
    miss = 0
    by_canonical = Counter()
    sample_misses = []

    for _key, site in sites.items():
        for survey in site.get("surveys") or []:
            responses = survey.get("responses") or {}
            for raw_q, _val in responses.items():
                total_responses += 1
                hit = raw_index.get(raw_q)
                if not hit:
                    # try normalize-insensitive fallback
                    miss += 1
                    if len(sample_misses) < 40:
                        sample_misses.append(raw_q[:160])
                    continue
                hit_raw += 1
                if hit.get("libraryQuestionId"):
                    hit_lib += 1
                    by_canonical[hit["canonical_id"]] += 1
                else:
                    # mapped to canonical but not yet bridged to ql-*
                    by_canonical[f"UNBRIDGED:{hit['canonical_id']}"] += 1

    return {
        "allSitesFile": all_sites_path.name,
        "siteCount": len(sites),
        "answerCells": total_responses,
        "resolvedViaMapping": hit_raw,
        "resolvedViaMappingPct": round(100.0 * hit_raw / total_responses, 1) if total_responses else 0,
        "resolvedToLibraryId": hit_lib,
        "resolvedToLibraryPct": round(100.0 * hit_lib / total_responses, 1) if total_responses else 0,
        "unmappedRaw": miss,
        "topCanonicalHits": by_canonical.most_common(25),
        "sampleUnmapped": sample_misses,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", default=str(DEFAULT_MAPPING))
    ap.add_argument("--all-sites", default=str(DEFAULT_ALL_SITES))
    ap.add_argument("--skip-dry-run", action="store_true")
    args = ap.parse_args()

    mapping_path = Path(args.mapping)
    if not mapping_path.exists():
        raise SystemExit(f"Mapping not found: {mapping_path}")

    DATA.mkdir(parents=True, exist_ok=True)
    # Keep a local copy of Mike's mapping for reproducibility
    local_mapping = DATA / "Question_Harmonization_Mapping.json"
    if mapping_path.resolve() != local_mapping.resolve():
        shutil.copy2(mapping_path, local_mapping)

    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    by_id, by_label = load_library()
    print(f"Library items: {len(by_id)}")

    bridge_doc = build_bridge(mapping, by_id, by_label)
    attach_raw_index(mapping, bridge_doc)

    print(
        f"Canonical fields: {bridge_doc['canonicalCount']}  "
        f"bridged->ql-*: {bridge_doc['bridgedCount']}  "
        f"unbridged: {bridge_doc['unbridgedCount']}"
    )
    print(
        f"Raw map rows indexed: {bridge_doc['rawIndexCount']}  "
        f"with library id: {bridge_doc['rawIndexedWithLibrary']}"
    )

    report = {
        "bridgeSummary": {
            "canonicalCount": bridge_doc["canonicalCount"],
            "bridgedCount": bridge_doc["bridgedCount"],
            "unbridgedCount": bridge_doc["unbridgedCount"],
            "rawIndexCount": bridge_doc["rawIndexCount"],
            "rawIndexedWithLibrary": bridge_doc["rawIndexedWithLibrary"],
        },
        "unbridged": bridge_doc["unbridged"],
        "bridgedSample": [
            {
                "canonical_id": v["canonical_id"],
                "label": v["label"],
                "libraryQuestionId": v["libraryQuestionId"],
                "matchHow": v["matchHow"],
            }
            for v in list(bridge_doc["bridges"].values())
            if v.get("libraryQuestionId")
        ][:40],
    }

    all_sites_path = Path(args.all_sites)
    if not args.skip_dry_run and all_sites_path.exists():
        print(f"Dry-running all-sites: {all_sites_path.name}")
        report["allSitesDryRun"] = dry_run_all_sites(all_sites_path, bridge_doc)
        dr = report["allSitesDryRun"]
        print(
            f"Answer cells: {dr['answerCells']}  "
            f"map hit: {dr['resolvedViaMapping']} ({dr['resolvedViaMappingPct']}%)  "
            f"ql-* hit: {dr['resolvedToLibraryId']} ({dr['resolvedToLibraryPct']}%)  "
            f"unmapped: {dr['unmappedRaw']}"
        )
    elif not args.skip_dry_run:
        print(f"All-sites file missing, skip dry-run: {all_sites_path}")

    # Persist bridge without the huge rawToLibrary duplicated in report
    BRIDGE_OUT.write_text(json.dumps(bridge_doc, indent=2), encoding="utf-8")
    REPORT_OUT.parent.mkdir(exist_ok=True)
    REPORT_OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {BRIDGE_OUT}")
    print(f"Wrote {REPORT_OUT}")
    print("No Cosmos site documents were modified.")


if __name__ == "__main__":
    main()
