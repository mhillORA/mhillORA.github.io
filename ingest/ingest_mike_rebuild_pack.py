"""
Ingest Mike's ReBUILD 39-site partnership pack into Cosmos.

Writes (no local-file dependency for runtime):
  1) site-survey-definitions / mike-mighty-field-map   (field map)
  2) site-survey-assignments + site-survey-responses   (per matched site)
  3) site-profiles.mikePack                            (canonical answers on profile)

Matches pack sites -> live sites (preferred) or legacy-sites (then linkedArtemisSiteId).
Hand aliases cover known PI/practice renames; remaining unmatched rows get inert live
stubs on --apply so all 39 pack sites land in Cosmos.

Does NOT overwrite Chaos scheduling fields on live sites.
Does NOT delete existing survey responses; upserts dedicated Mike response docs.

Usage:
  python ingest/ingest_mike_rebuild_pack.py
  python ingest/ingest_mike_rebuild_pack.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient, PartitionKey

REPO = Path(__file__).resolve().parents[1]
PACK = Path(r"c:\Users\shue1\Downloads\ReBUILD_39_Sites_Partnership_Profile_Data.json")
FIELD_MAP = REPO / "ingest" / "data" / "mike_mighty_field_map.json"
SURVEY_ID = "survey-rebuild-mytx272am-201"
SOURCE = "mike-rebuild-39-pack"
FIELD_MAP_DOC_ID = "mike-mighty-field-map"
REPORT = REPO / ".firecrawl" / "mike-pack-cosmos-ingest-report.json"

# Confirmed live-site links (Mike pack id → Artemis sites.id). Do not map
# Gary Lane → Richard Lane (RCOT) or Jeremiah Brown → Michael Singer.
HAND_ALIASES: dict[str, dict] = {
    "REBUILD-004": {
        "siteId": "mpybtwssq8bk2t93cb",
        "note": "Charles Wykoff / Retina Consultants of Texas (same org as Brown; separate Mike response)",
    },
    "REBUILD-010": {
        "siteId": "1a0908afddb8383bb62",
        "note": "Western Carolina Retinal Associates, division of Asheville Eye / William Bridges",
    },
    "REBUILD-011": {
        "siteId": "1a0908a4d5117212421",
        "note": "Carl Danzig - Deerfield Beach",
    },
    "REBUILD-015": {
        "siteId": "1a0908a38d914190d24",
        "note": "John Thordsen Site",
    },
    "REBUILD-039": {
        "siteId": "mpybmg4prfu37clg7ls",
        "note": "Duke (institution; pack PI Eleonora Lad)",
    },
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    t = re.sub(r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc|the|center|institute|associates|assoc)\b", "", t)
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


_EXCEL_DATE_RE = re.compile(
    r"^\s*\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*$"
)
_STREET_HINT_RE = re.compile(
    r"\d|street|st\b|ave|avenue|rd\b|road|blvd|drive|dr\b|suite|ste\b|lane|ln\b|way\b",
    re.I,
)
_PHONE_RE = re.compile(r"^\+?[\d\s().-]{7,}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Pack practice_type free-text → rebuild radio options
PRACTICE_ALIASES = {
    "research institution": "Dedicated Research Center",
    "dedicated research center": "Dedicated Research Center",
    "research center": "Dedicated Research Center",
    "university hospital": "University Hospital",
    "university ophthalmology department": "University Hospital",
    "university": "University Hospital",
    "general hospital": "General Hospital",
    "hospital": "General Hospital",
    "doctor's office (group practice)": "Doctor's Office (Group Practice)",
    "group practice": "Doctor's Office (Group Practice)",
    "doctor's office (private practice)": "Doctor's Office (Private Practice)",
    "private practice": "Doctor's Office (Private Practice)",
    "private practice, speciality clinic": "Doctor's Office (Private Practice)",
    "private practice, specialty clinic": "Doctor's Office (Private Practice)",
    "specialty clinic": "Specialized Clinic/Institution",
    "speciality clinic": "Specialized Clinic/Institution",
    "specialized clinic/institution": "Specialized Clinic/Institution",
    "specialized clinic": "Specialized Clinic/Institution",
}

# Pack staffing cells are ROLE LABELS, not headcounts — map to dedicated-roles multiselect.
STAFF_ROLE_OPTION = {
    "staffing.study_coordinators": "Study Coordinator",
    "staffing.sub_investigators": "Sub-Investigators",
    "staffing.certified_photographers": "Certified Photographers/Technicians",
    "staffing.certified_bcva_examiners": "Certified BCVA Examiners",
    "staffing.pharmacist": "Pharmacist",
}
ROLES_LIB = "ql-rebuild-034-if-yes-which-dedicated-roles-are-in-place"
ROLES_QID = "rebuild_034_if-yes-which-dedicated-roles-are-in-plac"
DEDICATED_STAFF_LIB = "ql-rebuild-025-do-you-have-dedicated-staff-to-conduct-this-study"
ONSITE_PHARMACY_LIB = "ql-rebuild-064-on-site-pharmacy"
CRA_REMOTE_LIB = "ql-rebuild-051-will-cra-have-remote-access-to-the-electronic-source"
PATIENT_ID_OTHER_LIB = "ql-rebuild-086-if-other-please-specify"

# When Yes/No equipment cell carries a manufacturer string, also fill model follow-up.
EQUIP_MODEL_FOLLOWUP = {
    "equipment.color_fundus_photography": "ql-rebuild-044-manufacturer-model-if-yes",
    "equipment.fundus_autofluorescence": "ql-rebuild-046-manufacturer-model-if-yes",
    "equipment.fluorescein_angiography": "ql-rebuild-048-manufacturer-model-if-yes",
    "equipment.etdrs_lightbox": "ql-rebuild-050-make-model-catalog-no-if-yes",
}

# Paths handled specially / must not write via naive 1:1 map
SPECIAL_SKIP_PATHS = set(STAFF_ROLE_OPTION) | {
    "recruitment_methods.advertising",  # was wrongly mapped onto patient-ID methods
    "pharmacy_lab.temp_monitoring",  # collided with drug_refrigerator lib
}

_PROMPT_LABEL_RE = re.compile(
    r"^(fluorescein angiography|fundus (auto)?fluorescence|color fundus|manufacturer/?model|"
    r"brand|make/?model|if different|please specify)\b",
    re.I,
)
_PERSON_NAME_RE = re.compile(
    r"^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){0,3}(?:,?\s*(?:MD|DO|PhD|OD))?$"
)


def sanitize_pack_value(path: str, val, label: str = "", qtype: str = "", options: list | None = None) -> object | None:
    """Drop Excel-date / Yes-No / address-bleed junk before writing answers."""
    if val is None:
        return None
    if isinstance(val, (dict, list)):
        return val
    s = str(val).strip()
    if not is_filled(s):
        return None
    # Excel datetime spilled into text fields
    if _EXCEL_DATE_RE.match(s) or ("00:00:00" in s and re.search(r"\d{4}-\d{2}-\d{2}", s)):
        return None
    low_path = (path or "").lower()
    low_lab = (label or "").lower()
    typ = str(qtype or "").lower()
    opts = [str(o).strip() for o in (options or []) if str(o).strip()]
    yes_no_opts = {o.lower() for o in opts} <= {"yes", "no", "n/a"} and "yes" in {
        o.lower() for o in opts
    }

    # Identity / name / phone / email fields must not be Yes/No or dates
    if re.search(r"name|contact|email|phone|institution|title|role", low_path + " " + low_lab):
        if re.match(r"^(yes|no)$", s, re.I) and not yes_no_opts:
            return None
    # Please-specify / which-system / manufacturer text must not be bare Yes/No
    if re.search(
        r"please specify|if other|describe|which system|manufacturer|make/?model|catalog",
        low_lab,
    ) and re.match(r"^(yes|no)$", s, re.I):
        return None
    # Excel column-header / prompt residue in equipment cells
    if _PROMPT_LABEL_RE.match(s) and len(s) < 90 and not re.search(r"optos|heidelberg|zeiss|topcon", s, re.I):
        return None
    # Institution name must not be a street address blob
    if "institution_name" in low_path or low_lab.strip() in ("institution name", "practice name"):
        if _STREET_HINT_RE.search(s) and ("," in s or re.search(r"\d{5}", s) or "suite" in s.lower()):
            return None
    # Practice type must not be an address / phone / email
    if "practice_type" in low_path or "practice setting" in low_lab:
        if _STREET_HINT_RE.search(s) and (re.search(r"\d", s) or "suite" in s.lower()):
            return None
        if _EMAIL_RE.match(s) or (_PHONE_RE.match(s) and len(re.sub(r"\D", "", s)) >= 10):
            return None
    # Phone fields: must look like a phone
    if "phone" in low_path or re.search(r"\bphone\b", low_lab):
        digits = re.sub(r"\D", "", s)
        if len(digits) < 7 or _EMAIL_RE.match(s) or re.match(r"^(yes|no)$", s, re.I):
            return None
    # Email fields
    if "email" in low_path or re.search(r"\bemail\b", low_lab):
        if not _EMAIL_RE.match(s):
            return None
    # Address must not be an email
    if "address" in low_path or re.search(r"\baddress\b", low_lab):
        if _EMAIL_RE.match(s) or re.match(r"^(yes|no|na|n/?a)$", s, re.I):
            return None
    # Patient-volume / count cells must not carry recruitment-method labels
    if "patient_volume" in low_path or re.search(r"how many patients|percentage of these patients", low_lab):
        if re.search(
            r"site database review|patient chart review|dear dr|physician referral|"
            r"past enrollment|advertising|transportation",
            s,
            re.I,
        ):
            return None
        if not re.search(r"\d", s) and not re.match(r"^(yes|no|n/?a)$", s, re.I):
            # free text without a number is almost never a volume answer
            if len(s) > 40 or re.search(r"review|referral|enroll|recruit", s, re.I):
                return None
    return val


def _option_labels(q: dict | None) -> list[str]:
    opts = []
    for o in (q or {}).get("options") or []:
        if isinstance(o, dict):
            opts.append(str(o.get("label") or o.get("value") or "").strip())
        else:
            opts.append(str(o).strip())
    return [o for o in opts if o]


def _yes_no_from_cert_text(s: str, vendor: str) -> str | None:
    """Parse Clario/AST certification free-text → Yes/No, or None if unusable."""
    low = s.lower()
    v = vendor.lower()
    if re.search(rf"never\s+(been\s+)?certified|not\s+certified|no\s+{v}|has never|{v}.{{0,40}}never", low):
        return "No"
    if re.search(rf"certified\s+by\s+{v}|{v}.{{0,40}}certif|has been certified|staff.{{0,20}}certified", low):
        return "Yes"
    if re.match(r"^(yes|y|true|1)$", s, re.I):
        return "Yes"
    if re.match(r"^(no|n|false|0)$", s, re.I):
        return "No"
    # Person name in AST/Clario contact cell → treat as prior relationship / Yes
    if _PERSON_NAME_RE.match(s.strip()) and len(s.split()) <= 4:
        return "Yes"
    # Recruitment / enrollment bleed into reading-center cells
    if re.search(r"past enrollment|physician referral|advertising|recruit", low):
        return None
    if re.search(r"unable|not available|do not have|don't have|none|n/?a", low):
        return "No"
    # Long free-text that mentions the vendor without "never" → Yes
    if v in low and len(s) > 12:
        return "Yes"
    return None


def coerce_to_question_value(val, q: dict | None, path: str = "") -> object | None:
    """Shape pack free-text into the live question's options/type when possible."""
    if val is None or not q:
        return val
    s = str(val).strip()
    if not s:
        return None
    typ = str(q.get("type") or "text").lower()
    opts = _option_labels(q)
    low = s.lower()
    path_l = (path or "").lower()
    lab = str(q.get("label") or "").lower()

    # Practice setting aliases
    if "practice" in path_l or "practice setting" in lab:
        if opts:
            if s in opts:
                return s
            alias = PRACTICE_ALIASES.get(low)
            if alias and alias in opts:
                return alias
            for key, mapped in PRACTICE_ALIASES.items():
                if key in low and mapped in opts:
                    return mapped
            for o in opts:
                ol = o.lower()
                if low in ol or ol in low:
                    return o
            best, bs = None, 0.0
            for o in opts:
                r = SequenceMatcher(None, low, o.lower()).ratio()
                if r > bs:
                    best, bs = o, r
            if best and bs >= 0.55:
                return best
            if re.search(r"other", low) and any(o.lower() == "other" for o in opts):
                return next(o for o in opts if o.lower() == "other")
            return None

    # IRB Central / Local — never accept bare Yes or study notes
    if "irb" in path_l or ("irb" in lab and ("central" in lab or "type" in lab or "able to use" in lab)):
        if opts and any("central" in o.lower() or "local" in o.lower() for o in opts):
            if re.search(r"\bcentral\b", low) and not re.search(r"\blocal\b", low):
                hit = next((o for o in opts if "central" in o.lower()), None)
                if hit:
                    return hit
            if re.search(r"\blocal\b", low) and not re.search(r"\bcentral\b", low):
                hit = next((o for o in opts if "local" in o.lower()), None)
                if hit:
                    return hit
            if re.match(r"^(yes|no|y|n)$", s, re.I):
                return None
            # study notes / microperimetry bleed
            if len(s) > 40 or re.search(r"microperimetry|enroll|ecc|ecg|trial", low):
                return None
            return None

    # Clario / AST certification radios
    if "clario" in path_l or "clario" in lab:
        return _yes_no_from_cert_text(s, "clario")
    if path_l.endswith(".ast") or re.search(r"\bast\b|adaptive sensory", lab):
        return _yes_no_from_cert_text(s, "ast")

    # Number questions: only real counts
    if typ == "number" or (opts and all(re.match(r"^[\d≥>≤\-\–]+$", o) for o in opts[:4])):
        if re.match(r"^\d+(\.\d+)?$", s):
            return s
        m = re.search(r"\b(\d+)\b", s)
        if m and not re.search(r"sub-?i|coordinator|photographer|examiner|pharmacist|certified", low):
            return m.group(1)
        return None

    yes_no_set = {o.lower() for o in opts}
    # Yes/No (+ optional N/A) radios
    if typ in ("radio", "select") and yes_no_set <= {"yes", "no", "n/a"} and "yes" in yes_no_set:
        if re.match(r"^(yes|y|true|1)$", s, re.I):
            return "Yes"
        if re.match(r"^(no|n|false|0)$", s, re.I):
            return "No"
        if re.match(r"^(n/?a|na|not applicable)$", s, re.I) and "n/a" in yes_no_set:
            return next(o for o in opts if o.lower() == "n/a")
        if re.search(r"unable|not available|do not have|don't have|none\b|no\s+\w+\s+on\s+site", low):
            return "No"
        # manufacturer / free text means they have it
        if _PROMPT_LABEL_RE.match(s):
            return None
        return "Yes"

    # Multiselect — return JSON array string when multiple options match
    if typ in ("multiselect", "checkboxes", "checkbox") and opts:
        matched = []
        for o in opts:
            ol = o.lower()
            if low == ol or ol in low or low in ol:
                if o not in matched:
                    matched.append(o)
        # SD-OCT brands
        if "heidelberg" in low and "zeiss" in low:
            both = next((o for o in opts if o.lower() == "both"), None)
            if both:
                return both
        # Board-certified PI / Sub-I (exact option set)
        opt_l = {o.lower() for o in opts}
        if {"pi", "sub-i", "none"} <= opt_l or {"pi", "sub-i"} <= opt_l:
            picked = []
            pi_opt = next((o for o in opts if o.lower() == "pi"), None)
            subi_opt = next((o for o in opts if o.lower() == "sub-i"), None)
            none_opt = next((o for o in opts if o.lower() == "none"), None)
            if pi_opt and re.search(r"\bpi\b|principal investigator", low) and not re.search(r"sub-?i", low):
                picked.append(pi_opt)
            if subi_opt and re.search(r"sub-?i|subinvestigator|sub investigator", low):
                picked.append(subi_opt)
            if re.search(r"retina", low) and not picked and pi_opt:
                picked.append(pi_opt)
            if picked:
                return json.dumps(picked) if len(picked) > 1 else picked[0]
            if none_opt and re.search(r"\bnone\b|\bno\b", low):
                return none_opt
            return None
        # Patient identify methods — prefer specific options over Other
        if matched:
            if len(matched) > 1:
                both = next((o for o in matched if o.lower() == "both"), None)
                if both:
                    return both
                # drop Other if a concrete option also matched
                concrete = [m for m in matched if m.lower() != "other"]
                if concrete:
                    return json.dumps(concrete) if len(concrete) > 1 else concrete[0]
            return matched[0]
        other = next((o for o in opts if o.lower() == "other"), None)
        if other and not re.match(r"^(yes|no)$", s, re.I):
            return other
        if re.match(r"^(yes|y)$", s, re.I):
            return None
        return None

    # Free-text: reject bare Yes/No for system/model questions
    if typ in ("text", "textarea", ""):
        if re.match(r"^(yes|no)$", s, re.I) and re.search(
            r"system|manufacturer|model|specify|describe|which", lab
        ):
            return None
        # Strip EMR boilerplate to a usable system name when possible
        if "electronic source" in lab or "which system" in lab:
            if re.match(r"^(yes|no)$", s, re.I):
                return None
            m = re.search(
                r"\b(RealTime|CRIO|Medidata|Veeva|Epic|NextGen|eClinical|OpenClinica|iMedNet|TrialMaster)\b",
                s,
                re.I,
            )
            if m:
                return m.group(1)
            if re.search(r"electronic medical|emr|e-?source|electronic source", low):
                # keep a short cleaned phrase
                cleaned = re.sub(r"\s+", " ", s)
                if len(cleaned) > 120:
                    cleaned = cleaned[:117] + "..."
                return cleaned
        return s

    return val


