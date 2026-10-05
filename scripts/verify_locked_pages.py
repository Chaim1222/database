"""
בדיקה שדפי הטאב "נעולים" בדשבורד עדיין נעולים, ותיקון אוטומטי של מה שהוכח (--apply).

שלושה מקורות, כמו report_locked_pages (migrations/migration_add_locked_pages_report.sql):
  - נעולים לקריאה: דפי mechalol_pages עם sort_template_denied_at או template_check_access_denied_at
  - נעולים לקריאה (אוטומטי): manual_matches שה-reason שלהם מתחיל ב"נעול לקריאה"
  - נעולים ליצירה: blacklist_titles שה-reason שלהם מתחיל ב"נעול ליצירה"
כל אחד נשאל מחדש ב-API של המכלול (`prop=info&inprop=allevel`, מטא-נתונים בלבד, אצוות של 50) ורמת הנעילה
של היום מושווית למה שנרשם. check_missing_locked.py רק מוסיף ולא בודק מחדש, ו-sort_template_denied_at נבדק
שוב רק אחרי 30 יום או בעריכה, ולכן אף נעילה לא אומתה מחדש עד שהסקריפט הזה נוסף.

רמות (הכרעת חיים, 5.10): חשובים רק נעול ליצירה (`create`) ונעול לקריאה (`read`). נעול **למחצה** לקריאה (`read-semi`)
לא מופיע בדוח ולא בטאב: נרשם ב-page_lock_levels, ו-report_locked_pages מדלג עליו (migrations/migration_add_page_lock_levels.sql).
רמות אחרות (למשל נעילת עריכה) לא נחשבות נעולות לצורך הטאב ומדווחות כ-other:unknown, בלי שום פעולה.

בלי --apply: דוח בלבד, לא כותב למסד. עם --apply:
  1. רושם ב-page_lock_levels את רמת הנעילה של דפי הקריאה שנשארו נעולים (read / read-semi).
  2. נעילה שהוסרה (open_now): כותרת ברשימה השחורה נמחקת; דף מכלול מקבל איפוס של sort_template_denied_at
     ו-template_check_access_denied_at (העדכון השעתי יקרא את התבנית); שיוך אוטומטי של דף שנפתח נמחק.
  מעקה: אם יותר מ-20% מקבוצה (מ-20 שורות ומעלה) נראית פתוחה או לא הוחזרה, זו כנראה תקלת API ולא שינוי אמיתי:
  לא משנים כלום ויוצאים בשגיאה. רמות חריגות (other:*) ודפים שה-API לא החזיר: לא נוגעים.

הרצה (דורשת גישה למכלול, כלומר GitHub Actions; מהקונטיינר האתר חוסם):
    python verify_locked_pages.py [--limit N] [--report locked_verify_report.json] [--apply]
"""
import argparse
import json
from collections import Counter

from mechalol_api import fetch_page_lock_info, log, login

PAGE_SIZE = 1000
CHUNK = 200
SHOW = 300  # כמה חריגות להדפיס ללוג לכל קטגוריה (הלוג צריך להספיק: את ה-artifact אי אפשר תמיד להוריד)
MAX_SUSPECT_SHARE = 0.2  # מעקה: יותר מ-20% "פתוחים" או "לא הוחזרו" בקבוצה = כנראה תקלת API, לא מתקנים כלום
MIN_GUARD_SIZE = 20      # בקבוצה קטנה מזה אין משמעות לאחוז

READ_GROUP = "נעולים לקריאה (דפי מכלול)"
CREATE_GROUP = "נעולים ליצירה (רשימה שחורה)"
MANUAL_GROUP = "נעולים לקריאה (manual_matches)"
SEMI = "semi_locked"  # allevel=read-semi: לא מופיע בדוח ולא בטאב (הכרעת חיים)


class GuardError(Exception):
    """מעקה הבטיחות נפל: לא משנים כלום."""


def lock_family(info):
    """
    משפחת הנעילה לפי allevel: none | create | read | read-semi. רמה אחרת (למשל נעילת עריכה) = unknown.
    בכוונה לא classify_lock_level של check_missing_locked.py: שם read-semi נשאר "לא מוכר" (התנהגות ייצור שלא שונתה).
    """
    level = info["allevel"]
    if level == "none":
        return "open"
    if level == "create":
        return "create_locked"
    if level == "read":
        return "read_locked"
    if level == "read-semi":
        return SEMI
    return "unknown"


def verdict(expected, info):
    """
    expected: 'read_locked' | 'create_locked'. info: תשובת fetch_page_lock_info לדף (None = לא הוחזר).
    still_locked | semi_locked | open_now | not_returned | other:<רמה> (למשל נעול ליצירה שהדף נוצר: other:read_locked).
    """
    if info is None:
        return "not_returned"
    level = lock_family(info)
    if level == expected:
        return "still_locked"
    if level == SEMI and expected == "read_locked":
        return SEMI
    if level == "open":
        return "open_now"
    return "other:" + level


def row_result(row_id, title, expected, info):
    """שורת דוח: ההכרעה, וגם ה-allevel הגולמי מה-API."""
    return {"id": row_id, "title": title, "verdict": verdict(expected, info), "allevel": info.get("allevel") if info else None}


def visible(results):
    """הדוח לא כולל דפים נעולים למחצה."""
    return [r for r in results if r["verdict"] != SEMI]


def summarize(verdicts):
    """{verdict: count} לרשימת תוצאות."""
    return dict(Counter(verdicts))


