"""
Sync General Site Feasibility Survey (10 Sep 2026 DOCX) → Cosmos.

- Match each DOCX question against existing library + GF Long questions
- Reuse libraryQuestionId / gf question id when matched
- Create missing library questions
- Rebuild GF Long (all DOCX questions) + Short (compact subset)

Usage:
  python ingest/sync_gsf_from_docx.py
  python ingest/sync_gsf_from_docx.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from azure.cosmos import CosmosClient
from docx import Document

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DOCX = Path(r"c:\Users\shue1\Downloads\General Site Feasibility Survey_10Sep2026.docx")
LONG_ID = "survey-general-feasibility"
SHORT_ID = "survey-general-feasibility-short"

# DOCX Q numbers for Short (compact profile)
SHORT_NUMS = [
    1, 2, 3, 5, 7, 8, 10, 14, 15, 21, 22, 27, 28, 84, 88, 90, 91,
]

# Explicit matches: normalized docx label key → library id
ALIASES = {
    "date of response": "ql-gf-01-date-of-response",
    "site legal name": "ql-site-name",
    "first and last name of respondent": "ql-gf-00-name",
    "title position of respondent": "ql-form-filler-role",
    "respondent email": "ql-form-filler-email",
    "respondent phone number": "ql-site-phone",
    "primary research point of contact first and last name": "ql-coord-name",
    "primary research contact email": "ql-coord-email",
    "primary research point of contact phone number": "ql-coord-phone",
    "primary research point of contact title role": "ql-primary-contact-role",
    "what is your site s street address": "ql-site-address",
    "which of the following practice settings best describes your clinical site": "ql-gf-05-practice-setting",
    "has your site conducted clinical research studies before": "ql-gf-19-research-experience",
    "please indicate the types of ophthalmic studies your site has participated in": "ql-gf-20-please-indicate-the-types-of-ophthalmic-studies-your-sit",
    "has your site ever been audited by a regulatory authority": "ql-gf-26-past-fda-audits",
    "which of the following sponsor types do you have experience partnering with": "ql-gf-21-sponsor-experience",
    "how many investigators pi sub i does your site have": "ql-gf-06-investigators",
    "which of the following equipment is available at your site": "ql-gf-25-equipment",
    "can your site use a central irb": "ql-gf-29-central-irb",
    "are there other committees at your site that require protocol review prior to or after approval from": "ql-gf-22-other-committees",
    "would your site s subjects benefit from language translations of patient facing material for recruit": "ql-gf-24-translations",
    "contracting budgeting contact first and last name": "ql-contracts-name",
    "contracting budgeting contact email": "ql-contracts-email",
}


def cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    db = (
        CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
        .get_database_client("crcscheduling")
    )
    return db


def norm(s: str) -> str:
    t = re.sub(r"\s+", " ", str(s or "").lower())
    t = re.sub(r"\(select all that apply.*?\)", "", t)
    t = re.sub(r"\*+", "", t)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def slug(label: str, num: int) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", norm(label)).strip("-")[:48] or "q"
    return f"gsf_{num:03d}_{s}"


def parse_docx(path: Path) -> list[dict]:
    doc = Document(str(path))
    paras = [(p.style.name if p.style else "", (p.text or "").strip()) for p in doc.paragraphs]
    questions = []
    cur = None
    section = None
    q_re = re.compile(r"^(\d+)\.\s+(.+?)\s*$")

    for style, text in paras:
        if not text:
            continue
        if style.startswith("Heading") or text.upper().startswith("SECTION "):
            section = text
            continue
        m = q_re.match(text)
        if m and re.match(r"^\d+\.", text):
            if cur:
                questions.append(cur)
            label = m.group(2).strip()
            required = label.endswith("*") or text.rstrip().endswith("*")
            label = label.rstrip(" *").strip()
            cur = {
                "num": int(m.group(1)),
                "label": label,
                "required": required,
                "section": section or "",
                "options": [],
                "notes": [],
                "select_all": "select all that apply" in label.lower(),
            }
            continue
        if cur is None:
            continue
        low = text.lower()
        if style == "List Paragraph":
            if low.startswith("if ") or "file upload" in low:
                cur["notes"].append(text)
            else:
                cur["options"].append(text)
        elif low.startswith("format:") or low.startswith("branch"):
            cur["notes"].append(text)

    if cur:
        questions.append(cur)

    # de-dupe by num (keep first complete)
    by_num = {}
    for q in questions:
        n = q["num"]
        if n not in by_num or len(q["options"]) > len(by_num[n]["options"]):
            by_num[n] = q
    questions = [by_num[k] for k in sorted(by_num)]

    yes_no = {"yes", "no"}
    for q in questions:
        clean = []
        for o in q["options"]:
            ol = o.lower().strip()
            if ol.startswith("if ") or "file upload" in ol or ol.startswith("branch"):
                continue
            clean.append(o)
        # unique preserve order
        seen = set()
        opts = []
        for o in clean:
            k = o.strip()
            if k.lower() in seen:
                continue
            seen.add(k.lower())
            opts.append(k)
        q["options"] = opts
        labels = {o.lower() for o in opts}
        if q["select_all"] or "select all that apply" in q["label"].lower():
            q["type"] = "multiselect"
        elif labels and labels <= yes_no:
            q["type"] = "radio"
            q["options"] = ["Yes", "No"]
        elif opts:
            q["type"] = "radio"
        elif "date" in q["label"].lower():
            q["type"] = "date"
        elif any(
            k in q["label"].lower()
            for k in ("how many", "percentage", "quantity", "duration", "number of days", "turnaround")
        ):
            q["type"] = "number" if "turnaround" not in q["label"].lower() else "text"
        elif any(k in q["label"].lower() for k in ("describe", "specify", "comment", "suggestions", "feedback", "anything else")):
            q["type"] = "textarea"
        else:
            q["type"] = "text"
        # strip select-all wording from display label for cleaner UI (keep note in help)
        q["help"] = "Select all that apply." if q["type"] == "multiselect" else (q["notes"][0] if q["notes"] else "")
    return questions


def find_match(q, by_lib_id, by_lib_label, gf_by_lib, gf_by_label):
    ln = norm(q["label"])
    # alias exact / prefix
    for ak, lid in ALIASES.items():
        if ln == ak or ln.startswith(ak) or ak.startswith(ln[:40]):
            if lid in by_lib_id:
                return by_lib_id[lid], f"alias:{lid}"
        if SequenceMatcher(None, ln, ak).ratio() >= 0.88 and lid in by_lib_id:
            return by_lib_id[lid], f"alias-fuzzy:{lid}"

    if ln in by_lib_label:
        return by_lib_label[ln], "exact-lib"

    # fuzzy library
    best = None
    best_s = 0
    for k, obj in by_lib_label.items():
        s = SequenceMatcher(None, ln, k).ratio()
        if s > best_s:
            best_s = s
            best = obj
    if best and best_s >= 0.84:
        return best, f"fuzzy-lib:{best_s:.2f}"

    if ln in gf_by_label:
        g = gf_by_label[ln]
        lid = g.get("libraryQuestionId")
        if lid and lid in by_lib_id:
            return by_lib_id[lid], "exact-gf→lib"
        return g, "exact-gf"

    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", nargs="?", default=str(DEFAULT_DOCX))
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    docx_path = Path(args.docx)
    if not docx_path.exists():
        raise SystemExit(f"Missing DOCX: {docx_path}")

    questions = parse_docx(docx_path)
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

    long_def = def_c.read_item(LONG_ID, LONG_ID)
    gf_qs = list(long_def.get("questions") or [])
    gf_by_lib = {q.get("libraryQuestionId"): q for q in gf_qs if q.get("libraryQuestionId")}
    gf_by_label = {}
    gf_by_id = {q["id"]: q for q in gf_qs if q.get("id")}
    for q in gf_qs:
        k = norm(q.get("label"))
        if k and k not in gf_by_label:
            gf_by_label[k] = q

    now = datetime.now(timezone.utc).isoformat()
    built = []
    report = []
    created_lib = 0
    reused_lib = 0

    for q in questions:
        match, how = find_match(q, by_lib_id, by_lib_label, gf_by_lib, gf_by_label)
        opts = list(q.get("options") or [])
        qtype = q["type"]
        if qtype == "radio" and opts and {o.lower() for o in opts} <= {"yes", "no"}:
            opts = ["Yes", "No"]

        if match and match.get("id") and str(match["id"]).startswith("ql-"):
            lib_id = match["id"]
            reused_lib += 1
            # Update library item to DOCX shape while keeping id
            lib_doc = dict(by_lib_id.get(lib_id) or match)
            lib_doc.update(
                {
                    "id": lib_id,
                    "label": q["label"],
                    "type": qtype if qtype != "radio" else "radio",
                    "options": opts if qtype in ("radio", "select", "multiselect") else [],
                    "required": q["required"],
                    "category": (q.get("section") or "General Feasibility")[:80],
                    "help": q.get("help") or lib_doc.get("help") or "",
                    "status": "active",
                    "updatedAt": now,
                    "source": "gsf-docx-10sep2026",
                }
            )
            if args.apply:
                lib_c.upsert_item(lib_doc)
            by_lib_id[lib_id] = lib_doc
            # Prefer existing GF question id linked to this library id
            prev = next((g for g in gf_qs if g.get("libraryQuestionId") == lib_id), None)
            qid = (prev or {}).get("id") or slug(q["label"], q["num"])
        elif match and match.get("id") and str(match["id"]).startswith("gf_"):
            # matched a GF question without library — create/link library
            prev = match
            lib_id = prev.get("libraryQuestionId") or f"ql-{slug(q['label'], q['num'])}"
            if lib_id not in by_lib_id:
                lib_doc = {
                    "id": lib_id,
                    "label": q["label"],
                    "type": qtype,
                    "options": opts if qtype in ("radio", "select", "multiselect") else [],
                    "required": q["required"],
                    "category": (q.get("section") or "General Feasibility")[:80],
                    "help": q.get("help") or "",
                    "status": "active",
                    "createdAt": now,
                    "updatedAt": now,
                    "source": "gsf-docx-10sep2026",
                    "tags": ["general-feasibility", "gsf-2026"],
                }
                if args.apply:
                    lib_c.upsert_item(lib_doc)
                by_lib_id[lib_id] = lib_doc
                created_lib += 1
            else:
                reused_lib += 1
            qid = prev.get("id") or slug(q["label"], q["num"])
            how = (how or "") + "+lib"
        else:
            lib_id = f"ql-{slug(q['label'], q['num'])}"
            lib_doc = {
                "id": lib_id,
                "label": q["label"],
                "type": qtype,
                "options": opts if qtype in ("radio", "select", "multiselect") else [],
                "required": q["required"],
                "category": (q.get("section") or "General Feasibility")[:80],
                "help": q.get("help") or "",
                "status": "active",
                "createdAt": now,
                "updatedAt": now,
                "source": "gsf-docx-10sep2026",
                "tags": ["general-feasibility", "gsf-2026", "new"],
            }
            if args.apply:
                lib_c.upsert_item(lib_doc)
            by_lib_id[lib_id] = lib_doc
            created_lib += 1
            qid = slug(q["label"], q["num"])
            how = "created"

        survey_q = {
            "id": qid,
            "label": q["label"],
            "type": qtype,
            "required": bool(q["required"]),
            "options": opts if qtype in ("radio", "select", "multiselect") else [],
            "logic": None,
            "libraryQuestionId": lib_id,
            "help": q.get("help") or "",
            "category": (q.get("section") or "")[:80],
            "docxNum": q["num"],
        }
        # Branch: Q21 No → research naive flag (skip handled lightly via note; full skip logic optional)
        if q["num"] == 21:
            survey_q["help"] = (survey_q["help"] + " If No, site is research-naïve.").strip()

        built.append(survey_q)
        report.append(
            {
                "num": q["num"],
                "label": q["label"][:100],
                "type": qtype,
                "libraryQuestionId": lib_id,
                "questionId": qid,
                "how": how or "created",
                "options": len(opts),
            }
        )

    # Short subset
    by_num = {q["docxNum"]: q for q in built}
    short_qs = [dict(by_num[n]) for n in SHORT_NUMS if n in by_num]

    out_path = REPO / ".firecrawl" / "gsf-sync-report.json"
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "docx": str(docx_path),
                "total": len(built),
                "reused_lib": reused_lib,
                "created_lib": created_lib,
                "short": len(short_qs),
                "questions": report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"DOCX questions: {len(built)}")
    print(f"Library reused: {reused_lib}  created: {created_lib}")
    print(f"Short questions: {len(short_qs)}")
    print(f"Report: {out_path}")
    for r in report:
        print(f"{r['how'][:24]:24s} Q{r['num']:03d} -> {r['libraryQuestionId']} / {r['questionId']}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write Cosmos.")
        return

    long_def["title"] = "General Feasibility (Long)"
    long_def["description"] = (
        "General Site Feasibility Survey (10 Sep 2026). "
        "Auto-prepended (Long or Short) on study surveys. "
        "Question IDs preserved where matched to prior GF / library items."
    )
    long_def["questions"] = built
    long_def["generalFeasibilityVariant"] = "long"
    long_def["updatedAt"] = now
    long_def["source"] = "gsf-docx-10sep2026"
    long_def["tags"] = list(
        dict.fromkeys((long_def.get("tags") or []) + ["general-feasibility", "general-feasibility-long", "gsf-2026"])
    )
    def_c.upsert_item(long_def)

    try:
        short_def = def_c.read_item(SHORT_ID, SHORT_ID)
    except Exception:
        short_def = {"id": SHORT_ID, "createdAt": now}
    short_def.update(
        {
            "id": SHORT_ID,
            "title": "General Feasibility (Short)",
            "description": "Compact subset of the 10 Sep 2026 General Site Feasibility Survey.",
            "status": "active",
            "questions": short_qs,
            "generalFeasibilityVariant": "short",
            "predefined": True,
            "tags": ["general-feasibility", "general-feasibility-short", "gsf-2026", "predefined"],
            "source": "gsf-docx-10sep2026",
            "updatedAt": now,
        }
    )
    def_c.upsert_item(short_def)
    print(f"\nAPPLIED Long={LONG_ID} ({len(built)} qs) Short={SHORT_ID} ({len(short_qs)} qs)")


if __name__ == "__main__":
    main()