def staff_role_is_present(path: str, val) -> bool:
    """True when a staffing cell indicates that role exists (not bleed/TBD)."""
    if not is_filled(val):
        return False
    s = str(val).strip()
    low = s.lower()
    if re.match(r"^(tbd|n/?a|na|none|no|unknown)$", low):
        return False
    if _EXCEL_DATE_RE.match(s):
        return False
    # Pharmacy/storage bleed into coordinator column
    if path == "staffing.study_coordinators" and re.search(
        r"pharmacy|drug prep|refrigerat|freezer|temperature", low
    ):
        return False
    if path == "staffing.pharmacist" and re.search(
        r"crc|coordinator|trained for this", low
    ) and "pharmacist" not in low:
        return False
    option = STAFF_ROLE_OPTION.get(path, "")
    # Explicit role label or short affirmative
    if option and (option.lower() in low or low in option.lower()):
        return True
    if path == "staffing.sub_investigators" and re.search(r"sub-?i|subinvestigator", low):
        return True
    if path == "staffing.study_coordinators" and re.search(r"coordinator|crc\b", low):
        return True
    if path == "staffing.certified_photographers" and re.search(r"photograph|oct tech", low):
        return True
    if path == "staffing.certified_bcva_examiners" and re.search(r"bcva|examiner", low):
        return True
    if path == "staffing.pharmacist" and re.search(r"pharmacist|pharmacy", low):
        return True
    # Bare "Pharmacist" / "Sub-I" style short labels
    if len(s) <= 48 and not re.search(r"\d{4}-\d{2}-\d{2}", s):
        return True
    return False


