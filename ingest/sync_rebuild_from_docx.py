"""
Sync Mighty / ReBUILD Feasibility Questionnaire (AF standardized DOCX) → Artemis.

- Parse numbered questions from the AF DOCX
- Expand Study #1/#2/#3 enrollment repeats into distinct questions
- Lift inline "If other / Manufacturer/Model" option text into follow-up fields
- Match existing library items when possible; create only when needed
- Upsert survey definition `survey-rebuild-mytx272am-201`

Usage:
  python ingest/sync_rebuild_from_docx.py
  python ingest/sync_rebuild_from_docx.py --apply
  python ingest/sync_rebuild_from_docx.py "c:\\Users\\shue1\\Downloads\\ReBUILD_Feasibility_Questionnaire_AF (1).docx" --apply
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient
from docx import Document

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DOCX = Path(
    r"c:\Users\shue1\Downloads\ReBUILD_Feasibility_Questionnaire_AF (1).docx"
)
SURVEY_ID = "survey-rebuild-mytx272am-201"
SOURCE = "rebuild-af-std-14sep2026"

ALIASES = {
    "investigator name": "ql-pi-name",
    "investigator first and last name": "ql-pi-name",
    "investigator email": "ql-pi-email",
    "investigator phone": "ql-pi-phone",
    "investigator phone number": "ql-pi-phone",
    "institution name": "ql-site-name",
    "site name": "ql-site-name",
    "address": "ql-site-address",
    "street address": "ql-site-address",
    "institution street address": "ql-site-address",
    "preferred site contact name": "ql-coord-name",
    "primary research point of contact first and last name": "ql-coord-name",
    "preferred site contact email": "ql-coord-email",
    "primary research point of contact email": "ql-coord-email",
    "primary research contact email": "ql-coord-email",
    "preferred site contact phone": "ql-coord-phone",
    "primary research point of contact phone number": "ql-coord-phone",
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
    "would your site require translation of any study documents or patient facing materials": "ql-gf-24-translations",
    "is equipment routinely calibrated at your site": "ql-gsf_074_is-equipment-routinely-calibrated-at-your-site",
    "does your site maintain a regular calibration schedule": "ql-gsf_074_is-equipment-routinely-calibrated-at-your-site",
    "do you have experience with electronic data capture edc": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "please select which of the following edc systems": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "please select which of the following edc systems your site has experience with": "ql-gsf_065_please-select-which-of-the-following-edc-systems",
    "do you have experience with interactive response technology irt": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
    "please select which of the following irt rtsm": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
    "please select which of the following irt rtsm systems your site has experience with": "ql-gsf_066_please-select-which-of-the-following-irt-rtsm-sy",
}

Q_RE = re.compile(r"^(\d+)\.\s+(.+?)\s*(\*)?\s*$")
TYPE_RE = re.compile(r"^Question Type:\s*(.+)$", re.I)
BRANCH_RE = re.compile(r"^Branch Logic:\s*(.+)$", re.I)
SECTION_RE = re.compile(r"^SECTION\s+\d+", re.I)
STUDY_RE = re.compile(r"^Study\s*#?\s*(\d+)\s*$", re.I)
FOLLOW_OPT_RE = re.compile(
    r"^(If other|If no,|Manufacturer/Model|Make/Model|If yes, what percentage)",
    re.I,
)


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


def clean_section(s: str) -> str:
    s = re.sub(r"^SECTION\s+\d+\s*:\s*", "", str(s or ""), flags=re.I).strip()
    return s or "ReBUILD"


def map_type(raw: str) -> tuple[str, list[str]]:
    t = (raw or "").lower()
    if "yes/no" in t or "yes / no" in t:
        return "radio", ["Yes", "No"]
    if "multi-select" in t or "multi select" in t or "select all" in t:
        return "multiselect", []
    if "single select" in t or "single-select" in t or "range select" in t:
        return "radio", []
    if "long response" in t or "long text" in t:
        return "textarea", []
    if "numeric" in t or "number" in t:
        return "number", []
    if "short response" in t or "short text" in t:
        return "text", []
    return "text", []


def parse_branch(branch: str, by_num: dict[int, str]) -> dict | None:
    """Best-effort showIf from Branch Logic lines."""
    b = str(branch or "")
    if not b:
        return None
    # If "No," skip / go to …
    m = re.search(r'If\s+"([^"]+)"\s*,?\s*(?:skip|go to)', b, re.I)
    if m:
        # Shown when NOT that value → inverse is hard; encode as show when opposite for Yes/No
        val = m.group(1).strip()
        # Most branches are "If No, skip next" → show follow-up when Yes
        # Or "If Yes, skip to Section 2" on interest gate → show Q14 when No
        return {"_raw": b, "triggerValue": val}
    return {"_raw": b}


def parse_docx(path: Path) -> tuple[list[dict], dict]:
    d = Document(str(path))
    paras = [(p.style.name if p.style else "", (p.text or "").strip()) for p in d.paragraphs]

    section = "ReBUILD"
    study_ctx = ""
    questions: list[dict] = []
    cur = None
    docx_num_counts: Counter[int] = Counter()

    def flush():
        nonlocal cur
        if cur:
            questions.append(cur)
            cur = None

    for style, text in paras:
        if not text:
            continue
        if SECTION_RE.match(text) or (style.startswith("Heading") and not STUDY_RE.match(text)):
            flush()
            section = clean_section(text)
            study_ctx = ""
            continue
        sm = STUDY_RE.match(text)
        if sm:
            flush()
            study_ctx = f"Study #{sm.group(1)}"
            continue

        m = Q_RE.match(text)
        if m:
            flush()
            num = int(m.group(1))
            docx_num_counts[num] += 1
            label = re.sub(r"\s*\*\s*$", "", m.group(2).strip()).strip()
            if study_ctx and num in (24, 25):
                label = f"{study_ctx}: {label}"
            required = bool(m.group(3)) or text.rstrip().endswith("*")
            cur = {
                "docxNum": num,
                "label": label,
                "required": required,
                "category": section if not study_ctx else "Site Profile — Recent Dry AMD Studies",
                "type": "text",
                "options": [],
                "branch": "",
                "help": "",
                "studyCtx": study_ctx,
            }
            continue

        if cur is None:
            continue

        tm = TYPE_RE.match(text)
        if tm:
            typ, opts = map_type(tm.group(1))
            cur["type"] = typ
            if opts and not cur["options"]:
                cur["options"] = list(opts)
            cur["help"] = tm.group(1).strip()
            continue

        bm = BRANCH_RE.match(text)
        if bm:
            cur["branch"] = bm.group(1).strip()
            continue

        if style == "List Paragraph" or text.startswith(("•", "-", "\u2022")):
            opt = re.sub(r"^[•\-\u2022]\s*", "", text).strip()
            if opt and opt not in cur["options"]:
                cur["options"].append(opt)
            continue

    flush()

    # Normalize types when options present
    for q in questions:
        if q["options"] and q["type"] in ("text", "textarea", "number"):
            opts_l = [o.lower() for o in q["options"]]
            if {"yes", "no"}.issubset(set(opts_l)) and len(q["options"]) <= 4:
                q["type"] = "radio"
            else:
                help_l = (q.get("help") or "").lower()
                q["type"] = "multiselect" if ("multi" in help_l or "select all" in help_l) else "radio"

    # Expand follow-up option text into separate questions
    expanded: list[dict] = []
    for q in questions:
        followups = []
        clean_opts = []
        for opt in q.get("options") or []:
            if FOLLOW_OPT_RE.search(opt) or "please specify" in opt.lower() or "please describe" in opt.lower():
                # Keep "Other" as option when present separately; lift describe/spec into follow-up
                if opt.lower().startswith("other"):
                    clean_opts.append("Other")
                followups.append(
                    {
                        "docxNum": q["docxNum"],
                        "label": opt.rstrip(":").strip(),
                        "required": False,
                        "category": q["category"],
                        "type": "text",
                        "options": [],
                        "branch": "",
                        "help": f"Follow-up to: {q['label'][:80]}",
                        "studyCtx": q.get("studyCtx") or "",
                        "isFollowUp": True,
                        "parentLabel": q["label"],
                    }
                )
            else:
                clean_opts.append(opt)
        # Dedupe options preserving order
        seen = set()
        q["options"] = []
        for o in clean_opts:
            k = o.lower()
            if k in seen:
                continue
            seen.add(k)
            q["options"].append(o)
        expanded.append(q)
        expanded.extend(followups)

    meta = {
        "docxPath": str(path),
        "rawParsed": len(questions),
        "afterFollowUps": len(expanded),
        "duplicateNumbers": sorted([n for n, c in docx_num_counts.items() if c > 1]),
        "docxNumCounts": {str(k): v for k, v in sorted(docx_num_counts.items())},
        "missingNumbers": [
            i
            for i in range(1, (max(docx_num_counts) if docx_num_counts else 0) + 1)
            if i not in docx_num_counts
        ],
    }
    return expanded, meta


def find_match(label: str, by_lib_id: dict, by_lib_label: dict):
    ln = norm(label)
    if ln in ALIASES and ALIASES[ln] in by_lib_id:
        return by_lib_id[ALIASES[ln]], f"alias:{ALIASES[ln]}"
    for key, lid in ALIASES.items():
        if lid not in by_lib_id:
            continue
        if ln == key:
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
    if best and best_s >= 0.94 and len(ln) >= 48:
        return best, f"fuzzy-lib:{best_s:.2f}"
    return None, None


def attach_branch_logic(survey_qs: list[dict], raw_questions: list[dict]):
    """Wire simple Yes/No skip branches onto follow-up rows."""
    by_label = {q["label"]: q for q in survey_qs}
    # Interest gate: Q13 Yes → skip not-interested reasons
    interest = next(
        (
            q
            for q in survey_qs
            if "reviewed the protocol synopsis" in q["label"].lower()
            and "interest" in q["label"].lower()
        ),
        None,
    )
    not_int = next(
        (q for q in survey_qs if q["label"].lower().startswith("if not interested")),
        None,
    )
    if interest and not_int:
        not_int["logic"] = {
            "showIf": {"questionId": interest["id"], "equals": "No"},
        }

    # Generic: "If No, skip the next question" on parent → next required showIf Yes
    for i, rq in enumerate(raw_questions):
        branch = (rq.get("branch") or "").lower()
        if "skip the next" in branch and 'if "no"' in branch:
            parent = by_label.get(rq["label"])
            # next non-followup or next item
            if i + 1 < len(raw_questions) and parent:
                child_label = raw_questions[i + 1]["label"]
                child = by_label.get(child_label)
                if child:
                    child["logic"] = {
                        "showIf": {"questionId": parent["id"], "equals": "Yes"},
                    }
        if "skip to q20" in branch.replace(" ", "") or "go to q20" in branch.replace(" ", ""):
            parent = by_label.get(rq["label"])
            # satellite block: show Q18/Q19 when Yes
            if parent:
                for sq in survey_qs:
                    if sq["label"] in (
                        "Satellite Institution Name",
                        "Will this be an independent satellite site?",
                    ) or sq["label"].startswith("If no, what procedures"):
                        sq["logic"] = {
                            "showIf": {"questionId": parent["id"], "equals": "Yes"},
                        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", nargs="?", default=str(DEFAULT_DOCX))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    docx_path = Path(args.docx)
    if not docx_path.exists():
        raise SystemExit(f"DOCX not found: {docx_path}")

    questions, meta = parse_docx(docx_path)

    db = cosmos()
    lib_c = db.get_container_client("site-survey-question-library")
    def_c = db.get_container_client("site-survey-definitions")

    # Prior survey for delta report
    prior_labels = set()
    try:
        prior = def_c.read_item(SURVEY_ID, SURVEY_ID)
        prior_labels = {
            norm(q.get("label"))
            for q in (prior.get("questions") or [])
            if q.get("label")
        }
    except Exception:
        prior = None

    lib_items = list(lib_c.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    by_lib_id = {x["id"]: x for x in lib_items if x.get("id")}
    by_lib_label = {}
    for x in lib_items:
        k = norm(x.get("label"))
        if k and k not in by_lib_label:
            by_lib_label[k] = x
    preexisting_labels = dict(by_lib_label)

    now = datetime.now(timezone.utc).isoformat()
    survey_qs = []
    report = []
    created = 0
    reused = 0
    label_counts = Counter(norm(q["label"]) for q in questions)
    dup_labels = [lab for lab, c in label_counts.items() if c > 1]

    for i, qq in enumerate(questions, start=1):
        match, how = find_match(qq["label"], by_lib_id, preexisting_labels)
        opts = list(qq.get("options") or [])
        qtype = qq["type"]

        if match and str(match.get("id") or "").startswith("ql-"):
            lib_id = match["id"]
            reused += 1
            lib_doc = dict(by_lib_id.get(lib_id) or match)
            tags = list(
                dict.fromkeys((lib_doc.get("tags") or []) + ["rebuild", "mytx272am-201", "mighty", SOURCE])
            )
            lib_doc["tags"] = tags
            lib_doc["updatedAt"] = now
            # Refresh options from AF when richer
            if opts and qtype in ("radio", "select", "multiselect"):
                if len(opts) >= len(lib_doc.get("options") or []):
                    lib_doc["options"] = opts
                    lib_doc["type"] = qtype
            if args.apply:
                lib_c.upsert_item(lib_doc)
            by_lib_id[lib_id] = lib_doc
        else:
            lib_id = slug(qq["label"], i)
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
                "tags": ["rebuild", "mytx272am-201", "mighty", "feasibility", SOURCE, "new"],
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
                "docxNum": qq.get("docxNum"),
            }
        )
        report.append(
            {
                "n": i,
                "docxNum": qq.get("docxNum"),
                "label": qq["label"][:140],
                "libraryQuestionId": lib_id,
                "how": how or "created",
                "type": qtype,
                "followUp": bool(qq.get("isFollowUp")),
            }
        )

    attach_branch_logic(survey_qs, questions)

    pages = []
    for sq in survey_qs:
        title = (sq.get("category") or "ReBUILD").strip()
        if not pages or pages[-1]["title"] != title:
            pages.append({"id": f"page-{len(pages) + 1}", "title": title, "questionIds": []})
        pages[-1]["questionIds"].append(sq["id"])

    new_labels = {norm(q["label"]) for q in questions}
    added_vs_prior = sorted(new_labels - prior_labels)
    removed_vs_prior = sorted(prior_labels - new_labels)

    summary = {
        "docx": str(docx_path),
        "surveyId": SURVEY_ID,
        "source": SOURCE,
        "docxMeta": meta,
        "surveyQuestionCount": len(survey_qs),
        "libraryReused": reused,
        "libraryCreated": created,
        "duplicateLabelsInParsed": [
            {"norm": d, "count": label_counts[d]} for d in dup_labels
        ],
        "duplicateDocxNumbers": meta["duplicateNumbers"],
        "missingDocxNumbers": meta["missingNumbers"],
        "vsPriorSurvey": {
            "priorCount": len(prior_labels),
            "added": len(added_vs_prior),
            "removed": len(removed_vs_prior),
            "addedSample": added_vs_prior[:25],
            "removedSample": removed_vs_prior[:25],
        },
        "questions": report,
    }

    out = REPO / ".firecrawl" / "rebuild-af-sync-report.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"DOCX: {docx_path.name}")
    print(f"Parsed rows (raw): {meta['rawParsed']}")
    print(f"After follow-up expansion: {meta['afterFollowUps']}")
    print(f"Survey questions to write: {len(survey_qs)}")
    print(f"Library reused: {reused}  created: {created}")
    print(f"DOCX duplicate numbers: {meta['duplicateNumbers'] or 'none'}")
    print(f"DOCX missing numbers (1..max): {meta['missingNumbers'] or 'none'}")
    print(f"Duplicate labels in parse: {len(dup_labels)}")
    print(
        f"vs prior Artemis survey: +{len(added_vs_prior)} added / -{len(removed_vs_prior)} removed "
        f"(prior had {len(prior_labels)})"
    )
    print(f"Report: {out}")

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
                "(AF standardized format). Library questions matched to existing items where possible."
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
            "docxPath": docx_path.name,
            "tags": ["rebuild", "mytx272am-201", "mighty", "feasibility", "predefined", SOURCE],
            "updatedAt": now,
        }
    )
    def_c.upsert_item(survey)
    print(f"\nAPPLIED survey={SURVEY_ID} ({len(survey_qs)} qs, {len(pages)} pages)")


if __name__ == "__main__":
    main()
