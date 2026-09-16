"""Ingest Stealth GA Feasibility.xlsx into ReBUILD survey responses.

Stealth wins over Mike pack / prior answers for overlapping library IDs.
Matches every usable Stealth row to a live Artemis site (email > PI+institution).

Usage:
  python ingest/ingest_stealth_ga_rebuild.py
  python ingest/ingest_stealth_ga_rebuild.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter

from ingest_mike_rebuild_pack import (
    SURVEY_ID,
    coerce_to_question_value,
    cosmos_db,
    iso_now,
    sanitize_pack_value,
)

REPO = Path(__file__).resolve().parents[1]
XLSX = Path(r"c:\Users\shue1\Downloads\Stealth GA Feasibility.xlsx")
REPORT = REPO / ".firecrawl" / "stealth-ga-rebuild-ingest-report.json"
SOURCE = "stealth-ga-feasibility"
MAP_OUT = REPO / ".firecrawl" / "stealth-ga-column-to-rebuild.json"

# Curated Stealth column -> rebuild libraryQuestionId (Response cols + specials)
# Verified against Stealth GA Feasibility.xlsx Q inference + live rebuild survey.
COL_LIB: dict[str, str] = {
    "AS": "ql-rebuild-013-has-the-investigator-reviewed-the-protocol-synop",  # may fuzzy-fix below
    "BB": "ql-gf-05-practice-setting",
    "BO": "ql-rebuild-023-how-many-dry-amd-clinical-trials-has-your-site-condu",
    "BS": "ql-rebuild-027-how-many-ongoing-trials-does-your-site-have-in-patie",
    "BU": "ql-rebuild-028-if-you-have-ongoing-dry-amd-ga-trials-would-they-int",
    "CC": "ql-rebuild-072-is-your-staff-gcp-certified",
    "CD": "ql-rebuild-025-do-you-have-dedicated-staff-to-conduct-this-study",
    "CS": "ql-rebuild-030-has-your-site-staff-equipment-ever-been-certified-by",
    "DE": "mu3330hmyp18qfkmzy",  # FAF Yes/No
    "DG": "mu3330pegxxzitpbtm4",  # FA Yes/No
    "DL": "mu3330woingrwq22ky",  # ETDRS lightbox
    "DN": "ql-rebuild-043-do-you-have-a-dedicated-4-meter-lane-room-area-to-pe",
    "DO": "ql-rebuild-055-does-your-site-maintain-a-regular-calibration-schedu",
    "DV": "ql-rebuild-051-will-cra-have-remote-access-to-the-electronic-source",
    "DW": "ql-rebuild-064-on-site-pharmacy",
    "DX": "ql-rebuild-061-would-your-study-staff-have-unrestricted-access-to-a",
    "EI": "ql-rebuild-063-do-you-need-a-separate-trial-specific-pharmacy-contr",
    "EJ": "ql-rebuild-065-2-8-c-secured-refrigerator-with-continuous-temperatu",
    "EK": "ql-rebuild-066-secured-temperature-controlled-storage-room-for-anci",
    "EL": "ql-rebuild-069-20-c-freezer-with-continuous-temperature-monitoring-",
    "EN": "ql-rebuild-067-are-you-able-to-conduct-on-site-blood-draws",
    "ES": "ql-rebuild-070-is-your-site-able-to-obtain-dry-ice-for-shipping-spe",
    "ET": "ql-gsf_072_does-your-site-have-one-or-more-staff-who-are-ia",
    "EU": "ql-rebuild-073-centrifuge",
    "EV": "ql-rebuild-074-ability-to-collect-process-and-ship-package-and-labe",
    "EY": "ql-rebuild-075-secure-space-to-store-clinical-study-files-and-subje",
    "FA": "ql-gsf_073_does-your-site-have-a-backup-plan-for-power-outa",
    "FC": "ql-rebuild-078-what-percentage-of-these-patients-have-extrafoveal-g",
    "FP": "ql-rebuild-060-is-your-site-willing-to-pre-screen-potential-suitabl",
    "FS": "ql-gf-29-central-irb",
    "FT": "ql-rebuild-063-if-local-irb-ec-how-often-does-the-irb-meet",
    "GG": "ql-rebuild-074-can-irb-ec-submission-and-contract-budget-negotiatio",
    "GM": "ql-rebuild-080-on-average-how-long-will-it-take-to-execute-the-clin",
    "GN": "ql-rebuild-081-do-you-accept-electronic-signatures-of-the-clinical-",
}

# When Yes carries model text, model lives in the next column
MODEL_FOLLOWUP: dict[str, tuple[str, str]] = {
    # stealth_col: (model_col, rebuild_model_lib)
    "DE": ("DF", "ql-rebuild-046-manufacturer-model-if-yes"),
    "DG": ("DH", "ql-rebuild-048-manufacturer-model-if-yes"),
    "DL": ("DM", "ql-rebuild-050-make-model-catalog-no-if-yes"),
}

# Checkbox role columns (truthy if cell equals header / Yes / checked)
ROLE_COLS = {
    "CE": "Study Coordinator",
    "CF": "Pharmacist",
    "CG": "Sub-Investigators",
    "CH": "Certified Photographers/Technicians",
    "CI": "Certified BCVA Examiners",
}
ROLES_LIB = "ql-rebuild-034-if-yes-which-dedicated-roles-are-in-place"

# SD-OCT brand checkboxes
OCT_COLS = {
    "CU": "Heidelberg Spectralis",
    "CV": "Zeiss Cirrus",
}
OCT_LIB = "ql-rebuild-041-do-you-have-the-capability-to-perform-spectral-domai"
OCT_OTHER_COL = "CW"  # may be Other specify
OCT_OTHER_LIB = "ql-rebuild-042-if-other-please-specify"

# Board-certified PI / Sub-I checkboxes
BOARD_COLS = {"CK": "PI", "CL": "Sub-I"}
BOARD_LIB = "ql-rebuild-036-are-you-or-any-of-your-sub-investigators-board-certi"

# Count fields
COUNT_COLS = {
    "CJ": "ql-rebuild-027-how-many-sub-investigators-do-you-plan-to-have-invol",
    "CT": "ql-rebuild-032-how-many-certified-bcva-examiners-do-you-plan-to-hav",
}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_EXCEL_DATE_RE = re.compile(
    r"^\s*\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*$"
)
_QUESTION_VAL_RE = re.compile(
    r"^(does |do |is |are |have |how |what |which |please |if |has |will |would |response$)",
    re.I,
)


def col_idx(letter: str) -> int:
    return column_index_from_string(letter) - 1


def norm_name(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(
        r"\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|do|phd|od|dr\.?|sc|the|center|institute|associates|assoc)\b",
        "",
        t,
    )
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def norm_email(s: str) -> str:
    return str(s or "").strip().lower()


def is_junk_value(v) -> bool:
    if v is None:
        return True
    s = str(v).strip()
    if not s or s.lower() in ("response", "open-ended response", "n/a", "na", "null", "none", "-"):
        return True
    if _EXCEL_DATE_RE.match(s) or ("00:00:00" in s and re.search(r"\d{4}-\d{2}-\d{2}", s)):
        return True
    if _QUESTION_VAL_RE.match(s) and ("?" in s or len(s) > 40):
        return True
    return False


def checkbox_checked(cell_val, option_label: str) -> bool:
    if cell_val is None:
        return False
    s = str(cell_val).strip()
    if not s or is_junk_value(s):
        return False
    if re.match(r"^(yes|y|true|1|x|✓|✔)$", s, re.I):
        return True
    ol = option_label.lower()
    sl = s.lower()
    if sl == ol or ol in sl or sl in ol:
        return True
    return False


def yes_no_from_stealth(val) -> str | None:
    if is_junk_value(val):
        return None
    s = str(val).strip()
    if re.match(r"^(yes)\b", s, re.I):
        return "Yes"
    if re.match(r"^(no)\b", s, re.I):
        return "No"
    if re.match(r"^(n/?a|not applicable)$", s, re.I):
        return "N/A"
    # "Yes- please list..." / "Yes- please specify..."
    if re.match(r"^yes\b", s, re.I):
        return "Yes"
    return None


def centrifuge_coerce(val) -> str | None:
    if is_junk_value(val):
        return None
    s = str(val).strip().lower()
    if s in ("yes", "standard", "refrigerated", "both") or "centrifuge" in s:
        return "Yes"
    if s == "no":
        return "No"
    yn = yes_no_from_stealth(val)
    return yn


def practice_coerce(val, opts: list) -> str | None:
    if is_junk_value(val):
        return None
    s = str(val).strip()
    # normalize curly apostrophe
    s2 = s.replace("\u2019", "'").replace("\u2018", "'")
    for o in opts:
        if s2.lower() == o.lower():
            return o
    aliases = {
        "doctor's office (group practice)": "Doctor's Office (Group Practice)",
        "doctor's office (private practice)": "Doctor's Office (Private Practice)",
        "university hospital": "University Hospital",
        "general hospital": "General Hospital",
        "dedicated research center": "Dedicated Research Center",
        "specialized clinic/institution": "Specialized Clinic/Institution",
        "specialty clinic": "Specialized Clinic/Institution",
    }
    hit = aliases.get(s2.lower())
    if hit and hit in opts:
        return hit
    for o in opts:
        if o.lower() in s2.lower() or s2.lower() in o.lower():
            return o
    return None


def irb_coerce(val, opts: list) -> str | None:
    if is_junk_value(val):
        return None
    s = str(val).strip().lower()
    if "central" in s:
        return next((o for o in opts if "central" in o.lower()), None)
    if "local" in s:
        return next((o for o in opts if "local" in o.lower()), None)
    return None


def load_sheet(path: Path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb["Stealth GA"]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    return rows[0], rows[1:]


def resolve_interest_lib(survey_qs: list) -> None:
    """Fix AS interest lib id from live survey labels."""
    for q in survey_qs:
        lab = (q.get("label") or "").lower()
        if "reviewed the protocol synopsis" in lab and q.get("libraryQuestionId"):
            COL_LIB["AS"] = q["libraryQuestionId"]
            return


def resolve_ongoing_libs(survey_qs: list) -> None:
    for q in survey_qs:
        lab = (q.get("label") or "").lower()
        lib = q.get("libraryQuestionId")
        if not lib:
            continue
        if "how many ongoing" in lab and "dry amd" in lab:
            COL_LIB["BS"] = lib
        if "interfere with recruit" in lab:
            COL_LIB["BU"] = lib
        if "dry amd clinical trials has your site conducted" in lab:
            COL_LIB["BO"] = lib


def parse_stealth_rows(hdr, data):
    rows = []
    for r in data:
        pi = str(r[col_idx("E")] or "").strip()
        inst = str(r[col_idx("F")] or "").strip()
        email = str(r[col_idx("M")] or "").strip()
        if not pi and not inst:
            continue
        if pi.lower() in ("investigator name", "at", "name"):
            continue
        # skip embedded header rows (GCP question text in CC)
        cc = str(r[col_idx("CC")] or "")
        if "gcp certified" in cc.lower() or cc.strip() == "Response":
            continue
        es = str(r[col_idx("ES")] or "")
        if "dry ice" in es.lower():
            continue
        rows.append(
            {
                "pi": pi,
                "inst": inst,
                "email": email,
                "phone": str(r[col_idx("N")] or "").strip(),
                "city": str(r[col_idx("I")] or "").strip(),
                "state": str(r[col_idx("J")] or "").strip(),
                "address": str(r[col_idx("G")] or "").strip(),
                "zip": str(r[col_idx("K")] or "").strip(),
                "raw": r,
            }
        )
    return rows


def _pi_last_first(pi: str) -> tuple[str, str]:
    t = re.sub(r"\b(md|do|phd|od|dr\.?|,)\b", " ", str(pi or ""), flags=re.I)
    parts = [p for p in re.split(r"\s+", t.strip()) if p]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0].lower(), ""
    return parts[-1].lower(), parts[0].lower()


def match_site(row, live_sites, by_email: dict):
    email = norm_email(row["email"])
    if email and _EMAIL_RE.match(email) and email in by_email:
        return by_email[email], "email", 1.0

    inst_n = norm_name(row["inst"])
    pi_n = norm_name(row["pi"])
    pi_last, pi_first = _pi_last_first(row["pi"])
    best = None
    for site in live_sites:
        sn = norm_name(site.get("name") or "")
        sp = norm_name(site.get("piName") or site.get("pi") or "")
        sp_last, sp_first = _pi_last_first(site.get("piName") or site.get("pi") or "")
        score = 0.0
        how = ""
        if inst_n and sn:
            if inst_n == sn:
                score, how = 1.0, "exact-name"
            elif len(inst_n) >= 8 and len(sn) >= 8 and (inst_n in sn or sn in inst_n):
                shorter, longer = (inst_n, sn) if len(inst_n) <= len(sn) else (sn, inst_n)
                if len(shorter) / max(len(longer), 1) >= 0.5:
                    score, how = 0.93, "contains-name"
            else:
                r = SequenceMatcher(None, inst_n, sn).ratio()
                if r >= 0.88:
                    score, how = r, "fuzzy-name"
        pi_hit = False
        if pi_n and sp and pi_n == sp:
            pi_hit = True
        elif pi_last and sp_last and pi_last == sp_last and (
            not pi_first or not sp_first or pi_first[0] == sp_first[0]
        ):
            pi_hit = True
        if pi_hit:
            if score >= 0.72:
                score, how = max(score, 0.97), (how or "name") + "+pi"
            else:
                tokens = [t for t in inst_n.split() if len(t) >= 4]
                if any(t in sn for t in tokens):
                    score, how = 0.90, "pi+token"
                elif score >= 0.80:
                    score, how = 0.90, how + "+pi"
        # Require either strong name or name+PI — never PI-only across orgs
        if score >= 0.88 and (best is None or score > best[0]):
            best = (score, site, how)
    if best:
        return best[1], best[2], round(best[0], 3)
    return None, None, 0.0


def build_answers(row, survey_qs: list) -> list:
    q_by_lib = {q.get("libraryQuestionId"): q for q in survey_qs if q.get("libraryQuestionId")}
    raw = row["raw"]
    answers = []
    seen = set()

    def add(lib, value, stealth_col, label_fallback=""):
        if not lib or lib in seen:
            return
        if value is None or (isinstance(value, str) and not str(value).strip()):
            return
        mq = q_by_lib.get(lib) or {}
        label = mq.get("label") or label_fallback or lib
        qtype = mq.get("type") or "text"
        opts = mq.get("options") or []
        clean = sanitize_pack_value(f"stealth.{stealth_col}", value, label, qtype, opts)
        if clean is None:
            return
        coerced = coerce_to_question_value(clean, mq, f"stealth.{stealth_col}")
        if coerced is None or (isinstance(coerced, str) and not str(coerced).strip()):
            return
        seen.add(lib)
        answers.append(
            {
                "questionId": mq.get("id") or lib,
                "libraryQuestionId": lib,
                "label": label,
                "type": qtype,
                "value": coerced if not isinstance(coerced, (dict, list)) else json.dumps(coerced),
                "stealthColumn": stealth_col,
                "source": SOURCE,
            }
        )

    # Simple mapped response columns
    for letter, lib in COL_LIB.items():
        idx = col_idx(letter)
        if idx >= len(raw):
            continue
        val = raw[idx]
        if is_junk_value(val):
            continue
        mq = q_by_lib.get(lib) or {}
        opts = []
        for o in mq.get("options") or []:
            opts.append(o if isinstance(o, str) else str(o.get("label") or o.get("value") or ""))
        opts = [o for o in opts if o]
        typ = str(mq.get("type") or "").lower()
        lab = (mq.get("label") or "").lower()

        if letter == "BB":
            v = practice_coerce(val, opts)
        elif letter == "FS":
            v = irb_coerce(val, opts)
        elif letter == "EU":
            v = centrifuge_coerce(val)
        elif letter == "BO":
            # map 1-2 style onto radio options
            s = str(val).strip().replace("–", "-")
            if is_junk_value(s):
                v = None
            elif s in opts:
                v = s
            elif s in ("1-2", "1–2"):
                v = next((o for o in opts if "1" in o and "2" in o), s)
            elif s in ("3-5", "3–5"):
                v = next((o for o in opts if "3" in o and "5" in o), s)
            elif s in ("0", "≥6", ">=6", "6+"):
                v = next((o for o in opts if o.replace(" ", "") in (s, "≥6", ">=6") or o == s), None)
                if s == "0":
                    v = "0"
            else:
                v = coerce_to_question_value(s, mq, f"stealth.{letter}")
        else:
            yn = yes_no_from_stealth(val)
            if yn and typ in ("radio", "select") and opts:
                optset = {o.lower() for o in opts}
                if yn.lower() in optset or (yn == "N/A" and "n/a" in optset):
                    v = next(o for o in opts if o.lower() == yn.lower() or (yn == "N/A" and o.lower() == "n/a"))
                else:
                    v = yn
            elif yn and not opts:
                v = yn
            else:
                # free text / other
                s = str(val).strip()
                # strip "Yes- please..." down to Yes for yes/no; model handled separately
                if re.match(r"^yes\b", s, re.I) and typ in ("radio", "select"):
                    v = "Yes"
                else:
                    v = s
        add(lib, v, letter)

        # model follow-ups
        if letter in MODEL_FOLLOWUP:
            mcol, mlib = MODEL_FOLLOWUP[letter]
            midx = col_idx(mcol)
            if midx < len(raw) and not is_junk_value(raw[midx]):
                model = str(raw[midx]).strip()
                if not re.match(r"^(yes|no|response)", model, re.I):
                    add(mlib, model, mcol)
            else:
                # model sometimes embedded after Yes-
                s = str(val).strip()
                m = re.match(r"^yes[\s\-–:]+(?:please\s+)?(?:list|specify)[^\w]*(.*)$", s, re.I)
                if m and m.group(1).strip():
                    add(MODEL_FOLLOWUP[letter][1], m.group(1).strip(), letter + ".embedded")

    # Dedicated roles multiselect
    roles = []
    for letter, opt in ROLE_COLS.items():
        idx = col_idx(letter)
        if idx < len(raw) and checkbox_checked(raw[idx], opt):
            # Stealth uses "Certified Photographers/OCT Technicians" -> rebuild "Certified Photographers/Technicians"
            if "Photograph" in opt:
                roles.append("Certified Photographers/Technicians")
            else:
                roles.append(opt)
    if roles:
        add(ROLES_LIB, json.dumps(roles) if len(roles) > 1 else roles[0], "CE-CI")
        if "ql-rebuild-025-do-you-have-dedicated-staff-to-conduct-this-study" not in seen:
            add(
                "ql-rebuild-025-do-you-have-dedicated-staff-to-conduct-this-study",
                "Yes",
                "CE-CI.infer",
            )

    # SD-OCT brands
    octs = []
    for letter, opt in OCT_COLS.items():
        idx = col_idx(letter)
        if idx < len(raw) and checkbox_checked(raw[idx], opt):
            octs.append(opt)
    if len(octs) >= 2:
        add(OCT_LIB, "Both", "CU-CV")
    elif len(octs) == 1:
        add(OCT_LIB, octs[0], "CU-CV")
    # other specify
    oidx = col_idx(OCT_OTHER_COL) if OCT_OTHER_COL else -1
    if oidx >= 0 and oidx < len(raw) and not is_junk_value(raw[oidx]):
        other = str(raw[oidx]).strip()
        if other.lower() not in ("other", "other (please specify)", "us"):
            if OCT_LIB not in seen:
                add(OCT_LIB, "Other", OCT_OTHER_COL)
            add(OCT_OTHER_LIB, other, OCT_OTHER_COL)

    # Board certified
    boards = []
    for letter, opt in BOARD_COLS.items():
        idx = col_idx(letter)
        if idx < len(raw) and checkbox_checked(raw[idx], opt):
            boards.append(opt)
    if boards:
        add(BOARD_LIB, json.dumps(boards) if len(boards) > 1 else boards[0], "CK-CL")

    # Counts
    for letter, lib in COUNT_COLS.items():
        idx = col_idx(letter)
        if idx >= len(raw) or is_junk_value(raw[idx]):
            continue
        s = str(raw[idx]).strip()
        if re.match(r"^\d+$", s):
            add(lib, s, letter)

    return answers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--xlsx", default=str(XLSX))
    args = ap.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        raise SystemExit(f"Missing {path}")

    hdr, data = load_sheet(path)
    stealth_rows = parse_stealth_rows(hdr, data)
    print(f"Stealth usable rows: {len(stealth_rows)}")

    db = cosmos_db()
    survey = db.get_container_client("site-survey-definitions").read_item(SURVEY_ID, SURVEY_ID)
    survey_qs = survey.get("questions") or []
    resolve_interest_lib(survey_qs)
    resolve_ongoing_libs(survey_qs)

    # Persist effective column map
    MAP_OUT.parent.mkdir(exist_ok=True)
    MAP_OUT.write_text(
        json.dumps(
            {
                "colLib": COL_LIB,
                "roles": ROLE_COLS,
                "oct": OCT_COLS,
                "board": BOARD_COLS,
                "models": MODEL_FOLLOWUP,
                "counts": COUNT_COLS,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    live = list(
        db.get_container_client("sites").query_items(
            "SELECT c.id, c.name, c.pi, c.piName, c.piEmail FROM c",
            enable_cross_partition_query=True,
        )
    )
    by_email = {}
    for s in live:
        em = norm_email(s.get("piEmail") or "")
        if em and _EMAIL_RE.match(em):
            by_email[em] = s

    now = iso_now()
    matched = []
    unmatched = []
    for row in stealth_rows:
        site, how, score = match_site(row, live, by_email)
        answers = build_answers(row, survey_qs)
        rec = {
            "pi": row["pi"],
            "inst": row["inst"],
            "email": row["email"],
            "siteId": site.get("id") if site else None,
            "siteName": site.get("name") if site else None,
            "matchHow": how,
            "matchScore": score,
            "answerCount": len(answers),
            "answersWithLib": sum(1 for a in answers if a.get("libraryQuestionId")),
        }
        if site and score >= 0.88:
            matched.append({**rec, "answers": answers})
        else:
            unmatched.append(rec)

    # Collapse multiple Stealth PIs → one Artemis site: merge answers (later overwrites)
    by_site: dict[str, dict] = {}
    for m in matched:
        sid = m["siteId"]
        if sid not in by_site:
            by_site[sid] = dict(m)
            continue
        existing = {a["libraryQuestionId"]: a for a in by_site[sid]["answers"] if a.get("libraryQuestionId")}
        for a in m["answers"]:
            lib = a.get("libraryQuestionId")
            if lib:
                existing[lib] = a  # Stealth later row wins
        merged = list(existing.values())
        by_site[sid]["answers"] = merged
        by_site[sid]["answerCount"] = len(merged)
        by_site[sid]["answersWithLib"] = len(merged)
        by_site[sid]["pi"] = m["pi"] or by_site[sid]["pi"]
        by_site[sid]["matchHow"] = by_site[sid]["matchHow"] + "+" + (m["matchHow"] or "")
    matched_sites = list(by_site.values())

    print(f"Matched rows: {len(matched)} → unique sites: {len(matched_sites)}  Unmatched rows: {len(unmatched)}")
    by_how = {}
    for m in matched:
        by_how[m["matchHow"]] = by_how.get(m["matchHow"], 0) + 1
    print("Match how:", by_how)
    print(
        f"Avg answers/site: {sum(m['answerCount'] for m in matched_sites)/max(len(matched_sites),1):.1f}"
    )

    report = {
        "generatedAt": now,
        "source": SOURCE,
        "surveyId": SURVEY_ID,
        "stealthRows": len(stealth_rows),
        "matchedRows": len(matched),
        "matchedSites": len(matched_sites),
        "unmatched": len(unmatched),
        "matchHow": by_how,
        "unmatchedSample": unmatched[:25],
        "matchedSample": [
            {k: v for k, v in m.items() if k != "answers"} for m in matched_sites[:15]
        ],
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {REPORT}")

    if not args.apply:
        print("Dry run only. Re-run with --apply to write Cosmos.")
        return

    rsp_c = db.create_container_if_not_exists(
        id="site-survey-responses",
        partition_key={"paths": ["/siteId"], "kind": "Hash"},
    )
    asg_c = db.create_container_if_not_exists(
        id="site-survey-assignments",
        partition_key={"paths": ["/siteId"], "kind": "Hash"},
    )

    written = 0
    for m in matched_sites:
        site_id = m["siteId"]
        answers = m["answers"]
        rsp_id = f"rsp-stealth-ga-{site_id}"
        asg_id = f"asg-stealth-ga-{site_id}"
        assignment = {
            "id": asg_id,
            "surveyId": SURVEY_ID,
            "siteId": site_id,
            "targetRole": "pi",
            "status": "submitted",
            "source": SOURCE,
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
            "displayName": m["pi"] or m["inst"],
            "answers": answers,
            "source": SOURCE,
            "stealthInstitution": m["inst"],
            "stealthPi": m["pi"],
            "stealthEmail": m["email"],
            "matchHow": m["matchHow"],
            "matchScore": m["matchScore"],
            "answerCount": len(answers),
            "createdAt": now,
            "updatedAt": now,
            "submittedAt": now,
        }
        asg_c.upsert_item(assignment)
        rsp_c.upsert_item(response)
        written += 1

    report["status"] = "applied"
    report["written"] = written
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Applied: {written} Stealth GA site responses (Stealth wins via newest prefill).")


if __name__ == "__main__":
    main()
