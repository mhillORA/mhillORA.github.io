"""
Ingest Ora_Feasibility_Data_All_Sites JSON into ARTEMIS Cosmos (legacy-only).

Writes (additive — does not delete existing survey-general-feasibility):
  legacy-sites              match or create; indicationsCovered / therapeuticAreas
  site-survey-definitions   one per source_tab / study (+ indication)
  site-survey-assignments   keyed by legacy site id
  site-survey-responses     keyed by legacy site id (+ indication)
  site-profiles             keyed by legacy site id (Budget Buddy later)

NEVER writes the shared `sites` container (Chaos-visible).

Match order: email -> alias -> name -> PI -> address -> legacy name
Phone-as-name sites: recover via address/PI.

Usage:
  python ingest/feasibility_master_ingest.py
  python ingest/feasibility_master_ingest.py --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

try:
    from azure.cosmos import CosmosClient, PartitionKey
except ImportError:
    print("Install: pip install azure-cosmos")
    sys.exit(1)

DEFAULT_JSON = Path(
    r"C:\Users\shue1\Downloads\drive-download-20260825T174506Z-1-001\Ora_Feasibility_Data_All_Sites_2.json"
)
CROSSWALK_PATH = Path(__file__).resolve().parent / "feasibility_monday_profile_crosswalk.json"
ALIASES_PATH = Path(__file__).resolve().parent / "general_feasibility_site_aliases.json"
SCHEMA_PATH = Path(
    r"C:\Users\shue1\Downloads\drive-download-20260825T174506Z-1-001\Site_Profile_Field_Schema_3.json"
)

SOURCE = "feasibility-master-ingest"
ENDPOINT = os.environ.get("COSMOS_ENDPOINT", "https://ora-clinical-recruiting.documents.azure.com:443/")
KEY = os.environ.get("COSMOS_KEY", "")
DATABASE_ID = os.environ.get("DATABASE_ID", "crcscheduling")

PHONE_RE = re.compile(r"^[\d\s().+\-extEXT#]+$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LEGAL_SUFFIX = re.compile(
    r"\b(llc|inc|incorporated|ltd|limited|pc|p\.c|pa|p\.a|sc|s\.c|pllc|llp|dba)\b",
    re.I,
)
ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
STATE_RE = re.compile(
    r"\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b",
    re.I,
)


def load_key():
    global KEY, ENDPOINT, DATABASE_ID
    if KEY:
        return
    repo = Path(__file__).resolve().parents[1]
    for p in (
        repo / "data-api-connections.json",
        repo / "api" / "local.settings.json",
        Path(r"C:\Users\shue1\OneDrive\Desktop\HoldAll\CHAOS\azure-api-fixed\local.settings.json"),
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


def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(s: str, max_len: int = 48) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", (s or "").strip().lower()).strip("-")
    return (t or "x")[:max_len]


def norm_name(s: str) -> str:
    t = (s or "").strip().lower().replace("&", " and ")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = LEGAL_SUFFIX.sub(" ", t)
    return re.sub(r"\s+", " ", t).strip()


def norm_email(s: str) -> str:
    return (s or "").strip().lower()


def norm_pi(s: str) -> str:
    t = (s or "").strip().lower()
    t = re.sub(r"\b(md|phd|do|od|mba|rn|fnp|pa-c|jr|sr|ii|iii|iv)\b\.?", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def norm_addr(s: str) -> str:
    t = (s or "").strip().lower()
    t = t.replace(" street", " st").replace(" avenue", " ave").replace(" road", " rd")
    t = t.replace(" boulevard", " blvd").replace(" suite", " ste").replace(" drive", " dr")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def is_phone_name(name: str) -> bool:
    n = (name or "").strip()
    return bool(n and PHONE_RE.match(n) and sum(c.isdigit() for c in n) >= 7)


def is_unusable_name(name: str) -> str | None:
    n = (name or "").strip()
    if not n:
        return "empty"
    if len(n) < 3:
        return "too_short"
    if is_phone_name(n):
        return "phone"
    if EMAIL_RE.match(n):
        return "email"
    if re.fullmatch(r"[\d\W_]+", n):
        return "digits_punct"
    if n.lower() in {"n/a", "na", "none", "unknown", "test", "tbd"}:
        return "placeholder"
    return None


def parse_address_blob(blob: str) -> dict:
    raw = (blob or "").strip()
    if not raw:
        return {}
    # drop emails mistaken as address
    if EMAIL_RE.match(raw) or "@" in raw and len(raw) < 80:
        return {}
    zip_m = ZIP_RE.search(raw)
    state_m = STATE_RE.search(raw)
    city = ""
    street = raw
    if state_m:
        before = raw[: state_m.start()].rstrip(" ,")
        parts = re.split(r",\s*", before)
        if len(parts) >= 2:
            street = ", ".join(parts[:-1]).strip()
            city = parts[-1].strip()
        else:
            street = before
    return {
        "address_street": street or None,
        "address_city": city or None,
        "address_state": (state_m.group(1).upper() if state_m else None),
        "address_zip": (zip_m.group(1) if zip_m else None),
        "address_raw": raw,
    }


def to_bool(v) -> bool | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in {"yes", "y", "true", "1"}:
        return True
    if s in {"no", "n", "false", "0"}:
        return False
    return None


def to_number(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip().replace(",", "")
    m = re.search(r"-?\d+(\.\d+)?", s)
    if not m:
        return None
    num = m.group(0)
    return int(num) if "." not in num else float(num)


def site_type_enum(v):
    if not v:
        return None
    s = str(v).strip().lower()
    mapping = {
        "private": "Private Practice",
        "private practice": "Private Practice",
        "dedicated": "Dedicated Research Center",
        "research": "Dedicated Research Center",
        "academic": "Academic Medical Center",
        "university": "Academic Medical Center",
        "hospital": "Hospital-Based",
        "community": "Community Health Center",
    }
    for k, out in mapping.items():
        if k in s:
            return out
    return str(v).strip()


def irb_type_from_yes_no(v):
    b = to_bool(v)
    if b is True:
        return "Central"
    if b is False:
        return "Local"
    if v:
        return str(v).strip()
    return None


def survey_def_id(source_platform: str, source_tab: str, study_name: str) -> str:
    plat = "sm" if "survey" in (source_platform or "").lower() else "mon"
    base = study_name or source_tab or "unknown"
    return f"survey-feas-{plat}-{slugify(base)}"[:64]


def assignment_id(survey_id: str, site_id: str) -> str:
    h = hashlib.sha1(f"{survey_id}|{site_id}".encode()).hexdigest()[:10]
    return f"asg-feas-{h}"


def response_id(survey_id: str, site_id: str, source_tab: str) -> str:
    h = hashlib.sha1(f"{survey_id}|{site_id}|{source_tab}".encode()).hexdigest()[:12]
    return f"rsp-feas-{h}"


def legacy_site_id(name: str) -> str:
    return f"legacy-site-feas-{slugify(name)}"[:64]


def new_artemis_site_id(name: str) -> str:
    h = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
    return f"site-feas-{h}"


def load_aliases() -> dict[str, str]:
    if not ALIASES_PATH.exists():
        return {}
    raw = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))
    return {str(k): str(v) for k, v in raw.items() if not str(k).startswith("_") and v}


def is_address_like_name(name: str) -> bool:
    """True when a 'name' is really a street address (not a practice name)."""
    n = (name or "").strip()
    if not n:
        return True
    if is_phone_name(n) or EMAIL_RE.match(n):
        return True
    # "123 Main St…" / "123 Main Street, City, ST 12345"
    if re.match(
        r"^\d+\s+.+\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|hwy|pkwy|parkway|circle|cir|suite|ste)\b",
        n,
        re.I,
    ):
        return True
    if ZIP_RE.search(n) and re.search(
        r"\b(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|suite|ste)\b", n, re.I
    ):
        return True
    return False


def preferred_display_name(ident_bits: dict) -> str | None:
    """Never use a raw street address as the site title."""
    names = [n for n in (ident_bits.get("names") or []) if n and not is_address_like_name(n) and not is_unusable_name(n)]
    if names:
        return sorted(names, key=lambda x: (-len(x), x))[0]

    pis = ident_bits.get("pis") or []
    addrs = ident_bits.get("addresses") or []
    city = ""
    if addrs:
        city = (addrs[0].get("address_city") or "") if isinstance(addrs[0], dict) else ""
    if not city and addrs and isinstance(addrs[0], dict) and addrs[0].get("address_raw"):
        city = parse_address_blob(addrs[0]["address_raw"]).get("address_city") or ""

    if pis:
        pi = pis[0]
        return f"{pi} - {city}" if city else f"{pi} (site)"

    if city:
        return f"Site in {city}"

    # last resort: keep non-address canonical if any
    canonical = ident_bits.get("canonical_name") or ""
    if canonical and not is_address_like_name(canonical) and not is_unusable_name(canonical):
        return canonical
    return None


def extract_site_identity(site_key: str, site: dict) -> dict:
    """Pull best display name, addresses, PIs, emails from nested surveys."""
    canonical = (site.get("canonical_name") or site_key or "").strip()
    names = set()
    if canonical and not is_unusable_name(canonical) and not is_address_like_name(canonical):
        names.add(canonical)
    for n in site.get("names_used") or []:
        if n and not is_unusable_name(str(n)) and not is_address_like_name(str(n)):
            names.add(str(n).strip())

    addresses = []
    pis = []
    emails = set()
    phones = set()

    for sv in site.get("surveys") or []:
        if sv.get("pi_name"):
            pis.append(str(sv["pi_name"]).strip())
        resp = sv.get("responses") or {}
        for k, v in resp.items():
            if v is None or str(v).strip() == "":
                continue
            val = str(v).strip()
            lk = k.lower()
            if "email" in lk and "@" in val:
                emails.add(norm_email(val))
            if lk in {"phone", "site phone"} or (lk.endswith("phone") and "@" not in val):
                phones.add(val)
            if "address" in lk and "email" not in lk:
                addresses.append(val)
            if "site name" in lk and not is_unusable_name(val) and not is_address_like_name(val):
                names.add(val)
            if ("principal investigator" in lk and "name" in lk) or lk.startswith("investigator #"):
                if not EMAIL_RE.match(val) and not is_address_like_name(val):
                    pis.append(val)

    parsed_addrs = [parse_address_blob(a) for a in addresses]
    parsed_addrs = [a for a in parsed_addrs if a]

    bits = {
        "site_key": site_key,
        "canonical_name": canonical,
        "names": sorted(names),
        "pis": sorted({p for p in pis if p}),
        "emails": sorted(emails),
        "phones": sorted(phones),
        "addresses_raw": addresses,
        "addresses": parsed_addrs,
    }
    display = preferred_display_name(bits)

    return {
        **bits,
        "display_name": display,
        "name_unusable_reason": is_unusable_name(canonical) or ("address_as_name" if is_address_like_name(canonical) else None),
        "surveys": site.get("surveys") or [],
        "raw": site,
    }


def name_score(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        if min(len(na), len(nb)) >= 10:
            return 0.92
    ta, tb = set(na.split()), set(nb.split())
    jacc = len(ta & tb) / len(ta | tb) if ta and tb else 0
    seq = SequenceMatcher(None, na, nb).ratio()
    return (jacc * 0.55) + (seq * 0.45)


def pi_score(a: str, b: str) -> float:
    na, nb = norm_pi(a), norm_pi(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    if not ta or not tb:
        return 0.0
    # last-name focused
    if ta & tb and (list(ta)[-1] in tb or list(tb)[-1] in ta):
        return max(0.88, SequenceMatcher(None, na, nb).ratio())
    return SequenceMatcher(None, na, nb).ratio()


def address_score(parsed: dict, site: dict) -> float:
    if not parsed:
        return 0.0
    score = 0.0
    weight = 0.0
    city = norm_name(parsed.get("address_city") or "")
    state = (parsed.get("address_state") or "").upper()
    z = parsed.get("address_zip") or ""
    street = norm_addr(parsed.get("address_street") or "")

    scity = norm_name(site.get("city") or "")
    sstate = (site.get("state") or "").upper()
    sz = str(site.get("zip") or site.get("zipCode") or "")
    sstreet = norm_addr(
        " ".join(x for x in [site.get("address1") or "", site.get("address2") or ""] if x)
    )

    if city and scity:
        weight += 0.35
        if city == scity:
            score += 0.35
        elif city in scity or scity in city:
            score += 0.25
    if state and sstate:
        weight += 0.2
        if state == sstate:
            score += 0.2
    if z and sz:
        weight += 0.25
        if z == sz[:5]:
            score += 0.25
    if street and sstreet:
        weight += 0.35
        seq = SequenceMatcher(None, street, sstreet).ratio()
        if seq >= 0.75:
            score += 0.35 * seq
    if weight == 0:
        return 0.0
    return score / max(weight, 0.01) * (weight / 1.15)  # scale


def build_artemis_indexes(sites, staff, legacy):
    by_id = {s["id"]: s for s in sites}
    email_index = {}
    for s in sites:
        for k in ("piEmail", "pi2Email", "pi3Email", "siteCoordinatorEmail", "siteCoordinator2Email", "siteCoordinator3Email"):
            e = norm_email(s.get(k) or "")
            if e:
                email_index[e] = s
    for st in staff:
        e = norm_email(st.get("email") or "")
        sid = st.get("siteId")
        if e and sid and sid in by_id:
            email_index[e] = by_id[sid]

    pi_index = []
    for s in sites:
        if s.get("pi"):
            pi_index.append((norm_pi(s["pi"]), s, "site.pi"))
    for st in staff:
        if str(st.get("role") or "").lower() == "pi" and st.get("name") and st.get("siteId") in by_id:
            pi_index.append((norm_pi(st["name"]), by_id[st["siteId"]], "staff.pi"))

    return by_id, email_index, pi_index, legacy


def match_identity(ident, sites, email_index, pi_index, legacy, alias_to_site):
    # 1) email
    for e in ident["emails"]:
        hit = email_index.get(e)
        if hit:
            return hit, "email", 1.0, "artemis"

    # 2) alias (by display / names)
    for n in [ident.get("display_name"), *ident.get("names", [])]:
        if not n:
            continue
        target = alias_to_site.get(n) or alias_to_site.get(norm_name(n))
        if target:
            # target may be site id or name
            for s in sites:
                if s["id"] == target or norm_name(s.get("name")) == norm_name(target) or s.get("name") == target:
                    return s, "alias", 0.99, "artemis"

    # 3) name
    scored = []
    candidates = [ident.get("display_name"), *ident.get("names", [])]
    for s in sites:
        best = 0.0
        for n in candidates:
            if n:
                best = max(best, name_score(n, s.get("name") or ""))
                abbr = s.get("siteNameAbbreviation") or ""
                if abbr:
                    best = max(best, name_score(n, abbr))
        if best >= 0.86:
            scored.append((best, s))
    scored.sort(key=lambda x: -x[0])
    if scored and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.08):
        return scored[0][1], "name", scored[0][0], "artemis"

    # 4) PI
    pi_hits = []
    for p in ident["pis"]:
        for npi, s, how in pi_index:
            sc = pi_score(p, npi)
            if sc >= 0.9:
                pi_hits.append((sc, s, how))
    pi_hits.sort(key=lambda x: -x[0])
    if pi_hits:
        # unique site?
        top_sites = {h[1]["id"]: h for h in pi_hits if h[0] >= 0.9}
        if len(top_sites) == 1:
            h = next(iter(top_sites.values()))
            return h[1], f"pi:{h[2]}", h[0], "artemis"

    # 5) address
    addr_hits = []
    for parsed in ident["addresses"]:
        for s in sites:
            sc = address_score(parsed, s)
            if sc >= 0.72:
                addr_hits.append((sc, s))
    addr_hits.sort(key=lambda x: -x[0])
    if addr_hits and (len(addr_hits) == 1 or addr_hits[0][0] - addr_hits[1][0] >= 0.08):
        return addr_hits[0][1], "address", addr_hits[0][0], "artemis"

    # 6) legacy name
    leg_hits = []
    for leg in legacy:
        best = 0.0
        for n in candidates:
            if n:
                best = max(best, name_score(n, leg.get("name") or ""))
        if best >= 0.9:
            leg_hits.append((best, leg))
    leg_hits.sort(key=lambda x: -x[0])
    if leg_hits and (len(leg_hits) == 1 or leg_hits[0][0] - leg_hits[1][0] >= 0.08):
        leg = leg_hits[0][1]
        linked = leg.get("linkedArtemisSiteId")
        if linked:
            for s in sites:
                if s["id"] == linked:
                    return s, "legacy-linked", leg_hits[0][0], "artemis"
        return leg, "legacy-name", leg_hits[0][0], "legacy"

    if scored:
        return None, "ambiguous-name", scored[0][0], None
    return None, "unmatched", 0.0, None


def responses_to_questions_and_answers(responses: dict):
    questions = []
    answers = []
    date_full = re.compile(r"^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?$")
    slash_date = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")

    def is_excel_date(val: str) -> bool:
        s = (val or "").strip()
        return bool(date_full.match(s) or slash_date.match(s))

    def is_date_label(label: str) -> bool:
        lab = (label or "").lower()
        if "update" in lab:
            return False
        return bool(re.search(r"\bdate\b|completion date|start date|end date", lab))

    for i, (label, value) in enumerate(responses.items()):
        if not label or str(label).strip().lower() == "form view":
            continue
        # Skip option headers that are themselves Excel dates (matrix corruption)
        if is_excel_date(str(label).strip()) or re.search(r"\|\s*\d{4}-\d{1,2}-\d{1,2}", str(label)):
            # still keep the field if it has a real non-date value; scrub label tail
            label = re.sub(r"\s*\|\s*\d{4}-\d{1,2}-\d{1,2}.*$", "", str(label)).strip() or label
        qid = f"q_{i:03d}_{slugify(label, 40)}"
        val = None if value is None or str(value).strip() == "" else str(value).strip()
        # Drop Excel datetimes dumped into count/text fields
        if val and is_excel_date(val) and not is_date_label(label):
            val = None
        # infer type lightly
        qtype = "textarea" if val and len(val) > 100 else "text"
        if val and val.lower() in {"yes", "no"}:
            qtype = "select"
        if val and is_date_label(label) and is_excel_date(val):
            qtype = "date"
        questions.append({
            "id": qid,
            "label": label,
            "type": qtype,
            "required": False,
            "options": ["Yes", "No"] if qtype == "select" else [],
            "logic": None,
        })
        answers.append({
            "questionId": qid,
            "label": label,
            "type": qtype,
            "skipped": val is None,
            "value": val,
        })
    return questions, answers


def apply_crosswalk(monday_responses: dict, crosswalk: dict) -> dict:
    profile = {
        "investigators": [],
        "contacts": [],
        "indication": {},
        "equipment_list": [],
    }
    inv_by_idx = {}
    contacts_by_role = {}

    for rule in crosswalk.get("fields") or []:
        monday = rule.get("monday")
        if not monday or monday in (crosswalk.get("skip_monday_fields") or []):
            continue
        raw = monday_responses.get(monday)
        if raw is None or str(raw).strip() == "":
            continue
        transform = rule.get("transform") or "string"
        target = rule.get("profile") or ""
        layer = rule.get("layer") or "profile"

        value = raw
        if transform == "string":
            value = str(raw).strip()
        elif transform == "email":
            value = norm_email(str(raw))
        elif transform == "number":
            value = to_number(raw)
        elif transform == "number_or_count_text":
            value = to_number(raw)
            if value is None and raw:
                value = str(raw).strip()
        elif transform == "boolean_yes_no":
            value = to_bool(raw)
        elif transform == "boolean_or_string":
            b = to_bool(raw)
            value = b if b is not None else str(raw).strip()
        elif transform == "site_type_enum":
            value = site_type_enum(raw)
        elif transform == "irb_type_from_yes_no":
            value = irb_type_from_yes_no(raw)
        elif transform == "date":
            value = str(raw).strip()
        elif transform == "string_or_list":
            value = [x.strip() for x in str(raw).split(",") if x.strip()]
        elif transform == "equipment_notes":
            profile.setdefault("_equipment_notes", str(raw).strip())
            continue
        elif transform.startswith("address_"):
            parsed = parse_address_blob(str(raw))
            key = transform.replace("_from_blob", "")
            # address_street_from_blob -> address_street
            field = key.replace("address_", "address_", 1)
            # transform names: address_street_from_blob
            field = transform.replace("_from_blob", "")
            value = parsed.get(field)
            if value:
                profile[field] = value
            if parsed.get("address_raw") and "address_raw" not in profile:
                profile["address_raw"] = parsed["address_raw"]
            continue
        else:
            value = str(raw).strip()

        if value is None or value == "":
            continue

        if target.startswith("investigators["):
            m = re.match(r"investigators\[(\d+)\]\.(\w+)", target)
            if m:
                idx, field = int(m.group(1)), m.group(2)
                inv_by_idx.setdefault(idx, {"is_primary": idx == 0})
                inv_by_idx[idx][field] = value
        elif target.startswith("contacts["):
            m = re.match(r"contacts\[(\w+)\]\.(\w+)", target)
            if m:
                role, field = m.group(1), m.group(2)
                contacts_by_role.setdefault(role, {"role": role})
                contacts_by_role[role][field] = value
        elif target.startswith("indication."):
            # indication.DED.patient_database
            parts = target.split(".")
            if len(parts) >= 3:
                ta, field = parts[1], parts[2]
                profile["indication"].setdefault(ta, {})[field] = value
        elif layer == "indication":
            profile.setdefault("indication_misc", {})[target] = value
        else:
            profile[target] = value

        also = rule.get("also_set") or {}
        for k, how in also.items():
            if how == "boolean_from_nonempty":
                profile[k] = True

    profile["investigators"] = [inv_by_idx[i] for i in sorted(inv_by_idx)]
    profile["contacts"] = list(contacts_by_role.values())
    notes = profile.pop("_equipment_notes", None)
    if notes:
        profile["equipment_list"] = [{"name": "Listed equipment", "notes": notes, "owned": None}]
    return profile


def merge_profile(existing: dict | None, incoming: dict, site_id: str, display_name: str) -> dict:
    base = dict(existing or {})
    base["id"] = site_id
    base["siteId"] = site_id
    base["schemaVersion"] = "1.0"
    base["updatedAt"] = iso_now()
    if not base.get("createdAt"):
        base["createdAt"] = iso_now()
    base["source"] = SOURCE

    # shallow merge with preference for non-empty incoming
    for k, v in incoming.items():
        if k in {"investigators", "contacts", "indication", "equipment_list"}:
            continue
        if v is None or v == "" or v == []:
            continue
        if k not in base or base[k] in (None, "", [], {}):
            base[k] = v
        elif isinstance(v, str) and isinstance(base.get(k), str) and len(v) > len(base[k]):
            base[k] = v

    if incoming.get("institution_name"):
        base["institution_name"] = incoming["institution_name"]
    elif not base.get("institution_name"):
        base["institution_name"] = display_name

    # investigators: merge by index/name
    inv = list(base.get("investigators") or [])
    for i, person in enumerate(incoming.get("investigators") or []):
        if i < len(inv):
            merged = dict(inv[i])
            for pk, pv in person.items():
                if pv not in (None, ""):
                    merged[pk] = pv
            inv[i] = merged
        else:
            inv.append(person)
    base["investigators"] = inv

    contacts = list(base.get("contacts") or [])
    by_role = {c.get("role"): dict(c) for c in contacts if c.get("role")}
    for c in incoming.get("contacts") or []:
        role = c.get("role") or "research"
        cur = by_role.get(role, {"role": role})
        for pk, pv in c.items():
            if pv not in (None, ""):
                cur[pk] = pv
        by_role[role] = cur
    base["contacts"] = list(by_role.values())

    ind = dict(base.get("indication") or {})
    for ta, fields in (incoming.get("indication") or {}).items():
        ind.setdefault(ta, {}).update({k: v for k, v in fields.items() if v not in (None, "")})
    base["indication"] = ind

    if incoming.get("equipment_list") and not base.get("equipment_list"):
        base["equipment_list"] = incoming["equipment_list"]

    base["study_responses"] = list(base.get("study_responses") or [])
    return base


def fetch_all(container, query="SELECT * FROM c"):
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def ensure_containers(db):
    """ARTEMIS-only containers. Never creates/writes the shared `sites` container."""
    db.create_container_if_not_exists(id="site-profiles", partition_key=PartitionKey(path="/id"))
    db.create_container_if_not_exists(id="site-survey-definitions", partition_key=PartitionKey(path="/id"))
    db.create_container_if_not_exists(id="site-survey-assignments", partition_key=PartitionKey(path="/id"))
    db.create_container_if_not_exists(id="site-survey-responses", partition_key=PartitionKey(path="/id"))
    db.create_container_if_not_exists(id="legacy-sites", partition_key=PartitionKey(path="/id"))


def indication_of(study_or_sv) -> str | None:
    if not study_or_sv:
        return None
    if isinstance(study_or_sv, dict) and "study" in study_or_sv and "indication" not in study_or_sv:
        study_or_sv = study_or_sv.get("study") or {}
    ind = (study_or_sv or {}).get("indication")
    if ind is None:
        return None
    s = str(ind).strip()
    return s or None


def main():
    ap = argparse.ArgumentParser(description="Ingest feasibility master JSON into ARTEMIS")
    ap.add_argument("json_path", nargs="?", default=str(DEFAULT_JSON))
    ap.add_argument("--apply", action="store_true", help="Write to Cosmos (default: dry-run)")
    ap.add_argument("--report", default="", help="Write match report JSON path")
    args = ap.parse_args()

    path = Path(args.json_path)
    if not path.exists():
        raise SystemExit(f"JSON not found: {path}")

    load_key()
    if not KEY:
        raise SystemExit("COSMOS_KEY missing")

    data = json.loads(path.read_text(encoding="utf-8"))
    crosswalk = json.loads(CROSSWALK_PATH.read_text(encoding="utf-8"))
    aliases = load_aliases()

    client = CosmosClient(ENDPOINT, credential=KEY)
    db = client.get_database_client(DATABASE_ID)
    if args.apply:
        ensure_containers(db)

    sites_c = db.get_container_client("sites")
    legacy_c = db.get_container_client("legacy-sites")
    try:
        staff = fetch_all(db.get_container_client("site-staff"))
    except Exception:
        staff = []

    artemis_sites = fetch_all(sites_c)
    legacy_sites = fetch_all(legacy_c)
    _, email_index, pi_index, _ = build_artemis_indexes(artemis_sites, staff, legacy_sites)

    identities = []
    for key, site in (data.get("sites") or {}).items():
        identities.append(extract_site_identity(key, site))

    match_stats = Counter()
    skip_examples = []
    plan = []  # per identity — always targets legacy-sites (never writes shared `sites`)

    def resolve_legacy_bucket(hit, realm, method, score, ident):
        """Map a match onto a legacy-sites id. Never create ARTEMIS `sites` docs."""
        site_name = (
            ident["display_name"]
            or preferred_display_name(ident)
            or (ident["canonical_name"] if ident.get("canonical_name") and not is_address_like_name(ident["canonical_name"]) and not is_unusable_name(ident["canonical_name"]) else None)
            or "Unnamed feasibility site"
        )
        if hit and realm == "artemis":
            for leg in legacy_sites:
                if leg.get("linkedArtemisSiteId") == hit["id"]:
                    return {
                        "legacy_id": leg["id"],
                        "site_name": leg.get("name") or hit.get("name") or site_name,
                        "create_legacy": False,
                        "linkedArtemisSiteId": hit["id"],
                        "method": f"artemis_{method}->existing_legacy",
                        "score": score,
                    }
            return {
                "legacy_id": legacy_site_id(hit.get("name") or site_name),
                "site_name": hit.get("name") or site_name,
                "create_legacy": True,
                "linkedArtemisSiteId": hit["id"],
                "method": f"artemis_{method}->new_legacy",
                "score": score,
            }
        if hit and realm == "legacy":
            return {
                "legacy_id": hit["id"],
                "site_name": hit.get("name") or site_name,
                "create_legacy": False,
                "linkedArtemisSiteId": hit.get("linkedArtemisSiteId"),
                "method": method,
                "score": score,
            }
        return {
            "legacy_id": legacy_site_id(site_name),
            "site_name": site_name,
            "create_legacy": True,
            "linkedArtemisSiteId": None,
            "method": method if method and method != "unmatched" else "unmatched_new_legacy",
            "score": score,
        }

    for ident in identities:
        if not ident["display_name"] and not ident["addresses"] and not ident["pis"]:
            match_stats["skipped_no_identity"] += 1
            if len(skip_examples) < 10:
                skip_examples.append({
                    "site_key": ident["site_key"],
                    "canonical_name": ident["canonical_name"],
                    "reason": "no usable name, address, or PI",
                })
            continue

        hit, method, score, realm = match_identity(
            ident, artemis_sites, email_index, pi_index, legacy_sites, aliases
        )
        bucket = resolve_legacy_bucket(hit, realm, method, score, ident)
        match_stats[bucket["method"]] += 1
        if method.startswith("ambiguous"):
            match_stats["ambiguous_treated_as_create"] += 1

        plan.append({
            "ident": ident,
            "action": "upsert_legacy",
            "site_id": bucket["legacy_id"],  # surveys/profiles key off legacy id
            "site_name": bucket["site_name"],
            "create_artemis": False,
            "create_legacy": bucket["create_legacy"],
            "linkedArtemisSiteId": bucket.get("linkedArtemisSiteId"),
            "method": bucket["method"],
            "score": bucket["score"],
            "legacy_id": bucket["legacy_id"],
        })

    # Build survey definition map from all surveys in plan
    def_map = {}  # def_id -> questions accumulator (union of labels)
    survey_ops = []  # concrete response writes

    for item in plan:
        ident = item["ident"]
        site_id = item["site_id"]
        for sv in ident["surveys"]:
            plat = sv.get("source_platform") or "unknown"
            tab = sv.get("source_tab") or "unknown"
            study = (sv.get("study") or {})
            study_name = study.get("study_name") or tab
            def_id = survey_def_id(plat, tab, study_name)
            responses = sv.get("responses") or {}
            questions, answers = responses_to_questions_and_answers(responses)
            if def_id not in def_map:
                ind = indication_of(study)
                def_map[def_id] = {
                    "id": def_id,
                    "title": study_name,
                    "audience": ["PI", "Coordinator"],
                    "status": "active",
                    "isPredefined": True,
                    "library": "feasibility",
                    "source": SOURCE,
                    "sourcePlatform": plat,
                    "sourceTab": tab,
                    "study": study,
                    "indication": ind,
                    "therapeuticArea": ind,  # TA = Indication in this dataset
                    "questions": {},
                    "createdAt": iso_now(),
                }
            # union questions by label
            for q in questions:
                def_map[def_id]["questions"][q["label"]] = q

            # remap answers to stable def question ids after union — deferred
            survey_ops.append({
                "def_id": def_id,
                "site_id": site_id,
                "site_name": item["site_name"],
                "plat": plat,
                "tab": tab,
                "study": study,
                "indication": indication_of(study),
                "pi_name": sv.get("pi_name"),
                "responses": responses,
                "answers_by_label": {a["label"]: a for a in answers},
            })

    # Finalize definitions with ordered questions
    definitions = []
    for def_id, d in def_map.items():
        qlist = []
        for i, (label, q) in enumerate(d["questions"].items()):
            q2 = dict(q)
            q2["id"] = f"q_{i:03d}_{slugify(label, 40)}"
            qlist.append(q2)
        definitions.append({
            **{k: v for k, v in d.items() if k != "questions"},
            "questions": qlist,
            "updatedAt": iso_now(),
        })

    label_to_qid = {
        d["id"]: {q["label"]: q["id"] for q in d["questions"]}
        for d in definitions
    }
    qmeta = {
        d["id"]: {q["label"]: q for q in d["questions"]}
        for d in definitions
    }

    # Profiles from Monday general via crosswalk; study-specific blobs under study_responses
    # Multiple JSON sites may collapse onto one ARTEMIS site_id — merge carefully.
    profile_by_site = {}
    for item in plan:
        ident = item["ident"]
        site_id = item["site_id"]
        incoming = {
            "institution_name": item["site_name"],
            "investigators": [],
            "contacts": [],
            "indication": {},
        }
        if ident["phones"]:
            incoming["phone"] = ident["phones"][0]
        elif is_phone_name(ident["canonical_name"]):
            incoming["phone"] = ident["canonical_name"]
        if ident["addresses"]:
            incoming.update({k: v for k, v in ident["addresses"][0].items() if v})

        study_blobs = []
        for sv in ident["surveys"]:
            plat = sv.get("source_platform") or ""
            tab = sv.get("source_tab") or ""
            study = sv.get("study") or {}
            resp = sv.get("responses") or {}
            if plat == "Monday.com" and "general" in tab.lower():
                cw = apply_crosswalk(resp, crosswalk)
                for k, v in cw.items():
                    if k in ("investigators", "contacts", "indication", "equipment_list"):
                        continue
                    if v not in (None, "", [], {}):
                        incoming[k] = v
                if cw.get("investigators"):
                    incoming["investigators"] = cw["investigators"]
                if cw.get("contacts"):
                    incoming["contacts"] = cw["contacts"]
                if cw.get("indication"):
                    incoming.setdefault("indication", {}).update(cw["indication"])
                if cw.get("equipment_list"):
                    incoming["equipment_list"] = cw["equipment_list"]
            study_blobs.append({
                "sourcePlatform": plat,
                "sourceTab": tab,
                "study": study,
                "indication": indication_of(study),
                "therapeuticArea": indication_of(study),
                "pi_name": sv.get("pi_name"),
                "surveyId": survey_def_id(plat, tab, study.get("study_name") or tab),
                "fieldCount": len(resp),
                "ingestedAt": iso_now(),
            })
        if ident["pis"] and not incoming.get("investigators"):
            incoming["investigators"] = [{"name": ident["pis"][0], "is_primary": True}]

        if site_id not in profile_by_site:
            profile_by_site[site_id] = {
                "incoming": incoming,
                "study_blobs": study_blobs,
                "display_name": item["site_name"],
                "item": item,
            }
        else:
            prev = profile_by_site[site_id]
            prev["incoming"] = merge_profile(
                prev["incoming"], incoming, site_id, item["site_name"]
            )
            seen = {b.get("surveyId") for b in prev["study_blobs"]}
            for b in study_blobs:
                if b.get("surveyId") not in seen:
                    prev["study_blobs"].append(b)
                    seen.add(b.get("surveyId"))

    # Report
    indication_counts = Counter()
    for op in survey_ops:
        indication_counts[op.get("indication") or "Unknown"] += 1

    report = {
        "generatedAt": iso_now(),
        "sourceFile": str(path),
        "apply": bool(args.apply),
        "writesSharedSitesContainer": False,
        "totals": {
            "json_sites": len(identities),
            "planned": len(plan),
            "skipped_no_identity": match_stats.get("skipped_no_identity", 0),
            "survey_definitions": len(definitions),
            "survey_responses": len(survey_ops),
            "profiles": len(profile_by_site),
            "create_legacy_sites": sum(1 for p in plan if p.get("create_legacy")),
            "link_existing_legacy": sum(1 for p in plan if not p.get("create_legacy")),
            "create_artemis_sites": 0,
        },
        "indication_counts": dict(indication_counts),
        "match_stats": dict(match_stats),
        "skip_examples": skip_examples,
        "unusable_phone_names": sum(1 for i in identities if i.get("name_unusable_reason") == "phone"),
        "sample_legacy_creates": [
            {"site_name": p["site_name"], "method": p["method"], "legacy_id": p["legacy_id"]}
            for p in plan if p.get("create_legacy")
        ][:15],
        "sample_legacy_reuse": [
            {"site_name": p["site_name"], "method": p["method"], "legacy_id": p["legacy_id"], "score": p["score"]}
            for p in plan if not p.get("create_legacy")
        ][:15],
        "definition_titles": [
            {"id": d["id"], "title": d["title"], "indication": d.get("indication")}
            for d in definitions
        ],
    }

    report_path = Path(args.report) if args.report else Path(__file__).resolve().parent / "feasibility_master_dryrun_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["totals"], indent=2))
    print("indication_counts", json.dumps(report["indication_counts"], indent=2))
    print("match_stats", json.dumps(report["match_stats"], indent=2))
    print("skip_examples", json.dumps(skip_examples, indent=2))
    print("unusable_phone_names", report["unusable_phone_names"])
    print("Wrote report", report_path)

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to write Cosmos (legacy-sites + surveys + profiles only).")
        return

    # APPLY — legacy-sites / surveys / profiles only. Never touch shared `sites`.
    defs_c = db.get_container_client("site-survey-definitions")
    asg_c = db.get_container_client("site-survey-assignments")
    rsp_c = db.get_container_client("site-survey-responses")
    prof_c = db.get_container_client("site-profiles")

    # Upsert legacy sites (preserve relationship fields on re-run)
    PRESERVE_LEGACY = (
        "relationshipPreference", "advantages", "disadvantages",
        "relationshipNotes", "notes", "siteCode", "metrics",
    )
    legacy_upserts = {}
    for item in plan:
        lid = item["legacy_id"]
        ident = item["ident"]
        addr = (ident["addresses"] or [{}])[0]
        inds = sorted({
            indication_of(sv.get("study") or {})
            for sv in ident["surveys"]
            if indication_of(sv.get("study") or {})
        })
        doc = {
            "id": lid,
            "name": item["site_name"],
            "source": SOURCE,
            "linkedArtemisSiteId": item.get("linkedArtemisSiteId"),
            "city": addr.get("address_city"),
            "state": addr.get("address_state"),
            "zip": addr.get("address_zip"),
            "address1": addr.get("address_street"),
            "pi": (ident["pis"] or [None])[0],
            "indicationsCovered": inds,
            "therapeuticAreas": inds,  # TA = Indication
            "feasibilitySurveyCount": len(ident["surveys"]),
            "updatedAt": iso_now(),
        }
        if lid not in legacy_upserts:
            legacy_upserts[lid] = doc
        else:
            prev = legacy_upserts[lid]
            prev["indicationsCovered"] = sorted(set(prev.get("indicationsCovered") or []) | set(inds))
            prev["therapeuticAreas"] = list(prev["indicationsCovered"])
            prev["feasibilitySurveyCount"] = (prev.get("feasibilitySurveyCount") or 0) + len(ident["surveys"])
            if not prev.get("pi") and doc.get("pi"):
                prev["pi"] = doc["pi"]
            if not prev.get("address1") and doc.get("address1"):
                for k in ("city", "state", "zip", "address1"):
                    if doc.get(k):
                        prev[k] = doc[k]
            if item.get("linkedArtemisSiteId") and not prev.get("linkedArtemisSiteId"):
                prev["linkedArtemisSiteId"] = item["linkedArtemisSiteId"]

    for lid, doc in legacy_upserts.items():
        existing = None
        try:
            existing = legacy_c.read_item(lid, lid)
        except Exception:
            existing = None
        if existing:
            for k in PRESERVE_LEGACY:
                if existing.get(k) not in (None, ""):
                    doc[k] = existing[k]
            if existing.get("name") and existing.get("source") != SOURCE:
                # keep manually edited name from anterior-segment legacy
                doc["name"] = existing["name"]
            if existing.get("linkedArtemisSiteId") and not doc.get("linkedArtemisSiteId"):
                doc["linkedArtemisSiteId"] = existing["linkedArtemisSiteId"]
            # merge indication lists
            doc["indicationsCovered"] = sorted(set(existing.get("indicationsCovered") or []) | set(doc.get("indicationsCovered") or []))
            doc["therapeuticAreas"] = list(doc["indicationsCovered"])
            doc["createdAt"] = existing.get("createdAt") or iso_now()
        else:
            doc["createdAt"] = iso_now()
        legacy_c.upsert_item(doc)
    print(f"Upserted {len(legacy_upserts)} legacy-sites (no shared sites writes)")

    for d in definitions:
        defs_c.upsert_item(d)
    print(f"Upserted {len(definitions)} survey definitions")

    for op in survey_ops:
        def_id = op["def_id"]
        site_id = op["site_id"]
        ind = op.get("indication")
        asg_id = assignment_id(def_id, site_id)
        rsp_id = response_id(def_id, site_id, op["tab"])
        lmap = label_to_qid.get(def_id) or {}
        meta = qmeta.get(def_id) or {}
        answers = []
        for label, a in op["answers_by_label"].items():
            qid = lmap.get(label)
            if not qid:
                continue
            q = meta.get(label) or {}
            answers.append({
                "questionId": qid,
                "label": label,
                "type": q.get("type") or a.get("type") or "text",
                "skipped": a.get("skipped", False),
                "value": a.get("value"),
            })
        asg = {
            "id": asg_id,
            "surveyId": def_id,
            "siteId": site_id,
            "targetRole": "pi",
            "status": "submitted",
            "source": SOURCE,
            "sourcePlatform": op["plat"],
            "sourceTab": op["tab"],
            "study": op["study"],
            "indication": ind,
            "therapeuticArea": ind,
            "createdAt": iso_now(),
            "submittedAt": iso_now(),
        }
        rsp = {
            "id": rsp_id,
            "assignmentId": asg_id,
            "surveyId": def_id,
            "siteId": site_id,
            "targetRole": "pi",
            "displayName": op.get("pi_name") or "",
            "answers": answers,
            "source": SOURCE,
            "sourcePlatform": op["plat"],
            "sourceTab": op["tab"],
            "study": op["study"],
            "indication": ind,
            "therapeuticArea": ind,
            "submittedAt": iso_now(),
            "createdAt": iso_now(),
        }
        asg_c.upsert_item(asg)
        rsp_c.upsert_item(rsp)
    print(f"Upserted {len(survey_ops)} assignments/responses")

    for site_id, pack in profile_by_site.items():
        existing = None
        try:
            existing = prof_c.read_item(site_id, site_id)
        except Exception:
            existing = None
        doc = merge_profile(existing, pack["incoming"], site_id, pack["display_name"])
        existing_ids = {b.get("surveyId") for b in doc.get("study_responses") or []}
        for b in pack["study_blobs"]:
            if b.get("surveyId") not in existing_ids:
                doc.setdefault("study_responses", []).append(b)
        # roll up indications on profile
        inds = sorted({
            b.get("indication") for b in (doc.get("study_responses") or [])
            if b.get("indication")
        })
        doc["indicationsCovered"] = inds
        doc["therapeuticAreas"] = inds
        prof_c.upsert_item(doc)
    print(f"Upserted {len(profile_by_site)} site-profiles")
    print("Done. Shared `sites` container was not modified.")


if __name__ == "__main__":
    main()
