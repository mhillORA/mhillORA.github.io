"""
Fill blank live-site PI names, prioritizing Mike's ReBUILD pack over legacy.

Sources (in order):
  1) Mike survey response already linked to this siteId (ql-pi-name / displayName)
  2) Mike pack practice_name exact / high-confidence match
  3) Site title like "Charles Wykoff Site (...)" 
  4) Legacy PI (last resort)

Does not clear existing PIs. Does not invent from weak fuzzy matches.

Usage:
  python ingest/fill_blank_pi_from_mike.py
  python ingest/fill_blank_pi_from_mike.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
REPORT = REPO / "ingest" / "data" / "fill_blank_pi_from_mike_report.json"
MIKE_SRC = "mike-rebuild-39-pack"


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


def norm_practice(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower().strip())
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def clean_pi(s: str) -> str:
    t = str(s or "").strip()
    if not t or re.fullmatch(r"\d+", t):
        return ""
    if len(t) < 3 or len(t) > 120:
        return ""
    if "@" in t:
        return ""
    return t


def pi_from_site_title(name: str) -> str:
    """'Charles Wykoff Site (The Woodlands)' → 'Charles Wykoff'."""
    m = re.match(
        r"^(?P<pi>[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){0,3})\s+Site\b",
        str(name or "").strip(),
    )
    if not m:
        return ""
    return clean_pi(m.group("pi"))


def load_pack() -> list[dict]:
    if not PACK.exists():
        return []
    raw = json.loads(PACK.read_text(encoding="utf-8"))
    sites = raw if isinstance(raw, list) else raw.get("sites") or raw.get("data") or []
    out = []
    for s in sites:
        pi = clean_pi(s.get("pi_name"))
        practice = str(s.get("practice_name") or "").strip()
        if not pi or not practice:
            continue
        out.append(
            {
                "practice": practice,
                "pi": pi,
                "n": norm_practice(practice),
                "id": s.get("site_id"),
            }
        )
    return out


def match_pack(practice: str, pack: list[dict]) -> tuple[str, str, float] | None:
    nn = norm_practice(practice)
    if not nn or len(nn) < 8:
        return None
    best = None
    bs = 0.0
    for m in pack:
        mn = m["n"]
        if not mn or len(mn) < 8:
            continue
        if nn == mn:
            r = 1.0
        elif nn in mn or mn in nn:
            shorter, longer = (nn, mn) if len(nn) <= len(mn) else (mn, nn)
            r = 0.92 if len(shorter) / max(len(longer), 1) >= 0.7 else 0.0
        else:
            r = SequenceMatcher(None, nn, mn).ratio()
        if r > bs:
            best, bs = m, r
    if best and bs >= 0.88:
        return best["pi"], best["practice"], bs
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    db = cosmos()
    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")
    resp_c = db.get_container_client("site-survey-responses")

    sites = list(
        sites_c.query_items(
            "SELECT * FROM c",
            enable_cross_partition_query=True,
        )
    )
    legacy = {
        str(L["id"]): L
        for L in legacy_c.query_items(
            "SELECT c.id, c.pi, c.piName, c.linkedArtemisSiteId FROM c",
            enable_cross_partition_query=True,
        )
    }
    mike_resps = list(
        resp_c.query_items(
            "SELECT c.id, c.siteId, c.answers, c.displayName, c.mikePracticeName, c.source "
            "FROM c WHERE STARTSWITH(c.id, @p) OR c.source = @src",
            parameters=[
                {"name": "@p", "value": "rsp-mike-rebuild"},
                {"name": "@src", "value": MIKE_SRC},
            ],
            enable_cross_partition_query=True,
        )
    )
    mike_by_site: dict[str, list] = {}
    for r in mike_resps:
        mike_by_site.setdefault(str(r.get("siteId") or ""), []).append(r)

    pack = load_pack()
    now = datetime.now(timezone.utc).isoformat()
    rows = []

    for site in sites:
        st = str(site.get("status") or "").lower()
        if st in ("inactive", "archived", "closed"):
            continue
        cur = clean_pi(site.get("pi") or site.get("piName"))
        if cur:
            continue
        name = str(site.get("name") or "").strip()
        if not name:
            continue
        sid = site["id"]

        new_pi = ""
        reason = ""
        detail = ""

        # 1) Mike response linked to this live site
        for r in mike_by_site.get(sid) or []:
            for a in r.get("answers") or []:
                if a.get("libraryQuestionId") == "ql-pi-name":
                    new_pi = clean_pi(a.get("value"))
                    if new_pi:
                        reason = "mike-response-answer"
                        detail = r.get("id") or ""
                        break
            if new_pi:
                break
            new_pi = clean_pi(r.get("displayName"))
            if new_pi:
                reason = "mike-response-display"
                detail = r.get("mikePracticeName") or r.get("id") or ""
                break

        # 2) Mike pack by practice name (strict)
        if not new_pi:
            hit = match_pack(name, pack)
            if hit:
                new_pi, detail, score = hit
                reason = f"mike-pack-name:{score:.2f}"

        # 3) PI embedded in site title
        if not new_pi:
            titled = pi_from_site_title(name)
            if titled:
                new_pi = titled
                reason = "site-title"

        # 4) Legacy last resort
        if not new_pi:
            lids = []
            if site.get("promotedFromLegacySiteId"):
                lids.append(str(site["promotedFromLegacySiteId"]))
            lids += [str(x) for x in (site.get("legacySiteIds") or [])]
            for lid in lids:
                L = legacy.get(lid)
                if not L:
                    continue
                new_pi = clean_pi(L.get("pi") or L.get("piName"))
                if new_pi:
                    reason = "legacy"
                    detail = lid
                    break

        if not new_pi:
            rows.append(
                {
                    "siteId": sid,
                    "name": name,
                    "piEmail": site.get("piEmail") or "",
                    "filled": False,
                    "reason": "no-source",
                }
            )
            continue

        rows.append(
            {
                "siteId": sid,
                "name": name,
                "piEmail": site.get("piEmail") or "",
                "filled": True,
                "afterPi": new_pi,
                "reason": reason,
                "detail": detail,
            }
        )
        if args.apply:
            doc = dict(site)
            doc["pi"] = new_pi
            doc["updatedAt"] = now
            doc["piFilledFromMikeAt"] = now
            doc["piFill"] = {"at": now, "reason": reason, "detail": detail}
            sites_c.upsert_item(doc)

    filled = [r for r in rows if r.get("filled")]
    unfilled = [r for r in rows if not r.get("filled")]
    from collections import Counter

    report = {
        "mode": "apply" if args.apply else "dry-run",
        "blankSeen": len(rows),
        "filled": len(filled),
        "stillBlank": len(unfilled),
        "byReason": dict(Counter(r["reason"] for r in filled)),
        "filledRows": filled,
        "stillBlankRows": unfilled,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"mode={'APPLY' if args.apply else 'DRY-RUN'} blank={len(rows)} filled={len(filled)} stillBlank={len(unfilled)}")
    print("byReason", report["byReason"])
    for r in filled[:40]:
        print(f"  {r['reason']:22} {(r['name'] or '')[:36]:36} -> {r['afterPi'][:40]}")
    if len(filled) > 40:
        print(f"  ... +{len(filled)-40} more")
    print(f"\nstill blank ({len(unfilled)}):")
    for r in unfilled[:40]:
        print(f"  {(r['name'] or '')[:50]:50} {r.get('piEmail') or ''}")
    if len(unfilled) > 40:
        print(f"  ... +{len(unfilled)-40} more")
    print(f"report={REPORT}")


if __name__ == "__main__":
    main()
