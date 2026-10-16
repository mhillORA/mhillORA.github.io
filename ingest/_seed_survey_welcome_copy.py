"""Seed global survey-welcome-copy doc in Cosmos (idempotent)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_cavalry_nk_survey import cosmos_db  # noqa: E402

DOC_ID = "survey-welcome-copy"
APPLY = "--apply" in sys.argv

DEFAULT = {
    "id": DOC_ID,
    "type": "welcomeCopy",
    "experienced": {
        "title": "Sites experienced with Ora",
        "body": (
            "Welcome back — and thank you for your continued partnership. Because your site has worked "
            "with Ora before, we've already completed most of this form for you using information from "
            "your prior feasibility surveys. Simply review what we have on file, confirm it's still accurate, and "
            "answer a few study-specific questions at the end."
        ),
        "durationNote": "This should take about 15 minutes.",
    },
    "newToOra": {
        "title": "New to Ora? Welcome — we're glad you're here.",
        "body": (
            "Thank you for your interest in partnering with Ora on this study. As you complete this "
            "profile, we'll store your information securely so that future feasibility surveys are "
            "faster and more streamlined — many of these questions will only need to be answered once. "
            "We look forward to building a lasting partnership with your site."
        ),
        "durationNote": "This should take about 30 minutes.",
    },
}


def main() -> None:
    db = cosmos_db()
    c = db.get_container_client("site-survey-definitions")
    try:
        existing = c.read_item(DOC_ID, DOC_ID)
        print("Already exists:")
        print(json.dumps({
            "id": existing.get("id"),
            "type": existing.get("type"),
            "updatedAt": existing.get("updatedAt"),
            "experiencedTitle": (existing.get("experienced") or {}).get("title"),
            "newToOraTitle": (existing.get("newToOra") or {}).get("title"),
        }, indent=2))
        return
    except Exception:
        pass

    print("Would create:")
    print(json.dumps(DEFAULT, indent=2)[:800])
    if not APPLY:
        print("\nDry-run only. Re-run with --apply.")
        return

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    doc = {**DEFAULT, "createdAt": now, "updatedAt": now, "updatedBy": "system-seed"}
    c.create_item(doc)
    print(f"\nSeeded {DOC_ID}")


if __name__ == "__main__":
    main()
