"""
Clean up site-survey-question-library bloat.

Why ~2k questions: UI "Import from templates" + SurveyMonkey exports turned
multiselects into one library row per "Question | Option".

This script:
  1) Upserts one canonical equipment multiselect (checkbox) with full options + aliases
  2) Collapses other exploded "Label | Option" groups into real multiselect/select rows
  3) Archives exploded option rows and remaps libraryQuestionId on survey defs
  4) Adds aliases so historical labels still match

Usage:
  python ingest/cleanup_question_library.py
  python ingest/cleanup_question_library.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey

REPO = Path(__file__).resolve().parents[1]
MULTI_CATALOG = REPO / "ingest" / "feasibility_multiselect_library.json"
REPORT = REPO / ".firecrawl" / "question-library-cleanup-report.json"
SOURCE = "question-library-cleanup"

EQUIPMENT_CANON_ID = "ql-site-equipment-inventory"
EQUIPMENT_LABEL = "Please select all equipment available on site"

IMAGING_OPTIONS = [
    "SD-OCT (Spectral Domain OCT)",
    "OCT-Angiography (OCT-A)",
    "Color Fundus Photography (CFP)",
    "Ultra-widefield Color Fundus Camera",
    "Fundus Autofluorescence (FAF)",
    "Fluorescein Angiography (FA)",
    "Ultra-widefield Fluorescein Angiography",
    "ETDRS lightbox",
    "Dedicated 4 meter BCVA lane",
    "Trial lens set & frames",
    "Slit lamp (biomicroscopy)",
    "Room for qCSF machine",
    "Corneal fluorescein strips",
]

EQUIPMENT_LABEL_HINTS = (
    "equipment available on site",
    "select all equipment",
    "check all that apply for the following equipment",
    "following equipment is mandatory",
    "sd-oct equipment",
    "fa equipment",
    "available equipment make and model",
    "capability of performing spectral domain",
    "color fundus photography",
    "fundus autofluorescence",
    "fluorescein angiography",
    "etdrs lightbox",
    "slit lamp",
    "trial lens",
    "bcva lane",
    "qcsf",
)

FIELD_GROUP_HINTS = (
    "contact information",
    "site details",
    "staff information",
    "coordinator details",
    "investigator details",
    "contracts contact",
    "principle investigator",
    "principal investigator",
    "please complete the following information",
    "provide vitreoretinal surgeon",
    "study staff information",
)

MULTI_HINTS = (
    "select all",
    "check all",
    "all that apply",
    "all boxes that apply",
    "any of the following",
    "please select any",
    "which of the following",
    "which tests do you",
    "equipment available",
    "equipment is mandatory",
    "appropriate storage for drug",
)


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


def norm(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def slug(s: str, n: int = 48) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return (t or "q")[:n]


EQUIPMENT_EXCLUDE_HINTS = (
    "make/model",
    "make model",
    "cat. no",
    "cat no",
    "please specify",
    "if other",
    "software version",
    "device/model",
    "how many",
    "certified by",
    "reading center",
    "calibration",
    "routinely calibrated",
    "temperature monitoring",
    "bcva vendors",
    "bcva examiners",
)


def is_equipment_label(label: str) -> bool:
    n = norm(label)
    if any(h in n for h in EQUIPMENT_EXCLUDE_HINTS):
        return False
    return any(h in n for h in EQUIPMENT_LABEL_HINTS)


def classify_group(base: str) -> str:
    n = norm(base)
    if any(h in n for h in FIELD_GROUP_HINTS):
        return "field_group"
    if is_equipment_label(base):
        return "equipment"
    if any(h in n for h in MULTI_HINTS):
        return "multiselect"
    # option-looking values → select
    return "select"


def catalog_equipment_options() -> list[str]:
    opts: list[str] = []
    seen = set()
    if MULTI_CATALOG.exists():
        data = json.loads(MULTI_CATALOG.read_text(encoding="utf-8"))
        for q in data.get("questions") or []:
            if "equipment available on site" in norm(q.get("canonical") or ""):
                for o in q.get("options") or []:
                    s = str(o).strip()
                    if not s or s.upper() == "N/A":
                        continue
                    # drop free-text companions from option list
                    if s.lower().startswith("please list"):
                        continue
                    k = norm(s)
                    if k in seen:
                        continue
                    seen.add(k)
                    opts.append(s)
                break
    for o in IMAGING_OPTIONS:
        k = norm(o)
        if k not in seen:
            seen.add(k)
            opts.append(o)
    opts.append("N/A")
    return opts


def fetch_all(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos_db()
    lib_c = db.create_container_if_not_exists(
        id="site-survey-question-library", partition_key=PartitionKey(path="/id")
    )
    defs_c = db.get_container_client("site-survey-definitions")

    library = fetch_all(lib_c)
    by_id = {x["id"]: x for x in library if x.get("id")}
    now = iso_now()

    exploded = []
    groups: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for doc in library:
        label = str(doc.get("label") or "")
        if " | " not in label:
            continue
        if str(doc.get("status") or "active") == "archived":
            continue
        base, opt = label.split(" | ", 1)
        base, opt = base.strip().rstrip(":").strip(), opt.strip()
        if not base or not opt:
            continue
        exploded.append(doc)
        groups[base].append((opt, doc))

    equipment_options = catalog_equipment_options()
    equipment_aliases = {EQUIPMENT_LABEL, f"{EQUIPMENT_LABEL}:"}
    equipment_alias_ids: list[str] = []

    # Collect equipment-related singles (Yes/No devices, rebuild radios, etc.)
    for doc in library:
        if str(doc.get("status") or "active") == "archived":
            continue
        label = str(doc.get("label") or "")
        if doc["id"] == EQUIPMENT_CANON_ID:
            continue
        if is_equipment_label(label) or (
            " | " in label and is_equipment_label(label.split(" | ", 1)[0])
        ):
            equipment_aliases.add(label)
            equipment_aliases.add(label.split(" | ", 1)[0].strip().rstrip(":"))
            equipment_alias_ids.append(doc["id"])
            # If option-like suffix is a device name, add as option
            if " | " in label:
                opt = label.split(" | ", 1)[1].strip()
                if opt and not opt.lower().startswith("please list") and norm(opt) not in {
                    "yes",
                    "no",
                    "n a",
                    "open ended response",
                }:
                    if norm(opt) not in {norm(o) for o in equipment_options}:
                        # insert before N/A
                        equipment_options.insert(-1, opt)

    # Dedupe options preserving order
    deduped = []
    seen_opt = set()
    for o in equipment_options:
        k = norm(o)
        if not k or k in seen_opt:
            continue
        seen_opt.add(k)
        deduped.append(o)
    if "N/A" not in deduped:
        deduped.append("N/A")
    equipment_options = deduped

    equipment_doc = {
        "id": EQUIPMENT_CANON_ID,
        "label": EQUIPMENT_LABEL,
        "type": "multiselect",
        "options": equipment_options,
        "required": False,
        "category": "Equipment",
        "help": "Select every piece of equipment available at your site. Use notes on the survey if something is missing from the list.",
        "aliases": sorted({a for a in equipment_aliases if a and a != EQUIPMENT_LABEL}),
        "mapsToProfile": "equipment_list",
        "status": "active",
        "tags": ["equipment", "canonical", "cleanup"],
        "source": SOURCE,
        "updatedAt": now,
        "createdAt": (by_id.get(EQUIPMENT_CANON_ID) or {}).get("createdAt") or now,
    }

    collapse_plan = []  # new canonical docs for non-equipment groups
    archive_ids = set(equipment_alias_ids)
    id_remap: dict[str, str] = {oid: EQUIPMENT_CANON_ID for oid in equipment_alias_ids}

    for base, pairs in groups.items():
        kind = classify_group(base)
        if kind == "equipment":
            for opt, doc in pairs:
                archive_ids.add(doc["id"])
                id_remap[doc["id"]] = EQUIPMENT_CANON_ID
            continue
        if kind == "field_group":
            # leave structured field groups alone for now
            continue
        if len(pairs) < 2:
            continue

        options = []
        seen = set()
        for opt, _doc in pairs:
            k = norm(opt)
            if not k or k in seen:
                continue
            seen.add(k)
            options.append(opt)
        if len(options) < 2:
            continue

        new_id = f"ql-ms-{slug(base)}"
        # avoid colliding with existing ql-* that already is the right question
        existing_canon = None
        for doc in library:
            if doc["id"] == new_id:
                existing_canon = doc
                break
            if norm(doc.get("label") or "") == norm(base) and str(doc.get("id") or "").startswith(
                "ql-"
            ):
                existing_canon = doc
                new_id = doc["id"]
                break

        qtype = "multiselect" if kind == "multiselect" else "select"
        aliases = [base, f"{base}:"] + [f"{base} | {opt}" for opt, _ in pairs]
        canon = {
            "id": new_id,
            "label": base,
            "type": qtype,
            "options": options if "N/A" in options or qtype != "multiselect" else options + ["N/A"],
            "required": False,
            "category": "Imported",
            "aliases": sorted(set(aliases)),
            "status": "active",
            "tags": ["collapsed-multiselect", "cleanup"],
            "source": SOURCE,
            "updatedAt": now,
            "createdAt": (existing_canon or {}).get("createdAt") or now,
        }
        collapse_plan.append(canon)
        for _opt, doc in pairs:
            archive_ids.add(doc["id"])
            id_remap[doc["id"]] = new_id

    # Also archive exact template dupes of ql-* labels (same norm label, prefer ql-*)
    by_norm = defaultdict(list)
    for doc in library:
        if str(doc.get("status") or "active") == "archived":
            continue
        by_norm[norm(doc.get("label") or "")].append(doc)
    dup_archived = 0
    for _k, docs in by_norm.items():
        if len(docs) < 2 or not _k:
            continue
        preferred = next((d for d in docs if str(d["id"]).startswith("ql-")), None)
        if not preferred:
            continue
        aliases = list(preferred.get("aliases") or [])
        for d in docs:
            if d["id"] == preferred["id"]:
                continue
            if str(d["id"]).startswith("ql-"):
                continue
            archive_ids.add(d["id"])
            id_remap[d["id"]] = preferred["id"]
            aliases.append(d.get("label") or "")
            dup_archived += 1
        preferred_aliases = sorted({a for a in aliases if a})
        # stash for apply
        preferred["_pending_aliases"] = preferred_aliases

    report = {
        "generatedAt": now,
        "libraryBefore": len(library),
        "explodedRows": len(exploded),
        "explodedGroups": len(groups),
        "equipmentOptions": len(equipment_options),
        "equipmentAliases": len(equipment_doc["aliases"]),
        "collapseCanons": len(collapse_plan),
        "archiveCount": len(archive_ids),
        "remapCount": len(id_remap),
        "dupLabelArchived": dup_archived,
        "equipmentId": EQUIPMENT_CANON_ID,
        "sampleRemap": dict(list(id_remap.items())[:12]),
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write Cosmos.")
        return

    # Upsert equipment + collapsed canons
    lib_c.upsert_item(equipment_doc)
    for canon in collapse_plan:
        lib_c.upsert_item(canon)

    # Merge pending aliases onto preferred ql-* docs
    for doc in library:
        pending = doc.pop("_pending_aliases", None)
        if not pending:
            continue
        if doc["id"] in archive_ids:
            continue
        try:
            live = lib_c.read_item(doc["id"], doc["id"])
        except Exception:
            continue
        aliases = sorted(set(list(live.get("aliases") or []) + pending + [live.get("label") or ""]))
        live["aliases"] = [a for a in aliases if a and a != live.get("label")]
        live["updatedAt"] = now
        lib_c.upsert_item(live)

    # Archive exploded / dup rows
    archived = 0
    for oid in archive_ids:
        if oid == EQUIPMENT_CANON_ID:
            continue
        doc = by_id.get(oid)
        if not doc:
            continue
        if str(doc.get("status")) == "archived":
            continue
        doc = {**doc}
        doc["status"] = "archived"
        doc["archivedAt"] = now
        doc["archivedBy"] = SOURCE
        doc["replacedBy"] = id_remap.get(oid)
        doc["updatedAt"] = now
        lib_c.upsert_item(doc)
        archived += 1
        if archived % 100 == 0:
            print(f"  archived {archived}/{len(archive_ids)}…")

    # Remap survey definitions
    defs = fetch_all(defs_c)
    defs_touched = 0
    q_remapped = 0
    for d in defs:
        if d.get("isConfig") or d.get("type") == "fieldMap" or d.get("status") == "config":
            continue
        changed = False
        for q in d.get("questions") or []:
            lid = str(q.get("libraryQuestionId") or "")
            if lid and lid in id_remap and id_remap[lid] != lid:
                q["libraryQuestionId"] = id_remap[lid]
                changed = True
                q_remapped += 1
        if changed:
            d["updatedAt"] = now
            defs_c.upsert_item(d)
            defs_touched += 1

    report.update(
        {
            "status": "applied",
            "archivedWritten": archived,
            "defsTouched": defs_touched,
            "questionsRemapped": q_remapped,
        }
    )
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Applied: equipment canon + {len(collapse_plan)} collapsed; "
        f"archived {archived}; remapped {q_remapped} def questions across {defs_touched} surveys."
    )


if __name__ == "__main__":
    main()
