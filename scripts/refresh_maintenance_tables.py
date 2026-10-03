"""
מריץ את refresh_maintenance_tables (migrations/migration_add_refresh_maintenance_tables.sql) עם מפתח השירות:
מסיר משורות התחזוקה (rev_link_check, והשורות האוטומטיות של blacklist_titles ו-manual_matches) את מה שהתיישן.
אותה פונקציה שהכפתור בפאנל הניהול של הדשבורד קורא לה. ראו README, "רענון טבלאות התחזוקה".

הרצה:
    python refresh_maintenance_tables.py --dry-run   # דוח בלבד
    python refresh_maintenance_tables.py             # מוחק
"""
import argparse

from mechalol_api import log

TABLES = ("rev_link_check", "blacklist_titles", "manual_matches")


def summarize(report):
    """שורות לוג קריאות מדוח הפונקציה."""
    lines = []
    for table in TABLES:
        info = report.get(table) or {}
        stale = info.get("stale") or {}
        lines.append(f"{table}: {info.get('total', 0)} שורות, מיותרות {sum(stale.values())} {stale or ''}".rstrip())
        manual = info.get("manual_stale_not_deleted") or []
        if manual:
            lines.append(f"{table}: {len(manual)} שורות ידניות מיותרות, לא נמחקות (לבדיקה): {manual[:10]}")
    deleted = report.get("deleted") or {}
    if report.get("applied"):
        lines.append(f"נמחקו: {dict(deleted)}")
    return lines


def main():
    from supabase_client import execute_with_retry, get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="דוח בלבד, בלי מחיקה")
    args = parser.parse_args()
    client = get_client()
    report = execute_with_retry(
        lambda: client.rpc("refresh_maintenance_tables", {"p_apply": not args.dry_run}).execute(),
        "refresh_maintenance_tables", log_fn=log,
    ).data
    log(f"START | refresh_maintenance_tables{' (--dry-run)' if args.dry_run else ''}")
    for line in summarize(report):
        log(line)


if __name__ == "__main__":
    main()
