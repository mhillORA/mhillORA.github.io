"""
Apply the approved 14 survey-sourced PI name fills (blank-with-email sites
not in Mike's pack). Keeps existing piEmail.

Usage:
  python ingest/apply_blank_pi_survey_fills.py
  python ingest/apply_blank_pi_survey_fills.py --apply
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / "ingest" / "data" / "blank_pi_14_apply_report.json"

FILLS = {
    "Advancing Vision Research": "Gary W. Jerkins, M.D.",
    "Deep Blue Retina Clinical Research, PLLC": "Jorge Calzada, MD",
    "Eye Care for the Adirondacks": "Roy Arogyasami",
    "Florida Eye Microsurgical Institute, Inc.": "Randy Katz",
    "Gundersen Health System": "Dr. Syed Shah",
    "Jacksoneye": "Mitchell A Jackson MD",
    "National Ophthalmic Research Institute": "Ashish Sharma, MD",
    "North East Eye Research Associates - Woburn": "Dr. Ioanis Panagiotopoulos",
    "Pendleton Eye Center": "Robert Pendleton MD, PhD",
    "Periman Eye": "Laura M. Periman, MD",
    "Pinnacle Research Institute": "Scott Schecter, OD",
    "Southern Eye Center": "Jaime Jimenez",
    "Total Eye Care": "David G. Evans, OD",
    "Valley Retina Institute, PA": "Victor H. Gonzalez, MD",
}


def cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    parts = dict(
        x.split("=", 1)
        for x in data["cosmosdb-connection"]["connectionString"].rstrip(";").split(";")
        if "=" in x
    )
    return CosmosClient(parts["AccountEndpoint"], parts["AccountKey"]).get_database_client(
        "crcscheduling"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    c = cosmos().get_container_client("sites")
    sites = list(c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    by_name = {str(s.get("name") or "").strip(): s for s in sites}
    now = datetime.now(timezone.utc).isoformat()
    rows = []

    for name, pi in FILLS.items():
        s = by_name.get(name)
        if not s:
            rows.append({"name": name, "ok": False, "error": "not found"})
            print(f"MISS {name}")
            continue
        before = str(s.get("pi") or "").strip()
        email = str(s.get("piEmail") or "").strip()
        rows.append(
            {
                "name": name,
                "ok": True,
                "id": s["id"],
                "before": before,
                "after": pi,
                "email": email,
            }
        )
        print(f"{'APPLY' if args.apply else 'DRY '} {name[:42]:42} {before!r:30} -> {pi}")
        if args.apply:
            doc = dict(s)
            doc["pi"] = pi
            doc["updatedAt"] = now
            doc["piFilledFromSurveyAt"] = now
            doc["piFill"] = {
                "at": now,
                "reason": "approved-survey-fill-14",
                "beforePi": before,
                "piEmailKept": email,
            }
            c.upsert_item(doc)

    report = {
        "at": now,
        "mode": "apply" if args.apply else "dry-run",
        "applied": len([r for r in rows if r.get("ok")]),
        "rows": rows,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {REPORT} applied={report['applied']}/{len(FILLS)}")


if __name__ == "__main__":
    main()
