"""
בדיקה שדפי הטאב "נעולים" בדשבורד עדיין נעולים (דוח בלבד, לא כותבת למסד).

שלושה מקורות, כמו report_locked_pages (migrations/migration_add_locked_pages_report.sql):
  - נעולים לקריאה: דפי mechalol_pages עם sort_template_denied_at או template_check_access_denied_at
  - נעולים לקריאה (אוטומטי): manual_matches שה-reason שלהם מתחיל ב"נעול לקריאה"
  - נעולים ליצירה: blacklist_titles שה-reason שלהם מתחיל ב"נעול ליצירה"
כל אחד נשאל מחדש ב-API של המכלול (`prop=info&inprop=allevel`, מטא-נתונים בלבד, אצוות של 50) ורמת הנעילה
של היום מושווית למה שנרשם. check_missing_locked.py רק מוסיף ולא בודק מחדש, ו-sort_template_denied_at נבדק
שוב רק אחרי 30 יום או בעריכה, ולכן אף נעילה לא אומתה מחדש עד עכשיו.

הרצה (דורשת גישה למכלול, כלומר GitHub Actions; מהקונטיינר האתר חוסם):
    python verify_locked_pages.py [--limit N] [--report locked_verify_report.json]
"""
import argparse
import json
from collections import Counter

from mechalol_api import classify_lock_level, fetch_page_lock_info, log, login

PAGE_SIZE = 1000
SHOW = 30  # כמה כותרות להדפיס ללוג לכל קטגוריה; הרשימה המלאה בקובץ הדוח


def verdict(expected, info):
    """
    expected: 'read_locked' | 'create_locked'. info: תשובת fetch_page_lock_info לדף (None = לא הוחזר).
    still_locked | open_now | not_returned | other:<רמה> (למשל נעול ליצירה שהפך לנעול לקריאה = הדף נוצר).
    """
    if info is None:
        return "not_returned"
    level = classify_lock_level(info)
    if level == expected:
        return "still_locked"
    if level == "open":
        return "open_now"
    return "other:" + level


def summarize(verdicts):
    """{verdict: count} לרשימת תוצאות."""
    return dict(Counter(verdicts))


def read_all(client, build_query, label):
    from supabase_client import execute_with_retry

    rows, after = [], 0
    while True:
        batch = execute_with_retry(
            lambda: build_query(client).gt("id", after).order("id").limit(PAGE_SIZE).execute(),
            f"{label} after_id={after}", log_fn=log,
        ).data or []
        rows += batch
        if len(batch) < PAGE_SIZE:
            return rows
        after = batch[-1]["id"]


def check_read_locked(client, limit):
    """דפי מכלול שסומנו כנעולים לקריאה: נבדקים לפי page_id."""
    rows = read_all(
        client,
        lambda c: c.table("mechalol_pages").select("id,title")
        .or_("sort_template_denied_at.not.is.null,template_check_access_denied_at.not.is.null"),
        "mechalol read-locked",
    )
    rows = rows[:limit] if limit else rows
    info = fetch_page_lock_info(pageids=[r["id"] for r in rows])
    by_id = {v["pageid"]: v for v in info.values() if v.get("pageid")}
    return [{"id": r["id"], "title": r["title"], "verdict": verdict("read_locked", by_id.get(r["id"]))} for r in rows]


def check_create_locked(client, limit):
    """כותרות ברשימה השחורה (נעולות ליצירה): נבדקות לפי כותרת, כי לדף כזה אין page_id."""
    rows = read_all(
        client,
        lambda c: c.table("blacklist_titles").select("id,title").like("reason", "נעול ליצירה%"),
        "blacklist create-locked",
    )
    rows = rows[:limit] if limit else rows
    info = fetch_page_lock_info(titles=[r["title"] for r in rows])
    return [{"id": r["id"], "title": r["title"], "verdict": verdict("create_locked", info.get(r["title"]))} for r in rows]


def check_manual_read_locked(client, limit):
    """שיוכים אוטומטיים של דפים נעולים לקריאה (manual_matches): נבדקים לפי page_id של המכלול."""
    rows = read_all(
        client,
        lambda c: c.table("manual_matches").select("id,mechalol_page_id").like("reason", "נעול לקריאה%"),
        "manual_matches read-locked",
    )
    rows = rows[:limit] if limit else rows
    if not rows:
        return []
    info = fetch_page_lock_info(pageids=[r["mechalol_page_id"] for r in rows])
    by_id = {v["pageid"]: v for v in info.values() if v.get("pageid")}
    return [{"id": r["id"], "title": str(r["mechalol_page_id"]), "verdict": verdict("read_locked", by_id.get(r["mechalol_page_id"]))}
            for r in rows]


def main():
    from supabase_client import get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="רק N הראשונים בכל מקור (לבדיקה)")
    parser.add_argument("--report", default="locked_verify_report.json")
    args = parser.parse_args()

    login()  # אופציונלי: תעבורה מחוברת פחות נחסמת; נכשל בשקט
    client = get_client()
    log(f"START | verify_locked_pages (דוח בלבד){f' | limit={args.limit}' if args.limit else ''}")
    groups = {
        "נעולים לקריאה (דפי מכלול)": check_read_locked(client, args.limit),
        "נעולים ליצירה (רשימה שחורה)": check_create_locked(client, args.limit),
        "נעולים לקריאה (manual_matches)": check_manual_read_locked(client, args.limit),
    }
    for name, results in groups.items():
        log(f"{name}: {len(results)} נבדקו | {summarize(r['verdict'] for r in results)}")
        for r in [x for x in results if x["verdict"] != "still_locked"][:SHOW]:
            log(f"   {r['verdict']} | {r['id']} | {r['title']}")
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(groups, fh, ensure_ascii=False, indent=1)
    log(f"הדוח המלא נכתב ל-{args.report}")


if __name__ == "__main__":
    main()
