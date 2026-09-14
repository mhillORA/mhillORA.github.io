"""
Build a slim ReBUILD priority-site likelihood index from Mike's 39-pack.
Read-only. Used by ARTEMIS Send Survey to show who already has profile data.

Output: ingest/data/rebuild_priority_likelihood.json
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
OUT = REPO / "ingest" / "data" / "rebuild_priority_likelihood.json"
OUT_CSV = REPO / ".firecrawl" / "rebuild-priority-likelihood.csv"


def norm(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc|the)\b", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def flatten(obj, prefix=""):
    if isinstance(obj, dict):
        if "value" in obj or "pre_populate" in obj:
            yield prefix, obj.get("value"), bool(obj.get("pre_populate"))
            return
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else k
            yield from flatten(v, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from flatten(v, f"{prefix}[{i}]")


def main():
    pack = json.loads(PACK.read_text(encoding="utf-8"))
    sites_out = []
    for s in pack.get("sites") or []:
        filled = 0
        total = 0
        gaish = 0
        for section in ("section_1_site_profile", "section_2_indication_history"):
            for path, val, _pre in flatten(s.get(section) or {}):
                total += 1
                nonempty = val is not None and str(val).strip() not in ("", "null", "None")
                if nonempty:
                    filled += 1
                    if "ga" in path.lower() or "dry_amd" in path.lower() or "geographic" in path.lower():
                        gaish += 1
        pct = round(100.0 * filled / total, 1) if total else 0.0
        sites_out.append(
            {
                "priorityId": s.get("site_id"),
                "practiceName": s.get("practice_name") or "",
                "piName": s.get("pi_name") or "",
                "location": s.get("location") or "",
                "nameKey": norm(s.get("practice_name") or ""),
                "piKey": norm(s.get("pi_name") or ""),
                "filledFields": filled,
                "totalFields": total,
                "likelihoodPct": pct,
                "hasGaData": bool(s.get("has_ga_data")),
                "gaRelatedFilled": gaish,
                "totalSurveys": s.get("total_surveys") or 0,
                "indications": s.get("indications_covered") or [],
            }
        )
    sites_out.sort(key=lambda x: (-x["likelihoodPct"], x["practiceName"]))

    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": PACK.name,
        "purpose": "ReBUILD / Mighty prior-data likelihood for priority sites (Mike partnership pack)",
        "siteCount": len(sites_out),
        "avgLikelihoodPct": round(
            sum(x["likelihoodPct"] for x in sites_out) / len(sites_out), 1
        )
        if sites_out
        else 0,
        "sites": sites_out,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    import csv

    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "likelihoodPct",
                "filledFields",
                "totalFields",
                "practiceName",
                "piName",
                "location",
                "hasGaData",
                "priorityId",
                "totalSurveys",
            ],
        )
        w.writeheader()
        for x in sites_out:
            w.writerow({k: x.get(k) for k in w.fieldnames})

    print(f"Sites: {doc['siteCount']}  avg likelihood: {doc['avgLikelihoodPct']}%")
    for x in sites_out[:8]:
        print(f"  {x['likelihoodPct']:5.1f}%  {x['practiceName']} ({x['piName']})")
    print(f"Wrote {OUT}")
    print(f"Wrote {OUT_CSV}")


if __name__ == "__main__":
    main()
