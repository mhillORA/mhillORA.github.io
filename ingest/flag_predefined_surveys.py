"""
Flag feasibility / general survey definitions as predefined library templates.

Sets:
  isPredefined: true
  library: "feasibility"
  audience normalized to ["PI", "Coordinator"]

Matches:
  - id starts with survey-feas-
  - id == survey-general-feasibility
  - source in feasibility ingest sources (optional catch-all)

Usage:
  python ingest/flag_predefined_surveys.py
  python ingest/flag_predefined_surveys.py --apply
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_feasibility_for_budget_buddy as m  # noqa: E402

FEAS_SOURCES = {
    "feasibility-master-ingest",
    "general-feasibility-survey",
    "monday-general-feasibility",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_audience(aud) -> list[str]:
    out = []
    seen = set()
    for a in aud or []:
        key = str(a or "").strip().lower()
        if key in ("pi", "principal investigator", "investigator"):
            label = "PI"
        elif key in ("coordinator", "crc", "study coordinator"):
            label = "Coordinator"
        else:
            label = str(a).strip() or None
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out or ["PI", "Coordinator"]


def is_predefined_candidate(doc: dict) -> bool:
    sid = str(doc.get("id") or "")
    if sid.startswith("survey-feas-") or sid == "survey-general-feasibility":
        return True
    src = str(doc.get("source") or "").lower()
    if src in FEAS_SOURCES or "feasibility" in src:
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    m.load_key()
    if not m.KEY:
        raise SystemExit("COSMOS_KEY missing")

    client = CosmosClient(m.ENDPOINT, credential=m.KEY)
    db = client.get_database_client(m.DATABASE_ID)
    defs_c = db.get_container_client("site-survey-definitions")
    defs = list(defs_c.query_items(query="SELECT * FROM c", enable_cross_partition_query=True))

    to_flag = []
    already = []
    skipped = []
    for d in defs:
        if not is_predefined_candidate(d):
            skipped.append(d)
            continue
        needs = (
            d.get("isPredefined") is not True
            or d.get("library") != "feasibility"
            or normalize_audience(d.get("audience")) != (d.get("audience") or [])
        )
        # also rewrite audience if casing differs
        if normalize_audience(d.get("audience")) != list(d.get("audience") or []):
            needs = True
        if d.get("isPredefined") is True and d.get("library") == "feasibility" and not needs:
            already.append(d)
            continue
        to_flag.append(d)

    print(f"definitions: {len(defs)}")
    print(f"already predefined: {len(already)}")
    print(f"to flag: {len(to_flag)}")
    print(f"skipped (custom/other): {len(skipped)}")
    for d in to_flag:
        print(f"  {d.get('id')}  |  {d.get('title')}  |  indication={d.get('indication')}")

    report = {
        "generatedAt": iso_now(),
        "apply": bool(args.apply),
        "toFlag": [{"id": d.get("id"), "title": d.get("title"), "indication": d.get("indication")} for d in to_flag],
        "already": [d.get("id") for d in already],
        "skipped": [{"id": d.get("id"), "title": d.get("title")} for d in skipped],
    }
    out = Path(__file__).resolve().parents[1] / "exports" / "flag_predefined_surveys_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {out}")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to update Cosmos.")
        return

    now = iso_now()
    for d in to_flag:
        d["isPredefined"] = True
        d["library"] = "feasibility"
        d["audience"] = normalize_audience(d.get("audience"))
        d["updatedAt"] = now
        if not d.get("status"):
            d["status"] = "active"
        defs_c.upsert_item(d)
        print(f"  flagged {d['id']}")
    print("Done.")


if __name__ == "__main__":
    main()
