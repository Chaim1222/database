"""
מתעד את גודל המסד ואת הטבלאות הגדולות בנקודה נתונה בריצה השבועית, כדי למדוד את
שיא הנפח בפועל (README, "אחסון בסופרבייס"). קורא את הפונקציה db_size_report()
(migrations/migration_add_db_size_report.sql).

הפלט: לוג, ובנוסף טבלת markdown ל-GITHUB_STEP_SUMMARY כשהוא מוגדר (סיכום הריצה).
הרצה בשלושה שלבים ב-weekly_full_reconciliation.yml: before_fetch / peak_before_swap /
after_truncate.

לא חוסם: כל כשל (פונקציה שעוד לא הותקנה, שגיאת רשת) נרשם כאזהרה וקוד היציאה 0 -
מדידה לא צריכה להפיל את הריצה.

הרצה:
    python log_db_size.py <label>
"""

import os
import sys

MIB = 1024 * 1024


def _mib(value):
    return "-" if value is None else f"{value / MIB:,.1f}"


def format_report(label, rows, top=8):
    """טבלת markdown: שורת המסד, ואחריה `top` הטבלאות הגדולות."""
    db = next((r for r in rows if r["item"] == "DATABASE"), None)
    tables = [r for r in rows if r["item"] != "DATABASE"]
    tables.sort(key=lambda r: r["total_bytes"] or 0, reverse=True)
    lines = [
        f"### גודל מסד: {label}",
        "",
        f"**סך הכול: {_mib(db['total_bytes']) if db else '?'} MiB**",
        "",
        "| טבלה | סך הכול MiB | טבלה MiB | אינדקסים MiB |",
        "|---|---:|---:|---:|",
    ]
    for r in tables[:top]:
        lines.append(
            f"| {r['item']} | {_mib(r['total_bytes'])} | {_mib(r['table_bytes'])} | {_mib(r['index_bytes'])} |"
        )
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) != 2:
        print("שימוש: python log_db_size.py <label>")
        return 0
    label = argv[1]
    try:
        from supabase_client import get_client

        rows = get_client().rpc("db_size_report").execute().data or []
        if not rows:
            print(f"WARNING | db_size_report החזירה תוצאה ריקה ({label})")
            return 0
        report = format_report(label, rows)
        print(report)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as f:
                f.write(report + "\n")
    except Exception as exc:  # noqa: BLE001 - מדידה לא צריכה להפיל את הריצה
        print(f"WARNING | מדידת גודל המסד נכשלה ({label}): {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
