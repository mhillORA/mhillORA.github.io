"""
Convert GF Equipment (gf_25_equipment) from free-text to multiselect checkboxes.

Option list = union of Monday General Feasibility Excel Equipment column
(General_Feasibility_1787078071.xlsx). Values stay comma-joined so prior
answers still prefill.

Usage:
  python ingest/update_gf_equipment_multiselect.py
  python ingest/update_gf_equipment_multiselect.py --apply
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

LONG_ID = "survey-general-feasibility"
SHORT_ID = "survey-general-feasibility-short"
QID = "gf_25_equipment"

# Canonical order from fullest Monday export cell + remaining uniques
EQUIPMENT_OPTIONS = [
    "Centrifuge",
    "Refrigerated Centrifuge",
    "2-8*C Refrigerator",
    "-20*C Freezer",
    "-70/-80*C Freezer",
    "Anterior Segment Optical Coherence Tomography (OCT) Equipment",
    "Fundus Photography (FP) Equipment",
    "Slit Lamp for research purposes available on-site",
    "Slit Lamp for photography",
    "Specular Microscope",
    "Meibography Imaging",
    "Applanation Tonometer for research purposes available on-site",
    "Indirect ophthalmoscopy capabilities at your clinical research site",
    "4M Lane BCVA (best corrected visual acuity) system available on-site",
    "Locked Storage space for study documents and/or technology devices",
]


def cosmos():
    data = json.loads(Path("data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return (
        CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
        .get_database_client("crcscheduling")
        .get_container_client("site-survey-definitions")
    )


def patch_questions(questions: list) -> tuple[list, bool]:
    changed = False
    out = []
    for q in questions or []:
        if str(q.get("id")) != QID:
            out.append(q)
            continue
        next_q = dict(q)
        next_q["type"] = "multiselect"
        next_q["options"] = list(EQUIPMENT_OPTIONS)
        next_q["label"] = next_q.get("label") or "Equipment"
        next_q["help"] = (
            next_q.get("help")
            or "Check all equipment / facilities your site currently has."
        )
        next_q["required"] = True if next_q.get("required") is None else next_q.get("required")
        changed = (
            q.get("type") != next_q["type"]
            or list(q.get("options") or []) != next_q["options"]
            or True
        )
        out.append(next_q)
        changed = True
    return out, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    c = cosmos()
    now = datetime.now(timezone.utc).isoformat()
    for sid in (LONG_ID, SHORT_ID):
        doc = c.read_item(sid, sid)
        qs, changed = patch_questions(doc.get("questions") or [])
        equip = next((q for q in qs if q.get("id") == QID), None)
        print(f"{sid}: found={bool(equip)} type={equip and equip.get('type')} options={len((equip or {}).get('options') or [])}")
        if not args.apply:
            continue
        if not equip:
            print(f"  SKIP missing {QID}")
            continue
        doc["questions"] = qs
        doc["updatedAt"] = now
        c.upsert_item(doc)
        print(f"  APPLIED")


if __name__ == "__main__":
    main()
