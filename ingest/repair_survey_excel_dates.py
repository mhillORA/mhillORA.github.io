"""
Repair Excel datetime values stored in non-date survey answers.

Dry-run by default. Apply with --apply.

Does NOT touch answers whose question label is a real date field
(e.g. "Date:", "Start Date"). Does NOT treat bare times (08:00:00) as dates.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

from azure.cosmos import CosmosClient

DATE_FULL = re.compile(
    r"^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?$"
)
SLASH_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")
DATE_IN_LABEL = re.compile(
    r"\bdate\b|completion date|submitted|start date|end date", re.I
)


def is_spurious_excel_date(value: object) -> bool:
    s = str(value or "").strip()
    if not s:
        return False
    if DATE_FULL.match(s) or SLASH_DATE.match(s):
        return True
    # Explicit midnight datetime only (not 08:00:00 office hours)
    if re.match(r"^\d{4}-\d{1,2}-\d{1,2} 00:00:00(\.\d+)?$", s):
        return True
    return False


def is_date_question(label: str) -> bool:
    lab = (label or "").lower()
    if "update" in lab:
        return False
    return bool(DATE_IN_LABEL.search(lab))


def label_has_embedded_excel_date(label: str) -> bool:
    """Question option headers corrupted into '... | 2026-01-05 00:00:00'."""
    return bool(re.search(r"\|\s*\d{4}-\d{1,2}-\d{1,2}", label or ""))


def connect():
    cfg = json.load(open("data-api-connections.json", encoding="utf-8"))
    cs = cfg["cosmosdb-connection"]["connectionString"]
    endpoint = re.search(r"AccountEndpoint=([^;]+)", cs).group(1)
    key = re.search(r"AccountKey=([^;]+)", cs).group(1)
    client = CosmosClient(endpoint, key)
    db = client.get_database_client("crcscheduling")
    return (
        db.get_container_client("site-survey-responses"),
        db.get_container_client("site-survey-definitions"),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write repairs to Cosmos")
    ap.add_argument(
        "--survey",
        action="append",
        default=[],
        help="Limit to surveyId (repeatable). Default: all.",
    )
    args = ap.parse_args()

    resp_c, def_c = connect()
    defs = {
        d["id"]: d
        for d in def_c.query_items("SELECT * FROM c", enable_cross_partition_query=True)
    }

    query = (
        "SELECT * FROM c WHERE (NOT IS_DEFINED(c._archived) OR c._archived != true)"
    )
    params = []
    if args.survey:
        # filter client-side for simplicity
        pass

    rows = list(resp_c.query_items(query, enable_cross_partition_query=True))
    if args.survey:
        allow = set(args.survey)
        rows = [r for r in rows if r.get("surveyId") in allow]

    stats = Counter()
    examples = []
    patched_docs = []

    for doc in rows:
        answers = doc.get("answers")
        if not isinstance(answers, list):
            continue
        changed = False
        for a in answers:
            if not isinstance(a, dict):
                continue
            label = a.get("label") or ""
            raw = a.get("value")
            if raw is None or str(raw).strip() == "":
                continue
            if is_date_question(label):
                stats["skipped_real_date_question"] += 1
                continue
            if not is_spurious_excel_date(raw):
                continue

            stats["cells_cleared"] += 1
            stats[f"survey:{doc.get('surveyId')}"] += 1
            if label_has_embedded_excel_date(label):
                stats["cells_on_corrupt_option_label"] += 1

            if len(examples) < 30:
                examples.append(
                    {
                        "responseId": doc.get("id"),
                        "surveyId": doc.get("surveyId"),
                        "siteId": doc.get("siteId"),
                        "label": (label or "")[:140],
                        "oldValue": str(raw)[:80],
                    }
                )

            a["value"] = None
            a["skipped"] = True
            a["_repairedFrom"] = str(raw).strip()
            a["_repairedAt"] = datetime.utcnow().isoformat() + "Z"
            a["_repairReason"] = "excel-datetime-in-non-date-field"
            changed = True

        if changed:
            stats["responses_patched"] += 1
            doc["updatedAt"] = datetime.utcnow().isoformat() + "Z"
            doc["_answerRepair"] = {
                "at": doc["updatedAt"],
                "reason": "cleared-excel-datetimes-in-non-date-answers",
            }
            patched_docs.append(doc)

    # Also flag definitions whose question labels embed excel dates
    bad_labels = []
    for d in defs.values():
        for q in d.get("questions") or []:
            lab = q.get("label") or ""
            if label_has_embedded_excel_date(lab) or is_spurious_excel_date(lab):
                bad_labels.append(
                    {"surveyId": d.get("id"), "title": d.get("title"), "label": lab[:160]}
                )
    stats["definition_labels_with_embedded_dates"] = len(bad_labels)

    out = {
        "mode": "apply" if args.apply else "dry-run",
        "stats": dict(stats),
        "examples": examples,
        "definition_labels_with_embedded_dates": bad_labels[:40],
        "responses_to_patch": len(patched_docs),
    }
    Path("exports").mkdir(parents=True, exist_ok=True)
    report_path = Path("exports/survey_answer_repair_report.json")
    report_path.write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"mode={'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"responses_scanned={len(rows)}")
    print(f"responses_patched={stats['responses_patched']}")
    print(f"cells_cleared={stats['cells_cleared']}")
    print(f"skipped_real_date_question={stats['skipped_real_date_question']}")
    print(
        f"definition_labels_with_embedded_dates={stats['definition_labels_with_embedded_dates']}"
    )
    print(f"report={report_path}")

    if not args.apply:
        print("Re-run with --apply to write repairs.")
        return

    for doc in patched_docs:
        resp_c.upsert_item(doc)
    print(f"Upserted {len(patched_docs)} response documents.")


if __name__ == "__main__":
    main()
