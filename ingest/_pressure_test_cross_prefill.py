"""Pressure-test Cavalry prefill from Viatris prior answers (Cochet, Schirmer, slit lamp, etc.)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_cavalry_nk_survey import cosmos_db  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
CAV = "survey-cavalry-nk-feasibility"
VIA = "survey-feas-mon-viatris-nk-gene-therapy-p1-2"

CHECK_LIBS = [
    "ql-cochet-bonnet-esthesiometer",
    "ql-schirmer-tear-samples",
    "ql-slit-lamp-camera",
    "ql-mackie-criteria-nk",
    "ql-site-name",
    "ql-pi-name",
    "ql-coord-name",
]


def ok(m): print(f"  PASS  {m}")
def fail(m): print(f"  FAIL  {m}")


def node_cross_prefill(questions, responses):
    script = r"""
const {
  buildPrefillMapForQuestions,
  finalizeStreetOnlyPrefill,
  resolveQuestionLibraryId,
} = require('./api/lib/survey-response-service');
const { resolveGfBridgeLibraryId, resolveConceptLibraryId } = require('./api/lib/gf-question-bridges');
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const map = finalizeStreetOnlyPrefill(
  payload.questions,
  buildPrefillMapForQuestions(payload.questions, payload.responses, {})
);
const byLib = {};
for (const q of payload.questions) {
  const lib = resolveQuestionLibraryId(q) || q.libraryQuestionId;
  if (lib && map[q.id]) byLib[lib] = { value: map[q.id], label: (q.label||'').slice(0,80), id: q.id };
}
const sampleBridges = (payload.sampleAnswers || []).map(a => ({
  label: (a.label||'').slice(0,70),
  rawLib: a.libraryQuestionId,
  resolved: resolveGfBridgeLibraryId(a),
  concept: resolveConceptLibraryId(a.label),
  value: a.value,
}));
process.stdout.write(JSON.stringify({ byLib, sampleBridges, filledCount: Object.keys(map).length }, null, 2));
"""
    proc = subprocess.run(
        ["node", "-e", script],
        input=json.dumps({"questions": questions, "responses": responses, "sampleAnswers": responses[0].get("answers") if responses else []}),
        capture_output=True,
        text=True,
        cwd=str(REPO),
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[:1200])
    return json.loads(proc.stdout)


def main() -> int:
    fails = 0
    db = cosmos_db()
    defs = db.get_container_client("site-survey-definitions")
    rsp = db.get_container_client("site-survey-responses")
    cav = defs.read_item(CAV, CAV)
    qs = cav.get("questions") or []

    # Find a Viatris response that answered Cochet or Schirmer
    rows = list(
        rsp.query_items(
            query="SELECT TOP 80 * FROM c WHERE c.surveyId = @sid",
            parameters=[{"name": "@sid", "value": VIA}],
            enable_cross_partition_query=True,
        )
    )
    print(f"Viatris responses scanned: {len(rows)}")
    pick = None
    for r in rows:
        for a in r.get("answers") or []:
            lab = (a.get("label") or "").lower()
            val = str(a.get("value") or "").strip()
            if not val:
                continue
            if "cochet" in lab or "schirmer" in lab or "slit-lamp" in lab or "slit lamp" in lab:
                pick = r
                break
        if pick:
            break

    if not pick:
        fail("No Viatris response with Cochet/Schirmer/slit-lamp answers found")
        return 1

    print(f"Using siteId={pick.get('siteId')} siteName={pick.get('siteName')!r}")
    out = node_cross_prefill(qs, [pick])
    print("\n=== Bridge sample (first response answers) ===")
    for b in out.get("sampleBridges") or []:
        lab = (b.get("label") or "").lower()
        if any(k in lab for k in ("cochet", "schirmer", "slit", "mackie", "site name", "tear")):
            print(json.dumps(b, ensure_ascii=False))

    print("\n=== Cavalry prefill hits ===")
    by_lib = out.get("byLib") or {}
    for lib in CHECK_LIBS:
        hit = by_lib.get(lib)
        if hit:
            ok(f"{lib}: {hit['value']!r}  ({hit['label']})")
        else:
            # only fail hard for cochet/schirmer/slit if Viatris had them
            via_had = False
            for a in pick.get("answers") or []:
                lab = (a.get("label") or "").lower()
                val = str(a.get("value") or "").strip()
                if not val:
                    continue
                if lib == "ql-cochet-bonnet-esthesiometer" and "cochet" in lab:
                    via_had = True
                if lib == "ql-schirmer-tear-samples" and "schirmer" in lab:
                    via_had = True
                if lib == "ql-slit-lamp-camera" and "slit" in lab and "make" not in lab:
                    via_had = True
                if lib == "ql-mackie-criteria-nk" and "mackie" in lab:
                    via_had = True
                if lib == "ql-site-name" and lab.strip() == "site name":
                    via_had = True
            if via_had:
                fail(f"{lib} not prefilling though Viatris had an answer")
                fails += 1
            else:
                print(f"  SKIP  {lib} (no Viatris source answer)")

    # Street-only reshape unit check
    print("\n=== Street-only reshape ===")
    street_q = next((q for q in qs if (q.get("label") or "") == "Site Street Address"), None)
    if street_q:
        unit = {
            "questions": [street_q, {"id": "city", "label": "City", "libraryQuestionId": "ql-site-city", "type": "text"}],
            "responses": [{
                "answers": [{
                    "questionId": "x",
                    "libraryQuestionId": "ql-site-address",
                    "label": "Address",
                    "value": "10439 State Highway 151, San Antonio, TX 78251",
                }]
            }],
        }
        script = r"""
const { buildPrefillMapForQuestions, finalizeStreetOnlyPrefill } = require('./api/lib/survey-response-service');
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(0,'utf8'));
const map = finalizeStreetOnlyPrefill(p.questions, buildPrefillMapForQuestions(p.questions, p.responses, {}));
process.stdout.write(JSON.stringify(map));
"""
        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(unit),
            capture_output=True,
            text=True,
            cwd=str(REPO),
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode != 0:
            fail(proc.stderr[:400])
            fails += 1
        else:
            m = json.loads(proc.stdout)
            got = m.get(street_q["id"]) or ""
            if got == "10439 State Highway 151":
                ok(f"street-only from compound → {got!r}")
            else:
                fail(f"street-only expected highway only, got {got!r}")
                fails += 1

    print(f"\n=== Result: {fails} failure(s); filled {out.get('filledCount')} fields ===")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
