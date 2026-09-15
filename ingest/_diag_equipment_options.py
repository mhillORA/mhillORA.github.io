"""Diagnose equipment questions that inherited the full inventory options list."""
from __future__ import annotations

import json
from pathlib import Path

from azure.cosmos import CosmosClient

REPO = Path(__file__).resolve().parents[1]


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


def main():
    db = cosmos_db()
    defs = db.get_container_client("site-survey-definitions")
    lib = db.get_container_client("site-survey-question-library")
    try:
        inv = lib.read_item("ql-site-equipment-inventory", "ql-site-equipment-inventory")
        print(
            "inventory options",
            len(inv.get("options") or []),
            "label",
            (inv.get("label") or "")[:60],
        )
    except Exception as e:
        print("inventory missing", e)

    for sid in (
        "survey-rebuild-mytx272am-201",
        "survey-general-feasibility",
        "survey-general-feasibility-short",
    ):
        try:
            doc = defs.read_item(sid, sid)
        except Exception as e:
            print(sid, "MISS", e)
            continue
        qs = doc.get("questions") or []
        print("===", sid, "qs", len(qs))
        for q in qs:
            lib_id = str(q.get("libraryQuestionId") or "")
            opts = q.get("options") or []
            label = (q.get("label") or "")[:80]
            hit = (
                lib_id == "ql-site-equipment-inventory"
                or len(opts) >= 12
                or "equipment" in label.lower()
                or "oct" in label.lower()
                or "fundus" in label.lower()
                or "etdrs" in label.lower()
                or "slit" in label.lower()
                or "angiograph" in label.lower()
            )
            if not hit:
                continue
            print(
                f"  id={q.get('id')} type={q.get('type')} opts={len(opts)} "
                f"section={q.get('section')!r} lib={lib_id}"
            )
            print(f"    {label}")
            if opts:
                print("    sample:", opts[:6])


if __name__ == "__main__":
    main()
