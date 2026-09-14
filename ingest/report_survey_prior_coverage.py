"""
Score sites against a survey's library questions using historical all-sites answers
(via Mike harmonization bridge). Read-only — does not write Cosmos.

Outputs:
  .firecrawl/mighty-prior-coverage.json
  .firecrawl/mighty-prior-coverage.csv

Usage:
  python ingest/report_survey_prior_coverage.py
  python ingest/report_survey_prior_coverage.py --survey survey-rebuild-mytx272am-201
  python ingest/report_survey_prior_coverage.py --priority-only
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
BRIDGE = REPO / "ingest" / "data" / "harmonization_bridge.json"
DEFAULT_ALL_SITES = Path(r"c:\Users\shue1\Downloads\Ora_Feasibility_Data_All_Sites+12Sep26 Update2.json")
DEFAULT_PRIORITY = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
OUT_JSON = REPO / ".firecrawl" / "mighty-prior-coverage.json"
OUT_CSV = REPO / ".firecrawl" / "mighty-prior-coverage.csv"
DEFAULT_SURVEY = "survey-rebuild-mytx272am-201"


def cosmos_db():
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


def norm_name(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc|the)\b", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def load_survey_questions(survey_id: str):
    db = cosmos_db()
    def_c = db.get_container_client("site-survey-definitions")
    survey = def_c.read_item(survey_id, survey_id)
    qs = []
    for q in survey.get("questions") or []:
        lib = q.get("libraryQuestionId")
        if not lib:
            continue
        qs.append(
            {
                "questionId": q.get("id"),
                "libraryQuestionId": lib,
                "label": q.get("label") or "",
                "page": q.get("page"),
            }
        )
    # unique by library id (first wins)
    seen = set()
    unique = []
    for q in qs:
        if q["libraryQuestionId"] in seen:
            continue
        seen.add(q["libraryQuestionId"])
        unique.append(q)
    return survey, unique


def build_raw_to_lib(bridge: dict) -> dict[str, str]:
    out = {}
    for raw, hit in (bridge.get("rawToLibrary") or {}).items():
        lib = hit.get("libraryQuestionId")
        if lib:
            out[raw] = lib
    return out


def site_answered_libs(site: dict, raw_to_lib: dict[str, str]) -> dict[str, dict]:
    """libraryQuestionId -> {value, study, raw_question} (most recent-ish last write wins)."""
    found = {}
    for survey in site.get("surveys") or []:
        study = (survey.get("study") or {}).get("study_name") or survey.get("source_tab") or ""
        for raw_q, val in (survey.get("responses") or {}).items():
            if val is None or str(val).strip() == "":
                continue
            lib = raw_to_lib.get(raw_q)
            if not lib:
                continue
            found[lib] = {
                "value": val if not isinstance(val, (dict, list)) else json.dumps(val)[:200],
                "study": study,
                "raw_question": raw_q[:160],
            }
    return found


def fuzzy_priority_match(practice: str, pi: str, all_sites: dict) -> tuple[str | None, float]:
    target = norm_name(practice)
    pi_n = norm_name(pi)
    best_key, best = None, 0.0
    for key, site in all_sites.items():
        names = [site.get("canonical_name") or ""] + list(site.get("names_used") or [])
        score = 0.0
        for n in names:
            nn = norm_name(n)
            if not nn or not target:
                continue
            if nn == target:
                score = max(score, 1.0)
            elif target in nn or nn in target:
                score = max(score, 0.85)
        if pi_n:
            for survey in site.get("surveys") or []:
                if norm_name(survey.get("pi_name") or "") == pi_n:
                    score = max(score, score + 0.1 if score else 0.55)
        if score > best:
            best, best_key = score, key
    return best_key, round(best, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", default=DEFAULT_SURVEY)
    ap.add_argument("--all-sites", default=str(DEFAULT_ALL_SITES))
    ap.add_argument("--priority", default=str(DEFAULT_PRIORITY))
    ap.add_argument("--priority-only", action="store_true", help="Restrict to ReBUILD 39 pack sites")
    ap.add_argument("--top", type=int, default=25)
    args = ap.parse_args()

    if not BRIDGE.exists():
        raise SystemExit(f"Bridge missing. Run build_harmonization_bridge.py first: {BRIDGE}")
    all_sites_path = Path(args.all_sites)
    if not all_sites_path.exists():
        raise SystemExit(f"All-sites file missing: {all_sites_path}")

    bridge = json.loads(BRIDGE.read_text(encoding="utf-8"))
    raw_to_lib = build_raw_to_lib(bridge)
    survey, questions = load_survey_questions(args.survey)
    target_libs = [q["libraryQuestionId"] for q in questions]
    target_set = set(target_libs)
    print(f"Survey: {survey.get('id')} — {survey.get('title')}")
    print(f"Target questions (unique ql-*): {len(target_libs)}")
    print(f"Bridge raw->ql map size: {len(raw_to_lib)}")

    data = json.loads(all_sites_path.read_text(encoding="utf-8"))
    all_sites = data.get("sites") or {}

    priority_rows = []
    priority_path = Path(args.priority)
    if priority_path.exists():
        pack = json.loads(priority_path.read_text(encoding="utf-8"))
        for row in pack.get("sites") or []:
            key, score = fuzzy_priority_match(
                row.get("practice_name") or "",
                row.get("pi_name") or "",
                all_sites,
            )
            priority_rows.append({**row, "allSitesKey": key, "nameMatchScore": score})

    # Which site keys to score
    if args.priority_only:
        site_keys = [r["allSitesKey"] for r in priority_rows if r.get("allSitesKey")]
        site_meta = {
            r["allSitesKey"]: {
                "priorityId": r.get("site_id"),
                "practice_name": r.get("practice_name"),
                "pi_name": r.get("pi_name"),
                "nameMatchScore": r.get("nameMatchScore"),
            }
            for r in priority_rows
            if r.get("allSitesKey")
        }
    else:
        site_keys = list(all_sites.keys())
        site_meta = {}
        for r in priority_rows:
            if r.get("allSitesKey"):
                site_meta[r["allSitesKey"]] = {
                    "priorityId": r.get("site_id"),
                    "practice_name": r.get("practice_name"),
                    "pi_name": r.get("pi_name"),
                    "nameMatchScore": r.get("nameMatchScore"),
                    "isPriority": True,
                }

    rows = []
    for key in site_keys:
        site = all_sites.get(key)
        if not site:
            continue
        answered = site_answered_libs(site, raw_to_lib)
        hit_libs = [lib for lib in target_libs if lib in answered]
        miss_libs = [lib for lib in target_libs if lib not in answered]
        pct = round(100.0 * len(hit_libs) / len(target_libs), 1) if target_libs else 0.0
        meta = site_meta.get(key) or {}
        rows.append(
            {
                "canonical_name": site.get("canonical_name") or key,
                "allSitesKey": key,
                "priorityId": meta.get("priorityId"),
                "priorityPractice": meta.get("practice_name"),
                "priorityPi": meta.get("pi_name"),
                "nameMatchScore": meta.get("nameMatchScore"),
                "isPriority": bool(meta.get("priorityId") or meta.get("isPriority")),
                "totalSurveys": site.get("total_surveys") or len(site.get("surveys") or []),
                "studiesCompleted": len(site.get("studies_completed") or []),
                "indications": ", ".join(site.get("indications_covered") or [])[:120],
                "matchedQuestions": len(hit_libs),
                "totalQuestions": len(target_libs),
                "coveragePct": pct,
                "missingCount": len(miss_libs),
                "matchedLibraryIds": hit_libs,
                "missingLibraryIds": miss_libs[:40],
                "sampleAnswers": [
                    {
                        "libraryQuestionId": lib,
                        "label": next((q["label"] for q in questions if q["libraryQuestionId"] == lib), ""),
                        "value": str(answered[lib]["value"])[:120],
                        "study": answered[lib]["study"],
                    }
                    for lib in hit_libs[:8]
                ],
            }
        )

    # Question-level: how many sites have each Mighty question answered
    q_hits = defaultdict(int)
    for r in rows:
        for lib in r["matchedLibraryIds"]:
            q_hits[lib] += 1
    question_coverage = []
    for q in questions:
        lib = q["libraryQuestionId"]
        n = q_hits.get(lib, 0)
        question_coverage.append(
            {
                "libraryQuestionId": lib,
                "label": q["label"],
                "sitesWithAnswer": n,
                "sitePct": round(100.0 * n / len(rows), 1) if rows else 0,
            }
        )
    question_coverage.sort(key=lambda x: -x["sitesWithAnswer"])

    # Relative completeness among questions that have ANY historical hit in the corpus
    libs_with_history = {q["libraryQuestionId"] for q in question_coverage if q["sitesWithAnswer"] > 0}
    for r in rows:
        mappable = [lib for lib in target_libs if lib in libs_with_history]
        hit_m = [lib for lib in mappable if lib in set(r["matchedLibraryIds"])]
        r["mappableQuestionCount"] = len(mappable)
        r["mappableMatched"] = len(hit_m)
        r["mappableCoveragePct"] = (
            round(100.0 * len(hit_m) / len(mappable), 1) if mappable else 0.0
        )

    rows.sort(
        key=lambda r: (
            -r["mappableCoveragePct"],
            -r["coveragePct"],
            -r["matchedQuestions"],
            r["canonical_name"] or "",
        )
    )

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "surveyId": survey.get("id"),
        "surveyTitle": survey.get("title"),
        "targetQuestionCount": len(target_libs),
        "mappableQuestionCount": len(libs_with_history),
        "sitesScored": len(rows),
        "priorityOnly": bool(args.priority_only),
        "avgCoveragePct": round(sum(r["coveragePct"] for r in rows) / len(rows), 1) if rows else 0,
        "avgMappableCoveragePct": (
            round(sum(r["mappableCoveragePct"] for r in rows) / len(rows), 1) if rows else 0
        ),
        "sitesWithAnyMatch": sum(1 for r in rows if r["matchedQuestions"] > 0),
        "sitesGe50": sum(1 for r in rows if r["coveragePct"] >= 50),
        "sitesGe25": sum(1 for r in rows if r["coveragePct"] >= 25),
        "sitesMappableGe50": sum(1 for r in rows if r["mappableCoveragePct"] >= 50),
        "topSites": [
            {
                "name": r["canonical_name"],
                "coveragePct": r["coveragePct"],
                "mappableCoveragePct": r["mappableCoveragePct"],
                "matched": r["matchedQuestions"],
                "mappableMatched": r["mappableMatched"],
                "priorityId": r.get("priorityId"),
            }
            for r in rows[: args.top]
        ],
    }

    report = {
        "summary": summary,
        "questionCoverage": question_coverage,
        "sites": rows,
    }
    OUT_JSON.parent.mkdir(exist_ok=True)
    OUT_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "mappableCoveragePct",
                "coveragePct",
                "mappableMatched",
                "mappableQuestionCount",
                "matchedQuestions",
                "totalQuestions",
                "missingCount",
                "canonical_name",
                "isPriority",
                "priorityId",
                "priorityPractice",
                "priorityPi",
                "nameMatchScore",
                "totalSurveys",
                "studiesCompleted",
                "indications",
            ],
        )
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k) for k in w.fieldnames})

    print(
        f"Sites scored: {summary['sitesScored']}  "
        f"full avg: {summary['avgCoveragePct']}%  "
        f"mappable avg: {summary['avgMappableCoveragePct']}% "
        f"({summary['mappableQuestionCount']}/{summary['targetQuestionCount']} qs have history)"
    )
    print("Top mappable coverage:")
    for t in summary["topSites"][:12]:
        pri = f"  [{t['priorityId']}]" if t.get("priorityId") else ""
        print(
            f"  map {t['mappableCoveragePct']:5.1f}% ({t['mappableMatched']}/{summary['mappableQuestionCount']})  "
            f"full {t['coveragePct']:5.1f}%  {t['name']}{pri}"
        )
    print(f"Wrote {OUT_CSV}")
    print(f"Wrote {OUT_JSON}")


if __name__ == "__main__":
    main()
