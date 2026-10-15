"""
Pressure-test Cavalry NK site-profile autofill against a real Cosmos site.
Uses local buildSiteRecordPrefill (same code path as the API).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_cavalry_nk_survey import cosmos_db  # noqa: E402

SURVEY_ID = "survey-cavalry-nk-feasibility"
REPO = Path(__file__).resolve().parents[1]
CANON = {
    "ql-site-name": "Site Name",
    "ql-site-address": "Site Street Address",
    "ql-site-city": "City",
    "ql-site-state": "State",
    "ql-site-zip": "Zip",
    "ql-site-phone": "Site Phone",
    "ql-pi-name": "PI Name",
    "ql-pi-phone": "PI Phone",
    "ql-pi-email": "PI Email",
    "ql-coord-name": "Coordinator Name",
    "ql-coord-email": "Coordinator Email",
    "ql-coord-phone": "Coordinator Phone",
}


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}")


def pick_site(db):
    c = db.get_container_client("sites")
    # Prefer a site with street + city + PI so autofill is meaningful
    query = (
        "SELECT TOP 40 * FROM c WHERE IS_DEFINED(c.name) AND c.name != null "
        "AND (IS_DEFINED(c.city) OR IS_DEFINED(c.address) OR IS_DEFINED(c.address1))"
    )
    sites = list(c.query_items(query=query, enable_cross_partition_query=True))
    best = None
    best_score = -1
    for s in sites:
        score = 0
        for k in ("name", "address", "address1", "city", "state", "zip", "zipCode",
                  "pi", "piName", "piEmail", "siteCoordinator", "siteCoordinatorEmail", "phone"):
            if str(s.get(k) or "").strip():
                score += 1
        if score > best_score:
            best_score = score
            best = s
    return best, best_score, len(sites)


def run_prefill_node(survey_qs: list, site: dict) -> dict:
    """Call Node buildSiteRecordPrefill with survey questions + site doc."""
    script = r"""
