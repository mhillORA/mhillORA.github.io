"""
Authoritative Mike → Mighty field map.

Mike's Question_Harmonization_Mapping + ReBUILD_39 pack paths are treated as
ground truth. Each pack path maps to a Mike canonical_id and (when present) a
Mighty survey libraryQuestionId.

Usage:
  python ingest/build_mike_mighty_map.py
"""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
MAPPING = REPO / "ingest" / "data" / "Question_Harmonization_Mapping.json"
MAP_OUT = REPO / "ingest" / "data" / "mike_mighty_field_map.json"
LIKELIHOOD_OUT = REPO / "ingest" / "data" / "rebuild_priority_likelihood.json"
LIKELIHOOD_WEB = REPO / "rebuild_priority_likelihood.json"
CSV_OUT = REPO / ".firecrawl" / "rebuild-priority-likelihood.csv"
REPORT_OUT = REPO / ".firecrawl" / "mike-mighty-map-report.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"

# pack_path → (canonical_id, preferred libraryQuestionId or None)
# Canonical IDs follow Mike's Question_Harmonization_Mapping.json exactly.
PACK_TO_CANONICAL = {
    # Contact
    "contact_info.institution_name": ("PROF-001", "ql-site-name"),
    "contact_info.address": ("PROF-002", "ql-site-address"),
    "contact_info.site_phone": ("PROF-003", None),
    "contact_info.site_fax": ("PROF-004", None),
    "contact_info.investigator_name": ("PROF-005", "ql-pi-name"),
    "contact_info.investigator_email": ("PROF-006", "ql-pi-email"),
    "contact_info.investigator_phone": ("PROF-007", "ql-pi-phone"),
    "contact_info.preferred_contact_name": ("PROF-008", "ql-coord-name"),
    "contact_info.preferred_contact_email": ("PROF-009", "ql-coord-email"),
    "contact_info.preferred_contact_phone": ("PROF-010", "ql-coord-phone"),
    "contact_info.preferred_contact_role": ("PROF-011", None),
    "contact_info.contract_budget_contact": ("PROF-012", "ql-contracts-name"),
    # Site info
    "site_info.practice_type": ("PROF-013", "ql-gf-05-practice-setting"),
    "site_info.satellite_offices": ("PROF-014", "ql-rebuild-018-does-your-site-have-satellite-offices-or-other-locat"),
    "site_info.office_hours": ("PROF-015", None),
    # Staffing
    "staffing.dedicated_staff": ("PROF-020", "ql-rebuild-025-do-you-have-dedicated-staff-to-conduct-this-study"),
    "staffing.study_coordinators": ("PROF-021", None),
    "staffing.sub_investigators": ("PROF-022", "ql-rebuild-027-how-many-sub-investigators-do-you-plan-to-have-invol"),
    "staffing.board_certified_retinal": ("PROF-023", "ql-rebuild-036-are-you-or-any-of-your-sub-investigators-board-certi"),
    "staffing.certified_photographers": ("PROF-024", "ql-rebuild-029-how-many-certified-photographers-do-you-plan-to-have"),
    "staffing.certified_bcva_examiners": ("PROF-025", "ql-rebuild-032-how-many-certified-bcva-examiners-do-you-plan-to-hav"),
    "staffing.pharmacist": ("PROF-026", None),
    # Equipment
    "equipment.sd_oct": ("PROF-030", "ql-rebuild-041-do-you-have-the-capability-to-perform-spectral-domai"),
    "equipment.color_fundus_photography": ("PROF-031", "ql-rebuild-043-do-you-have-color-fundus-photography-cfp-imaging-cap"),
    "equipment.fundus_autofluorescence": ("PROF-032", "ql-rebuild-045-do-you-have-fundus-autofluorescence-faf-imaging-capa"),
    "equipment.fluorescein_angiography": ("PROF-033", "ql-rebuild-047-do-you-have-fluorescein-angiography-fa-imaging-capab"),
    "equipment.etdrs_lightbox": ("PROF-034", "ql-rebuild-041-do-you-have-an-etdrs-lightbox"),
    "equipment.dedicated_bcva_lane": ("PROF-035", "ql-rebuild-043-do-you-have-a-dedicated-4-meter-lane-room-area-to-pe"),
    "equipment.trial_lens_set": ("PROF-036", None),
    "equipment.qcsf": ("PROF-037", "ql-rebuild-044-do-you-have-room-for-a-quantitative-contrast-sensiti"),
    "equipment.slit_lamp": ("PROF-038", "ql-rebuild-046-do-you-have-the-equipment-necessary-to-perform-biomi"),
    "equipment.tonometer": ("PROF-039", None),
    "equipment.microperimetry": ("PROF-040", None),
    "equipment.calibration_schedule": ("PROF-041", "ql-rebuild-055-does-your-site-maintain-a-regular-calibration-schedu"),
    "equipment.ecg": ("PROF-042", None),
    "equipment.corneal_fluorescein_strips": ("PROF-043", "ql-rebuild-045-do-you-have-corneal-fluorescein-staining-strips"),
    # Reading centers
    "reading_center.clario": ("PROF-050", "ql-rebuild-030-has-your-site-staff-equipment-ever-been-certified-by"),
    "reading_center.ast": ("PROF-051", "ql-rebuild-031-has-your-site-staff-equipment-ever-been-certified-by"),
    "reading_center.oirrc": ("PROF-052", "ql-gsf_087_please-indicate-the-central-imaging-reading-cent"),
    "reading_center.merit": ("PROF-053", "ql-gsf_087_please-indicate-the-central-imaging-reading-cent"),
    "reading_center.duke_dirc": ("PROF-054", "ql-gsf_087_please-indicate-the-central-imaging-reading-cent"),
    "reading_center.other_reading_center": ("PROF-055", "ql-rebuild-109-if-other-please-specify"),
    # Source / records
    "source_records.source_records_type": ("PROF-060", "ql-gsf_060_how-will-the-monitor-review-source-data-at-your-"),
    "source_records.electronic_source_system": ("PROF-061", "ql-rebuild-059-if-electronic-source-which-system"),
    "source_records.cra_remote_access": ("PROF-062", "ql-rebuild-051-will-cra-have-remote-access-to-the-electronic-source"),
    "source_records.secure_storage": ("PROF-063", "ql-rebuild-075-secure-space-to-store-clinical-study-files-and-subje"),
    # Pharmacy / lab / emergency
    "pharmacy_lab.drug_refrigerator": ("PROF-070", "ql-rebuild-065-2-8-c-secured-refrigerator-with-continuous-temperatu"),
    "pharmacy_lab.freezer_minus20": ("PROF-071", "ql-rebuild-069-20-c-freezer-with-continuous-temperature-monitoring-"),
    "pharmacy_lab.freezer_minus80": ("PROF-072", None),
    "pharmacy_lab.temp_monitoring": ("PROF-073", "ql-rebuild-065-2-8-c-secured-refrigerator-with-continuous-temperatu"),
    "pharmacy_lab.backup_generator": ("PROF-074", "ql-gsf_073_does-your-site-have-a-backup-plan-for-power-outa"),
    "pharmacy_lab.clia_waiver": ("PROF-075", "ql-rebuild-074-ability-to-collect-process-and-ship-package-and-labe"),
    "pharmacy_lab.blood_draw": ("PROF-076", "ql-rebuild-067-are-you-able-to-conduct-on-site-blood-draws"),
    "pharmacy_lab.centrifuge": ("PROF-077", "ql-rebuild-073-centrifuge"),
    "pharmacy_lab.sample_processing": ("PROF-078", "ql-rebuild-074-ability-to-collect-process-and-ship-package-and-labe"),
    "pharmacy_lab.room_temp_storage": ("PROF-070", "ql-rebuild-066-secured-temperature-controlled-storage-room-for-anci"),
    "pharmacy_lab.ip_distance": ("PROF-07E", "ql-rebuild-062-if-pharmacy-is-independent-to-your-site-please-provi"),
    "pharmacy_lab.emergency_procedures": ("PROF-07D", None),
    # IRB
    "irb.irb_type": ("PROF-080", "ql-gf-29-central-irb"),
    "irb.irb_meeting_frequency": ("PROF-081", "ql-rebuild-063-if-local-irb-ec-how-often-does-the-irb-meet"),
    "irb.submission_lead_time": ("PROF-082", "ql-rebuild-064-if-local-irb-ec-what-is-the-lead-time-for-preparing-"),
    "irb.additional_committees": ("PROF-083", "ql-rebuild-094-are-there-other-committees-at-your-site-that-require"),
    "irb.irb_contract_parallel": ("PROF-084", "ql-rebuild-074-can-irb-ec-submission-and-contract-budget-negotiatio"),
    "irb.translations_required": ("PROF-085", "ql-gf-24-translations"),
    "irb.rate_limiting": ("PROF-086", "ql-rebuild-072-are-there-any-requirements-after-irb-ec-approval-tha"),
    "irb.approval_turnaround": ("PROF-082", "ql-rebuild-067-how-long-does-it-take-to-receive-the-approval-docume"),
    "irb.cta_with_irb": ("PROF-083", "ql-rebuild-095-if-local-irb-ec-does-the-clinical-trial-agreement-ne"),
    # Contracts
    "contract_budget.cta_execution_time": ("PROF-090", "ql-rebuild-080-on-average-how-long-will-it-take-to-execute-the-clin"),
    "contract_budget.contracting_parties": ("PROF-091", "ql-rebuild-101-who-will-be-contracting-parties-to-the-clinical-tria"),
    "contract_budget.electronic_signatures": ("PROF-092", "ql-rebuild-081-do-you-accept-electronic-signatures-of-the-clinical-"),
    "contract_budget.separate_contract_office": ("PROF-093", "ql-rebuild-077-do-you-have-a-separate-contract-and-or-budget-office"),
    # Vendors
    "vendor_experience.edc_systems": ("PROF-095", "ql-gsf_065_please-select-which-of-the-following-edc-systems"),
    "vendor_experience.edc_experience": ("PROF-095", "ql-gsf_065_please-select-which-of-the-following-edc-systems"),
    "vendor_experience.irt_experience": ("PROF-096", "ql-rebuild-106-please-select-which-of-the-following-irt-rtsm-system"),
    "vendor_experience.reading_center_experience": ("PROF-097", "ql-gsf_087_please-indicate-the-central-imaging-reading-cent"),
    # Indication / volume (IND-*)
    "patient_volume.ga_patients_managed": ("IND-001", "ql-rebuild-077-how-many-patients-over-55-years-old-with-at-least-on"),
    "patient_volume.ga_database_size": ("IND-002", "ql-rebuild-077-how-many-patients-over-55-years-old-with-at-least-on"),
    "patient_volume.ga_lesion_eligible": ("IND-003", "ql-rebuild-078-what-percentage-of-these-patients-have-extrafoveal-g"),
    "patient_volume.bcva_eligible": ("IND-004", None),
    "patient_volume.no_cnv": ("IND-005", None),
    "patient_volume.patient_proximity": ("IND-006", None),
    "patient_volume.ga_patients_monthly": ("IND-001", "ql-rebuild-080-based-on-the-numbers-above-and-the-protocol-synopsis"),
    "patient_volume.newly_diagnosed": ("IND-002", "ql-rebuild-054-how-many-newly-referred-or-newly-diagnosed-with-dry-"),
    # Recruitment
    "recruitment_methods.patient_id_methods": ("IND-007", "ql-rebuild-085-what-method-s-are-you-planning-to-use-to-identify-pa"),
    "recruitment_methods.advertising": ("IND-008", "ql-rebuild-085-what-method-s-are-you-planning-to-use-to-identify-pa"),
    "recruitment_methods.transportation_assistance": ("IND-009", None),
    "recruitment_methods.pre_screen_willingness": ("STUDY-002", "ql-rebuild-060-is-your-site-willing-to-pre-screen-potential-suitabl"),
}



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


