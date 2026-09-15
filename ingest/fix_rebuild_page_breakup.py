"""
Align rebuild survey page breakup to AF DOCX sections.

Fixes leftover Study #1–3 enrollment fields that landed under SITE PROFILE
because they were stamped Page 1 and carry-forwarded to the wrong parent.

Usage:
  python ingest/fix_rebuild_page_breakup.py
  python ingest/fix_rebuild_page_breakup.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
AF_PATH = REPO / ".firecrawl" / "rebuild-af-questions.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"
MOST_RECENT = (
    "Most Recent Dry AMD Studies (repeat for each of the 3 most recent studies)"
)


def cosmos_defs():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = dict(x.split("=", 1) for x in conn.rstrip(";").split(";") if "=" in x)
    return (
        CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
        .get_database_client("crcscheduling")
        .get_container_client("site-survey-definitions")
    )


def norm_label(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def is_weak(s: str) -> bool:
    t = (s or "").strip()
    return (not t) or bool(re.match(r"^(page\s*\d+|questions)$", t, re.I))


def build_pages(qs: list) -> list:
    pages = []
    for i, q in enumerate(qs):
        key = str(q.get("section") or "Questions").strip() or "Questions"
        if not pages or pages[-1]["key"] != key:
            pages.append(
                {
                    "key": key,
                    "title": re.sub(r"^SECTION\s+\d+\s*:\s*", "", key, flags=re.I).strip()
                    or key,
                    "questionIds": [],
                    "indexes": [],
                }
            )
        pages[-1]["questionIds"].append(q.get("id") or f"q_{i}")
        pages[-1]["indexes"].append(i)
    return pages


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
    before = Counter(str(q.get("section") or "(none)") for q in qs)

    changed = 0
    last_strong = ""
    parent_section = {}  # questionId -> section
    new_qs = []

    for q in qs:
        nq = dict(q)
        label = str(q.get("label") or "")
        key = norm_label(label)
        src = by_label.get(key)
        target = None

        # Exact AF label → AF section
        if src and src.get("section"):
            target = str(src["section"])
        # Study #N enrollment/period rows belong with the Most Recent block
        elif re.match(r"^study\s*#?\s*[123]\s*:", label, re.I) or re.search(
            r"number of subjects enrolled|length of enrollment period", label, re.I
        ):
            target = MOST_RECENT
        # Branch follow-ups → parent section
        elif (nq.get("logic") or {}).get("showIf", {}).get("questionId"):
            pid = str(nq["logic"]["showIf"]["questionId"])
            if pid in parent_section:
                target = parent_section[pid]
        # Weak Page 1 → prior strong section
        if not target and is_weak(str(nq.get("section") or "")) and last_strong:
            target = last_strong
        # Else keep current if strong
        if not target and not is_weak(str(nq.get("section") or "")):
            target = str(nq["section"]).strip()

        if target and str(nq.get("section") or "") != target:
            nq["section"] = target
            changed += 1
        elif target:
            nq["section"] = target

        if not is_weak(str(nq.get("section") or "")):
            last_strong = str(nq["section"]).strip()
        qid = str(nq.get("id") or "")
        if qid and last_strong:
            parent_section[qid] = last_strong

        new_qs.append(nq)

    # Second pass: follow-ups whose parent appears later/earlier now resolved
    for nq in new_qs:
        show = ((nq.get("logic") or {}).get("showIf") or {}).get("questionId")
        if not show:
            continue
        parent_sec = parent_section.get(str(show))
        if parent_sec and str(nq.get("section") or "") != parent_sec:
            # Don't yank Most Recent study rows back to SITE PROFILE
            if str(nq.get("section") or "") == MOST_RECENT:
                continue
            if re.match(r"^study\s*#?\s*[123]\s*:", str(nq.get("label") or ""), re.I):
                continue
            nq["section"] = parent_sec
            changed += 1

    pages = build_pages(new_qs)
    after = Counter(str(q.get("section") or "(none)") for q in new_qs)
    print(f"survey={SURVEY_ID}")
    print(f"sections before: {dict(before)}")
    print(f"sections after:  {dict(after)}")
    print(f"section fields updated: {changed}")
    print(f"pages: {len(pages)}")
    for p in pages:
        print(f"  {len(p['questionIds']):3d}  {p['title'][:70]}")

    if not args.apply:
        print("Dry run only. Re-run with --apply to write Cosmos.")
        return

    now = datetime.now(timezone.utc).isoformat()
    doc["questions"] = new_qs
    doc["pages"] = pages
    doc["updatedAt"] = now
    doc["pagesRestoredAt"] = now
    c.upsert_item(doc)
    print("APPLIED")


if __name__ == "__main__":
    main()