def is_model_text(s: str) -> bool:
    """True when value looks like equipment manufacturer/model, not bare Yes/No."""
    t = str(s or "").strip()
    if not t or re.match(r"^(yes|no|y|n|n/?a)$", t, re.I):
        return False
    if _PROMPT_LABEL_RE.match(t):
        return False
    if re.search(
        r"optos|heidelberg|zeiss|topcon|cirrus|spectralis|precision vision|etdrs|wall-mounted|retro",
        t,
        re.I,
    ):
        return True
    # short free-text model without yes/no
    return 2 <= len(t) <= 80 and not re.search(r"unable|never|do not have", t, re.I)


def slug(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")
    return t[:48] or "site"


def generate_id() -> str:
    return f"{int(time.time() * 1000):x}{secrets.token_hex(4)}"


def parse_location(loc: str) -> tuple[str, str]:
    text = str(loc or "").strip()
    if "," in text:
        city, state = text.rsplit(",", 1)
        return city.strip(), state.strip()
    return text, ""


def build_live_stub(pack_site: dict) -> dict:
    now = iso_now()
    city, state = parse_location(pack_site.get("location") or "")
    practice = str(pack_site.get("practice_name") or "").strip() or "Mike pack site"
    pi = str(pack_site.get("pi_name") or "").strip()
    return {
        "id": generate_id(),
        "name": practice,
        "status": "Active",
        "address": "",
        "address1": "",
        "address2": "",
        "city": city,
        "state": state,
        "zip": "",
        "zipCode": "",
        "pi": pi,
        "piName": pi,
        "piEmail": "",
        "siteCoordinator": "",
        "siteCoordinatorEmail": "",
        "notes": f"Created from Mike ReBUILD pack {pack_site.get('site_id')}",
        "source": SOURCE,
        "mikeRebuildPriorityId": pack_site.get("site_id"),
        "createdAt": now,
        "updatedAt": now,
    }


def match_site(practice: str, pi: str, live_sites: list, legacy_sites: list):
    """Return (siteId, how, score, matchName). Prefer live id."""
    target = norm_name(practice)
    pi_n = norm_name(pi)
    best = None  # dict with score, kind, site, how

    def consider(score, kind, site, how):
        nonlocal best
        if score < 0.72 or not site:
            return
        cand = {"score": float(score), "kind": kind, "site": site, "how": how}
        if best is None:
            best = cand
            return
        # Higher score wins; tie → prefer live
        if cand["score"] > best["score"] + 0.02:
            best = cand
            return
        if abs(cand["score"] - best["score"]) <= 0.02:
            if kind == "live" and best["kind"] != "live":
                best = cand

    for site in live_sites:
        nn = norm_name(site.get("name") or "")
        if not nn or not target:
            continue
        if nn == target:
            consider(1.0, "live", site, "exact-name")
        elif len(target) >= 12 and len(nn) >= 12 and (target in nn or nn in target):
            shorter, longer = (target, nn) if len(target) <= len(nn) else (nn, target)
            if len(shorter) / max(len(longer), 1) >= 0.55:
                consider(0.92, "live", site, "contains-name")
        else:
            r = SequenceMatcher(None, target, nn).ratio()
            if r >= 0.88:
                consider(r, "live", site, "fuzzy-name")
        if pi_n:
            for key in ("piName", "pi", "principalInvestigator"):
                if norm_name(site.get(key) or "") == pi_n:
                    # PI match alone is weak unless practice shares a token
                    tokens = [t for t in target.split() if len(t) >= 4]
                    overlap = any(t in nn for t in tokens)
                    consider(0.93 if overlap else 0.7, "live", site, "pi-name" if overlap else "pi-only")

    for site in legacy_sites:
        nn = norm_name(site.get("name") or "")
        if not nn or not target:
            continue
        score = 0.0
        how = ""
        if nn == target:
            score, how = 0.98, "legacy-exact-name"
        elif len(target) >= 12 and len(nn) >= 12 and (target in nn or nn in target):
            shorter, longer = (target, nn) if len(target) <= len(nn) else (nn, target)
            if len(shorter) / max(len(longer), 1) >= 0.55:
                score, how = 0.9, "legacy-contains-name"
        else:
            r = SequenceMatcher(None, target, nn).ratio()
            if r >= 0.88:
                score, how = r * 0.95, "legacy-fuzzy-name"
        if pi_n and norm_name(site.get("piName") or site.get("pi") or "") == pi_n:
            tokens = [t for t in target.split() if len(t) >= 4]
            overlap = any(t in nn for t in tokens)
            if overlap:
                score = max(score, 0.9)
                how = how or "legacy-pi"
            elif score < 0.72:
                score, how = 0.7, "legacy-pi-only"
        if score:
            linked = site.get("linkedArtemisSiteId")
            if linked:
                live = next((s for s in live_sites if s.get("id") == linked), None)
                if live:
                    consider(min(1.0, score + 0.01), "live", live, how + "+linked")
                    continue
            consider(score, "legacy", site, how)

    if not best:
        return None, None, 0.0, None
    site = best["site"]
    return site.get("id"), best["how"], round(best["score"], 3), site.get("name")


def _append_answer(answers, seen_libs, *, mq, lib, cid, path, val, meta, pre, src, qtype=None, label=None):
    if val is None or (isinstance(val, str) and not is_filled(val)):
        return
    if lib and lib in seen_libs:
        return
    if lib:
        seen_libs.add(lib)
    answers.append(
        {
            "questionId": (mq or {}).get("id") or cid or path,
            "libraryQuestionId": lib or (mq or {}).get("libraryQuestionId"),
            "label": label or (mq or {}).get("label") or meta.get("mikeLabel") or meta.get("mightyLabel") or path,
            "type": qtype or (mq or {}).get("type") or "text",
            "value": val if not isinstance(val, (dict, list)) else json.dumps(val),
            "mikeCanonicalId": cid,
            "mikePackPath": path,
            "mikeLabel": meta.get("mikeLabel"),
            "mikeFormField": meta.get("formField"),
            "mikePrePopulate": pre,
            "mikeSourceStudy": src,
            "source": SOURCE,
        }
    )


def build_answers(pack_site: dict, field_map: dict, survey_qs: list) -> list:
    path_meta = {f["packPath"]: f for f in field_map.get("fields") or [] if f.get("packPath")}
    q_by_lib = {
        q.get("libraryQuestionId"): q
        for q in survey_qs
        if q.get("libraryQuestionId")
    }
    q_by_id = {q.get("id"): q for q in survey_qs if q.get("id")}
    answers = []
    seen_libs = set()
    role_hits: list[str] = []
    role_pre = False
    role_src = None
    pharmacy_blob = ""

    for sec in ("section_1_site_profile", "section_2_indication_history"):
        for path, val, pre, src in flatten_answers(pack_site.get(sec) or {}):
            if not is_filled(val):
                continue

            # Aggregate staffing role labels → dedicated-roles multiselect
            if path in STAFF_ROLE_OPTION:
                if staff_role_is_present(path, val):
                    opt = STAFF_ROLE_OPTION[path]
                    if opt not in role_hits:
                        role_hits.append(opt)
                    role_pre = role_pre or bool(pre)
                    role_src = role_src or src
                continue

            # Skip known-bad 1:1 maps
            if path in SPECIAL_SKIP_PATHS:
                continue

            meta = path_meta.get(path) or {}
            lib = meta.get("libraryQuestionId")
            cid = meta.get("canonicalId")
            mq = (q_by_lib.get(lib) if lib else None) or q_by_id.get(meta.get("mightyQuestionId"))
            label = (mq or {}).get("label") or meta.get("mikeLabel") or meta.get("mightyLabel") or path
            qtype = (mq or {}).get("type") or "text"
            opts = (mq or {}).get("options") or []
            clean = sanitize_pack_value(path, val, label, qtype, opts)
            if clean is None:
                continue
            coerced = coerce_to_question_value(clean, mq, path)
            if coerced is None or (isinstance(coerced, str) and not is_filled(coerced)):
                continue
            # Prefer pack practice_name over feasibility address bleed for institution
            if path.endswith("institution_name") or path == "contact_info.institution_name":
                practice = str(pack_site.get("practice_name") or "").strip()
                if practice and _STREET_HINT_RE.search(str(coerced)):
                    coerced = practice

            raw_s = str(val).strip()
            if path.startswith("pharmacy_lab."):
                pharmacy_blob += " " + raw_s

            _append_answer(
                answers,
                seen_libs,
                mq=mq,
                lib=lib,
                cid=cid,
                path=path,
                val=coerced,
                meta=meta,
                pre=pre,
                src=src,
            )

            # Equipment manufacturer follow-up when pack cell carries model text
            model_lib = EQUIP_MODEL_FOLLOWUP.get(path)
            if model_lib and is_model_text(raw_s) and model_lib not in seen_libs:
                mq_model = q_by_lib.get(model_lib)
                _append_answer(
                    answers,
                    seen_libs,
                    mq=mq_model,
                    lib=model_lib,
                    cid=None,
                    path=path + ".model",
                    val=raw_s,
                    meta=meta,
                    pre=pre,
                    src=src,
                    qtype="text",
                    label=(mq_model or {}).get("label") or "Manufacturer/Model",
                )

            # Patient-ID Other follow-up when coerced to Other
            if (
                path == "recruitment_methods.patient_id_methods"
                and str(coerced).lower() == "other"
                and PATIENT_ID_OTHER_LIB not in seen_libs
                and not re.match(r"^(yes|no|other)$", raw_s, re.I)
            ):
                mq_other = q_by_lib.get(PATIENT_ID_OTHER_LIB)
                _append_answer(
                    answers,
                    seen_libs,
                    mq=mq_other,
                    lib=PATIENT_ID_OTHER_LIB,
                    cid=None,
                    path=path + ".other",
                    val=raw_s,
                    meta=meta,
                    pre=pre,
                    src=src,
                    qtype="text",
                    label=(mq_other or {}).get("label") or "Other (please specify)",
                )

            # Infer CRA remote access from electronic-source wording
            if path == "source_records.electronic_source_system" and CRA_REMOTE_LIB not in seen_libs:
                if re.search(r"remote|log[\s-]?in|login|can log", raw_s, re.I):
                    mq_cra = q_by_lib.get(CRA_REMOTE_LIB)
                    _append_answer(
                        answers,
                        seen_libs,
                        mq=mq_cra,
                        lib=CRA_REMOTE_LIB,
                        cid="PROF-062",
                        path="source_records.cra_remote_access",
                        val="Yes",
                        meta=path_meta.get("source_records.cra_remote_access") or {},
                        pre=pre,
                        src=src,
                    )

    # Emit aggregated dedicated roles (+ infer dedicated staff Yes)
    if role_hits:
        mq_roles = q_by_lib.get(ROLES_LIB) or q_by_id.get(ROLES_QID)
        role_val = json.dumps(role_hits) if len(role_hits) > 1 else role_hits[0]
        _append_answer(
            answers,
            seen_libs,
            mq=mq_roles,
            lib=ROLES_LIB,
            cid="PROF-021",
            path="staffing.dedicated_roles",
            val=role_val,
            meta={"mikeLabel": "Dedicated roles (from pack staffing labels)"},
            pre=role_pre,
            src=role_src,
            qtype="multiselect",
            label=(mq_roles or {}).get("label") or "If yes, which dedicated roles are in place?",
        )
        if DEDICATED_STAFF_LIB not in seen_libs:
            mq_ded = q_by_lib.get(DEDICATED_STAFF_LIB)
            _append_answer(
                answers,
                seen_libs,
                mq=mq_ded,
                lib=DEDICATED_STAFF_LIB,
                cid="PROF-020",
                path="staffing.dedicated_staff",
                val="Yes",
                meta=path_meta.get("staffing.dedicated_staff") or {},
                pre=role_pre,
                src=role_src,
            )

    # Infer on-site pharmacy No from pharmacy_lab free-text
    if ONSITE_PHARMACY_LIB not in seen_libs and re.search(
        r"don'?t have a pharmacy|no pharmacy|pharmacist on site|pharmacy/pharmacist on site",
        pharmacy_blob,
        re.I,
    ):
        mq_ph = q_by_lib.get(ONSITE_PHARMACY_LIB)
        _append_answer(
            answers,
            seen_libs,
            mq=mq_ph,
            lib=ONSITE_PHARMACY_LIB,
            cid=None,
            path="pharmacy_lab.onsite_inferred",
            val="No",
            meta={"mikeLabel": "On-site pharmacy (inferred)"},
            pre=False,
            src=None,
        )

    return answers


def build_profile_mike_pack(pack_site: dict, field_map: dict, answers: list) -> dict:
    by_canon = {}
    for a in answers:
        cid = a.get("mikeCanonicalId")
        if not cid:
            continue
        by_canon[cid] = {
            "value": a.get("value"),
            "packPath": a.get("mikePackPath"),
            "libraryQuestionId": a.get("libraryQuestionId"),
            "label": a.get("mikeLabel") or a.get("label"),
            "sourceStudy": a.get("mikeSourceStudy"),
        }
    return {
        "priorityId": pack_site.get("site_id"),
        "practiceName": pack_site.get("practice_name"),
        "piName": pack_site.get("pi_name"),
        "location": pack_site.get("location"),
        "hasGaData": bool(pack_site.get("has_ga_data")),
        "indicationsCovered": pack_site.get("indications_covered") or [],
        "source": SOURCE,
        "fieldMapId": FIELD_MAP_DOC_ID,
        "answerCount": len(answers),
        "canonicalAnswers": by_canon,
        "updatedAt": iso_now(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--pack", default=str(PACK))
    ap.add_argument("--map", default=str(FIELD_MAP))
    args = ap.parse_args()

    pack_path = Path(args.pack)
    map_path = Path(args.map)
    if not pack_path.exists():
        raise SystemExit(f"Pack missing: {pack_path}")
    if not map_path.exists():
        raise SystemExit(f"Field map missing — run build_mike_mighty_map.py first: {map_path}")

    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    field_map = json.loads(map_path.read_text(encoding="utf-8"))
    db = cosmos_db()
    pk = PartitionKey(path="/id")

    defs_c = db.create_container_if_not_exists(id="site-survey-definitions", partition_key=pk)
    asg_c = db.create_container_if_not_exists(id="site-survey-assignments", partition_key=pk)
    rsp_c = db.create_container_if_not_exists(id="site-survey-responses", partition_key=pk)
    profiles_c = db.create_container_if_not_exists(id="site-profiles", partition_key=pk)
    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")

    live_sites = list(
        sites_c.query_items(
            "SELECT c.id, c.name, c.piName, c.pi, c.principalInvestigator FROM c",
            enable_cross_partition_query=True,
        )
    )
    legacy_sites = list(
        legacy_c.query_items(
            "SELECT c.id, c.name, c.piName, c.pi, c.linkedArtemisSiteId FROM c",
            enable_cross_partition_query=True,
        )
    )

    survey = defs_c.read_item(SURVEY_ID, SURVEY_ID)
    survey_qs = survey.get("questions") or []

    now = iso_now()
    live_by_id = {s.get("id"): s for s in live_sites if s.get("id")}
    rows = []
    for pack_site in pack.get("sites") or []:
        priority_id = pack_site.get("site_id") or ""
        alias = HAND_ALIASES.get(priority_id)
        if alias and alias.get("siteId") in live_by_id:
            site = live_by_id[alias["siteId"]]
            site_id, how, score, match_name = (
                site["id"],
                "hand-alias",
                1.0,
                site.get("name"),
            )
        else:
            site_id, how, score, match_name = match_site(
                pack_site.get("practice_name") or "",
                pack_site.get("pi_name") or "",
                live_sites,
                legacy_sites,
            )
        answers = build_answers(pack_site, field_map, survey_qs)
        with_lib = sum(1 for a in answers if a.get("libraryQuestionId"))
        rows.append(
            {
                "priorityId": priority_id,
                "practiceName": pack_site.get("practice_name"),
                "piName": pack_site.get("pi_name"),
                "matchedSiteId": site_id,
                "matchedSiteName": match_name,
                "matchHow": how,
                "matchScore": score,
                "answerCount": len(answers),
                "answersWithLibraryId": with_lib,
                "unmatched": site_id is None,
                "willCreateStub": site_id is None,
            }
        )

    matched = [r for r in rows if r["matchedSiteId"]]
    unmatched = [r for r in rows if not r["matchedSiteId"]]
    print(f"Pack sites: {len(rows)}  matched: {len(matched)}  unmatched: {len(unmatched)}")
    print(
        f"Field map: {field_map.get('mappedPackPaths')}/{field_map.get('packPathCount')} "
        f"({field_map.get('mappedPct')}%)"
    )
    for r in matched:
        if r["matchHow"] == "hand-alias" or r["matchScore"] >= 0.9:
            print(
                f"  {r['matchScore']:.2f} {r['matchHow']:22s}  "
                f"{(r['practiceName'] or '')[:36]:36s} -> {(r['matchedSiteName'] or '')[:36]}  "
                f"({r['answerCount']} ans, {r['answersWithLibraryId']} lib)"
            )
    if unmatched:
        print(f"Unmatched (will create live stubs on --apply): {len(unmatched)}")
        for r in unmatched:
            print(f"  {r['priorityId']}  {r['practiceName']} ({r['piName']})")

    report = {
        "generatedAt": now,
        "source": SOURCE,
        "surveyId": SURVEY_ID,
        "matched": len(matched),
        "unmatched": len(unmatched),
        "handAliases": list(HAND_ALIASES.keys()),
        "rows": rows,
    }
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {REPORT}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write Cosmos.")
        return

    # 1) Field map lives in Cosmos
    map_doc = {
        **field_map,
        "id": FIELD_MAP_DOC_ID,
        "type": "fieldMap",
        "isConfig": True,
        "status": "config",
        "title": "Mike Mighty / ReBUILD field map",
        "source": SOURCE,
        "updatedAt": now,
    }
    # avoid showing in survey pickers
    map_doc.pop("questions", None)
    defs_c.upsert_item(map_doc)
    print(f"Upserted field map doc {FIELD_MAP_DOC_ID}")

    # 2) Create live stubs for still-unmatched pack sites
    created_stubs = []
    pack_by_id = {s.get("site_id"): s for s in (pack.get("sites") or [])}
    for row in rows:
        if row["matchedSiteId"]:
            continue
        pack_site = pack_by_id.get(row["priorityId"])
        if not pack_site:
            continue
        stub = build_live_stub(pack_site)
        sites_c.create_item(stub)
        live_sites.append(stub)
        live_by_id[stub["id"]] = stub
        row["matchedSiteId"] = stub["id"]
        row["matchedSiteName"] = stub.get("name")
        row["matchHow"] = "created-stub"
        row["matchScore"] = 1.0
        row["unmatched"] = False
        row["willCreateStub"] = False
        created_stubs.append(
            {
                "priorityId": row["priorityId"],
                "siteId": stub["id"],
                "name": stub.get("name"),
                "pi": stub.get("pi"),
            }
        )
        print(f"Created stub {stub['id']} for {row['priorityId']} {stub.get('name')}")

    written = 0
    for pack_site, row in zip(pack.get("sites") or [], rows):
        site_id = row["matchedSiteId"]
        if not site_id:
            continue
        answers = build_answers(pack_site, field_map, survey_qs)
        # Key by Mike priority id so two pack PIs at one Artemis site never overwrite each other
        priority_slug = slug(pack_site.get("site_id") or row["priorityId"] or site_id)
        asg_id = f"asg-mike-rebuild-{priority_slug}"
        rsp_id = f"rsp-mike-rebuild-{priority_slug}"
        assignment = {
            "id": asg_id,
            "surveyId": SURVEY_ID,
            "siteId": site_id,
            "targetRole": "pi",
            "status": "submitted",
            "source": SOURCE,
            "mikePriorityId": pack_site.get("site_id"),
            "createdAt": now,
            "updatedAt": now,
            "submittedAt": now,
        }
        response = {
            "id": rsp_id,
            "assignmentId": asg_id,
            "surveyId": SURVEY_ID,
            "siteId": site_id,
            "targetRole": "pi",
            "displayName": pack_site.get("pi_name") or pack_site.get("practice_name"),
            "answers": answers,
            "source": SOURCE,
            "mikePriorityId": pack_site.get("site_id"),
            "mikePracticeName": pack_site.get("practice_name"),
            "answerCount": len(answers),
            "answersWithLibraryId": sum(1 for a in answers if a.get("libraryQuestionId")),
            "createdAt": now,
            "updatedAt": now,
            "submittedAt": now,
        }
        asg_c.upsert_item(assignment)
        rsp_c.upsert_item(response)

        # site-profiles: one profile per Artemis site; merge Mike packs by priority id
        profile_id = site_id
        try:
            profile = profiles_c.read_item(profile_id, profile_id)
        except Exception:
            profile = {
                "id": profile_id,
                "siteId": site_id,
                "schemaVersion": "1.1",
                "createdAt": now,
                "source": SOURCE,
            }
        mike_pack = build_profile_mike_pack(pack_site, field_map, answers)
        packs = dict(profile.get("mikePacks") or {})
        packs[str(pack_site.get("site_id") or priority_slug)] = mike_pack
        profile["mikePacks"] = packs
        # Keep latest as mikePack for back-compat
        profile["mikePack"] = mike_pack
        profile["updatedAt"] = now
        if pack_site.get("practice_name") and not profile.get("institution_name"):
            profile["institution_name"] = pack_site.get("practice_name")
        inds = list(profile.get("indicationsCovered") or [])
        for ind in pack_site.get("indications_covered") or []:
            if ind and ind not in inds:
                inds.append(ind)
        profile["indicationsCovered"] = inds
        profiles_c.upsert_item(profile)
        written += 1

    # Archive stale Mike responses so prefill cannot prefer old site-keyed junk
    # over the priority-id docs we just wrote (two pack PIs may share one site).
    keep_rsp_ids = set()
    site_ids_touched = set()
    for pack_site, row in zip(pack.get("sites") or [], rows):
        site_id = row.get("matchedSiteId")
        if not site_id:
            continue
        site_ids_touched.add(site_id)
        priority_slug = slug(pack_site.get("site_id") or row["priorityId"] or site_id)
        keep_rsp_ids.add(f"rsp-mike-rebuild-{priority_slug}")
        keep_rsp_ids.add(f"asg-mike-rebuild-{priority_slug}")

    archived = 0
    for site_id in site_ids_touched:
        stale = list(
            rsp_c.query_items(
                query=(
                    "SELECT * FROM c WHERE c.siteId = @sid AND c.source = @src "
                    "AND (NOT IS_DEFINED(c._archived) OR c._archived != true)"
                ),
                parameters=[
                    {"name": "@sid", "value": site_id},
                    {"name": "@src", "value": SOURCE},
                ],
                enable_cross_partition_query=True,
            )
        )
        for doc in stale:
            did = doc.get("id")
            if did in keep_rsp_ids:
                continue
            doc["_archived"] = True
            doc["archivedAt"] = now
            doc["archivedReason"] = "superseded-by-priority-keyed-mike-ingest"
            doc["updatedAt"] = now
            rsp_c.upsert_item(doc)
            archived += 1
        stale_asg = list(
            asg_c.query_items(
                query=(
                    "SELECT * FROM c WHERE c.siteId = @sid AND c.source = @src "
                    "AND (NOT IS_DEFINED(c._archived) OR c._archived != true)"
                ),
                parameters=[
                    {"name": "@sid", "value": site_id},
                    {"name": "@src", "value": SOURCE},
                ],
                enable_cross_partition_query=True,
            )
        )
        for doc in stale_asg:
            did = doc.get("id")
            if did in keep_rsp_ids:
                continue
            doc["_archived"] = True
            doc["archivedAt"] = now
            doc["archivedReason"] = "superseded-by-priority-keyed-mike-ingest"
            doc["updatedAt"] = now
            asg_c.upsert_item(doc)
            archived += 1

    report.update(
        {
            "status": "applied",
            "createdStubs": created_stubs,
            "written": written,
            "archivedStaleMikeDocs": archived,
            "matchedAfter": sum(1 for r in rows if r.get("matchedSiteId")),
            "unmatchedAfter": sum(1 for r in rows if not r.get("matchedSiteId")),
            "rows": rows,
        }
    )
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(
        f"Applied: {written} site responses + profiles; "
        f"created {len(created_stubs)} stubs; archived {archived} stale Mike docs. "
        f"Field map in Cosmos."
    )
    print("No Chaos scheduling fields were modified.")


if __name__ == "__main__":
    main()
