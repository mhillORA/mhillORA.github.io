"""
Relabel bare 'If other, please specify' follow-ups on the rebuild survey
so exports/reporting keep parent-question context.

Also wires showIf to the parent's actual Other option text when missing.

Usage:
  python ingest/polish_rebuild_other_labels.py
  python ingest/polish_rebuild_other_labels.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
SURVEY_ID = "survey-rebuild-mytx272am-201"
REPORT = REPO / "ingest" / "data" / "rebuild_other_label_polish_report.json"
BARE_OTHER_RE = re.compile(
    r"^(if other,? please specify|please specify \(other\)|other,? please specify|please specify)\s*$",
    re.I,
)


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


def other_option(opts) -> str | None:
    for o in opts or []:
        s = str(o.get("label") if isinstance(o, dict) else o).strip()
        if re.match(r"^other\b", s, re.I):
            return s
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    c = db.get_container_client("site-survey-definitions")
    docs = list(
        c.query_items(
            "SELECT * FROM c WHERE c.id = @id",
            parameters=[{"name": "@id", "value": SURVEY_ID}],
            enable_cross_partition_query=True,
        )
    )
    if not docs:
        raise SystemExit(f"Survey {SURVEY_ID} not found")
    doc = docs[0]
    qs = list(doc.get("questions") or [])
    by_id = {q.get("id"): q for q in qs if q.get("id")}
    changes = []

    for i, q in enumerate(qs):
        lab = str(q.get("label") or "").strip()
        show = (q.get("logic") or {}).get("showIf") or {}
        parent_id = show.get("questionId")
        parent = by_id.get(parent_id) if parent_id else None

        # Only touch bare "please specify" follow-ups (not every question)
        is_bare = bool(BARE_OTHER_RE.match(lab))
        is_weak = bool(
            re.search(r"please specify", lab, re.I)
            and not re.search(r"—| – | - ", lab)
            and len(lab) < 60
        )
        if not is_bare and not is_weak:
            continue

        # Prefer explicit showIf parent; else nearest prior choice Q with Other
        # within a short window (same section / next few questions), not survey-wide.
        if not parent:
            for j in range(i - 1, max(-1, i - 8), -1):
                cand = qs[j]
                oth = other_option(cand.get("options"))
                if not oth:
                    continue
                # Same section when available
                if q.get("section") and cand.get("section") and q.get("section") != cand.get("section"):
                    continue
                parent = cand
                break

        if not parent:
            continue

        parent_lab = str(parent.get("label") or "").strip()
        if not parent_lab:
            continue
        # Already contextualized with this parent
        if parent_lab.lower() in lab.lower() and re.search(r"please specify", lab, re.I):
            continue

        oth = other_option(parent.get("options")) or "Other"
        ptype = str(parent.get("type") or "").lower()
        new_label = f"{parent_lab} — Other (please specify)"
        new_logic = dict(q.get("logic") or {})
        if ptype == "multiselect":
            new_logic["showIf"] = {"questionId": parent["id"], "includes": oth}
        else:
            new_logic["showIf"] = {"questionId": parent["id"], "equals": oth}

        if new_label != lab or new_logic != (q.get("logic") or {}):
            changes.append(
                {
                    "questionId": q.get("id"),
                    "before": lab,
                    "after": new_label,
                    "parentId": parent.get("id"),
                    "otherOption": oth,
                }
            )
            q["label"] = new_label
            q["logic"] = new_logic
            if not q.get("help"):
                q["help"] = f"Shown when “{oth}” is selected for: {parent_lab}"

    report = {
        "surveyId": SURVEY_ID,
        "changed": len(changes),
        "changes": changes,
        "mode": "apply" if args.apply else "dry-run",
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"changed={len(changes)} report={REPORT}")
    for ch in changes[:20]:
        print(f"  {ch['before'][:40]!r} -> {ch['after'][:70]!r}")

    if args.apply and changes:
        doc["questions"] = qs
        doc["updatedAt"] = datetime.now(timezone.utc).isoformat()
        doc["otherLabelsPolishedAt"] = doc["updatedAt"]
        # keep pages in sync if present
        if isinstance(doc.get("pages"), list) and doc["pages"]:
            qmap = {q["id"]: q for q in qs if q.get("id")}
            for page in doc["pages"]:
                pq = page.get("questions")
                if not isinstance(pq, list):
                    continue
                page["questions"] = [qmap.get(x.get("id"), x) if isinstance(x, dict) else x for x in pq]
        c.upsert_item(doc)
        print("Upserted survey definition.")


if __name__ == "__main__":
    main()
