"""
Create Cavalry NK feasibility survey in ARTEMIS Cosmos.

- Far-off / fuzzy matches treated as NEW questions
- Exact library label matches reuse libraryQuestionId
- If yes / If no follow-ups get showIf against parent
- Interest No ends survey (per Cavalry comments) after optional reason

Usage:
  python ingest/create_cavalry_nk_survey.py           # dry-run
  python ingest/create_cavalry_nk_survey.py --apply   # upsert Cosmos
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
XLSX = Path(r"c:\Users\shue1\Downloads\Cavalry Feas With Cav Comments (1).xlsx")
SURVEY_ID = "survey-cavalry-nk-feasibility"
SOURCE = "cavalry-feas-xlsx-2026-10"

YES_NO = ["Yes", "No"]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def slug(s: str, n: str = "") -> str:
    base = re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:48]
    num = re.sub(r"[^a-z0-9]+", "-", str(n or "").lower()).strip("-")
    return f"cav_{num}_{base}".strip("_") if num else f"cav_{base}"


def norm(s: str) -> str:
    s = str(s or "").lower().replace("\u2019", "'").replace("\u2018", "'")
    s = s.replace("\ufb01", "fi").replace("\ufb02", "fl")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def followup_kind(q: str) -> str | None:
    n = norm(q)
    if n.startswith("if yes"):
        return "yes"
    if n.startswith("if no"):
        return "no"
    if n.startswith("if local irb"):
        return "local_irb"
    return None


def base_num(num: str) -> str:
    m = re.match(r"^(\d+)", str(num or "").strip())
    return m.group(1) if m else str(num or "")


def looks_yes_no_label(label: str) -> bool:
    n = norm(label)
    if any(
        n.startswith(s)
        for s in (
            "has the",
            "has your",
            "have you",
            "have your",
            "do you",
            "does your",
            "does the",
            "is your",
            "is it",
            "are your",
            "are there",
            "can you",
            "can blood",
            "can irb",
            "will your",
            "will the",
            "did your",
        )
    ):
        return True
    if "the protocol requires" in n and (
        "can your" in n or "is your" in n or "do you" in n or "does your" in n
    ):
        return True
    if "the protocol requires" in n and "measured" in n:
        return True
    if "the protocol requires" in n and "captured" in n:
        return True
    if "can you cede" in n or "ceed to central" in n:
        return True
    if n.startswith("if local irb") and any(
        x in n for x in ("can you cede", "can you", "does the contract", "do you")
    ):
        # Exclude "how often does the IRB meet" etc.
        if "how often" in n or "how long" in n or "how many" in n or "lead time" in n:
            return False
        return True
    if "if your site has" in n and any(x in n for x in ("do you", "are you", "can you")):
        return True
    if "are there other committees" in n:
        return True
    if "electronic signatures" in n:
        return True
    return False


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


def load_rows():
    ws = openpyxl.load_workbook(XLSX, data_only=True).active
    rows = []
    for r in range(4, ws.max_row + 1):
        q = ws.cell(r, 5).value
        if not q:
            continue
        label = str(q).strip()
        # fix mojibake-ish punctuation / degree symbol
        label = label.replace("\u0092", "'").replace("\x92", "'")
        label = label.replace("\ufffd", "°")
        label = re.sub(r"site.s referral", "site's referral", label, flags=re.I)
        label = re.sub(r"-80[^\dA-Za-z]{0,3}C\b", "-80°C", label)
        label = re.sub(r"-20[^\dA-Za-z]{0,3}C\b", "-20°C", label)
        # Col C=Category (page), D=Question number, E=Questions (label/name)
        rows.append(
            {
                "cat": str(ws.cell(r, 3).value or "General").strip(),
                "num": str(ws.cell(r, 4).value or "").strip(),
                "label": label,
                "comment": str(ws.cell(r, 6).value or "").strip(),
            }
        )
    return expand_site_address_fields(rows)


def expand_site_address_fields(rows: list[dict]) -> list[dict]:
    """
    Keep workbook numbering (3b = address, 3c = phone).
    One Site Address question with type=address: street (Line1+2 combined) + city + state + zip sections.
    """
    out = []
    for item in rows:
        n = norm(item["label"])
        if item["cat"] == "Admin" and (
            "full site address" in n
            or (item["num"] == "3b" and "address" in n and "email" not in n)
        ):
            out.append(
                {
                    "cat": "Admin",
                    "num": "3b",  # unchanged number
                    "label": "Site Address",
                    "comment": item.get("comment")
                    or "Street (including suite), city, state, and ZIP",
                    "force_lib": "ql-site-address",
                    "force_type": "address",
                }
            )
            continue
        out.append(item)
    return out


def infer_type(label: str, num: str, cat: str, fk: str | None) -> tuple[str, list[str]]:
    n = norm(label)

    if n == "date" or n.startswith("date ") or "date of" in n:
        return "date", []
    if "email" in n and "list" not in n:
        return "text", []
    if "phone" in n:
        return "text", []

    # Multi-select / check all
    if "check all that apply" in n or "please check all" in n:
        if "contracting parties" in n or "clinical trial agreement" in n:
            return "multiselect", [
                "Site / Institution",
                "Principal Investigator",
                "SMO / Network",
                "Other",
            ]
        return "multiselect", []

    # IRB type
    if "type of irb" in n or "indicate the type of irb" in n:
        return "select", ["Central IRB/EC", "Local IRB/EC", "Either", "Other"]

    # Who captures images
    if "who would capture the images" in n:
        return "select", ["Investigator", "Photographer", "Technician", "Other"]

    # Owned/leased
    if "owned or leased" in n:
        return "select", [
            "Owned",
            "Leased",
            "Owned and available for study duration",
            "Leased and available for study duration",
            "Not available for full study duration",
        ]

    # Embedded "If yes, please describe…" — keep as free text
    if "offer travel support" in n:
        return "textarea", []

    if looks_yes_no_label(label) and fk not in ("yes", "no"):
        return "radio", YES_NO

    if fk == "yes" or fk == "no":
        if "acceptable to submit" in n or "draft cta" in n:
            return "radio", YES_NO
        if "owned or leased" in n:
            return "select", [
                "Owned",
                "Leased",
                "Owned and available for study duration",
                "Leased and available for study duration",
                "Not available for full study duration",
            ]
        if "make and model" in n or "operating system" in n:
            return "text", []
        if any(x in n for x in ("list", "describe", "explain", "specify", "provide", "languages", "proportion", "estimate")):
            if "languages" in n or "make and model" in n:
                return "text", []
            return "textarea", []
        return "textarea", []

    if fk == "local_irb":
        if looks_yes_no_label(label):
            return "radio", YES_NO
        if "how many workdays" in n:
            return "number", []
        if "how often" in n or "how long" in n or "lead time" in n:
            return "text", []
        return "text", []

    # Numeric-ish
    if any(
        x in n
        for x in (
            "how many",
            "what percentage",
            "approximately what percentage",
            "estimate of the number",
            "number of patients",
            "per year",
        )
    ):
        if "describe" in n or "list" in n:
            return "textarea", []
        return "number", []

    # Long narrative
    if any(
        x in n
        for x in (
            "describe",
            "please list all",
            "please provide",
            "foresee any",
            "if so, please",
            "referral network",
            "if yes, please",
        )
    ):
        return "textarea", []

    if "earliest date" in n or "ready for a site initiation" in n:
        return "date", []

    if "how long does it take" in n or "how often" in n or "how many workdays" in n:
        return "text", []

    # Travel support embeds "If yes, please describe"
    if "offer travel support" in n:
        return "textarea", []

    return "text", []


def attach_parents(rows: list[dict]) -> list[dict]:
    """Parent = nearest prior gate in same category (for If yes / If no / If Local)."""
    out = []
    last_gate = None  # most recent Yes/No (or select) that can gate If yes/no
    last_root_gate = None  # gate that is not itself a follow-up (e.g. 4a, not 4c)
    last_any = None
    irb_type = None
    prev_cat = None
    for item in rows:
        if item["cat"] != prev_cat:
            last_gate = None
            last_root_gate = None
            last_any = None
            irb_type = None
            prev_cat = item["cat"]

        fk = followup_kind(item["label"])
        n = norm(item["label"])
        bn = base_num(item["num"])
        letter = re.sub(r"^\d+", "", str(item["num"] or ""))
        parent = None
        is_child = False

        if fk == "local_irb":
            is_child = True
            parent = irb_type
        elif "are there other committees" in n:
            # Belongs with Local IRB cluster even without "If Local" prefix
            is_child = True
            parent = irb_type
            fk = "local_irb"
        elif fk in ("yes", "no"):
            is_child = True
            # Prefer nearest prior Y/N gate (e.g. 2g -> 2f committees, not 2b frequency)
            parent = last_gate or last_any
        elif n.startswith("if your site has"):
            is_child = True
            parent = last_root_gate or last_gate or last_any
        elif (
            letter
            and letter != "a"
            and last_root_gate
            and base_num(last_root_gate["num"]) == bn
            and looks_yes_no_label(last_root_gate["label"])
            # Independent siblings — do not gate on the "a" question
            and not (
                (item["cat"] == "Labs" and item["num"] == "1b")
                or (item["cat"] == "Study Assessments" and item["num"] == "7c")
            )
        ):
            # Same-number cluster under the "a" / root Y/N (6c/6d, 8d, …)
            is_child = True
            parent = last_root_gate

        out.append({**item, "followup": fk, "parent": parent, "is_child": is_child})

        if "type of irb" in n or "indicate the type of irb" in n:
            irb_type = item
            last_gate = item
            last_root_gate = item
            last_any = item
            continue

        is_yn = looks_yes_no_label(item["label"])
        if is_yn:
            last_gate = item
            # Only bare / "a" numbers become cluster roots (not 5b gating 5c)
            if (
                fk not in ("yes", "no", "local_irb")
                and not n.startswith("if your site has")
                and letter in ("", "a")
            ):
                last_root_gate = item
            # Local IRB Y/N (cede, CTA to IRB) and committee Y/N still gate following If yes
            if fk == "local_irb" or "are there other committees" in n:
                last_gate = item
        # 2f is not letter a and not If-local prefix, but is the gate for 2g
        if "are there other committees" in n:
            last_gate = item
        last_any = item
    return out


# Canonical Site Address library id (compound street+city+state+zip in the survey UI).
ADDRESS_LIB_SEED = {
    "ql-site-address": {"label": "Site Address", "type": "address", "category": "Site Profile"},
}


def build_questions(rows: list[dict], lib_by_norm: dict[str, dict], lib_by_id: dict[str, dict] | None = None):
    built = []
    id_by_key = {}  # (cat,num) -> qid
    lib_by_id = lib_by_id or {}

    for item in rows:
        qtype, opts = infer_type(item["label"], item["num"], item["cat"], item["followup"])
        qid = slug(item["label"], f"{item['cat'][:3]}-{item['num']}")
        # stable-ish ids
        qid = re.sub(r"-+", "-", qid)[:80]

        nlabel = norm(item["label"])
        lib = lib_by_norm.get(nlabel)
        forced = item.get("force_lib")
        if forced:
            lib = lib_by_id.get(forced) or ADDRESS_LIB_SEED.get(forced)
            if lib and "id" not in lib:
                lib = {"id": forced, **lib}
        # Only EXACT library reuse (or forced canonical); far-off = new
        if lib:
            lib_id = lib["id"]
            reuse = "exact_library"
            label = item["label"] if item.get("force_lib") else (lib.get("label") or item["label"])
            if item.get("force_type"):
                qtype = item["force_type"]
            elif item.get("force_lib"):
                pass  # keep inferred / force_type
            elif lib.get("type") in ("select", "multiselect", "date", "number", "address") and qtype == "text":
                # Adopt richer library types only when our infer stayed generic text
                qtype = lib["type"]
                if lib.get("options"):
                    opts = list(lib["options"])
            # Never let a fuzzy library hit turn a free-text Local IRB timing Q into radio
        else:
            lib_id = f"ql-{qid}"
            reuse = "new"
            label = item["label"]
            if item.get("force_type"):
                qtype = item["force_type"]

        q = {
            "id": qid,
            "label": label,
            "type": qtype,
            "required": False,
            "options": opts if qtype in ("radio", "select", "multiselect") else [],
            "logic": None,
            "libraryQuestionId": lib_id,
            "category": item["cat"],
            "section": item["cat"],
            "docxNum": item["num"],
            "help": item["comment"] or "",
            "cavalryReuse": reuse,
        }
        if qtype == "address":
            q["addressParts"] = ["street", "city", "state", "zip"]

        # Wire follow-ups to parent (category page stays the same)
        parent = item.get("parent")
        if item["is_child"] and parent:
            pkey = (parent["cat"], parent["num"])
            pid = id_by_key.get(pkey)
            if pid:
                fk = item["followup"]
                if fk == "local_irb":
                    q["logic"] = {
                        "showIf": {"questionId": pid, "equals": "Local IRB/EC"}
                    }
                elif fk == "no":
                    q["logic"] = {"showIf": {"questionId": pid, "equals": "No"}}
                else:
                    # If yes / If your site has …
                    q["logic"] = {"showIf": {"questionId": pid, "equals": "Yes"}}

        built.append(q)
        id_by_key[(item["cat"], item["num"])] = qid

    # Interest gate: No ends survey after reason follow-up if present
    interest = next(
        (q for q in built if "reviewed the protocol" in norm(q["label"]) and "interest" in norm(q["label"])),
        None,
    )
    if interest:
        interest["required"] = True
        interest["type"] = "radio"
        interest["options"] = YES_NO
        # Add dedicated reason question after interest if not already a separate follow-up
        idx = built.index(interest)
        reason_id = "cav_general_1_interest_reason"
        reason = {
            "id": reason_id,
            "label": "If not interested, please provide the reason(s):",
            "type": "textarea",
            "required": True,
            "options": [],
            "logic": {"showIf": {"questionId": interest["id"], "equals": "No"}},
            "libraryQuestionId": f"ql-{reason_id}",
            "category": interest["category"],
            "section": interest["section"],
            "docxNum": f"{interest.get('docxNum')}-reason",
            "help": "Shown when interest = No. Survey ends after this answer.",
            "cavalryReuse": "new",
        }
        # Trim embedded "If no..." from interest label for cleaner Yes/No
        interest["label"] = (
            "Has the Investigator reviewed the protocol synopsis and expressed interest "
            "in participating in this study?"
        )
        interest["logic"] = {
            "endSurveyIf": {
                "equals": "No",
                "showThroughQuestionId": reason_id,
            }
        }
        built.insert(idx + 1, reason)

    return built


def build_pages(questions: list[dict]) -> list[dict]:
    """One page per workbook category (Admin, General, Recruitment, …)."""
    pages = []
    by_cat: dict[str, list[str]] = {}
    for q in questions:
        by_cat.setdefault(q.get("category") or "General", []).append(q["id"])
    for cat, ids in by_cat.items():
        key = re.sub(r"[^a-z0-9]+", "-", cat.lower()).strip("-")
        pages.append(
            {
                "key": key,
                "title": cat,
                "questionIds": ids,
            }
        )
    return pages


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Upsert survey + library docs to Cosmos")
    args = ap.parse_args()

    db = cosmos_db()
    defs_c = db.get_container_client("site-survey-definitions")
    lib_c = db.get_container_client("site-survey-question-library")

    lib_by_norm = {}
    lib_by_id = {}
    for doc in lib_c.query_items(
        "SELECT c.id, c.label, c.type, c.options FROM c",
        enable_cross_partition_query=True,
    ):
        lib_by_id[doc["id"]] = doc
        label = doc.get("label") or ""
        if label:
            lib_by_norm[norm(label)] = doc

    rows = attach_parents(load_rows())
    questions = build_questions(rows, lib_by_norm, lib_by_id)
    pages = build_pages(questions)

    exact_reuse = sum(1 for q in questions if q.get("cavalryReuse") == "exact_library")
    new_qs = sum(1 for q in questions if q.get("cavalryReuse") == "new")

    ts = now_iso()
    survey = {
        "id": SURVEY_ID,
        "title": "Cavalry NK Feasibility (Stage 2/3)",
        "description": (
            "Site feasibility questionnaire for Cavalry Stage 2/3 neurotrophic keratitis. "
            "Built from Cavalry Feas With Cav Comments workbook. Interest=No ends the survey."
        ),
        "status": "active",
        "audience": ["PI", "Coordinator"],
        "indication": "Neurotrophic Keratitis (Stage 2/3)",
        "therapeuticArea": "Ophthalmology",
        "studyCode": "CAVALRY",
        "tags": ["cavalry", "nk", "feasibility", "neurotrophic-keratitis", "predefined"],
        "predefined": True,
        "isPredefined": True,
        "library": "feasibility",
        "source": SOURCE,
        "sourceFile": XLSX.name,
        "introBlurb": (
            "Thank you for completing this feasibility questionnaire for the Cavalry "
            "Stage 2/3 NK study. Please answer based on your site's current capabilities."
        ),
        "questions": [{k: v for k, v in q.items() if k != "cavalryReuse"} for q in questions],
        "pages": pages,
        "createdAt": ts,
        "updatedAt": ts,
    }

    print(f"Survey id: {SURVEY_ID}")
    print(f"Questions: {len(questions)} (exact library reuse={exact_reuse}, new={new_qs})")
    print(f"Pages/categories: {len(pages)}")
    for p in pages:
        print(f"  - {p['title']}: {len(p['questionIds'])} qs")

    # Show interest wiring
    interest = next((q for q in survey["questions"] if q["id"].startswith("cav_") and "interest" in norm(q["label"]) and "reason" not in norm(q["label"])), None)
    if interest:
        print("\nInterest gate:")
        print(" ", interest["id"], interest.get("logic"))

    followups = [q for q in survey["questions"] if q.get("logic") and q["logic"].get("showIf")]
    print(f"\nFollow-ups with showIf: {len(followups)}")
    for q in followups[:12]:
        print(f"  {q['docxNum'] if q.get('docxNum') else '?':6} -> {q['logic']['showIf']} | {q['label'][:70]}")

    if not args.apply:
        print("\nDry-run only. Re-run with --apply to upsert into Cosmos.")
        # still write a local preview
        out = REPO / "ingest" / "cavalry_nk_survey_preview.json"
        out.write_text(json.dumps(survey, indent=2), encoding="utf-8")
        print(f"Wrote preview {out}")
        return

    # Canonical Site Address library question (type=address → multipart UI)
    lib_upserts = 0
    for lib_id, seed in ADDRESS_LIB_SEED.items():
        prev = lib_by_id.get(lib_id) or {}
        lib_doc = {
            **prev,
            "id": lib_id,
            "label": seed["label"],
            "type": seed.get("type") or "address",
            "options": [],
            "required": bool(prev.get("required")),
            "category": seed.get("category") or prev.get("category") or "Site Profile",
            "help": prev.get("help")
            or "Street (Line 1 + suite combined), city, state, and ZIP in one question.",
            "status": "active",
            "createdAt": prev.get("createdAt") or ts,
            "updatedAt": ts,
            "source": prev.get("source") or SOURCE,
            "tags": list(
                dict.fromkeys(
                    list(prev.get("tags") or []) + ["site-profile", "address", "site-address"]
                )
            ),
            "addressParts": ["street", "city", "state", "zip"],
        }
        lib_c.upsert_item(lib_doc)
        lib_upserts += 1

    for q in questions:
        if q.get("cavalryReuse") == "exact_library":
            continue
        lib_id = q["libraryQuestionId"]
        if lib_id in ADDRESS_LIB_SEED:
            continue
        lib_doc = {
            "id": lib_id,
            "label": q["label"],
            "type": q["type"],
            "options": q.get("options") or [],
            "required": bool(q.get("required")),
            "category": q.get("category") or "Cavalry",
            "help": q.get("help") or "",
            "status": "active",
            "createdAt": ts,
            "updatedAt": ts,
            "source": SOURCE,
            "tags": ["cavalry", "nk", "feasibility"],
        }
        lib_c.upsert_item(lib_doc)
        lib_upserts += 1

    # Preserve createdAt if survey already exists
    try:
        existing = defs_c.read_item(SURVEY_ID, SURVEY_ID)
        survey["createdAt"] = existing.get("createdAt") or ts
    except Exception:
        pass

    defs_c.upsert_item(survey)
    print(f"\nApplied: upserted survey {SURVEY_ID}")
    print(f"Library upserts (new): {lib_upserts}")
    print("Feasibility > Templates should list: Cavalry NK Feasibility (Stage 2/3)")


if __name__ == "__main__":
    main()