def flatten_answers(obj, prefix=""):
    if isinstance(obj, dict):
        if "value" in obj or "pre_populate" in obj:
            yield prefix, obj.get("value"), bool(obj.get("pre_populate")), obj.get("source_study")
            return
        for k, v in obj.items():
            yield from flatten_answers(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from flatten_answers(v, f"{prefix}[{i}]")


def is_filled(val) -> bool:
    if val is None:
        return False
    s = str(val).strip()
    return s not in ("", "null", "None", "none", "n/a", "N/A", "-")


def main():
    mapping = json.loads(MAPPING.read_text(encoding="utf-8"))
    canon = mapping.get("canonical_fields") or {}
    pack = json.loads(PACK.read_text(encoding="utf-8"))

    survey = cosmos_db().get_container_client("site-survey-definitions").read_item(
        SURVEY_ID, SURVEY_ID
    )
    mighty_by_lib = {}
    for q in survey.get("questions") or []:
        lib = q.get("libraryQuestionId")
        if lib and lib not in mighty_by_lib:
            mighty_by_lib[lib] = q

    # Discover all pack paths from data
    all_paths = set()
    for site in pack.get("sites") or []:
        for sec in ("section_1_site_profile", "section_2_indication_history"):
            for path, *_ in flatten_answers(site.get(sec) or {}):
                all_paths.add(path)

    fields = []
    mapped_paths = 0
    with_lib = 0
    missing_from_map = sorted(all_paths - set(PACK_TO_CANONICAL))
    extra_in_map = sorted(set(PACK_TO_CANONICAL) - all_paths)

    for path in sorted(all_paths):
        entry = PACK_TO_CANONICAL.get(path)
        if not entry:
            fields.append(
                {
                    "packPath": path,
                    "canonicalId": None,
                    "mikeLabel": None,
                    "libraryQuestionId": None,
                    "mightyQuestionId": None,
                    "mightyLabel": None,
                    "mapped": False,
                }
            )
            continue
        cid, lib = entry
        meta = canon.get(cid) or {}
        mq = mighty_by_lib.get(lib) if lib else None
        # If preferred lib missing on survey, try leave null (still mapped to Mike)
        mapped_paths += 1
        if lib and mq:
            with_lib += 1
        elif lib and not mq:
            # preferred id not on this survey — still keep Mike link
            pass
        fields.append(
            {
                "packPath": path,
                "canonicalId": cid,
                "mikeLabel": meta.get("label"),
                "formField": meta.get("form_field"),
                "layer": meta.get("layer"),
                "category": meta.get("category"),
                "libraryQuestionId": lib,
                "mightyQuestionId": (mq or {}).get("id"),
                "mightyLabel": (mq or {}).get("label"),
                "mapped": True,
                "libOnSurvey": bool(mq),
            }
        )

    map_doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourcePack": PACK.name,
        "sourceMapping": "Question_Harmonization_Mapping.json",
        "surveyId": SURVEY_ID,
        "policy": "Mike files are ground truth. Pack paths map to canonical_id; libraryQuestionId links Mighty/AF when available.",
        "packPathCount": len(all_paths),
        "mappedPackPaths": mapped_paths,
        "mappedPct": round(100.0 * mapped_paths / len(all_paths), 1) if all_paths else 0,
        "withLibraryOnSurvey": with_lib,
        "missingFromMap": missing_from_map,
        "extraInMap": extra_in_map,
        "fields": fields,
        "packPathToCanonical": {p: v[0] for p, v in PACK_TO_CANONICAL.items()},
        "packPathToLibrary": {p: v[1] for p, v in PACK_TO_CANONICAL.items() if v[1]},
    }
    MAP_OUT.parent.mkdir(parents=True, exist_ok=True)
    MAP_OUT.write_text(json.dumps(map_doc, indent=2), encoding="utf-8")

    # Score each of Mike's 39 sites using HIS answers on mapped fields
    site_rows = []
    for s in pack.get("sites") or []:
        answers = {}
        for sec in ("section_1_site_profile", "section_2_indication_history"):
            for path, val, pre, src in flatten_answers(s.get(sec) or {}):
                answers[path] = {"value": val, "pre_populate": pre, "source_study": src}

        filled = 0
        total = len(all_paths)
        filled_mapped = 0
        mapped_total = mapped_paths
        sample = []
        for path in all_paths:
            row = answers.get(path) or {}
            ok = is_filled(row.get("value"))
            if ok:
                filled += 1
            if path in PACK_TO_CANONICAL:
                if ok:
                    filled_mapped += 1
                    if len(sample) < 6:
                        cid, lib = PACK_TO_CANONICAL[path]
                        sample.append(
                            {
                                "packPath": path,
                                "canonicalId": cid,
                                "libraryQuestionId": lib,
                                "value": str(row.get("value"))[:100],
                            }
                        )

        site_rows.append(
            {
                "priorityId": s.get("site_id"),
                "practiceName": s.get("practice_name") or "",
                "piName": s.get("pi_name") or "",
                "location": s.get("location") or "",
                "nameKey": norm_name(s.get("practice_name") or ""),
                "piKey": norm_name(s.get("pi_name") or ""),
                "hasGaData": bool(s.get("has_ga_data")),
                "totalSurveys": s.get("total_surveys") or 0,
                "indications": s.get("indications_covered") or [],
                "filledFields": filled,
                "totalFields": total,
                "likelihoodPct": round(100.0 * filled / total, 1) if total else 0,
                "filledMappedFields": filled_mapped,
                "mappedFieldCount": mapped_total,
                "mappedLikelihoodPct": (
                    round(100.0 * filled_mapped / mapped_total, 1) if mapped_total else 0
                ),
                "sampleAnswers": sample,
            }
        )

    site_rows.sort(key=lambda x: (-x["mappedLikelihoodPct"], -x["likelihoodPct"], x["practiceName"]))

    likelihood = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": PACK.name,
        "policy": "Mike pack answers are ground truth for prior likelihood",
        "surveyId": SURVEY_ID,
        "fieldMap": str(MAP_OUT.relative_to(REPO)).replace("\\", "/"),
        "siteCount": len(site_rows),
        "packPathCount": len(all_paths),
        "mappedPackPaths": mapped_paths,
        "mappedPct": map_doc["mappedPct"],
        "avgLikelihoodPct": round(
            sum(x["likelihoodPct"] for x in site_rows) / len(site_rows), 1
        )
        if site_rows
        else 0,
        "avgMappedLikelihoodPct": round(
            sum(x["mappedLikelihoodPct"] for x in site_rows) / len(site_rows), 1
        )
        if site_rows
        else 0,
        "sites": site_rows,
    }
    LIKELIHOOD_OUT.write_text(json.dumps(likelihood, indent=2), encoding="utf-8")
    LIKELIHOOD_WEB.write_text(json.dumps(likelihood, indent=2), encoding="utf-8")

    with CSV_OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "mappedLikelihoodPct",
                "likelihoodPct",
                "filledMappedFields",
                "mappedFieldCount",
                "filledFields",
                "totalFields",
                "practiceName",
                "piName",
                "location",
                "hasGaData",
                "priorityId",
            ],
        )
        w.writeheader()
        for x in site_rows:
            w.writerow({k: x.get(k) for k in w.fieldnames})

    report = {
        "mapSummary": {
            "packPaths": len(all_paths),
            "mapped": mapped_paths,
            "mappedPct": map_doc["mappedPct"],
            "withLibraryOnSurvey": with_lib,
            "missingFromMap": missing_from_map,
            "extraInMap": extra_in_map,
        },
        "likelihoodSummary": {
            "sites": len(site_rows),
            "avgLikelihoodPct": likelihood["avgLikelihoodPct"],
            "avgMappedLikelihoodPct": likelihood["avgMappedLikelihoodPct"],
            "top": [
                {
                    "practiceName": x["practiceName"],
                    "mappedLikelihoodPct": x["mappedLikelihoodPct"],
                    "likelihoodPct": x["likelihoodPct"],
                    "priorityId": x["priorityId"],
                }
                for x in site_rows[:12]
            ],
        },
    }
    REPORT_OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(
        f"Mike pack paths mapped: {mapped_paths}/{len(all_paths)} ({map_doc['mappedPct']}%)  "
        f"with Mighty lib on survey: {with_lib}"
    )
    if missing_from_map:
        print(f"UNMAPPED paths ({len(missing_from_map)}): {missing_from_map}")
    print(
        f"39-site avg fill: {likelihood['avgLikelihoodPct']}%  "
        f"avg on mapped fields: {likelihood['avgMappedLikelihoodPct']}%"
    )
    for x in site_rows[:8]:
        print(
            f"  map {x['mappedLikelihoodPct']:5.1f}%  all {x['likelihoodPct']:5.1f}%  "
            f"{x['practiceName']} ({x['piName']})"
        )
    print(f"Wrote {MAP_OUT}")
    print(f"Wrote {LIKELIHOOD_OUT}")
    print(f"Wrote {CSV_OUT}")


if __name__ == "__main__":
    main()
