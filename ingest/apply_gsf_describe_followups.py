"""
Add DOCX 'If yes/other, please describe|specify…' follow-up fields onto GF Long.

The Sep 2026 bible stored these as notes under the parent question; sync only put them
in help text. This inserts real textarea (or radio) follow-ups with showIf, without
changing parent labels/options.

Usage:
  python ingest/apply_gsf_describe_followups.py
  python ingest/apply_gsf_describe_followups.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from sync_gsf_from_docx import LONG_ID, SHORT_ID, cosmos

REPO = Path(__file__).resolve().parents[1]
DOCX_QS = REPO / ".firecrawl" / "gf-survey-10sep2026-questions.json"


def slug(s: str, max_len: int = 48) -> str:
    t = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return (t[:max_len] or "followup").rstrip("-")


def clean_note_label(note: str) -> str:
    t = re.sub(r"\*+\s*$", "", str(note or "").strip())
    t = re.sub(r"\s*\(file upload\)\s*$", "", t, flags=re.I)
    t = re.sub(r"\s*\(or should we ask.*?\)\s*$", "", t, flags=re.I)
    return t.strip() or "Please describe"


def find_other_option(options: list) -> str | None:
    for o in options or []:
        s = str(o).strip()
        if re.match(r"^other\b", s, flags=re.I):
            return s
    return None


def classify_note(note: str, parent_options: list) -> dict | None:
    """Return {kind, label, type, showIfOp, showIfValue} or None to skip."""
    raw = str(note or "").strip()
    if not raw:
        return None
    low = raw.lower()

    # Skip pure file-upload prompts (no upload control on public form yet)
    if "file upload" in low and "describe" not in low and "specify" not in low:
        return None

    label = clean_note_label(raw)
    opts = [str(o) for o in (parent_options or [])]

    # Standalone "Other (please describe)" option → other trigger (before generic please-describe)
    if re.match(r"^other\s*\(please describe\)", low):
        other = find_other_option(opts) or "Other (please describe)"
        return {
            "kind": "other",
            "label": "Please describe",
            "type": "textarea",
            "options": None,
            "trigger": "other",
            "otherValue": other,
        }

    # If other → when Other* selected
    if re.match(r"^if other\b", low) or re.search(r"\bif other,", low):
        other = find_other_option(opts)
        if not other:
            return None
        return {
            "kind": "other",
            "label": label,
            "type": "textarea",
            "options": None,
            "trigger": "other",
            "otherValue": other,
        }

    # Nested Yes/No follow-ups
    if re.search(r"\byes\s*/\s*no\b", low) or (
        low.startswith("if yes")
        and re.search(r"\b(were you|are you|can |does your|do you)\b", low)
        and not re.search(r"\b(describe|specify|indicate|provide|what |which )\b", low)
    ):
        return {
            "kind": "yesno",
            "label": label,
            "type": "radio",
            "options": ["Yes", "No"],
            "trigger": "yes",
        }

    # If yes / describe / specify / what / which / recommendations
    if (
        re.match(r"^if yes\b", low)
        or re.search(r"please\s+(describe|specify|indicate|provide)", low)
        or re.search(
            r"\b(what system|which communities|types of materials|recommendations|describe the role)\b",
            low,
        )
    ):
        yes_opt = next((o for o in opts if re.match(r"^yes\b", o.strip(), re.I)), None)
        if not yes_opt and any("confusing" in o.lower() for o in opts):
            yes_opt = next(o for o in opts if "confusing" in o.lower())
        if not yes_opt:
            yes_opt = "Yes"
        qtype = "number" if re.search(r"how many", low) else "textarea"
        if "date your clia" in low:
            qtype = "date"
        return {
            "kind": "yes",
            "label": label,
            "type": qtype,
            "options": None,
            "trigger": "yes",
            "yesValue": yes_opt,
        }

    return None


def build_show_if(parent_id: str, meta: dict) -> dict:
    if meta["trigger"] == "other":
        return {"questionId": parent_id, "includes": meta["otherValue"]}
    # yes (or nested yes gate)
    return {"questionId": parent_id, "equals": meta.get("yesValue") or "Yes"}


def ensure_after(questions: list, parent_id: str, new_q: dict) -> list:
    if any(q.get("id") == new_q["id"] for q in questions):
        out = []
        for q in questions:
            if q.get("id") == new_q["id"]:
                # keep existing answer history id; refresh logic/label/type
                merged = {**q, **new_q}
                out.append(merged)
            else:
                out.append(q)
        return out
    out = []
    inserted = False
    for q in questions:
        out.append(q)
        if not inserted and q.get("id") == parent_id:
            out.append(new_q)
            inserted = True
    if not inserted:
        out.append(new_q)
    return out


def apply_followups_clean(cosmos_qs: list, docx_qs: list) -> tuple[list, list]:
    """Insert follow-ups after each parent. Idempotent by follow-up id."""
    qs = deepcopy(cosmos_qs)
    created = []
    seen_nums: set[int] = set()
    parents = []
    for q in qs:
        n = q.get("docxNum")
        if not isinstance(n, int):
            continue
        if q.get("followUpOf") or "_fu_" in str(q.get("id") or ""):
            continue
        # Only the primary question for each DOCX number (skip Q37b-style extras)
        if n in seen_nums:
            continue
        seen_nums.add(n)
        parents.append(q)
    parent_ids = {q.get("id") for q in parents}
    docx_by_num = {q.get("num"): q for q in docx_qs}

    for parent in parents:
        num = parent.get("docxNum")
        dq = docx_by_num.get(num)
        if not dq:
            continue
        parent_id = parent.get("id")
        parent_opts = parent.get("options") or dq.get("options_clean") or dq.get("options") or []
        section = parent.get("category") or parent.get("section") or dq.get("section") or "Questions"
        notes = list(dq.get("notes") or [])
        for o in parent_opts:
            if re.match(r"^other\s*\(please describe\)", str(o), re.I):
                notes.append("Other (please describe)")

        seen_notes = set()
        uniq_notes = []
        for n in notes:
            k = str(n).strip().lower()
            if k in seen_notes:
                continue
            seen_notes.add(k)
            uniq_notes.append(n)

        for note in uniq_notes:
            meta = classify_note(note, parent_opts)
            if not meta:
                continue
            fid = f"gsf_{int(num):03d}_fu_{meta['kind']}_{slug(meta['label'], 28)}"
            if meta["kind"] == "yesno":
                show_if = {"questionId": parent_id, "equals": "Yes"}
            else:
                show_if = build_show_if(parent_id, meta)

            starred = "*" in str(note)
            new_q = {
                "id": fid,
                "libraryQuestionId": f"ql-{fid}",
                "label": meta["label"],
                "type": meta["type"],
                "required": starred,
                "category": section,
                "section": section,
                "docxNum": num,
                "help": "Shown when the condition above is met.",
                "logic": {"showIf": show_if},
                "followUpOf": parent_id,
                "followUpSource": "docx-note",
            }
            if meta.get("options"):
                new_q["options"] = meta["options"]

            qs = ensure_after(qs, parent_id, new_q)
            created.append(
                {
                    "parent": parent_id,
                    "id": fid,
                    "label": meta["label"],
                    "showIf": show_if,
                    "type": meta["type"],
                }
            )

            if parent_id in parent_ids:
                for q in qs:
                    if q.get("id") != parent_id:
                        continue
                    help_t = str(q.get("help") or "")
                    if re.search(r"if (yes|other)", help_t, re.I):
                        bits = [b.strip() for b in re.split(r"\s{2,}|\n", help_t) if b.strip()]
                        bits = [
                            b
                            for b in bits
                            if not re.search(r"if (yes|other)|please (describe|specify)", b, re.I)
                        ]
                        q["help"] = " ".join(bits).strip()
                    break

    return qs, created


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    docx_qs = json.loads(DOCX_QS.read_text(encoding="utf-8"))
    db = cosmos()
    def_c = db.get_container_client("site-survey-definitions")
    long_def = def_c.read_item(LONG_ID, LONG_ID)
    short_def = def_c.read_item(SHORT_ID, SHORT_ID)

    before = len(long_def.get("questions") or [])
    new_qs, created = apply_followups_clean(long_def.get("questions") or [], docx_qs)
    after = len(new_qs)

    print(f"Long questions: {before} -> {after} (+{after - before})")
    print(f"Follow-ups upserted: {len(created)}")
    for c in created[:40]:
        print(f"  {c['id']}: {c['label'][:70]} | {c['showIf']}")
    if len(created) > 40:
        print(f"  … {len(created) - 40} more")

    report = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "longBefore": before,
        "longAfter": after,
        "followUps": created,
    }
    out = REPO / ".firecrawl" / "gsf-describe-followups-report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Report:", out)

    if not args.apply:
        print("Dry run only. Re-run with --apply to write Cosmos.")
        return

    now = datetime.now(timezone.utc).isoformat()
    long_def["questions"] = new_qs
    long_def["updatedAt"] = now
    long_def["describeFollowUpsSource"] = "docx-notes-10sep2026"
    def_c.upsert_item(long_def)

    # Short: keep existing ids + any new follow-ups whose parent is on Short
    short_ids = {q.get("id") for q in (short_def.get("questions") or [])}
    short_parents = {q.get("id") for q in new_qs if q.get("id") in short_ids}
    short_qs = []
    for q in new_qs:
        if q.get("id") in short_ids or (q.get("followUpOf") in short_parents):
            short_qs.append(deepcopy(q))
    short_def["questions"] = short_qs
    short_def["updatedAt"] = now
    short_def["describeFollowUpsSource"] = "docx-notes-10sep2026"
    def_c.upsert_item(short_def)
    print(f"Applied to Long ({after}) + Short ({len(short_qs)}) in Cosmos.")


if __name__ == "__main__":
    main()
