"""
Ingest Anterior Segment Overview.xlsx -> Cosmos (ora-clinical-recruiting / crcscheduling)
Containers ONLY: legacy-studies, legacy-sites, legacy-study-site-outcomes
Does NOT write to live studies/sites/patients/crcs/events containers.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

try:
    from azure.cosmos import CosmosClient, PartitionKey
except ImportError:
    print("Install: pip install azure-cosmos openpyxl")
    sys.exit(1)

from openpyxl import load_workbook

DEFAULT_XLSX = Path(r"c:\Users\shue1\Downloads\Anterior Segment Overview.xlsx")
ENDPOINT = os.environ.get("COSMOS_ENDPOINT", "https://ora-clinical-recruiting.documents.azure.com:443/")
KEY = os.environ.get("COSMOS_KEY", "")
DATABASE_ID = os.environ.get("DATABASE_ID", "crcscheduling")
STUDIES_CONTAINER = "legacy-studies"
SITES_CONTAINER = "legacy-sites"
OUTCOMES_CONTAINER = "legacy-study-site-outcomes"


def load_key_from_local_settings():
    global KEY
    if KEY:
        return
    candidates = [
        Path(r"C:\Users\shue1\OneDrive\Desktop\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
        Path(__file__).resolve().parents[1] / "api" / "local.settings.json",
    ]
    for p in candidates:
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            vals = data.get("Values") or {}
            KEY = vals.get("COSMOS_KEY") or KEY
            return


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return float(v)
    s = str(v).strip().replace(",", "")
    if not s or s == "-":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def s(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    t = str(v).strip()
    if t.startswith("="):  # skip raw formulas if data_only failed
        return None
    return t or None


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return (slug or "unknown")[:80]


def outcome_id(study: str, site: str, group) -> str:
    raw = f"{study}|{site}|{group}"
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"legacy-outcome-{h}"


def parse_workbook(path: Path):
    wb = load_workbook(path, read_only=True, data_only=True)
    rows = list(wb["Completed Projects"].iter_rows(values_only=True))
    hdr_i = next(i for i, r in enumerate(rows) if r and s(r[0]) == "Unique ID")
    col = {
        "unique_id": 0,
        "study": 1,
        "site": 2,
        "group": 3,
        "pi": 4,
        "visit1_start": 5,
        "lplv": 8,
        "target_scheduled": 9,
        "scheduled": 10,
        "screen": 11,
        "enrolled": 13,
    }
    records = []
    for row in rows[hdr_i + 1 :]:
        if not row:
            continue
        study = s(row[col["study"]]) if len(row) > 1 else None
        site = s(row[col["site"]]) if len(row) > 2 else None
        if not study or not site:
            continue
        # skip repeated section headers / blank templates inside the sheet
        if study.lower() in {"study", "unique id", "row labels"}:
            continue
        if site.lower() in {"site", "row labels"}:
            continue
        visit1 = s(row[col["visit1_start"]]) if len(row) > 5 else None
        if visit1 and visit1.lower() in {"visit 1 start", "e002 date"}:
            continue
        records.append(
            {
                "unique_id": s(row[col["unique_id"]]) if len(row) > 0 else None,
                "study": study,
                "site": site,
                "group": num(row[col["group"]]) if len(row) > 3 else None,
                "pi": s(row[col["pi"]]) if len(row) > 4 else None,
                "visit1_start": visit1,
                "lplv": s(row[col["lplv"]]) if len(row) > 8 else None,
                "target_scheduled": num(row[col["target_scheduled"]]) if len(row) > 9 else None,
                "scheduled": num(row[col["scheduled"]]) if len(row) > 10 else None,
                "screened": num(row[col["screen"]]) if len(row) > 11 else None,
                "enrolled": num(row[col["enrolled"]]) if len(row) > 13 else None,
            }
        )

    # Indication from study tabs (header row: Study Name | Indication | ...)
    indication_by_study = {}
    skip = {
        "Scheduled",
        "Screened",
        "Enrolled",
        "Completed Projects",
        "Site Contact",
        "Master Tracker",
        "Template",
    }
    for name in wb.sheetnames:
        if name in skip:
            continue
        sheet_rows = list(wb[name].iter_rows(values_only=True))
        if len(sheet_rows) < 2:
            continue
        hdr = [s(v) for v in sheet_rows[0]]
        if not hdr or (hdr[0] or "").lower() != "study name":
            continue
        if len(hdr) < 2 or (hdr[1] or "").lower() != "indication":
            continue
        vals = list(sheet_rows[1])
        study_name = s(vals[0]) if vals else None
        indication = s(vals[1]) if len(vals) > 1 else None
        if not indication or len(indication) > 80:
            continue
        for key in filter(None, [study_name, name]):
            indication_by_study[key] = indication
            indication_by_study[norm_name(key)] = indication

    wb.close()
    return records, indication_by_study


def norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def resolve_indication(study: str, indication_by_study: dict) -> str | None:
    """Map Completed Projects study name → Indication (also used as TA)."""
    if not study:
        return None
    # Exact / normalized tab lookup
    for key in (study, norm_name(study)):
        if key in indication_by_study:
            return indication_by_study[key]
    n = norm_name(study)
    # Fuzzy: tab study/tab name contained in or containing completed-projects name
    best = None
    best_len = 0
    for key, ind in indication_by_study.items():
        kn = norm_name(key)
        if not kn or len(kn) < 4:
            continue
        if kn in n or n in kn:
            if len(kn) > best_len:
                best, best_len = ind, len(kn)
    if best:
        return best

    low = study.lower()
    # Explicit tokens in the study label
    if "redness" in low:
        return "Redness"
    if "allergy" in low or re.search(r"\bcac\b", low):
        return "Allergy"
    if "dry eye" in low or "dryeye" in n:
        return "Dry Eye"
    if "blepharitis" in low:
        return "Blepharitis"
    if "safety" in low:
        return "Safety"
    if "mgd" in low:
        return "MGD"
    if "presbyopia" in low:
        return "Presbyopia"

    # Family defaults from active dossier tabs in this workbook
    if low.startswith("telios"):
        return "Allergy"
    if low.startswith("stuart"):
        return "Dry Eye"
    if low.startswith("regn") or "regeneron" in low:
        return "Allergy"
    if low.startswith("roche"):
        return "Dry Eye"
    if low.startswith("dep-") or low.startswith("dep "):
        return "Dry Eye"
    if low.startswith("alcon") and ("c002" in n or "c003" in n or "e002" in n):
        return "Redness"
    return None


def site_id_for(name: str) -> str:
    return f"legacy-site-{slugify(name)}"


def build_docs(records, indication_by_study, source_file: str):
    now = datetime.utcnow().isoformat() + "Z"
    by_study = defaultdict(
        lambda: {
            "target_scheduled": 0.0,
            "scheduled": 0.0,
            "screened": 0.0,
            "enrolled": 0.0,
            "sites": set(),
            "pis": set(),
            "dates": [],
            "lplvs": [],
        }
    )
    by_site = defaultdict(
        lambda: {
            "name": None,
            "target_scheduled": 0.0,
            "scheduled": 0.0,
            "screened": 0.0,
            "enrolled": 0.0,
            "studies": set(),
            "pis": set(),
            "nOutcomeRows": 0,
        }
    )

    outcomes = []
    for r in records:
        study = r["study"]
        site_name = r["site"]
        study_id = f"legacy-study-{slugify(study)}"
        site_id = site_id_for(site_name)
        oid = outcome_id(study, site_name, r["group"])
        outcomes.append(
            {
                "id": oid,
                "type": "legacyStudySiteOutcome",
                "studyId": study_id,
                "studyName": study,
                "siteId": site_id,
                "siteName": site_name,
                "group": r["group"],
                "pi": r["pi"],
                "visit1Start": r["visit1_start"],
                "lplv": r["lplv"],
                "targetScheduled": r["target_scheduled"],
                "scheduled": r["scheduled"],
                "screened": r["screened"],
                "enrolled": r["enrolled"],
                "uniqueId": r["unique_id"],
                "source": "anterior-segment-overview",
                "sourceFile": source_file,
                "ingestedAt": now,
                "createdAt": now,
                "updatedAt": now,
            }
        )
        agg = by_study[study]
        for f_src, f_dst in [
            ("target_scheduled", "target_scheduled"),
            ("scheduled", "scheduled"),
            ("screened", "screened"),
            ("enrolled", "enrolled"),
        ]:
            agg[f_dst] += r.get(f_src) or 0
        agg["sites"].add(site_name)
        if r["pi"]:
            agg["pis"].add(r["pi"])
        if r["visit1_start"]:
            agg["dates"].append(r["visit1_start"])
        if r["lplv"]:
            agg["lplvs"].append(r["lplv"])

        sagg = by_site[site_id]
        sagg["name"] = site_name
        sagg["nOutcomeRows"] += 1
        sagg["studies"].add(study)
        if r["pi"]:
            sagg["pis"].add(r["pi"])
        for f_src, f_dst in [
            ("target_scheduled", "target_scheduled"),
            ("scheduled", "scheduled"),
            ("screened", "screened"),
            ("enrolled", "enrolled"),
        ]:
            sagg[f_dst] += r.get(f_src) or 0

    studies = []
    for study, agg in by_study.items():
        study_id = f"legacy-study-{slugify(study)}"
        indication = resolve_indication(study, indication_by_study)
        studies.append(
            {
                "id": study_id,
                "type": "legacyStudy",
                "name": study,
                "title": study,
                # In this workbook TA == Indication
                "therapeuticArea": indication,
                "indication": indication,
                "sponsor": None,
                "phase": None,
                "status": "Completed",
                "notes": None,
                "source": "anterior-segment-overview",
                "sourceFile": source_file,
                "editableFields": True,
                "metrics": {
                    "targetScheduled": round(agg["target_scheduled"], 2),
                    "scheduled": round(agg["scheduled"], 2),
                    "screened": round(agg["screened"], 2),
                    "enrolled": round(agg["enrolled"], 2),
                    "nSites": len(agg["sites"]),
                    "nPis": len(agg["pis"]),
                    "nSiteRows": len([o for o in outcomes if o["studyName"] == study]),
                    "visit1StartMin": min(agg["dates"]) if agg["dates"] else None,
                    "visit1StartMax": max(agg["dates"]) if agg["dates"] else None,
                    "lplvMin": min(agg["lplvs"]) if agg["lplvs"] else None,
                    "lplvMax": max(agg["lplvs"]) if agg["lplvs"] else None,
                },
                "createdAt": now,
                "updatedAt": now,
                "ingestedAt": now,
            }
        )

    # One doc per unique dropdown site (~50), not one per outcome row (~700)
    sites = []
    for sid, agg in sorted(by_site.items(), key=lambda x: -(x[1]["enrolled"])):
        sites.append(
            {
                "id": sid,
                "type": "legacySite",
                "name": agg["name"],
                "siteCode": slugify(agg["name"]).upper().replace("-", "_")[:32],
                "status": "Active",
                "notes": None,
                "relationshipPreference": None,
                "advantages": None,
                "disadvantages": None,
                "relationshipNotes": None,
                "linkedArtemisSiteId": None,
                "source": "anterior-segment-overview",
                "sourceFile": source_file,
                "editableFields": True,
                "metrics": {
                    "targetScheduled": round(agg["target_scheduled"], 2),
                    "scheduled": round(agg["scheduled"], 2),
                    "screened": round(agg["screened"], 2),
                    "enrolled": round(agg["enrolled"], 2),
                    "nStudies": len(agg["studies"]),
                    "nPis": len(agg["pis"]),
                    "nOutcomeRows": agg["nOutcomeRows"],
                    "studyNames": sorted(agg["studies"]),
                },
                "createdAt": now,
                "updatedAt": now,
                "ingestedAt": now,
            }
        )
    return studies, sites, outcomes



def upsert_all(studies, sites, outcomes, dry_run=False):
    load_key_from_local_settings()
    if not KEY:
        raise SystemExit("COSMOS_KEY missing. Set env COSMOS_KEY or use local.settings.json")

    if dry_run:
        print(f"DRY RUN: {len(studies)} studies, {len(sites)} unique sites, {len(outcomes)} outcome rows")
        print("sites sample:", json.dumps(sites[:3], indent=2))
        print("outcome sample:", json.dumps(outcomes[:1], indent=2))
        return

    client = CosmosClient(ENDPOINT, credential=KEY)
    db = client.get_database_client(DATABASE_ID)
    pk_id = PartitionKey(**{"path": "/id"})
    pk_study = PartitionKey(**{"path": "/studyId"})
    db.create_container_if_not_exists(id=STUDIES_CONTAINER, partition_key=pk_id)
    db.create_container_if_not_exists(id=SITES_CONTAINER, partition_key=pk_id)
    db.create_container_if_not_exists(id=OUTCOMES_CONTAINER, partition_key=pk_study)
    studies_c = db.get_container_client(STUDIES_CONTAINER)
    sites_c = db.get_container_client(SITES_CONTAINER)
    outcomes_c = db.get_container_client(OUTCOMES_CONTAINER)

    # Preserve manually edited study metadata
    existing_meta = {}
    for item in studies_c.query_items(
        query="SELECT c.id, c.therapeuticArea, c.sponsor, c.phase, c.status, c.notes, c.indication FROM c",
        enable_cross_partition_query=True,
    ):
        existing_meta[item["id"]] = item

    # Preserve site edits + linked Artemis id
    existing_sites = {}
    for item in sites_c.query_items(
        query=(
            "SELECT c.id, c.status, c.notes, c.linkedArtemisSiteId, c.siteCode, "
            "c.relationshipPreference, c.advantages, c.disadvantages, c.relationshipNotes, c.createdAt FROM c"
        ),
        enable_cross_partition_query=True,
    ):
        existing_sites[item["id"]] = item

    # Optional soft-match to live ARTEMIS sites by exact name (read-only; never writes to sites)
    live_by_name = {}
    try:
        live_c = db.get_container_client("sites")
        for item in live_c.query_items(
            query="SELECT c.id, c.name FROM c",
            enable_cross_partition_query=True,
        ):
            if item.get("name"):
                live_by_name[str(item["name"]).strip().lower()] = item["id"]
    except Exception as e:
        print("Note: could not read live sites for linking:", e)

    print(f"Upserting {len(studies)} legacy studies...")
    for doc in studies:
        prev = existing_meta.get(doc["id"])
        if prev:
            for k in ("sponsor", "phase", "status", "notes"):
                if prev.get(k) not in (None, ""):
                    doc[k] = prev[k]
            # Prefer freshly resolved indication; fall back to prior manual value
            if not doc.get("indication") and prev.get("indication"):
                doc["indication"] = prev["indication"]
            # TA is Indication in this workbook — always keep them aligned
            if doc.get("indication"):
                doc["therapeuticArea"] = doc["indication"]
            elif prev.get("therapeuticArea"):
                doc["therapeuticArea"] = prev["therapeuticArea"]
                doc["indication"] = prev["therapeuticArea"]
            if prev.get("createdAt"):
                doc["createdAt"] = prev["createdAt"]
        elif doc.get("indication"):
            doc["therapeuticArea"] = doc["indication"]
        studies_c.upsert_item(doc)

    print(f"Upserting {len(sites)} unique legacy sites (not {len(outcomes)} rows)...")
    for doc in sites:
        prev = existing_sites.get(doc["id"])
        if prev:
            for k in (
                "status",
                "notes",
                "siteCode",
                "relationshipPreference",
                "advantages",
                "disadvantages",
                "relationshipNotes",
            ):
                if prev.get(k) not in (None, ""):
                    doc[k] = prev[k]
            if prev.get("linkedArtemisSiteId"):
                doc["linkedArtemisSiteId"] = prev["linkedArtemisSiteId"]
            if prev.get("createdAt"):
                doc["createdAt"] = prev["createdAt"]
        if not doc.get("linkedArtemisSiteId"):
            link = live_by_name.get((doc.get("name") or "").strip().lower())
            if link:
                doc["linkedArtemisSiteId"] = link
        sites_c.upsert_item(doc)

    print(f"Upserting {len(outcomes)} site-study outcomes (with siteId)...")
    batch = 0
    for doc in outcomes:
        outcomes_c.upsert_item(doc)
        batch += 1
        if batch % 100 == 0:
            print(f"  ...{batch}/{len(outcomes)}")
    print("Done.")



def main():
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry = "--dry-run" in sys.argv
    path = Path(args[0]) if args else DEFAULT_XLSX
    if not path.exists():
        raise SystemExit(f"File not found: {path}")
    print(f"Parsing {path} ...")
    records, indications = parse_workbook(path)
    print(f"Parsed {len(records)} site-study outcome rows")
    studies, sites, outcomes = build_docs(records, indications, str(path))
    print(f"Built {len(studies)} studies, {len(sites)} UNIQUE sites, {len(outcomes)} outcome rows")
    upsert_all(studies, sites, outcomes, dry_run=dry)


if __name__ == "__main__":
    main()
