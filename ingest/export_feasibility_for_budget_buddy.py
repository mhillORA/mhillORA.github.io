"""
Export ARTEMIS feasibility data (ora-clinical-recruiting) into a Budget Buddy pack.

Reads (ARTEMIS / crcscheduling only — never Chaos shared sites):
  site-profiles, site-survey-definitions, site-survey-responses, legacy-sites

Writes a single JSON package + optional NDJSON shards for large response sets.

Usage:
  python ingest/export_feasibility_for_budget_buddy.py
  python ingest/export_feasibility_for_budget_buddy.py --out exports/budget_buddy_feasibility_pack.json
  python ingest/export_feasibility_for_budget_buddy.py --slim-answers   # drop empty answer values
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

ENDPOINT = os.environ.get("COSMOS_ENDPOINT", "https://ora-clinical-recruiting.documents.azure.com:443/")
KEY = os.environ.get("COSMOS_KEY", "")
DATABASE_ID = os.environ.get("DATABASE_ID", "crcscheduling")

DATASET = "artemis_feasibility_master"
SCHEMA_VERSION = 1
SOURCE = "artemis-feasibility-export"

THIS_DIR = Path(__file__).resolve().parent
REPO = THIS_DIR.parent
DEFAULT_OUT = REPO / "exports" / "budget_buddy_feasibility_pack.json"


def load_key():
    global KEY, ENDPOINT, DATABASE_ID
    if KEY:
        return
    for p in (
        REPO / "data-api-connections.json",
        REPO / "api" / "local.settings.json",
        Path(r"C:\Users\shue1\OneDrive\Desktop\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
        Path(r"C:\Users\shue1\Projects\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
    ):
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        vals = data.get("Values") or {}
        KEY = vals.get("COSMOS_KEY") or KEY
        ENDPOINT = vals.get("COSMOS_ENDPOINT") or ENDPOINT
        DATABASE_ID = vals.get("DATABASE_ID") or DATABASE_ID
        conn = (data.get("cosmosdb-connection") or {}).get("connectionString") or ""
        if conn and not KEY:
            parts = {}
            for chunk in conn.rstrip(";").split(";"):
                if "=" in chunk:
                    k, v = chunk.split("=", 1)
                    parts[k.strip()] = v.strip()
            KEY = parts.get("AccountKey") or KEY
            ENDPOINT = parts.get("AccountEndpoint") or ENDPOINT
            DATABASE_ID = (data.get("cosmosdb-connection") or {}).get("database") or DATABASE_ID
        if KEY:
            return


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_all(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def strip_cosmos_meta(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if not str(k).startswith("_")}


PROFILE_CORE_KEYS = {
    "id",
    "siteId",
    "schemaVersion",
    "source",
    "createdAt",
    "updatedAt",
    "institution_name",
    "site_type",
    "address_street",
    "address_city",
    "address_state",
    "address_zip",
    "address_country",
    "phone",
    "fax",
    "multi_site",
    "satellite_locations",
    "office_hours",
    "smo_affiliation",
    "smo_staffing_model",
    "investigators",
    "contacts",
    "irb_type",
    "central_irb_name",
    "irb_meeting_frequency",
    "irb_submission_lead_days",
    "avg_irb_approval_days",
    "additional_committees_required",
    "additional_committee_details",
    "contract_parallel_with_irb",
    "contract_required_before_irb",
    "gcp_compliant",
    "fda_audit_history",
    "fda_483_issued",
    "fda_audit_year",
    "ibc_registered",
    "ibc_provider",
    "equipment_list",
    "etdrs_certified_lanes",
    "etdrs_light_box",
    "etdrs_charts",
    "certified_va_examiners",
    "certified_oct_photographers",
    "exam_rooms_available",
    "qcsf_capability",
    "cae_experience",
    "cae_space_available",
    "block_enrollment_capable",
    "certifications",
    "on_site_pharmacy",
    "aseptic_prep_area",
    "drug_refrigerator_2_8c",
    "freezer_minus_20c",
    "freezer_minus_80c",
    "room_temp_locked_storage",
    "temp_monitoring_24_7",
    "temp_monitoring_alarmed",
    "backup_generator",
    "clia_waiver",
    "clia_cert_number",
    "clia_expiration",
    "compounding_pharmacy_relationship",
    "dry_ice_access",
    "phlebotomist_on_staff",
    "centrifuge_available",
    "centrifuge_make_model",
    "refrigerated_centrifuge",
    "iata_certified_staff",
    "pk_sampling_experience",
    "specimen_processing_capability",
    "study_coordinators_count",
    "coordinators_full_time",
    "coordinator_experience_years",
    "imaging_techs_count",
    "dedicated_regulatory_staff",
    "dedicated_data_entry",
    "cpr_certified_staff",
    "vitreoretinal_surgeon_access",
    "avg_contract_negotiation_weeks",
    "avg_budget_turnaround_weeks",
    "estimated_total_startup_weeks",
    "electronic_signatures_accepted",
    "icf_translation_languages",
    "separate_budget_office",
    "source_records_type",
    "emr_system",
    "edc_systems_used",
    "remote_monitoring_capable",
    "guest_wifi_for_monitors",
    "years_of_research",
    "total_trials_conducted",
    "phase_experience",
    "gene_therapy_experience",
    "gene_therapy_trial_count",
    "indication",
    "indicationsCovered",
    "therapeuticAreas",
    "study_responses",
}


def map_profile(doc: dict, legacy: dict | None, exported_at: str) -> dict:
    raw = strip_cosmos_meta(doc)
    site_id = raw.get("siteId") or raw.get("id")
    out = {k: raw[k] for k in PROFILE_CORE_KEYS if k in raw and raw[k] not in (None, "", [])}
    out["id"] = site_id
    out["siteId"] = site_id
    out["docType"] = "feasibilitySiteProfile"
    out["dataset"] = DATASET
    out["schemaVersion"] = SCHEMA_VERSION
    out["source"] = SOURCE
    out["artemisProfileId"] = site_id
    out["exportedAt"] = exported_at
    if legacy:
        out["siteName"] = legacy.get("name") or out.get("institution_name")
        out["siteCode"] = legacy.get("siteCode")
        out["relationshipPreference"] = legacy.get("relationshipPreference")
        out["advantages"] = legacy.get("advantages")
        out["disadvantages"] = legacy.get("disadvantages")
        out["relationshipNotes"] = legacy.get("relationshipNotes")
        out["linkedArtemisSiteId"] = legacy.get("linkedArtemisSiteId")
        out["legacyMetrics"] = legacy.get("metrics") or {}
        inds = sorted(
            set(out.get("indicationsCovered") or [])
            | set(legacy.get("indicationsCovered") or [])
            | set(legacy.get("therapeuticAreas") or [])
        )
        if inds:
            out["indicationsCovered"] = inds
            out["therapeuticAreas"] = inds
        if not out.get("institution_name") and legacy.get("name"):
            out["institution_name"] = legacy["name"]
        if not out.get("address_city") and legacy.get("city"):
            out["address_city"] = legacy.get("city")
            out["address_state"] = legacy.get("state")
            out["address_zip"] = legacy.get("zip")
            out["address_street"] = legacy.get("address1")
    return out


def slim_answers(answers: list, slim: bool) -> list:
    if not slim:
        return answers or []
    out = []
    for a in answers or []:
        if not a:
            continue
        val = a.get("value")
        if a.get("skipped") and (val is None or str(val).strip() == ""):
            continue
        if val is None or str(val).strip() == "":
            continue
        out.append(
            {
                "questionId": a.get("questionId"),
                "label": a.get("label"),
                "type": a.get("type") or "text",
                "value": val,
            }
        )
    return out


def map_response(doc: dict, exported_at: str, slim: bool) -> dict:
    raw = strip_cosmos_meta(doc)
    site_id = raw.get("siteId")
    survey_id = raw.get("surveyId")
    ind = raw.get("indication") or raw.get("therapeuticArea")
    study = raw.get("study") if isinstance(raw.get("study"), dict) else {}
    return {
        "id": raw.get("id"),
        "docType": "feasibilitySurveyResponse",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "siteId": site_id,
        "surveyId": survey_id,
        "assignmentId": raw.get("assignmentId"),
        "targetRole": raw.get("targetRole"),
        "displayName": raw.get("displayName"),
        "indication": ind,
        "therapeuticArea": ind,
        "study": {
            "study_name": study.get("study_name") or study.get("name"),
            "indication": study.get("indication") or ind,
            "sponsor": study.get("sponsor"),
        }
        if study or ind
        else None,
        "sourcePlatform": raw.get("sourcePlatform") or raw.get("platform"),
        "sourceTab": raw.get("sourceTab"),
        "submittedAt": raw.get("submittedAt") or raw.get("createdAt"),
        "answerCount": len(slim_answers(raw.get("answers") or [], False)),
        "answers": slim_answers(raw.get("answers") or [], slim),
        "score": raw.get("score"),
        "artemisResponseId": raw.get("id"),
        "exportedAt": exported_at,
    }


def map_definition(doc: dict, exported_at: str, response_count: int, site_count: int) -> dict:
    raw = strip_cosmos_meta(doc)
    questions = raw.get("questions") or []
    ind = raw.get("indication") or raw.get("therapeuticArea")
    return {
        "id": raw.get("id"),
        "docType": "feasibilitySurveyDefinition",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "title": raw.get("title") or raw.get("id"),
        "indication": ind,
        "therapeuticArea": ind,
        "platform": raw.get("platform") or raw.get("sourcePlatform") or raw.get("source"),
        "sourceTab": raw.get("sourceTab"),
        "questionCount": len(questions),
        "questions": [
            {
                "id": q.get("id") or q.get("questionId"),
                "label": q.get("label") or q.get("text") or q.get("title"),
                "type": q.get("type") or "text",
                "required": bool(q.get("required")),
            }
            for q in questions
            if q
        ],
        "responseCount": response_count,
        "siteCount": site_count,
        "artemisDefinitionId": raw.get("id"),
        "exportedAt": exported_at,
    }


def map_legacy_site(doc: dict, exported_at: str, profile_id: str | None, survey_ids: list[str]) -> dict:
    raw = strip_cosmos_meta(doc)
    site_id = raw.get("id")
    inds = sorted(set(raw.get("indicationsCovered") or []) | set(raw.get("therapeuticAreas") or []))
    return {
        "id": site_id,
        "docType": "feasibilityLegacySite",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "siteId": site_id,
        "siteName": raw.get("name"),
        "siteCode": raw.get("siteCode"),
        "pi": raw.get("pi"),
        "city": raw.get("city"),
        "state": raw.get("state"),
        "zip": raw.get("zip"),
        "address1": raw.get("address1"),
        "indicationsCovered": inds,
        "therapeuticAreas": inds,
        "relationshipPreference": raw.get("relationshipPreference"),
        "advantages": raw.get("advantages"),
        "disadvantages": raw.get("disadvantages"),
        "relationshipNotes": raw.get("relationshipNotes"),
        "notes": raw.get("notes"),
        "linkedArtemisSiteId": raw.get("linkedArtemisSiteId"),
        "metrics": raw.get("metrics") or {},
        "feasibilitySurveyCount": raw.get("feasibilitySurveyCount") or len(survey_ids),
        "profileId": profile_id or site_id,
        "surveyIds": sorted(survey_ids),
        "artemisLegacySiteId": site_id,
        "exportedAt": exported_at,
    }


def build_indication_index(profiles: list[dict], responses: list[dict], defs: list[dict]) -> dict:
    by_ind: dict[str, dict] = {}

    def bucket(ind: str) -> dict:
        key = (ind or "").strip()
        if not key:
            return {}
        if key not in by_ind:
            by_ind[key] = {
                "indication": key,
                "therapeuticArea": key,  # TA = Indication in this dataset
                "siteIds": set(),
                "surveyIds": set(),
                "profileCount": 0,
                "responseCount": 0,
            }
        return by_ind[key]

    for p in profiles:
        for ind in p.get("indicationsCovered") or []:
            b = bucket(ind)
            if not b:
                continue
            b["siteIds"].add(p["siteId"])
            b["profileCount"] += 1
        # nested indication layer keys
        for ind in (p.get("indication") or {}).keys():
            b = bucket(ind)
            if b:
                b["siteIds"].add(p["siteId"])

    for r in responses:
        ind = r.get("indication") or r.get("therapeuticArea")
        b = bucket(ind or "")
        if not b:
            continue
        if r.get("siteId"):
            b["siteIds"].add(r["siteId"])
        if r.get("surveyId"):
            b["surveyIds"].add(r["surveyId"])
        b["responseCount"] += 1

    for d in defs:
        ind = d.get("indication") or d.get("therapeuticArea")
        b = bucket(ind or "")
        if b and d.get("id"):
            b["surveyIds"].add(d["id"])

    out = []
    for ind, b in sorted(by_ind.items(), key=lambda x: (-len(x[1]["siteIds"]), x[0].lower())):
        out.append(
            {
                "indication": b["indication"],
                "therapeuticArea": b["therapeuticArea"],
                "siteCount": len(b["siteIds"]),
                "surveyCount": len(b["surveyIds"]),
                "profileHits": b["profileCount"],
                "responseCount": b["responseCount"],
                "siteIds": sorted(b["siteIds"]),
                "surveyIds": sorted(b["surveyIds"]),
            }
        )
    return {"byIndication": out, "indicationCount": len(out)}


def main():
    ap = argparse.ArgumentParser(description="Export ARTEMIS feasibility pack for Budget Buddy")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="Output JSON path")
    ap.add_argument("--slim-answers", action="store_true", help="Omit empty/skipped answers")
    ap.add_argument(
        "--split-responses",
        action="store_true",
        help="Write responses to sibling .responses.ndjson (pack references the file)",
    )
    args = ap.parse_args()

    load_key()
    if not KEY:
        raise SystemExit("COSMOS_KEY missing — set env or data-api-connections.json")

    client = CosmosClient(ENDPOINT, credential=KEY)
    db = client.get_database_client(DATABASE_ID)
    print(f"Reading {ENDPOINT} / {DATABASE_ID} ...")

    profiles_raw = fetch_all(db.get_container_client("site-profiles"))
    defs_raw = fetch_all(db.get_container_client("site-survey-definitions"))
    responses_raw = [
        r
        for r in fetch_all(db.get_container_client("site-survey-responses"))
        if r and not r.get("_archived")
    ]
    legacy_raw = fetch_all(db.get_container_client("legacy-sites"))
    print(
        f"Fetched profiles={len(profiles_raw)} defs={len(defs_raw)} "
        f"responses={len(responses_raw)} legacy-sites={len(legacy_raw)}"
    )

    exported_at = iso_now()
    legacy_by_id = {d["id"]: d for d in legacy_raw if d.get("id")}
    responses_by_survey: dict[str, list] = {}
    surveys_by_site: dict[str, set] = {}
    for r in responses_raw:
        sid = r.get("surveyId")
        site = r.get("siteId")
        if sid:
            responses_by_survey.setdefault(sid, []).append(r)
        if site and sid:
            surveys_by_site.setdefault(site, set()).add(sid)

    profiles = [
        map_profile(p, legacy_by_id.get(p.get("id") or p.get("siteId")), exported_at)
        for p in profiles_raw
        if p.get("id") or p.get("siteId")
    ]
    # Include legacy sites that have no profile yet (still useful for Buddy trust)
    profile_ids = {p["siteId"] for p in profiles}
    for lid, leg in legacy_by_id.items():
        if lid in profile_ids:
            continue
        # stub profile from legacy only if site has feasibility tags or surveys
        if not (leg.get("indicationsCovered") or surveys_by_site.get(lid)):
            continue
        profiles.append(map_profile({"id": lid, "siteId": lid}, leg, exported_at))

    responses = [map_response(r, exported_at, args.slim_answers) for r in responses_raw]
    definitions = [
        map_definition(
            d,
            exported_at,
            response_count=len(responses_by_survey.get(d.get("id"), [])),
            site_count=len({r.get("siteId") for r in responses_by_survey.get(d.get("id"), []) if r.get("siteId")}),
        )
        for d in defs_raw
        if d.get("id")
    ]

    # Orphan survey ids present only on responses
    known_defs = {d["id"] for d in definitions}
    for survey_id, rows in responses_by_survey.items():
        if survey_id in known_defs:
            continue
        sample = rows[0]
        study = sample.get("study") if isinstance(sample.get("study"), dict) else {}
        ind = sample.get("indication") or sample.get("therapeuticArea") or study.get("indication")
        definitions.append(
            {
                "id": survey_id,
                "docType": "feasibilitySurveyDefinition",
                "dataset": DATASET,
                "schemaVersion": SCHEMA_VERSION,
                "source": SOURCE,
                "title": study.get("study_name") or sample.get("sourceTab") or survey_id,
                "indication": ind,
                "therapeuticArea": ind,
                "platform": sample.get("sourcePlatform"),
                "sourceTab": sample.get("sourceTab"),
                "questionCount": 0,
                "questions": [],
                "responseCount": len(rows),
                "siteCount": len({r.get("siteId") for r in rows if r.get("siteId")}),
                "artemisDefinitionId": survey_id,
                "exportedAt": exported_at,
                "orphan": True,
            }
        )

    sites = [
        map_legacy_site(
            leg,
            exported_at,
            profile_id=leg["id"] if leg["id"] in profile_ids or leg["id"] in surveys_by_site else None,
            survey_ids=list(surveys_by_site.get(leg["id"], [])),
        )
        for leg in legacy_raw
        if leg.get("id") and (leg["id"] in profile_ids or leg["id"] in surveys_by_site or leg.get("indicationsCovered"))
    ]

    indication_index = build_indication_index(profiles, responses, definitions)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    responses_ref = None
    pack_responses = responses
    if args.split_responses:
        ndjson_path = out_path.with_suffix(".responses.ndjson")
        with ndjson_path.open("w", encoding="utf-8") as f:
            for r in responses:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        responses_ref = {
            "format": "ndjson",
            "path": ndjson_path.name,
            "count": len(responses),
        }
        pack_responses = []  # referenced externally
        print(f"Wrote {ndjson_path} ({len(responses)} responses)")

    pack = {
        "packType": "budget_buddy_feasibility",
        "dataset": DATASET,
        "schemaVersion": SCHEMA_VERSION,
        "source": SOURCE,
        "sourceAccount": "ora-clinical-recruiting",
        "sourceDatabase": DATABASE_ID,
        "exportedAt": exported_at,
        "notes": [
            "ARTEMIS-only feasibility master. siteId values are legacy-site ids (not Chaos shared sites).",
            "TA = Indication in this dataset.",
            "Profiles follow Site_Profile_Field_Schema (profile layer + indication map + study_responses).",
            "Existing bd-budgets budget tables must not be overwritten — use NEW containers only.",
        ],
        "counts": {
            "profiles": len(profiles),
            "sites": len(sites),
            "surveyDefinitions": len(definitions),
            "surveyResponses": len(responses),
            "indications": indication_index["indicationCount"],
        },
        "indicationIndex": indication_index,
        "sites": sites,
        "profiles": profiles,
        "surveyDefinitions": definitions,
        "surveyResponses": pack_responses,
        "surveyResponsesFile": responses_ref,
    }

    out_path.write_text(json.dumps(pack, indent=2, ensure_ascii=False), encoding="utf-8")
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(json.dumps(pack["counts"], indent=2))
    print(f"Wrote {out_path} ({size_mb:.1f} MB)")
    print("Top indications:")
    for row in indication_index["byIndication"][:12]:
        print(f"  {row['indication']}: sites={row['siteCount']} responses={row['responseCount']} surveys={row['surveyCount']}")


if __name__ == "__main__":
    main()
