"""
Ingest ReBUILD / MYTX272AM-201 Feasibility Questionnaire into the question library.

- Match to existing library items when the same concept already exists (explicit aliases
  + high-confidence fuzzy label match).
- Create new library questions only when no match.
- Upsert survey definition `survey-rebuild-mytx272am-201` using those library ids.

Usage:
  python ingest/sync_rebuild_from_docx.py
  python ingest/sync_rebuild_from_docx.py --apply
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
DEFAULT_DOCX = Path(
    r"c:\Users\shue1\Downloads\ReBUILD Feasibility Questionnaire_v0.1_10Sep2026_Draft.docx"
)
SURVEY_ID = "survey-rebuild-mytx272am-201"
SOURCE = "rebuild-sfq-v0.1-10sep2026"

# Explicit concept matches → existing library ids (do not invent duplicates)
ALIASES = {
    "investigator name": "ql-pi-name",
    "investigator first and last name": "ql-pi-name",
    "investigator email": "ql-pi-email",
    "investigator email address": "ql-pi-email",
    "investigator phone": "ql-pi-phone",
    "investigator phone number": "ql-pi-phone",
    "institution name": "ql-site-name",
    "site name": "ql-site-name",
    "site legal name": "ql-site-name",
    "address": "ql-site-address",
    "street address": "ql-site-address",
    "what is your site s street address": "ql-site-address",
    "preferred site contact name": "ql-coord-name",
    "primary research point of contact first and last name": "ql-coord-name",
    "preferred site contact email": "ql-coord-email",
    "primary research contact email": "ql-coord-email",
    "preferred site contact phone": "ql-coord-phone",
    "contract budget name": "ql-contracts-name",
    "contracting budgeting contact first and last name": "ql-contracts-name",
    "contract budget email": "ql-contracts-email",
    "contracting budgeting contact email": "ql-contracts-email",
    "please choose a practice type which best describes your site": "ql-gf-05-practice-setting",
    "which of the following practice settings best describes your clinical site": "ql-gf-05-practice-setting",
    "can your site use a central irb": "ql-gf-29-central-irb",
    "please indicate the type of irb ec your site is able to use": "ql-gf-29-central-irb",
    "are there other committees at your site that require protocol review prior to or after approval from": "ql-gf-22-other-committees",
    "in addition to the local irb ec review are there additional local committees": "ql-gf-22-other-committees",
    "will your site require translations": "ql-gf-24-translations",
    "would your site s subjects benefit from language translations": "ql-gf-24-translations",
    "is equipment routinely calibrated at your site": "ql-gsf_074_is-equipment-routinely-calibrated-at-your-site",
    "does your site maintain a regular calibration schedule": "ql-gsf_074_is-equipment-routinely-calibrated-at-your-site",
    "do you have experience with electronic data capture edc": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "please select which of the following edc systems": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "do you have experience with interactive response technology irt": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
    "please select which of the following irt rtsm": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
}


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


def norm(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\(select all that apply.*?\)", "", t)
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def slug(label: str, idx: int) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", norm(label)).strip("-")[:52] or "q"
    return f"ql-rebuild-{idx:03d}-{s}"


def q(
    label: str,
    *,
    type_: str = "text",
    options: list | None = None,
    required: bool = True,
    category: str = "ReBUILD Feasibility",
    help_: str = "",
    alias_key: str | None = None,
):
    return {
        "label": label.strip(),
        "type": type_,
        "options": options or [],
        "required": required,
        "category": category,
        "help": help_,
        "aliasKey": alias_key or norm(label),
    }


def rebuild_questions() -> list[dict]:
    """Curated SFQ fields from ReBUILD DOCX (tables + interest/comments)."""
    qs: list[dict] = []
    cat = "ReBUILD / MYTX272AM-201"

    # Interest gate
    qs.append(
        q(
            "Has the Investigator reviewed the protocol synopsis, and interested in participating in this study?",
            type_="radio",
            options=["Yes", "No"],
            category=cat,
        )
    )
    qs.append(
        q(
            "If NO, please provide the reason(s)",
            type_="multiselect",
            options=[
                "Lack of Patients",
                "Eligibility Criteria",
                "Competing Studies either ongoing/planned",
                "Lack of Time and/or Research Staff",
                "Lack of Equipment",
                "Protocol-related",
                "Other",
            ],
            required=False,
            category=cat,
            help_="Shown when interest = No.",
        )
    )
    qs.append(
        q(
            "If other reason for not participating, please describe",
            type_="textarea",
            required=False,
            category=cat,
        )
    )

    # Contact Information
    qs += [
        q("Investigator Name", type_="text", category="Contact Information", alias_key="investigator name"),
        q("Investigator Phone", type_="text", category="Contact Information", alias_key="investigator phone"),
        q("Investigator Email", type_="text", category="Contact Information", alias_key="investigator email"),
        q("Institution Name", type_="text", category="Contact Information", alias_key="institution name"),
        q("Site street address", type_="text", category="Contact Information", alias_key="street address"),
        q("City / State / Country / Zip Code", type_="text", category="Contact Information"),
        q(
            "Preferred Site Contact Name",
            type_="text",
            category="Contact Information",
            alias_key="preferred site contact name",
        ),
        q(
            "Preferred Site Contact Phone",
            type_="text",
            category="Contact Information",
            alias_key="preferred site contact phone",
        ),
        q(
            "Preferred Site Contact Email",
            type_="text",
            category="Contact Information",
            alias_key="preferred site contact email",
        ),
        q(
            "Contract/Budget Name",
            type_="text",
            category="Contact Information",
            alias_key="contract budget name",
        ),
        q(
            "Contract/Budget Phone",
            type_="text",
            required=False,
            category="Contact Information",
        ),
        q(
            "Contract/Budget Email",
            type_="text",
            category="Contact Information",
            alias_key="contract budget email",
        ),
    ]

    # Site Information
    qs.append(
        q(
            "Please choose a Practice Type which best describes your site",
            type_="radio",
            options=[
                "University Hospital",
                "General Hospital",
                "Doctor’s Office (Group Practice)",
                "Doctor’s Office (Private Practice)",
                "Dedicated Research Center",
                "Specialized Clinic/Institution",
                "Other (please specify)",
            ],
            category="Site Information",
            alias_key="please choose a practice type which best describes your site",
        )
    )
    qs.append(
        q(
            "If other practice type, please specify",
            type_="text",
            required=False,
            category="Site Information",
        )
    )
    qs.append(
        q(
            "Does your site have satellite offices or other locations where study procedures will be performed?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Information",
        )
    )
    qs.append(
        q(
            "Satellite / additional research location details (institution, address, independent satellite Y/N, procedures)",
            type_="textarea",
            required=False,
            category="Site Information",
        )
    )

    # Site Profile
    qs += [
        q(
            "How many Dry AMD clinical trials have you conducted in the past 5 years?",
            type_="radio",
            options=["0", "1-2", "3-5", "≥6"],
            category="Site Profile",
        ),
        q(
            "Please indicate what development phase",
            type_="multiselect",
            options=["Phase I", "Phase 2", "Phase 3"],
            required=False,
            category="Site Profile",
        ),
        q(
            "Do you have any ongoing trials in patients with dry AMD and GA? If so, how many?",
            type_="radio",
            options=["0", "1-2", "3-5", "≥6"],
            category="Site Profile",
        ),
        q(
            "If you answered the above question, would those trials interfere with recruitment?",
            type_="radio",
            options=["Yes", "No"],
            required=False,
            category="Site Profile",
        ),
        q(
            "For the 3 most recent Dry AMD studies your site has conducted, please provide enrollment details",
            type_="textarea",
            required=False,
            category="Site Profile",
            help_="Study # / subjects enrolled / length of enrollment period (months).",
        ),
        q(
            "Do you have dedicated staff to conduct this study?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Profile",
        ),
        q(
            "If YES, please check all dedicated staff that apply",
            type_="multiselect",
            options=[
                "Study Coordinator",
                "Pharmacist",
                "Sub-Investigators",
                "Certified Photographers/Technicians",
                "Certified BCVA Examiners",
            ],
            required=False,
            category="Site Profile",
        ),
        q(
            "How many Sub-Investigators do you plan to have involved in the trial?",
            type_="text",
            required=False,
            category="Site Profile",
        ),
        q(
            "Are you or any of your sub-I’s board-certified retinal specialists?",
            type_="multiselect",
            options=["PI", "Sub-I"],
            required=False,
            category="Site Profile",
        ),
        q(
            "How many Certified Photographers do you plan to have involved in the trial?",
            type_="number",
            required=False,
            category="Site Profile",
        ),
        q(
            "Has your site staff/equipment ever been certified by Clario reading center?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Profile",
        ),
        q(
            "Has your site staff/equipment ever been certified by Adaptive Sensory Technology (AST) reading center?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Profile",
        ),
        q(
            "How many Certified BCVA Examiners do you plan to have involved in the trial?",
            type_="number",
            required=False,
            category="Site Profile",
        ),
        q(
            "Do you have the capability of performing Spectral Domain OCT (SD-OCT) Imaging?",
            type_="multiselect",
            options=["Heidelberg Spectralis", "Zeiss Cirrus", "Both", "Other"],
            category="Equipment",
        ),
        q(
            "If other SD-OCT, please specify manufacturer/model",
            type_="text",
            required=False,
            category="Equipment",
        ),
        q(
            "Color Fundus Photography (CFP) Imaging available?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "CFP manufacturer/model",
            type_="text",
            required=False,
            category="Equipment",
        ),
        q(
            "Fundus Autofluorescence (FAF) Imaging available?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "FAF manufacturer/model",
            type_="text",
            required=False,
            category="Equipment",
        ),
        q(
            "Fluorescein Angiography (FA) Imaging available?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "FA manufacturer/model",
            type_="text",
            required=False,
            category="Equipment",
        ),
        q(
            "Do you have an ETDRS lightbox?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "ETDRS lightbox make/model/cat. No",
            type_="text",
            required=False,
            category="Equipment",
        ),
        q(
            "Do you have a dedicated 4 meter lane/room/area to perform BCVA testing?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "Do you have room for a Quantitative Contrast Sensitivity Function (qCSF) machine?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "Do you have Corneal Fluorescein staining strips?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "Do you have the equipment necessary to perform Biomicroscopy (Slit Lamp)?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
        ),
        q(
            "Does your site maintain a regular calibration schedule (SOP, Policy, etc) for all equipment?",
            type_="radio",
            options=["Yes", "No"],
            category="Equipment",
            alias_key="does your site maintain a regular calibration schedule",
        ),
        q(
            "If YES, can the calibration records be reviewed by the CRA during monitoring visits?",
            type_="radio",
            options=["Yes", "No"],
            required=False,
            category="Equipment",
        ),
        q(
            "How can records/clinical trial source records best be reviewed by the CRA monitoring at your site?",
            type_="multiselect",
            options=[
                "Paper source at the site",
                "Electronic Medical Records/Source (i.e., RealTime or CRIO), CRA can log-in",
                "Electronic Medical Records, CRA can review certified printouts",
                "Other (please specify)",
            ],
            category="Site Profile",
        ),
        q(
            "If Electronic Source, specify system",
            type_="text",
            required=False,
            category="Site Profile",
        ),
        q(
            "Will CRA have remote access to the Electronic Source for remote monitoring?",
            type_="radio",
            options=["Yes", "No"],
            required=False,
            category="Site Profile",
        ),
    ]

    # Access to Patients
    qs += [
        q(
            "How many patients > 55 years old with at least 1 eye with dry AMD with GA do you see on a monthly basis?",
            type_="number",
            category="Access to Patients",
        ),
        q(
            "What percentage of these patients have extrafoveal GA lesions (at least > 150 µm from the foveal center) with a cumulative GA lesion size of approximately > 0.5 mm2 and < 10.16 mm2?",
            type_="radio",
            options=["≤25%", ">25 to ≤50%", "over 50%"],
            category="Access to Patients",
        ),
        q(
            "How many newly referred or newly diagnosed with dry AMD with GA patients does your site see each month?",
            type_="number",
            category="Access to Patients",
        ),
        q(
            "Based on the numbers above and the protocol synopsis provided, how many patients do you anticipate being able to enroll each month?",
            type_="number",
            category="Access to Patients",
        ),
        q(
            "Please indicate below if any ELIGIBILITY criteria would prevent you from recruiting patients into the trial",
            type_="textarea",
            required=False,
            category="Access to Patients",
        ),
        q(
            "Does your site routinely use complement inhibitors to treat patients with GA?",
            type_="radio",
            options=["Yes", "No"],
            category="Access to Patients",
        ),
        q(
            "If YES, do you use complement inhibitors in the study’s proposed patient population?",
            type_="radio",
            options=["Yes", "No"],
            required=False,
            category="Access to Patients",
        ),
        q(
            "If yes, what percentage of Dry AMD patients?",
            type_="text",
            required=False,
            category="Access to Patients",
        ),
        q(
            "Is your site willing to pre-screen potential, suitable patients prior to the SIV and make a list of possible eligible patients?",
            type_="radio",
            options=["Yes", "No"],
            category="Access to Patients",
        ),
        q(
            "What method(s) are/were you planning to identify patients?",
            type_="multiselect",
            options=[
                "Site Database Review",
                "Patient Chart Review",
                "Dear Dr. Letter",
                "Past Enrollment in Similar Studies",
                "Other Physician Referrals",
                "Other (please specify)",
            ],
            category="Access to Patients",
        ),
    ]

    # IRB/EC
    qs += [
        q(
            "Please indicate the type of IRB/EC your site is able to use",
            type_="multiselect",
            options=["Central IRB/EC", "Local IRB/EC"],
            category="IRB/EC Submission",
            alias_key="please indicate the type of irb ec your site is able to use",
        ),
        q(
            "If Local IRB/EC, how often does the IRB meet?",
            type_="radio",
            options=["Weekly", "Every Other Week", "Monthly", "Other, please specify"],
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "If Local IRB/EC, what is the lead time for preparing the submission package?",
            type_="text",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "If Local IRB/EC, how many workdays in advance of your local meeting must the package be submitted?",
            type_="number",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "If Local IRB/EC, please describe the submission and approval process",
            type_="textarea",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "How long does it take to receive the approval documents from the IRB/EC meeting date?",
            type_="text",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "In addition to the local IRB/EC review, are there additional local committees that are a part of your review process and approval required prior to activation?",
            type_="radio",
            options=["Yes", "No"],
            category="IRB/EC Submission",
            alias_key="in addition to the local irb ec review are there additional local committees",
        ),
        q(
            "If yes, please specify committee name & frequency",
            type_="text",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "If Local IRB/EC, does the contract (Clinical Trial Agreement) need to be submitted?",
            type_="radio",
            options=["Yes", "No"],
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "If yes, is it acceptable to submit a DRAFT CTA?",
            type_="radio",
            options=["Yes", "No, fully executed CTA required"],
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "Are there any requirements after IRB/EC approval that are rate limiting to site activation?",
            type_="radio",
            options=["Yes", "No"],
            category="IRB/EC Submission",
        ),
        q(
            "If yes, please specify rate-limiting requirements after IRB/EC approval",
            type_="textarea",
            required=False,
            category="IRB/EC Submission",
        ),
        q(
            "Can IRB/EC submission and contract/budget negotiations occur in parallel?",
            type_="radio",
            options=["Yes", "No"],
            category="IRB/EC Submission",
        ),
        q(
            "Will your site require translations?",
            type_="radio",
            options=["Yes", "No"],
            category="IRB/EC Submission",
            alias_key="will your site require translations",
        ),
        q(
            "If yes, please specify translation requirements",
            type_="text",
            required=False,
            category="IRB/EC Submission",
        ),
    ]

    # Contract / Budget
    qs += [
        q(
            "Do you have a separate contract and/or budget office?",
            type_="radio",
            options=["Yes", "No"],
            category="Contract / Budget",
        ),
        q(
            "If yes, please provide contract/budget office contact details",
            type_="textarea",
            required=False,
            category="Contract / Budget",
        ),
        q(
            "Who will be contracting parties to the Clinical Trial Agreement? Please check all that apply.",
            type_="multiselect",
            options=["Institution", "PI", "Contract Department"],
            category="Contract / Budget",
        ),
        q(
            "On average, how long will it take to execute the Clinical Trial Agreement (CTA) / Budget between the Sponsor and your study site?",
            type_="radio",
            options=["< 30 days", "31 to 60 days", "60 to 90 days", "> 90 days"],
            category="Contract / Budget",
        ),
        q(
            "Do you accept electronic signatures of the Clinical Trial Agreement?",
            type_="radio",
            options=["Yes", "No"],
            category="Contract / Budget",
        ),
    ]

    # Vendors
    qs += [
        q(
            "Do you have experience with Electronic Data Capture (EDC)?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Vendor Experience",
            alias_key="do you have experience with electronic data capture edc",
        ),
        q(
            "If YES, what EDC systems do you have experience with, please specify?",
            type_="textarea",
            required=False,
            category="Site Vendor Experience",
        ),
        q(
            "Do you have experience with Interactive Response Technology (IRT) for patient randomization and IMP distribution?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Vendor Experience",
            alias_key="do you have experience with interactive response technology irt",
        ),
        q(
            "Do you have experience with sending ophthalmic images to a central reading center?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Vendor Experience",
        ),
        q(
            "If YES, which central reading center vendors have you worked with, please specify?",
            type_="textarea",
            required=False,
            category="Site Vendor Experience",
        ),
        q(
            "Do you have experience using paper patient diaries in a dry AMD population?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Vendor Experience",
        ),
        q(
            "Do you have experience using eDiaries in a dry AMD population?",
            type_="radio",
            options=["Yes", "No"],
            category="Site Vendor Experience",
        ),
        q(
            "What type of diary collection is your patient’s most comfortable using? Check all that apply.",
            type_="multiselect",
            options=["eDiary", "Paper Diary"],
            category="Site Vendor Experience",
        ),
        q(
            "Do you have any additional comments that you would like to provide?",
            type_="textarea",
            required=False,
            category=cat,
        ),
    ]
    return qs


def find_match(label: str, alias_key: str, by_lib_id: dict, by_lib_label: dict):
    ak = norm(alias_key or label)
    ln = norm(label)

    if ak in ALIASES and ALIASES[ak] in by_lib_id:
        return by_lib_id[ALIASES[ak]], f"alias:{ALIASES[ak]}"
    if ln in ALIASES and ALIASES[ln] in by_lib_id:
        return by_lib_id[ALIASES[ln]], f"alias:{ALIASES[ln]}"

    for key, lid in ALIASES.items():
        if lid not in by_lib_id:
            continue
        if ln == key or ak == key:
            return by_lib_id[lid], f"alias:{lid}"
        if SequenceMatcher(None, ln, key).ratio() >= 0.92:
            return by_lib_id[lid], f"alias-fuzzy:{lid}"

    if ln in by_lib_label:
        return by_lib_label[ln], "exact-lib"

    best = None
    best_s = 0.0
    for k, obj in by_lib_label.items():
        s = SequenceMatcher(None, ln, k).ratio()
        if s > best_s:
            best_s = s
            best = obj
    # High bar — avoid false positives (FA vs FAF manufacturer/model)
    if best and best_s >= 0.94 and len(ln) >= 48:
        return best, f"fuzzy-lib:{best_s:.2f}"
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", nargs="?", default=str(DEFAULT_DOCX))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    questions = rebuild_questions()
    db = cosmos()
    lib_c = db.get_container_client("site-survey-question-library")
    def_c = db.get_container_client("site-survey-definitions")

    lib_items = list(lib_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    by_lib_id = {x["id"]: x for x in lib_items if x.get("id")}
    by_lib_label = {}
    for x in lib_items:
        k = norm(x.get("label"))
        if k and k not in by_lib_label:
            by_lib_label[k] = x
    # Freeze pre-existing labels so same-run near-duplicates (FA vs FAF) don't collide
    preexisting_labels = dict(by_lib_label)

    now = datetime.now(timezone.utc).isoformat()
    survey_qs = []
    report = []
    created = 0
    reused = 0

    for i, qq in enumerate(questions, start=1):
        match, how = find_match(qq["label"], qq.get("aliasKey") or "", by_lib_id, preexisting_labels)
        opts = list(qq.get("options") or [])
        qtype = qq["type"]

        if match and str(match.get("id") or "").startswith("ql-"):
            lib_id = match["id"]
            reused += 1
            # Keep existing library label/options; tag with rebuild source
            lib_doc = dict(by_lib_id.get(lib_id) or match)
            tags = list(dict.fromkeys((lib_doc.get("tags") or []) + ["rebuild", "mytx272am-201", SOURCE]))
            lib_doc["tags"] = tags
            lib_doc["updatedAt"] = now
            if args.apply:
                lib_c.upsert_item(lib_doc)
            by_lib_id[lib_id] = lib_doc
        else:
            lib_id = slug(qq["label"], i)
            # collision-safe
            if lib_id in by_lib_id:
                lib_id = f"{lib_id}-{i}"
            lib_doc = {
                "id": lib_id,
                "label": qq["label"],
                "type": qtype,
                "options": opts if qtype in ("radio", "select", "multiselect") else [],
                "required": bool(qq.get("required", True)),
                "category": (qq.get("category") or "ReBUILD")[:80],
                "help": qq.get("help") or "",
                "status": "active",
                "createdAt": now,
                "updatedAt": now,
                "source": SOURCE,
                "tags": ["rebuild", "mytx272am-201", "feasibility", SOURCE, "new"],
            }
            if args.apply:
                lib_c.upsert_item(lib_doc)
            by_lib_id[lib_id] = lib_doc
            created += 1
            how = "created"

        survey_qs.append(
            {
                "id": f"rebuild_{i:03d}_{re.sub(r'[^a-z0-9]+', '-', norm(qq['label'])).strip('-')[:40]}",
                "label": qq["label"],
                "type": qtype,
                "required": bool(qq.get("required", True)),
                "options": opts if qtype in ("radio", "select", "multiselect") else [],
                "logic": None,
                "libraryQuestionId": lib_id,
                "help": qq.get("help") or "",
                "category": qq.get("category") or "ReBUILD",
            }
        )
        report.append(
            {
                "n": i,
                "label": qq["label"][:120],
                "libraryQuestionId": lib_id,
                "how": how or "created",
                "type": qtype,
            }
        )

    # Pages by category
    pages = []
    for sq in survey_qs:
        title = (sq.get("category") or "ReBUILD").strip()
        if not pages or pages[-1]["title"] != title:
            pages.append({"id": f"page-{len(pages) + 1}", "title": title, "questionIds": []})
        pages[-1]["questionIds"].append(sq["id"])

    out = REPO / ".firecrawl" / "rebuild-sync-report.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "docx": str(args.docx),
                "surveyId": SURVEY_ID,
                "total": len(survey_qs),
                "reused_lib": reused,
                "created_lib": created,
                "questions": report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"ReBUILD questions: {len(survey_qs)}")
    print(f"Library reused: {reused}  created: {created}")
    print(f"Report: {out}")
    for r in report:
        print(f"{r['how'][:22]:22s} Q{r['n']:03d} -> {r['libraryQuestionId']}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write Cosmos.")
        return

    try:
        survey = def_c.read_item(SURVEY_ID, SURVEY_ID)
    except Exception:
        survey = {"id": SURVEY_ID, "createdAt": now}

    survey.update(
        {
            "id": SURVEY_ID,
            "title": "ReBUILD Feasibility (MYTX272AM-201)",
            "description": (
                "Mighty Therapeutics MYTX272AM-201 / ReBUILD Site Feasibility Questionnaire "
                "(v0.1 10 Sep 2026 Draft). Library questions matched to existing items where possible."
            ),
            "status": "active",
            "predefined": True,
            "indication": "Dry AMD / GA",
            "therapeuticArea": "Ophthalmology",
            "studyCode": "MYTX272AM-201",
            "protocolName": "ReBUILD",
            "questions": survey_qs,
            "pages": pages,
            "generalFeasibilityVariant": "long",
            "source": SOURCE,
            "docxPath": Path(args.docx).name,
            "tags": ["rebuild", "mytx272am-201", "feasibility", "predefined", SOURCE],
            "updatedAt": now,
        }
    )
    def_c.upsert_item(survey)
    print(f"\nAPPLIED survey={SURVEY_ID} ({len(survey_qs)} qs, {len(pages)} pages)")


if __name__ == "__main__":
    main()
