"""
Fix rebuild survey pages + equipment questions.

Root cause:
  - All 110 questions stuck on section "Page 1" → one massive page
  - Library cleanup remapped imaging Yes/No questions onto
    ql-site-equipment-inventory and copied its ~115 options onto each

This restores sections (and type-specific options) from
.firecrawl/rebuild-af-questions.json.

Usage:
  python ingest/fix_rebuild_equipment_pages.py
  python ingest/fix_rebuild_equipment_pages.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
AF_PATH = REPO / ".firecrawl" / "rebuild-af-questions.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"
INVENTORY_ID = "ql-site-equipment-inventory"

# Capability questions that should be Yes/No (not the full equipment inventory)
YES_NO_LABEL_HINTS = (
    "color fundus photography",
    "fundus autofluorescence",
    "fluorescein angiography",
    "etdrs lightbox",
    "quantitative contrast",
    "qcsf",
    "biomicroscopy",
    "slit lamp",
    "4-meter",
    "4 meter",
    "corneal fluorescein",
)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm_label(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def cosmos_defs():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
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


def clean_choice_options(opts: list, qtype: str) -> list:
    """Drop manufacturer / please-specify prompt rows from choice lists."""
    out = []
    for o in opts or []:
        s = str(o or "").strip()
        if not s:
            continue
        low = s.lower()
        if "please specify" in low or "(if yes)" in low:
            continue
        if low.startswith("manufacturer") or low.startswith("make/model") or low.startswith("make / model"):
            continue
        if low.startswith("if other"):
            continue
        out.append(s)
    if qtype == "radio" and len(out) >= 2:
        # Prefer plain Yes/No when present
        lower = {x.lower(): x for x in out}
        if "yes" in lower and "no" in lower:
            return [lower["yes"], lower["no"]]
    return out


def is_capability_yes_no(label: str) -> bool:
    low = (label or "").lower()
    return any(h in low for h in YES_NO_LABEL_HINTS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    af = json.loads(AF_PATH.read_text(encoding="utf-8"))
    by_label = {}
    for q in af:
        key = norm_label(q.get("label") or "")
        if key and key not in by_label:
            by_label[key] = q

    c = cosmos_defs()
    doc = c.read_item(SURVEY_ID, SURVEY_ID)
    qs = list(doc.get("questions") or [])
    now = iso_now()

    section_fixed = 0
    equip_fixed = 0
    unmatched = []

    new_qs = []
    for q in qs:
        nq = dict(q)
        label = str(q.get("label") or "")
        key = norm_label(label)
        src = by_label.get(key)

        if src and src.get("section"):
            if str(nq.get("section") or "") != str(src["section"]):
                nq["section"] = src["section"]
                section_fixed += 1
        elif str(nq.get("section") or "").strip() in ("", "Page 1", "Questions"):
            # keep Page 1 only if we truly have no source — still count for report
            unmatched.append(label[:70])

        lib = str(nq.get("libraryQuestionId") or "")
        opts = list(nq.get("options") or [])
        needs_equip_fix = lib == INVENTORY_ID or (
            len(opts) >= 40 and is_capability_yes_no(label)
        )

        if needs_equip_fix:
            if src:
                qtype = str(src.get("type") or "radio").lower()
                src_opts = clean_choice_options(src.get("options") or [], qtype)
                if qtype in ("radio", "yesno", "select") and is_capability_yes_no(label):
                    qtype = "radio"
                    if not src_opts or not ({x.lower() for x in src_opts} >= {"yes", "no"}):
                        src_opts = ["Yes", "No"]
                nq["type"] = qtype
                nq["options"] = src_opts
            else:
                nq["type"] = "radio"
                nq["options"] = ["Yes", "No"]
            # Detach from mega inventory so save/link doesn't re-poison options
            if lib == INVENTORY_ID:
                nq["libraryQuestionId"] = None
            equip_fixed += 1

        new_qs.append(nq)

    # Section summary
    from collections import Counter

    before = Counter(str(q.get("section") or "(none)") for q in qs)
    after = Counter(str(q.get("section") or "(none)") for q in new_qs)
    print(f"survey={SURVEY_ID}")
    print(f"sections before: {dict(before)}")
    print(f"sections after:  {dict(after)}")
    print(f"section fields updated: {section_fixed}")
    print(f"equipment/capability questions fixed: {equip_fixed}")
    print(f"labels with no AF section match (kept as-is): {len(unmatched)}")
    for q in new_qs:
        if q.get("libraryQuestionId") is None and is_capability_yes_no(q.get("label") or ""):
            print(
                f"  FIX {q.get('id')}: type={q.get('type')} opts={q.get('options')} "
                f"section={q.get('section')!r}"
            )

    if not args.apply:
        print("Dry run only. Re-run with --apply to write Cosmos.")
        return

    doc["questions"] = new_qs
    doc["updatedAt"] = now
    doc["pagesRestoredAt"] = now
    doc["equipmentOptionsFixedAt"] = now
    c.upsert_item(doc)
    print("APPLIED")


if __name__ == "__main__":
    main()
