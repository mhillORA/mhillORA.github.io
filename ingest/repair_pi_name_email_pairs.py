"""
Repair live site PI name/email pairs corrupted by independent contact backfill.

Strategy (per site):
  1) Same-response PI name+email pair from survey history (prefer name↔email match)
  2) Else legacy PI name (keep live email if it matches legacy name, else legacy email too if present)
  3) Else Mike pack PI for rebuild-matched practices
  4) If still mismatched name vs email → clear the name (keep email)

Usage:
  python ingest/repair_pi_name_email_pairs.py
  python ingest/repair_pi_name_email_pairs.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

import backfill_site_contacts_from_surveys as bf

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / "ingest" / "data" / "pi_name_email_repair_report.json"
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")


def cosmos():
    return bf.cosmos()


def last_token(name: str) -> str:
    t = re.sub(r"\b(md|phd|do|od|dr|jr|sr|ii|iii|iv)\b", "", str(name or "").lower())
    parts = [p for p in re.split(r"[^a-z]+", t) if len(p) > 1]
    return parts[-1] if parts else ""


def needs_repair(pi: str, email: str) -> bool:
    pi = str(pi or "").strip()
    email = str(email or "").strip()
    if not pi:
        return False
    if not email:
        return False
    return not bf.name_matches_email(pi, email)


def load_mike_pi_by_practice() -> dict[str, str]:
    if not PACK.exists():
        return {}
    raw = json.loads(PACK.read_text(encoding="utf-8"))
    sites = raw if isinstance(raw, list) else raw.get("sites") or raw.get("data") or []
    out = {}
    for s in sites:
        pn = re.sub(r"\s+", " ", str(s.get("practice_name") or "").strip().lower())
        pi = str(s.get("pi_name") or "").strip()
        if pn and pi and not re.fullmatch(r"\d+", pi):
            out[pn] = pi
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")
    resp_c = db.get_container_client("site-survey-responses")

    sites = bf.fetch(sites_c)
    legacy = bf.fetch(legacy_c)
    responses = bf.fetch(
        resp_c,
        "SELECT c.id, c.siteId, c.answers, c.submittedAt, c.createdAt, c.updatedAt, c.source, "
        "c.mikePracticeName, c.displayName FROM c",
    )
    mike_pi = load_mike_pi_by_practice()

    legacy_by_id = {str(L["id"]): L for L in legacy}
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
    for r in responses:
        sid = str(r.get("siteId") or "")
        if sid in by_live:
            by_live[sid].append(r)
            continue
        live_id = legacy_to_live.get(sid)
        if live_id and live_id in by_live:
            by_live[live_id].append(r)

    rows = []
    now = datetime.now(timezone.utc).isoformat()

    for site in sites:
        sid = site["id"]
        cur_pi = str(site.get("pi") or site.get("piName") or "").strip()
        cur_email = str(site.get("piEmail") or "").strip()
        st = str(site.get("status") or "").lower()
        if st in ("inactive", "archived", "closed"):
            continue

        mismatched = needs_repair(cur_pi, cur_email)
        empty_pi = not cur_pi and bool(cur_email)
        # Also repair backfilled sites even if heuristic matches weakly but legacy disagrees
        lids = []
        if site.get("promotedFromLegacySiteId"):
            lids.append(str(site["promotedFromLegacySiteId"]))
        lids += [str(x) for x in (site.get("legacySiteIds") or [])]
        legacy_pi = ""
        legacy_email = ""
        for lid in lids:
            L = legacy_by_id.get(lid)
            if not L:
                continue
            legacy_pi = str(L.get("pi") or L.get("piName") or "").strip()
            legacy_email = str(L.get("piEmail") or "").strip()
            if legacy_pi:
                break

        legacy_disagrees = bool(
            legacy_pi and cur_pi and last_token(legacy_pi) != last_token(cur_pi)
        )

        if not mismatched and not empty_pi and not (legacy_disagrees and site.get("contactsBackfill")):
            continue

        extracted = bf.extract_pi_pair_from_responses(by_live.get(sid) or [])
        new_pi = ""
        new_email = cur_email
        reason = ""

        # Collect candidate names that match the current (trusted) email
        match_names = []
        if cur_email:
            if legacy_pi and bf.name_matches_email(legacy_pi, cur_email):
                match_names.append(("legacy-match-email", legacy_pi))
            # Mike pack / mike answers
            prac = re.sub(r"\s+", " ", str(site.get("name") or "").strip().lower())
            mpi = mike_pi.get(prac) or ""
            for r in by_live.get(sid) or []:
                if str(r.get("source") or "").startswith("mike"):
                    for a in r.get("answers") or []:
                        if a.get("libraryQuestionId") == "ql-pi-name" and a.get("value"):
                            mpi = str(a.get("value")).strip() or mpi
                    if not mpi:
                        mpi = str(r.get("displayName") or "").strip()
            if mpi and bf.name_matches_email(mpi, cur_email):
                match_names.append(("mike-match-email", mpi))
            # Any survey name that matches current email (scan all PI names in bucket)
            for r in by_live.get(sid) or []:
                for a in r.get("answers") or []:
                    if bf.classify_pi_name(a) is None:
                        continue
                    nm = bf.clean_name(a.get("value"))
                    if nm and bf.looks_like_person_name(nm) and bf.name_matches_email(nm, cur_email):
                        match_names.append(("survey-match-email", nm))

        if match_names:
            # Prefer longer / more complete name
            match_names.sort(key=lambda x: -len(x[1]))
            reason, new_pi = match_names[0]
            new_email = cur_email
        elif (
            extracted.get("pi")
            and extracted.get("piEmail")
            and bf.name_matches_email(extracted["pi"], extracted["piEmail"])
        ):
            new_pi = extracted["pi"]
            new_email = extracted["piEmail"]
            reason = "same-response-pair"
        elif legacy_pi and legacy_email and bf.name_matches_email(legacy_pi, legacy_email):
            new_pi, new_email = legacy_pi, legacy_email
            reason = "legacy-pair"
        elif mismatched or (legacy_disagrees and site.get("contactsBackfill")):
            new_pi = ""
            new_email = cur_email
            reason = "clear-mismatched-name"
        else:
            continue

        # Normalize: if we still have mismatch, clear name
        if new_pi and new_email and not bf.name_matches_email(new_pi, new_email):
            new_pi = ""
            reason = "clear-mismatched-name"

        patch = {}
        if new_pi != cur_pi:
            patch["pi"] = new_pi
        if new_email and new_email != cur_email:
            patch["piEmail"] = new_email
        if not patch:
            continue

        row = {
            "siteId": sid,
            "name": site.get("name"),
            "beforePi": cur_pi,
            "beforeEmail": cur_email,
            "afterPi": patch.get("pi", cur_pi),
            "afterEmail": patch.get("piEmail", cur_email),
            "reason": reason,
            "hadBackfill": bool(site.get("contactsBackfill")),
            "legacyPi": legacy_pi,
        }
        rows.append(row)

        if args.apply:
            doc = dict(site)
            doc.update(patch)
            doc["updatedAt"] = now
            doc["piPairRepairedAt"] = now
            doc["piPairRepair"] = {
                "at": now,
                "reason": reason,
                "beforePi": cur_pi,
                "beforeEmail": cur_email,
            }
            sites_c.upsert_item(doc)

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "repaired": len(rows),
        "byReason": {},
        "rows": rows,
    }
    from collections import Counter

    report["byReason"] = dict(Counter(r["reason"] for r in rows))
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"mode={'APPLY' if args.apply else 'DRY-RUN'} repaired={len(rows)}")
    print("byReason", report["byReason"])
    for r in rows[:30]:
        print(
            f"  {r['reason']:22} {(r['name'] or '')[:34]:34} "
            f"{(r['beforePi'] or '')[:20]:20} -> {(r['afterPi'] or '(clear)')[:20]:20} "
            f"| {r['beforeEmail'][:28]}"
        )
    if len(rows) > 30:
        print(f"  ... +{len(rows) - 30} more")
    print(f"report={REPORT}")


if __name__ == "__main__":
    main()