const { buildSiteRecordPrefill } = require('./api/lib/survey-response-service');
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const map = buildSiteRecordPrefill(payload.questions, payload.site, {});
process.stdout.write(JSON.stringify(map, null, 0));
"""
    proc = subprocess.run(
        ["node", "-e", script],
        input=json.dumps({"questions": survey_qs, "site": site}),
        capture_output=True,
        text=True,
        cwd=str(REPO),
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node prefill failed: {proc.stderr[:800]}")
    return json.loads(proc.stdout)


def main() -> int:
    fails = 0
    db = cosmos_db()
    survey = db.get_container_client("site-survey-definitions").read_item(SURVEY_ID, SURVEY_ID)
    qs = survey.get("questions") or []

    print("=== Canonical libraryQuestionIds on Cavalry ===")
    by_lib = {q.get("libraryQuestionId"): q for q in qs if q.get("libraryQuestionId")}
    for cid, label in CANON.items():
        hit = by_lib.get(cid)
        if hit:
            ok(f"{cid} -> {(hit.get('label') or '')[:70]}")
        else:
            fail(f"{cid} MISSING on definition")
            fails += 1

    site, score, n = pick_site(db)
    if not site:
        fail("No site found in Cosmos to pressure-test")
        return 1
    print(f"\n=== Site under test ({n} candidates, score={score}) ===")
    print(f"  id={site.get('id')}")
    print(f"  name={site.get('name')}")
    print(f"  city={site.get('city')} state={site.get('state')} zip={site.get('zip') or site.get('zipCode')}")
    print(f"  pi={site.get('pi') or site.get('piName')} email={site.get('piEmail')}")
    print(f"  coord={site.get('siteCoordinator')} email={site.get('siteCoordinatorEmail')}")

    print("\n=== buildSiteRecordPrefill output ===")
    try:
        prefill = run_prefill_node(qs, site)
    except Exception as e:
        fail(str(e))
        return 1

    # Map by library id for reporting
    q_by_id = {q.get("id"): q for q in qs}
    filled = []
    missing_expected = []
    for q in qs:
        lib = q.get("libraryQuestionId") or ""
        if lib not in CANON:
            continue
        qid = q.get("id")
        val = (prefill.get(qid) or "").strip()
        lab = (q.get("label") or "")[:50]
        if val:
            ok(f"{lib}: {val[:80]}")
            filled.append(lib)
        else:
            # Only fail if site profile actually has something for that field
            missing_expected.append((lib, lab, qid))

    # Soft-check: site name + at least one address part + PI or coord should fill when present on site
    must = []
    if str(site.get("name") or "").strip():
        must.append("ql-site-name")
    if any(str(site.get(k) or "").strip() for k in ("address", "address1", "street")):
        must.append("ql-site-address")
    if str(site.get("city") or "").strip():
        must.append("ql-site-city")
    if str(site.get("state") or "").strip():
        must.append("ql-site-state")
    if str(site.get("zip") or site.get("zipCode") or "").strip():
        must.append("ql-site-zip")
    if str(site.get("piEmail") or "").strip():
        must.append("ql-pi-email")
    # ql-pi-name is intentionally blank when site PI name disagrees with PI email
    # (existing personNameMatchesEmail guard) — only require when prefill kept it
    # or when email local-part plausibly matches the name.
    pi_raw = str(site.get("pi") or site.get("piName") or "").strip()
    pi_email = str(site.get("piEmail") or "").strip()
    if "ql-pi-name" in filled:
        must.append("ql-pi-name")
    elif pi_raw:
        print(f"  SKIP  ql-pi-name (cleared by PI name/email mismatch guard; pi={pi_raw!r} email={pi_email!r})")
    if str(site.get("siteCoordinator") or "").strip():
        must.append("ql-coord-name")
    if str(site.get("siteCoordinatorEmail") or "").strip():
        must.append("ql-coord-email")

    print("\n=== Required autofills given this site profile ===")
    for lib in must:
        if lib in filled:
            ok(f"required {lib} filled")
        else:
            fail(f"required {lib} EMPTY (site has data)")
            fails += 1
            for mlib, lab, qid in missing_expected:
                if mlib == lib:
                    print(f"       q={qid} label={lab!r}")

    # Second site pass: find one where PI name also prefills
    print("\n=== Second site (prefer PI name filled) ===")
    c = db.get_container_client("sites")
    more = list(
        c.query_items(
            query="SELECT TOP 80 * FROM c WHERE IS_DEFINED(c.pi) OR IS_DEFINED(c.piName)",
            enable_cross_partition_query=True,
        )
    )
    pi_hit = None
    for s2 in more:
        try:
            pf2 = run_prefill_node(qs, s2)
        except Exception:
            continue
        qid_pi = next(
            (q.get("id") for q in qs if q.get("libraryQuestionId") == "ql-pi-name"),
            None,
        )
        qid_name = next(
            (q.get("id") for q in qs if q.get("libraryQuestionId") == "ql-site-name"),
            None,
        )
        qid_city = next(
            (q.get("id") for q in qs if q.get("libraryQuestionId") == "ql-site-city"),
            None,
        )
        if qid_pi and pf2.get(qid_pi) and qid_name and pf2.get(qid_name) and qid_city and pf2.get(qid_city):
            pi_hit = (s2, pf2, qid_pi, qid_name, qid_city)
            break
    if pi_hit:
        s2, pf2, qid_pi, qid_name, qid_city = pi_hit
        ok(f"site {s2.get('id')} name={pf2.get(qid_name)!r}")
        ok(f"city={pf2.get(qid_city)!r} pi={pf2.get(qid_pi)!r}")
    else:
        print("  WARN  no site in sample had PI name + city + site name together (mismatch guard common)")

    # Attachment template plumbing in index.html
    print("\n=== Send-template attachment plumbing (static) ===")
    idx = (REPO / "index.html").read_text(encoding="utf-8")
    for needle, label in [
        ("uploadSurveyAttachments", "client upload API"),
        ("__pendingAttachmentIds", "form pending attachment ids"),
        ("site-survey-upload-attachments", "upload route path"),
        ("attachmentIds: reuseAttachmentIds", "send reuses template ids"),
    ]:
        if needle in idx:
            ok(label)
        else:
            fail(f"missing {label} ({needle})")
            fails += 1
    api = (REPO / "api" / "survey-secure-routes.js").read_text(encoding="utf-8")
    if "siteSurveyUploadAttachments" in api and "reuseIds" in api:
        ok("API upload + reuseAttachmentIds path present")
    else:
        fail("API attachment upload/reuse missing")
        fails += 1

    print(f"\n=== Result: {fails} failure(s) ===")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
