"""
מסמן ב-maintenance_refresh_state את התחלת הרענון וסיומו (migrations/migration_add_trigger_maintenance_refresh.sql),
כדי שהדשבורד ידע מתי לטעון מחדש. נקרא מ-.github/workflows/maintenance_refresh.yml.

הרצה:
    python maintenance_refresh_state.py running
    python maintenance_refresh_state.py success|failed
"""
import argparse
from datetime import datetime, timezone


def fields_for(status, now=None):
    """העמודות לעדכון עבור סטטוס: התחלה מאפסת סיום; סיום מסמן זמן."""
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    if status == "running":
        return {"status": "running", "started_at": stamp, "finished_at": None, "updated_at": stamp}
    return {"status": status, "finished_at": stamp, "updated_at": stamp}


def main():
    from mechalol_api import log
    from supabase_client import execute_with_retry, get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("status", choices=["running", "success", "failed"])
    args = parser.parse_args()
    client = get_client()
    execute_with_retry(
        lambda: client.table("maintenance_refresh_state").update(fields_for(args.status)).eq("id", 1).execute(),
        f"maintenance_refresh_state {args.status}", log_fn=log,
    )
    log(f"maintenance_refresh_state = {args.status}")


if __name__ == "__main__":
    main()