def plan_apply(groups):
    """
    מה לתקן, מתוך תוצאות הבדיקה: {"fix_read": [id דף מכלול], "fix_create": [id ברשימה השחורה], "fix_manual": [id ב-manual_matches],
    "levels": [(id דף מכלול, allevel)]}. נוגע רק ב-open_now (הוכח: ה-API החזיר allevel=none). מעקה: ראו MAX_SUSPECT_SHARE.
    """
    for name, results in groups.items():
        if len(results) < MIN_GUARD_SIZE:
            continue
        suspect = [r for r in results if r["verdict"] in ("open_now", "not_returned")]
        if len(suspect) / len(results) > MAX_SUSPECT_SHARE:
            raise GuardError(f"{name}: {len(suspect)} מתוך {len(results)} נראים פתוחים או לא הוחזרו (> {MAX_SUSPECT_SHARE:.0%}): כנראה תקלת API")
    ids = lambda name: [r["id"] for r in groups.get(name, []) if r["verdict"] == "open_now"]
    return {
        "fix_read": ids(READ_GROUP), "fix_create": ids(CREATE_GROUP), "fix_manual": ids(MANUAL_GROUP),
        "levels": [(r["id"], r["allevel"]) for r in groups.get(READ_GROUP, []) if r["verdict"] in ("still_locked", SEMI)],
    }


def chunks(items, size=CHUNK):
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def apply_plan(client, plan):
    from supabase_client import execute_with_retry

    for part in chunks(plan["levels"]):
        rows = [{"mechalol_id": i, "allevel": level} for i, level in part]
        execute_with_retry(lambda: client.table("page_lock_levels").upsert(rows, on_conflict="mechalol_id").execute(),
                           "page_lock_levels upsert", log_fn=log)
    for part in chunks(plan["fix_read"]):
        execute_with_retry(
            lambda: client.table("mechalol_pages").update({"sort_template_denied_at": None, "template_check_access_denied_at": None})
            .in_("id", part).execute(), "reset denied", log_fn=log)
    for part in chunks(plan["fix_create"]):
        execute_with_retry(lambda: client.table("blacklist_titles").delete().in_("id", part).like("reason", "נעול ליצירה%").execute(),
                           "blacklist delete", log_fn=log)
    for part in chunks(plan["fix_manual"]):
        execute_with_retry(lambda: client.table("manual_matches").delete().in_("id", part).like("reason", "נעול לקריאה%").execute(),
                           "manual_matches delete", log_fn=log)


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
    return [row_result(r["id"], r["title"], "read_locked", by_id.get(r["id"])) for r in rows]


def check_create_locked(client, limit):
    """כותרות ברשימה השחורה (נעולות ליצירה): נבדקות לפי כותרת, כי לדף כזה אין page_id."""
    rows = read_all(
        client,
        lambda c: c.table("blacklist_titles").select("id,title").like("reason", "נעול ליצירה%"),
        "blacklist create-locked",
    )
    rows = rows[:limit] if limit else rows
    info = fetch_page_lock_info(titles=[r["title"] for r in rows])
    return [row_result(r["id"], r["title"], "create_locked", info.get(r["title"])) for r in rows]


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
    return [row_result(r["id"], str(r["mechalol_page_id"]), "read_locked", by_id.get(r["mechalol_page_id"])) for r in rows]


def main():
    from supabase_client import get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="רק N הראשונים בכל מקור (לבדיקה)")
    parser.add_argument("--report", default="locked_verify_report.json")
    parser.add_argument("--apply", action="store_true", help="לרשום רמות ולתקן נעילות שהוסרו (ברירת מחדל: דוח בלבד)")
    args = parser.parse_args()

    login()  # אופציונלי: תעבורה מחוברת פחות נחסמת; נכשל בשקט
    client = get_client()
    log(f"START | verify_locked_pages ({'--apply' if args.apply else 'דוח בלבד'}){f' | limit={args.limit}' if args.limit else ''}")
    groups = {
        READ_GROUP: check_read_locked(client, args.limit),
        CREATE_GROUP: check_create_locked(client, args.limit),
        MANUAL_GROUP: check_manual_read_locked(client, args.limit),
    }
    report = {name: visible(results) for name, results in groups.items()}
    for name, results in report.items():
        log(f"{name}: {len(results)} נבדקו | {summarize(r['verdict'] for r in results)}")
        levels = summarize(f"{r['verdict']}/allevel={r['allevel']}" for r in results if r["verdict"] != "still_locked")
        if levels:
            log(f"   פירוט החריגות לפי רמת נעילה מה-API: {levels}")
        for r in [x for x in results if x["verdict"] != "still_locked"][:SHOW]:
            log(f"   {r['verdict']} | allevel={r['allevel']} | {r['id']} | {r['title']}")

    exit_code = 0
    if args.apply:
        try:
            plan = plan_apply(groups)
        except GuardError as exc:
            log(f"ERROR | המעקה עצר את התיקון, לא שונה כלום: {exc}")
            plan, exit_code = None, 1
        if plan:
            apply_plan(client, plan)
            log(f"תוקן | נרשמו רמות ל-{len(plan['levels'])} דפי קריאה | אופסו {len(plan['fix_read'])} דפי מכלול שנפתחו | "
                f"הוסרו {len(plan['fix_create'])} כותרות מהרשימה השחורה | הוסרו {len(plan['fix_manual'])} שיוכים אוטומטיים")
            report["applied"] = {k: v for k, v in plan.items() if k != "levels"}
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    log(f"הדוח המלא נכתב ל-{args.report}")
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
