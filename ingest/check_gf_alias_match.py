"""Link General Feasibility (long+short) questions to library via aliases; report coverage."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]
SEED = REPO / "ingest" / "feasibility_question_library_seed.json"
LONG_ID = "survey-general-feasibility"
SHORT_ID = "survey-general-feasibility-short"


def norm(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", " ", (s or "").strip().lower())
    return re.sub(r"\s+", " ", t).strip()


def load_cosmos():
    data = json.loads((REPO / "data-api-connections.json").read_text(encoding="utf-8"))
    conn = data["cosmosdb-connection"]["connectionString"]
    parts = {}
    for chunk in conn.rstrip(";").split(";"):
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    client = CosmosClient(parts["AccountEndpoint"], parts["AccountKey"])
    db = client.get_database_client("crcscheduling")
    return db


def main():
    apply = "--apply" in __import__("sys").argv
    db = load_cosmos()
    defs = db.get_container_client("site-survey-definitions")
    lib = db.get_container_client("site-survey-question-library")

    seed = json.loads(SEED.read_text(encoding="utf-8"))
    seed_qs = seed.get("questions") or []
    # alias map from seed
    alias_to_lib = {}
    for q in seed_qs:
        for a in [q["label"], *(q.get("aliases") or [])]:
            k = norm(a)
            if k and k not in alias_to_lib:
                alias_to_lib[k] = q["id"]

    # also index live library
    live_lib = list(lib.query_items("SELECT * FROM c", enable_cross_partition_query=True))
    for q in live_lib:
        for a in [q.get("label"), *(q.get("aliases") or [])]:
            k = norm(a or "")
            if k and k not in alias_to_lib and q.get("id"):
                alias_to_lib[k] = q["id"]

    report = {"long": None, "short": None, "unmatched": [], "matched": [], "updated": 0}

    for sid, key in [(LONG_ID, "long"), (SHORT_ID, "short")]:
        d = defs.read_item(sid, sid)
        qs = d.get("questions") or []
        matched = 0
        unmatched = []
        changed = False
        for q in qs:
            label = str(q.get("label") or "").strip()
            existing = q.get("libraryQuestionId")
            hit = alias_to_lib.get(norm(label)) or alias_to_lib.get(norm(label.rstrip(":")))
            # also try gf id as library if we seeded ql-* differently
            if hit:
                if existing != hit:
                    q["libraryQuestionId"] = hit
                    changed = True
                matched += 1
                report["matched"].append({"survey": sid, "label": label, "libraryQuestionId": hit})
            else:
                unmatched.append({"id": q.get("id"), "label": label, "libraryQuestionId": existing})
                report["unmatched"].append({"survey": key, "id": q.get("id"), "label": label})
        report[key] = {
            "id": sid,
            "title": d.get("title"),
            "questionCount": len(qs),
            "matched": matched,
            "unmatched": len(unmatched),
        }
        if changed and apply:
            d["questions"] = qs
            d["updatedAt"] = datetime.now(timezone.utc).isoformat()
            d["libraryLinkedAt"] = d["updatedAt"]
            defs.upsert_item(d)
            report["updated"] += 1
            print(f"UPDATED {sid}")
        else:
            print(f"{'WOULD UPDATE' if changed else 'OK'} {sid} matched={matched}/{len(qs)}")

    # Ensure short is still subset of long with same ids
    long_qs = {q.get("id") for q in defs.read_item(LONG_ID, LONG_ID).get("questions") or []}
    short_qs = defs.read_item(SHORT_ID, SHORT_ID).get("questions") or []
    bad = [q.get("id") for q in short_qs if q.get("id") not in long_qs]
    report["shortIdsNotInLong"] = bad
    report["mode"] = "APPLY" if apply else "DRY-RUN"

    out = REPO / "ingest" / "gf_alias_match_report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("mode", "long", "short", "shortIdsNotInLong")}, indent=2))
    print(f"unmatched count: {len(report['unmatched'])}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
