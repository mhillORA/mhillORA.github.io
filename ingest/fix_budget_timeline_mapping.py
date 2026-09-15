"""
Fix inverted contract/timeline mappings and repair Cosmos answers.

1) Harmonization seeds: Role / Contact / CTA time point at the right ql-* ids
2) Raw "average length of negotiations" → PROF-090 (not PROF-012)
3) Live rebuild answers: timeline values sitting in ql-contracts-name → move to ql-rebuild-080

Usage:
  python ingest/fix_budget_timeline_mapping.py
  python ingest/fix_budget_timeline_mapping.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
QH = REPO / "ingest" / "data" / "Question_Harmonization_Mapping.json"
HB = REPO / "ingest" / "data" / "harmonization_bridge.json"
BRIDGE_PY = REPO / "ingest" / "build_harmonization_bridge.py"

CTA_LIB = "ql-rebuild-080-on-average-how-long-will-it-take-to-execute-the-clin"
CONTACT_NAME_LIB = "ql-contracts-name"
CONTACT_EMAIL_LIB = "ql-contracts-email"
ROLE_LIB = "ql-primary-contact-role"

TIMELINE_VAL = re.compile(
    r"(?i)^\s*("
    r"\d+\s*(-|/to)?\s*\d*\s*(business\s+)?(day|days|week|weeks|month|months|yr|year|years)\b.*"
    r"|pair with the regulatory.*"
    r"|like a month.*"
    r")\s*$"
)
TIMELINE_RAW = re.compile(
    r"(?i)average length of contract/budget|how long will it take to execute|"
    r"cta execution|startup timing|negotiations within your site"
)


def cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    parts = {}
    for chunk in data["cosmosdb-connection"]["connectionString"].rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return CosmosClient(parts["AccountEndpoint"], parts["AccountKey"]).get_database_client(
        "crcscheduling"
    )


def fix_bridge_py() -> None:
    text = BRIDGE_PY.read_text(encoding="utf-8")
    old = '''    "PROF-011": "ql-contracts-name",
    "PROF-012": "ql-contracts-email",
    "PROF-013": "ql-gf-05-practice-setting",'''
    new = '''    "PROF-011": "ql-primary-contact-role",  # Primary Contact Role
    "PROF-012": "ql-contracts-name",  # Contract/Budget Contact (name)
    "PROF-090": "ql-rebuild-080-on-average-how-long-will-it-take-to-execute-the-clin",  # CTA / budget timeline
    "PROF-013": "ql-gf-05-practice-setting",'''
    if old not in text:
        raise SystemExit("build_harmonization_bridge.py seeds not found — abort")
    BRIDGE_PY.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("updated build_harmonization_bridge.py seeds")


def fix_question_mapping() -> int:
    qh = json.loads(QH.read_text(encoding="utf-8"))
    rows = qh.get("question_mapping") or []
    n = 0
    for row in rows:
        raw = str(row.get("raw_question") or "")
        if not TIMELINE_RAW.search(raw):
            continue
        if row.get("canonical_id") == "PROF-090":
            continue
        row["canonical_id"] = "PROF-090"
        row["label"] = "CTA Execution Time"
        row["layer"] = "profile"
        row["form"] = "s1.contract.cta_time"
        n += 1
    QH.write_text(json.dumps(qh, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Question_Harmonization_Mapping.json: remapped {n} timeline raw rows -> PROF-090")
    return n


def fix_harmonization_bridge() -> None:
    hb = json.loads(HB.read_text(encoding="utf-8"))

    # Find canonicals / raw maps
    canon_key = None
    raw_key = None
    for k, v in hb.items():
        if not isinstance(v, dict):
            continue
        if "PROF-011" in v and "PROF-012" in v and isinstance(v["PROF-011"], dict):
            canon_key = k
        if any(TIMELINE_RAW.search(str(rk)) for rk in list(v.keys())[:200] if isinstance(rk, str)):
            # prefer the large raw map
            if raw_key is None or len(v) > len(hb.get(raw_key) or {}):
                raw_key = k

    if not canon_key:
        raise SystemExit("harmonization_bridge canonical block not found")

    canon = hb[canon_key]
    # PROF-011 Primary Contact Role
    if "PROF-011" in canon:
        canon["PROF-011"]["libraryQuestionId"] = ROLE_LIB
        canon["PROF-011"]["libraryLabel"] = "Primary Research Point of Contact Title / Role"
        canon["PROF-011"]["matchHow"] = "seed-fix"
        canon["PROF-011"]["matchScore"] = 1.0
    # PROF-012 Contract/Budget Contact → name (not email)
    if "PROF-012" in canon:
        canon["PROF-012"]["libraryQuestionId"] = CONTACT_NAME_LIB
        canon["PROF-012"]["libraryLabel"] = "Contracting/Budgeting Contact First and Last Name"
        canon["PROF-012"]["matchHow"] = "seed-fix"
        canon["PROF-012"]["matchScore"] = 1.0
    # PROF-090 CTA time
    if "PROF-090" in canon:
        canon["PROF-090"]["libraryQuestionId"] = CTA_LIB
        canon["PROF-090"]["libraryLabel"] = (
            "On average, how long will it take to execute the Clinical Trial Agreement (CTA) / Budget"
        )
        canon["PROF-090"]["matchHow"] = "seed-fix"
        canon["PROF-090"]["matchScore"] = 1.0

    remapped = 0
    if raw_key:
        raw_map = hb[raw_key]
        for rk, dest in list(raw_map.items()):
            if not isinstance(rk, str) or not TIMELINE_RAW.search(rk):
                continue
            if not isinstance(dest, dict):
                continue
            dest["canonical_id"] = "PROF-090"
            dest["libraryQuestionId"] = CTA_LIB
            dest["libraryLabel"] = canon.get("PROF-090", {}).get("libraryLabel")
            dest["matchHow"] = "seed-fix-timeline"
            remapped += 1
        print(f"harmonization_bridge raw map ({raw_key}): remapped {remapped} timeline rows")
    else:
        print("harmonization_bridge: no raw map key found (canonical seeds still fixed)")

    HB.write_text(json.dumps(hb, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("updated harmonization_bridge.json seeds")


def looks_like_timeline(val: str) -> bool:
    s = str(val or "").strip()
    if not s or "@" in s:
        return False
    if TIMELINE_VAL.search(s):
        return True
    # short numeric duration phrases
    if re.search(r"(?i)\b(week|month|day)s?\b", s) and not re.search(r"[A-Za-z]{4,}\s+[A-Za-z]{4,}", s):
        return True
    return False


def fix_cosmos_answers(apply: bool) -> int:
    db = cosmos()
    c = db.get_container_client("site-survey-responses")
    rows = list(
        c.query_items(
            "SELECT * FROM c WHERE c.surveyId = @sid",
            parameters=[{"name": "@sid", "value": "survey-rebuild-mytx272am-201"}],
            enable_cross_partition_query=True,
        )
    )
    changed = 0
    for doc in rows:
        answers = doc.get("answers") or []
        moved = []
        kept = []
        for a in answers:
            lib = str(a.get("libraryQuestionId") or "")
            val = str(a.get("value") or "").strip()
            lab = str(a.get("label") or "")
            is_contact_slot = lib == CONTACT_NAME_LIB or re.search(
                r"contracting/budgeting contact first|contract/budget contact name", lab, re.I
            )
            if is_contact_slot and looks_like_timeline(val):
                moved.append({**a, "libraryQuestionId": CTA_LIB, "questionId": a.get("questionId") or "rebuild_080_cta_time", "label": "CTA / Budget execution time (remapped)", "_remappedFrom": CONTACT_NAME_LIB})
            else:
                kept.append(a)
        if not moved:
            continue
        # drop moved from contact; append remapped if CTA slot not already filled
        existing_cta = {
            str(a.get("value") or "").strip().lower()
            for a in kept
            if str(a.get("libraryQuestionId") or "") == CTA_LIB
        }
        for m in moved:
            if str(m.get("value") or "").strip().lower() not in existing_cta:
                kept.append(m)
        doc["answers"] = kept
        changed += 1
        print(f"  response {doc.get('id')} site={doc.get('siteId')} moved {len(moved)} timeline value(s) off contact name")
        if apply:
            c.upsert_item(doc)
    print(f"cosmos responses to repair: {changed} ({'APPLIED' if apply else 'dry-run'})")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write Cosmos repairs")
    args = ap.parse_args()

    fix_bridge_py()
    fix_question_mapping()
    fix_harmonization_bridge()
    fix_cosmos_answers(apply=args.apply)
    if not args.apply:
        print("\nDry-run only for Cosmos. Re-run with --apply to rewrite responses.")


if __name__ == "__main__":
    main()
