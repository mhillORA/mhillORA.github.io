"""
Backfill live site coordinator (and PI) contacts from original survey answers.

Priority for Site Coordinator email/name (OG feasibility surveys):
  1. Primary Study Coordinator / Site Coordinator Email questions
  2. Primary research POC / gf_16_poc-email / ql-coord-email
  3. Primary contact at site / study coordinator contact
  4. (last) generic primary contact email — only if no stronger match

PI fills only when live piEmail/pi is empty, from Investigator/PI email questions.

Responses are mostly keyed by legacy-site id; promoted live stubs are resolved via
promotedFromLegacySiteId / legacySiteIds / linkedArtemisSiteId.

Usage:
  python ingest/backfill_site_contacts_from_surveys.py
  python ingest/backfill_site_contacts_from_surveys.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)


def cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return CosmosClient(parts["AccountEndpoint"], parts["AccountKey"]).get_database_client(
        "crcscheduling"
    )


def fetch(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def first_email(text: str) -> str:
    m = EMAIL_RE.search(str(text or ""))
    return (m.group(0).strip() if m else "").lower()


def clean_name(text: str) -> str:
    t = str(text or "").strip()
    if not t or "@" in t:
        return ""
    # Drop trailing phone / role noise when answer is "Name | Email: x"
    t = re.split(r"\||\n|Email\s*:", t, maxsplit=1, flags=re.I)[0].strip()
    t = re.sub(r"\s+", " ", t)
    if len(t) < 2 or len(t) > 120:
        return ""
    if re.fullmatch(r"[\d\W]+", t):
        return ""
    # Phone-only / extension junk
    if re.search(r"\d{3}[\s\-.)]*\d{3}", t) and len(re.findall(r"[A-Za-z]", t)) < 3:
        return ""
    if re.search(r"\bext\.?\s*\d+\b", t, re.I) and len(re.findall(r"[A-Za-z]", t)) < 3:
        return ""
    low = t.lower().strip(" .")
    junk = {
        "yes",
        "no",
        "n/a",
        "na",
        "none",
        "unknown",
        "study coordinator",
        "coordinator",
        "primary contact",
        "pi",
        "investigator",
    }
    if low in junk:
        return ""
    if not re.search(r"[A-Za-z]{2,}", t):
        return ""
    return t


def looks_like_person_name(text: str) -> bool:
    t = clean_name(text)
    if not t:
        return False
    # Reject if mostly digits / phone fragments
    digits = len(re.findall(r"\d", t))
    letters = len(re.findall(r"[A-Za-z]", t))
    if digits >= 5 and digits >= letters:
        return False
    if re.search(r"\bext\.?\s*\d+\b", t, re.I):
        return False
    parts = [p for p in re.split(r"[\s,]+", t) if p]
    alpha_parts = [p for p in parts if re.search(r"[A-Za-z]{2,}", p)]
    if len(alpha_parts) >= 2:
        return True
    if len(alpha_parts) == 1 and alpha_parts[0].replace(".", "").isalpha() and len(alpha_parts[0]) >= 3:
        return True
    return False


def answer_blob(a: dict) -> tuple[str, str, str]:
    qid = str(a.get("questionId") or "").lower()
    lib = str(a.get("libraryQuestionId") or "").lower()
    label = str(a.get("label") or "")
    return qid, lib, label


def classify_coord(a: dict) -> int | None:
    """Lower score = higher priority. None = not a coordinator field."""
    qid, lib, label = answer_blob(a)
    low = label.lower()
    key = f"{qid} {lib} {low}"

    # Never use contracts / regulatory / budget contacts for site coordinator
    if any(x in low for x in ("regulatory", "budget", "contract", "payment")):
        return None
    if any(x in qid for x in ("regulatory", "budget", "contract", "payment")):
        return None

    if any(
        x in key
        for x in (
            "ql-coord-email",
            "gf_16_poc-email",
            "site-coordinator-email",
            "primary-study-coordin",
            "q_016_please-provide-the-primary-study-coordin",
            "q_015_site-coordinator-email",
            "q_051_primary-study-coordinator",
            "q_082_primary-study-coordinator",
        )
    ):
        return 1
    if "primary study coordinator" in low and "email" in low:
        return 1
    if "site coordinator email" in low:
        return 1
    if "main study coordinator" in low and "email" in low:
        return 1

    if "poc-email" in key or "gf_16_poc" in key or "ql-coord-email" in key:
        return 2
    if ("primary research" in low or "poc email" in low) and "email" in low:
        return 2

    if "study coordinator" in low and "email" in low:
        return 3
    if "primary contact / study coordinator" in low and "email" in low:
        return 3
    # Explicit site primary contact (not generic "primary contact" alone on PI forms)
    if "primary contact at your site" in low and "email" in low:
        return 3
    if "primary contact for" in low and "email" in low:
        return None

    if "dedicated study coordinator" in low and ("@" in str(a.get("value") or "") or "email" in low):
        return 4

    # Generic primary contact email — last resort only
    if "primary-contact-email" in key or (
        "primary contact email" in low and "investigator" not in low and "pi" not in low
    ):
        return 8

    return None


def classify_coord_name(a: dict) -> int | None:
    qid, lib, label = answer_blob(a)
    low = label.lower()
    key = f"{qid} {lib} {low}"
    if any(x in low for x in ("regulatory", "budget", "contract", "payment")):
        return None
    if any(x in key for x in ("ql-coord-name", "gf_15_research-contact", "primary-study-coordin", "site-coordinator")):
        if "email" in low and "name" not in low:
            return None
        return 1
    if "primary study coordinator" in low and ("name" in low or "email" not in low):
        return 1
    if "primary research point of contact" in low and "name" in low:
        return 2
    if "primary contact at your site" in low and "name" in low:
        return 3
    return None


def classify_pi(a: dict) -> int | None:
    qid, lib, label = answer_blob(a)
    low = label.lower()
    key = f"{qid} {lib} {low}"
    if any(
        x in key
        for x in (
            "ql-pi-email",
            "gf_09_inv-1-email",
            "investigator email",
            "pi-email",
            "principal investigator email",
            "site-details-pi-email",
        )
    ):
        return 1
    if ("investigator" in low or re.search(r"\bpi\b", low)) and "email" in low:
        if "sub-i" in low or "sub investigator" in low or "sub-investigator" in low:
            return None
        return 2
    return None


def classify_pi_name(a: dict) -> int | None:
    qid, lib, label = answer_blob(a)
    low = label.lower()
    key = f"{qid} {lib} {low}"
    if any(x in key for x in ("ql-pi-name", "gf_08_inv-1-name", "investigator name", "principal investigator")):
        if "email" in low:
            return None
        if "sub-i" in low or "sub-investigator" in low:
            return None
        return 1
    if re.search(r"\bpi\b", low) and "name" in low and "email" not in low:
        return 2
    return None


def pick_best(candidates: list[tuple[int, str, str, str]]) -> tuple[str, str, str] | None:
    """candidates: (score, value, source_qid, response_id)"""
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], -len(x[1])))
    best = candidates[0]
    return best[1], best[2], best[3]


def response_when(doc: dict) -> str:
    return str(doc.get("submittedAt") or doc.get("updatedAt") or doc.get("createdAt") or "")


def extract_from_responses(responses: list[dict]) -> dict:
    """Newest responses first; keep best-priority non-empty values."""
    responses = sorted(responses, key=response_when, reverse=True)
    coord_email_cands = []
    coord_name_cands = []
    pi_email_cands = []
    pi_name_cands = []

    for doc in responses:
        rid = doc.get("id") or ""
        for a in doc.get("answers") or []:
            val = str(a.get("value") or "").strip()
            if not val or a.get("skipped"):
                continue
            qid = str(a.get("questionId") or a.get("libraryQuestionId") or "")
            email = first_email(val)
            name = clean_name(val)

            sc = classify_coord(a)
            if sc is not None and email:
                coord_email_cands.append((sc, email, qid, rid))

            sn = classify_coord_name(a)
            if sn is not None and name and looks_like_person_name(name):
                coord_name_cands.append((sn, name, qid, rid))
            # Same answer often has "Name … Email: x@y"
            if sc is not None and name and looks_like_person_name(name) and not email:
                coord_name_cands.append((sc + 10, name, qid, rid))
            if sc is not None and email and name and looks_like_person_name(name):
                coord_name_cands.append((sc, name, qid, rid))

            pc = classify_pi(a)
            if pc is not None and email:
                pi_email_cands.append((pc, email, qid, rid))
            pn = classify_pi_name(a)
            if pn is not None and name and looks_like_person_name(name):
                pi_name_cands.append((pn, name, qid, rid))
            if pc is not None and email and name and looks_like_person_name(name):
                pi_name_cands.append((pc, name, qid, rid))

    out = {}
    ce = pick_best(coord_email_cands)
    cn = pick_best(coord_name_cands)
    pe = pick_best(pi_email_cands)
    pn = pick_best(pi_name_cands)
    if ce:
        out["siteCoordinatorEmail"] = ce[0]
        out["siteCoordinatorEmailSource"] = ce[1]
    if cn:
        out["siteCoordinator"] = cn[0]
        out["siteCoordinatorSource"] = cn[1]
    if pe:
        out["piEmail"] = pe[0]
        out["piEmailSource"] = pe[1]
    if pn:
        out["pi"] = pn[0]
        out["piSource"] = pn[1]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")
    resp_c = db.get_container_client("site-survey-responses")

    sites = fetch(sites_c)
    legacy = fetch(legacy_c)
    responses = fetch(
        resp_c,
        "SELECT c.id, c.siteId, c.answers, c.submittedAt, c.createdAt, c.updatedAt FROM c",
    )

    legacy_to_live: dict[str, str] = {}
    for s in sites:
        lid = s.get("promotedFromLegacySiteId")
        if lid:
            legacy_to_live[str(lid)] = s["id"]
        for x in s.get("legacySiteIds") or []:
            legacy_to_live[str(x)] = s["id"]
    for leg in legacy:
        linked = leg.get("linkedArtemisSiteId")
        if linked:
            legacy_to_live[str(leg["id"])] = str(linked)

    by_live: dict[str, list] = {s["id"]: [] for s in sites}
    unmatched = 0
    for r in responses:
        sid = str(r.get("siteId") or "")
        if not sid:
            unmatched += 1
            continue
        if sid in by_live:
            by_live[sid].append(r)
            continue
        live_id = legacy_to_live.get(sid)
        if live_id and live_id in by_live:
            by_live[live_id].append(r)
        else:
            unmatched += 1

    report_rows = []
    updates = 0
    skipped_full = 0
    no_data = 0

    for site in sites:
        sid = site["id"]
        extracted = extract_from_responses(by_live.get(sid) or [])
        if not extracted:
            no_data += 1
            continue

        patch = {}
        sources = {}
        if not str(site.get("siteCoordinatorEmail") or "").strip() and extracted.get("siteCoordinatorEmail"):
            patch["siteCoordinatorEmail"] = extracted["siteCoordinatorEmail"]
            sources["siteCoordinatorEmail"] = extracted.get("siteCoordinatorEmailSource")
        if not str(site.get("siteCoordinator") or "").strip() and extracted.get("siteCoordinator"):
            patch["siteCoordinator"] = extracted["siteCoordinator"]
            sources["siteCoordinator"] = extracted.get("siteCoordinatorSource")
        if not str(site.get("piEmail") or "").strip() and extracted.get("piEmail"):
            patch["piEmail"] = extracted["piEmail"]
            sources["piEmail"] = extracted.get("piEmailSource")
        if not str(site.get("pi") or "").strip() and extracted.get("pi"):
            patch["pi"] = extracted["pi"]
            sources["pi"] = extracted.get("piSource")

        if not patch:
            skipped_full += 1
            continue

        row = {
            "siteId": sid,
            "name": site.get("name"),
            "patch": patch,
            "sources": sources,
            "responseCount": len(by_live.get(sid) or []),
        }
        report_rows.append(row)
        updates += 1

        if args.apply:
            now = datetime.now(timezone.utc).isoformat()
            doc = dict(site)
            doc.update(patch)
            doc["updatedAt"] = now
            doc["contactsBackfill"] = {
                "at": now,
                "source": "site-survey-responses",
                "fields": sources,
            }
            sites_c.upsert_item(doc)

    out = REPO / ".firecrawl" / "site-contacts-backfill-report.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "apply": args.apply,
                "sites": len(sites),
                "responses": len(responses),
                "unmatchedResponses": unmatched,
                "wouldUpdate": updates,
                "alreadyHadContacts": skipped_full,
                "noSurveyContactData": no_data,
                "coordEmailFills": sum(1 for r in report_rows if "siteCoordinatorEmail" in r["patch"]),
                "coordNameFills": sum(1 for r in report_rows if "siteCoordinator" in r["patch"]),
                "piEmailFills": sum(1 for r in report_rows if "piEmail" in r["patch"]),
                "rows": report_rows,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Sites: {len(sites)}  responses: {len(responses)}  unmatched resp: {unmatched}")
    print(f"Would update: {updates}  already filled: {skipped_full}  no survey emails: {no_data}")
    print(
        "Coordinator email fills:",
        sum(1 for r in report_rows if "siteCoordinatorEmail" in r["patch"]),
        " name fills:",
        sum(1 for r in report_rows if "siteCoordinator" in r["patch"]),
        " PI email fills:",
        sum(1 for r in report_rows if "piEmail" in r["patch"]),
    )
    print("Report:", out)
    for r in report_rows[:12]:
        print(f"  {r['name'][:40]:40s} {r['patch']}")
    if len(report_rows) > 12:
        print(f"  … {len(report_rows) - 12} more")
    if not args.apply:
        print("\nDry run only. Re-run with --apply to write Cosmos.")
    else:
        print(f"\nApplied {updates} site updates.")


if __name__ == "__main__":
    main()
