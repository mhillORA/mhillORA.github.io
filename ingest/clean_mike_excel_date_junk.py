"""
Clean Excel datetime / Yes-No junk out of Mike rebuild survey answers
where the question is clearly not a date (or not a Yes/No name field).

Also clears street-looking values from Institution Name answers so live
site name can prefill instead.

Usage:
  python ingest/clean_mike_excel_date_junk.py
  python ingest/clean_mike_excel_date_junk.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / "ingest" / "data" / "excel_date_junk_cleanup_report.json"
SURVEY_PREFIX = "rsp-mike-rebuild"

DATE_RE = re.compile(
    r"^\s*\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*$"
)
STREET_RE = re.compile(
    r"\d|street|st\b|ave|avenue|rd\b|road|blvd|drive|dr\b|suite|ste\b|lane|ln\b|way\b",
    re.I,
)
YES_NO_RE = re.compile(r"^(yes|no)$", re.I)


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


def is_excel_date(val) -> bool:
    s = str(val or "").strip()
    if not s:
        return False
    if DATE_RE.match(s):
        return True
    if "00:00:00" in s and re.search(r"\d{4}-\d{2}-\d{2}", s):
        return True
    return False


def is_real_date_question(label: str, qtype: str) -> bool:
    lab = (label or "").lower()
    if str(qtype or "").lower() == "date":
        return True
    return bool(re.search(r"\bdate\b|dob|birth|when did|start date|end date", lab))


def is_name_like_question(label: str, lib: str) -> bool:
    blob = f"{label} {lib}".lower()
    return bool(
        re.search(
            r"name|contact|coordinator|investigator|pi\b|email|phone|title|role|institution",
            blob,
        )
    )


def is_yes_no_question(label: str, qtype: str, lib: str) -> bool:
    t = str(qtype or "").lower()
    if t in ("radio", "select") and re.search(r"\byes\b|\bno\b|do you|are you|is your|have you|can you|would you", (label or "").lower()):
        return True
    return False


def should_clear(a: dict) -> tuple[bool, str]:
    val = a.get("value")
    if val is None or str(val).strip() == "":
        return False, ""
    lab = str(a.get("label") or "")
    lib = str(a.get("libraryQuestionId") or "")
    qtype = str(a.get("type") or "")
    s = str(val).strip()

    # Excel dates in non-date fields
    if is_excel_date(s) and not is_real_date_question(lab, qtype):
        return True, "excel_date_in_non_date_field"

    # Yes/No dumped into name/contact identity fields
    if YES_NO_RE.match(s) and is_name_like_question(lab, lib) and not is_yes_no_question(lab, qtype, lib):
        # contracts name got "Yes" from separate-office question bleed
        if re.search(r"name|contact first|email|phone", lab, re.I):
            return True, "yes_no_in_identity_field"

    # Bare Yes/No in please-specify / free-text follow-ups
    if YES_NO_RE.match(s) and re.search(r"please specify|if other|describe", lab, re.I):
        if str(qtype or "").lower() in ("text", "textarea", ""):
            return True, "yes_no_in_please_specify"

    # Email dumped into address / name-looking phone into email, etc.
    if re.search(r"\baddress\b", lab, re.I) and re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s):
        return True, "email_in_address_field"
    if re.search(r"\bphone\b", lab, re.I):
        digits = re.sub(r"\D", "", s)
        if len(digits) < 7 or "@" in s or YES_NO_RE.match(s):
            return True, "junk_in_phone_field"
    if re.search(r"\bemail\b", lab, re.I) and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s):
        if YES_NO_RE.match(s) or STREET_RE.search(s) or is_excel_date(s):
            return True, "junk_in_email_field"

    # Street/address blob in Institution Name
    if lib == "ql-site-name" or re.search(r"^institution name$|practice name", lab, re.I):
        if STREET_RE.search(s) and ("," in s or re.search(r"\d{5}", s) or "suite" in s.lower()):
            return True, "address_in_institution_name"

    return False, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    c = db.get_container_client("site-survey-responses")
    rows = list(
        c.query_items(
            "SELECT * FROM c WHERE STARTSWITH(c.id, @p)",
            parameters=[{"name": "@p", "value": SURVEY_PREFIX}],
            enable_cross_partition_query=True,
        )
    )
    # also catch any mike rebuild without prefix
    extra = list(
        c.query_items(
            "SELECT * FROM c WHERE c.surveyId = @s AND (IS_DEFINED(c.source) ? c.source = @src : false)",
            parameters=[
                {"name": "@s", "value": "survey-rebuild-mytx272am-201"},
                {"name": "@src", "value": "mike-rebuild-39-pack"},
            ],
            enable_cross_partition_query=True,
        )
    )
    by_id = {r["id"]: r for r in rows}
    for r in extra:
        by_id[r["id"]] = r
    rows = list(by_id.values())

    report = {"scanned": len(rows), "docsChanged": 0, "answersCleared": 0, "samples": []}
    now = datetime.now(timezone.utc).isoformat()

    for doc in rows:
        if doc.get("_archived"):
            continue
        changed = False
        answers = list(doc.get("answers") or [])
        new_answers = []
        for a in answers:
            clear, reason = should_clear(a)
            if clear:
                report["answersCleared"] += 1
                if len(report["samples"]) < 60:
                    report["samples"].append(
                        {
                            "responseId": doc.get("id"),
                            "siteId": doc.get("siteId"),
                            "label": (a.get("label") or "")[:80],
                            "lib": a.get("libraryQuestionId"),
                            "before": a.get("value"),
                            "reason": reason,
                        }
                    )
                print(
                    f"{'APPLY' if args.apply else 'DRY'} {doc.get('siteId')}: "
                    f"{(a.get('label') or '')[:50]} = {a.get('value')!r} ({reason})"
                )
                # drop the bad answer entirely so site-record prefill can win
                changed = True
                continue
            new_answers.append(a)
        if changed:
            report["docsChanged"] += 1
            if args.apply:
                doc["answers"] = new_answers
                doc["updatedAt"] = now
                doc["excelDateJunkClearedAt"] = now
                c.upsert_item(doc)

    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(
        f"docsChanged={report['docsChanged']} answersCleared={report['answersCleared']} "
        f"scanned={report['scanned']} wrote {REPORT}"
    )


if __name__ == "__main__":
    main()
