"""Audit all site-survey-responses for Excel/date corruption and shape drift."""
from __future__ import annotations

import collections
import json
import re
from pathlib import Path

from azure.cosmos import CosmosClient

cfg = json.load(open("data-api-connections.json", encoding="utf-8"))
cs = cfg["cosmosdb-connection"]["connectionString"]
endpoint = re.search(r"AccountEndpoint=([^;]+)", cs).group(1)
key = re.search(r"AccountKey=([^;]+)", cs).group(1)
client = CosmosClient(endpoint, key)
db = client.get_database_client("crcscheduling")
defc = db.get_container_client("site-survey-definitions")
resc = db.get_container_client("site-survey-responses")

DATE_RE = re.compile(r"^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?)?$")
SLASH_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")


def is_date_like(v: object) -> bool:
    s = str(v or "").strip()
    if not s:
        return False
    return bool(DATE_RE.match(s) or SLASH_DATE.match(s) or "00:00:00" in s)


def is_date_question(label: str) -> bool:
    lab = (label or "").lower()
    if "update" in lab:
        return False
    return bool(re.search(r"\bdate\b|completion date|submitted|start date|end date", lab))


defs = list(defc.query_items("SELECT * FROM c", enable_cross_partition_query=True))
all_rows = list(
    resc.query_items(
        "SELECT c.id, c.surveyId, c.siteId, c.answers, c.submittedAt FROM c "
        "WHERE (NOT IS_DEFINED(c._archived) OR c._archived != true)",
        enable_cross_partition_query=True,
    )
)

by_survey: dict[str, list] = collections.defaultdict(list)
for r in all_rows:
    by_survey[r.get("surveyId")].append(r)

report = {
    "summary": {
        "definitions": len(defs),
        "active_responses": len(all_rows),
        "surveys_with_responses": 0,
        "corrupt_date_values_in_non_date_questions": 0,
        "legitimate_date_question_values": 0,
        "responses_with_any_corruption": 0,
    },
    "surveys": [],
    "worst_questions": [],
}

q_global: collections.Counter = collections.Counter()
corrupt_response_ids: set[str] = set()

for d in sorted(defs, key=lambda x: (x.get("title") or x.get("id") or "")):
    sid = d.get("id")
    title = d.get("title") or sid
    rows = by_survey.get(sid) or []
    if not rows:
        continue
    report["summary"]["surveys_with_responses"] += 1
    lens = collections.Counter(len(r.get("answers") or []) for r in rows)
    corrupt_items = []
    meta_date_count = 0
    corrupt_count = 0
    by_label: dict[str, list] = collections.defaultdict(list)

    for r in rows:
        for a in r.get("answers") or []:
            v = str(a.get("value") or "").strip()
            if not is_date_like(v):
                continue
            label = a.get("label") or a.get("questionId") or ""
            if is_date_question(label):
                meta_date_count += 1
                report["summary"]["legitimate_date_question_values"] += 1
                continue
            corrupt_count += 1
            report["summary"]["corrupt_date_values_in_non_date_questions"] += 1
            corrupt_response_ids.add(r.get("id"))
            by_label[label].append(
                {"responseId": r.get("id"), "siteId": r.get("siteId"), "value": v}
            )
            q_global[(sid, title, label)] += 1
            if len(corrupt_items) < 50:
                corrupt_items.append(
                    {
                        "responseId": r.get("id"),
                        "siteId": r.get("siteId"),
                        "questionId": a.get("questionId"),
                        "label": (label or "")[:160],
                        "value": v,
                    }
                )

    report["surveys"].append(
        {
            "surveyId": sid,
            "title": title,
            "questionCount": len(d.get("questions") or []),
            "responseCount": len(rows),
            "answerLengthHistogram": dict(sorted(lens.items())),
            "answerLengthMin": min(lens) if lens else 0,
            "answerLengthMax": max(lens) if lens else 0,
            "shapeUniform": len(lens) == 1,
            "corruptNonDateDateValues": corrupt_count,
            "legitimateDateQuestionValues": meta_date_count,
            "questionsWithCorruption": [
                {
                    "label": lab[:160],
                    "corruptCount": len(vals),
                    "samples": [x["value"] for x in vals[:5]],
                }
                for lab, vals in sorted(by_label.items(), key=lambda kv: -len(kv[1]))
            ],
            "sampleCorruptCells": corrupt_items,
        }
    )

report["summary"]["responses_with_any_corruption"] = len(corrupt_response_ids)
report["worst_questions"] = [
    {
        "surveyId": sid,
        "title": title,
        "label": label[:160],
        "corruptCount": n,
    }
    for (sid, title, label), n in q_global.most_common(50)
]
report["surveys"].sort(
    key=lambda s: (-s["corruptNonDateDateValues"], -s["responseCount"])
)

out_dir = Path("exports")
out_dir.mkdir(parents=True, exist_ok=True)
json_path = out_dir / "survey_answer_quality_audit.json"
json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

lines = [
    "# Survey answer quality audit",
    "",
    f"- Definitions: {report['summary']['definitions']}",
    f"- Active responses: {report['summary']['active_responses']}",
    f"- Surveys with responses: {report['summary']['surveys_with_responses']}",
    f"- **Corrupt Excel/date values in non-date questions: {report['summary']['corrupt_date_values_in_non_date_questions']}**",
    f"- Legitimate date-question values: {report['summary']['legitimate_date_question_values']}",
    f"- Responses with ≥1 corruption: {report['summary']['responses_with_any_corruption']}",
    "",
    "Shape note: almost no survey has uniform answer length across sites "
    "(SurveyMonkey/Monday sparse exports). That is expected. "
    "Corrupt cells are Excel datetimes stored where a count/text was expected.",
    "",
    "## By survey (corrupt first)",
    "",
    "| Survey | Responses | Q def | Answer lens | Corrupt dates | Form dates | Uniform |",
    "|---|---:|---:|---|---:|---:|:---:|",
]
for s in report["surveys"]:
    title = (s["title"] or "").replace("|", "/")
    lens = f"{s['answerLengthMin']}–{s['answerLengthMax']}"
    uni = "yes" if s["shapeUniform"] else "no"
    lines.append(
        f"| {title} | {s['responseCount']} | {s['questionCount']} | {lens} | "
        f"{s['corruptNonDateDateValues']} | {s['legitimateDateQuestionValues']} | {uni} |"
    )

lines += ["", "## Worst questions (date values where count/text expected)", ""]
for w in report["worst_questions"][:30]:
    lines.append(
        f"- **{w['corruptCount']}×** {w['title']} — {w['label'][:140]}"
    )

lines += ["", f"Full JSON: `{json_path.as_posix()}`", ""]
md_path = out_dir / "survey_answer_quality_audit.md"
md_path.write_text("\n".join(lines), encoding="utf-8")
print(md_path.read_text(encoding="utf-8"))
