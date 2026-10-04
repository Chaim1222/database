"""
שער האימות שרץ אחרי ההתאמה על טבלאות המראה, לפני ההחלפה האטומית
(שלב 4 בתכנון - mirror_architecture_design.md). משווה את מספר
השורות הפעיל מול המראה בשתי הטבלאות ומחליט אם ההחלפה בטוחה.

שלוש תוצאות אפשריות, מתוקשרות ל-workflow דרך GITHUB_OUTPUT
(should_swap=true/false) וקוד היציאה:

- אין שום ירידה בשתי הטבלאות -> should_swap=true, exit 0.
- יש ירידה, אבל קטנה (מתחת לסף) -> נחשב תנודתיות טבעית (למשל דפים
  שנמחקו בין הסבבים) - should_swap=true, exit 0, עם אזהרה בלוג.
  (תיקון 2026-09: קודם גם ירידה של שורה אחת דילגה על ההחלפה בשקט,
  בלי Issue - כלומר הפיוס השבועי לא נכנס לתוקף, ואף אחד לא ידע.)
- ירידה גדולה (1,000 ומעלה, או אחוז גדול מהטבלה) -> חשוד כתקלה
  אמיתית (fetch/match חלקי, למשל) - should_swap=false, exit 1.
  ה-exit code הלא-אפס מפעיל את צעד "פתיחת Issue בעת כישלון" הקיים
  כבר ב-biweekly_full_reconciliation.yml (לא כתוב כאן קוד נפרד
  לפתיחת Issue - זה כבר קיים ב-workflow ומופעל אוטומטית מכשל).

הרצה:
    python validate_before_swap.py
"""

from mechalol_api import log
from supabase_client import get_client, execute_with_retry

# סף ירידה מוחלט: מעל זה (או מעל סף האחוז למטה) - כשל חמור, Issue.
# הערה: המספר הזה לא נמסר במפורש בתכנון ("1,000 ומעלה") - הועתק
# כלשונו. סף האחוז (5%) כן נבחר כברירת מחדל סבירה בהיעדר מספר מפורש
# בתכנון - שווה לכוונן בהתאם לניסיון בפועל מהסבבים הראשונים.
ABSOLUTE_DROP_THRESHOLD = 1000
PERCENT_DROP_THRESHOLD = 0.05


def count_rows(client, table):
    result = execute_with_retry(
        lambda: client.table(table).select("id", count="exact", head=True).execute(),
        f"COUNT {table}",
        log_fn=log,
    )
    return result.count or 0


# שער איכות (נוסף ב-4.10.2026 אחרי סקירה: השער בדק רק כמות, ולכן בנייה עם התאמה חלקית הייתה עוברת).
# משווה כמה מאפיינים של הבנייה (הזמנית) מול הפעילה, שהיא המצב המוכר והתקין האחרון. הספים נבחרו כרחבים
# בכוונה ונשענים על ריצה אחת (4.10: ללא התאמה 3,783 בבנייה מול 3,788 בפעילה אחריה, מתועדים 335,469, חסרים 27,886) -
# לכוונן לפי הניסיון. כשל כאן עוצר את ההחלפה ופותח Issue, כמו ירידה חמורה במספר השורות.
UNMATCHED_FACTOR = 1.5
UNMATCHED_SLACK = 500
DOCUMENTED_MAX_SHIFT = 0.05
DOCUMENTED_MIN_SLACK = 1000
MISSING_MAX_SHIFT = 0.30
MISSING_SLACK = 500
UNMATCHED = "ללא התאמה"
DOCUMENTED = "מיובא ומתועד"


# בדיקת טריות: הטבלה הזמנית חייבת להיות בנייה טרייה. בבנייה, כל שורת ויקיפדיה נכתבת עם checked_at של הרגע (fetch_wikipedia.py),
# ו-forward_fill לא מעתיק את העמודה. אחרי החלפה הזמנית מחזיקה את הפעילה הקודמת, ושורותיה בנות ~שבוע. כך
# `resume_after_match` אחרי כשל *לאחר* ההחלפה (שהיה מחליף בחזרה לנתונים הישנים) נחסם בלי שינוי במסד.
FRESH_WINDOW_HOURS = 72
FRESH_MIN_SHARE = 0.9


def freshness_issue(total, fresh):
    """None אם הזמנית נראית כבנייה טרייה (רוב השורות נכתבו לאחרונה), אחרת הסבר."""
    if total <= 0:
        return "הטבלה הזמנית ריקה"
    if fresh / total < FRESH_MIN_SHARE:
        return (
            f"הטבלה הזמנית אינה בנייה טרייה: רק {fresh:,} מתוך {total:,} שורות נכתבו ב-{FRESH_WINDOW_HOURS} השעות האחרונות "
            "(ייתכן שהיא מחזיקה את הפעילה הקודמת אחרי החלפה)"
        )
    return None


def count_fresh(client, table, hours):
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    result = execute_with_retry(
        lambda: client.table(table).select("id", count="exact", head=True).gte("checked_at", cutoff).execute(),
        f"COUNT {table} checked_at>={cutoff}",
        log_fn=log,
    )
    return result.count or 0


def count_where(client, table, column, value):
    result = execute_with_retry(
        lambda: client.table(table).select("id", count="exact", head=True).eq(column, value).execute(),
        f"COUNT {table} {column}={value}",
        log_fn=log,
    )
    return result.count or 0


def collect_quality_stats(client, mechalol_table, wikipedia_table):
    return {
        "unmatched": count_where(client, mechalol_table, "match_type", UNMATCHED),
        "documented": count_where(client, mechalol_table, "status", DOCUMENTED),
        "missing": count_where(client, wikipedia_table, "is_missing", True),
    }


def quality_issues(active, temp):
    """
    רשימת בעיות איכות (ריקה = תקין) מהשוואת סטטיסטיקות הפעילה והזמנית. טהורה, נבדקת ביחידות.
    - ללא התאמה: עלייה חדה = התאמה חלקית או שגויה (ירידה אינה חוסמת).
    - מתועדים: סטייה מעל 5% = סיווג קטגוריות חלקי.
    - חסרים (is_missing): סטייה מעל 30% = חישוב החסרים לא הושלם או שגוי.
    """
    issues = []
    unmatched_limit = active["unmatched"] * UNMATCHED_FACTOR + UNMATCHED_SLACK
    if temp["unmatched"] > unmatched_limit:
        issues.append(f"ללא התאמה: {temp['unmatched']:,} בבנייה מול {active['unmatched']:,} בפעילה (סף {unmatched_limit:,.0f})")
    documented_limit = max(DOCUMENTED_MIN_SLACK, active["documented"] * DOCUMENTED_MAX_SHIFT)
    if abs(temp["documented"] - active["documented"]) > documented_limit:
        issues.append(f"מתועדים: {temp['documented']:,} בבנייה מול {active['documented']:,} בפעילה (סטייה מותרת {documented_limit:,.0f})")
    missing_limit = active["missing"] * MISSING_MAX_SHIFT + MISSING_SLACK
    if abs(temp["missing"] - active["missing"]) > missing_limit:
        issues.append(f"חסרים: {temp['missing']:,} בבנייה מול {active['missing']:,} בפעילה (סטייה מותרת {missing_limit:,.0f})")
    return issues


def classify_drop(active, new, label):
    """
    מחזיר (severity, drop) עבור זוג טבלה אחד. severity אחד מ:
    "none" (אין ירידה או יש עלייה), "minor" (ירידה קטנה מהסף),
    "severe" (ירידה מעל אחד הספים).
    """
    drop = active - new
    if drop <= 0:
        return "none", drop

    percent = drop / active if active else 0
    if drop >= ABSOLUTE_DROP_THRESHOLD or percent >= PERCENT_DROP_THRESHOLD:
        log(
            f"SEVERE | {label} | פעיל={active:,} מראה={new:,} | "
            f"ירידה={drop:,} ({percent:.1%}) - מעל הסף"
        )
        return "severe", drop

    log(
        f"WARNING | {label} | פעיל={active:,} מראה={new:,} | "
        f"ירידה={drop:,} ({percent:.1%}) - מתחת לסף, תנודתיות טבעית - לא חוסם"
    )
    return "minor", drop


def write_github_output(should_swap: bool):
    import os

    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        # הרצה מקומית מחוץ ל-GitHub Actions - אין קובץ יעד, רק מדלגים.
        log("GITHUB_OUTPUT לא מוגדר (כנראה הרצה מקומית) - מדלג על כתיבת הפלט")
        return

    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"should_swap={'true' if should_swap else 'false'}\n")


def main():
    client = get_client()

    log("=" * 80)
    log("START | validate_before_swap.py")

    wikipedia_active = count_rows(client, "wikipedia_pages")
    wikipedia_new = count_rows(client, "wikipedia_pages_temp")
    mechalol_active = count_rows(client, "mechalol_pages")
    mechalol_new = count_rows(client, "mechalol_pages_temp")

    log(
        f"ספירה | wikipedia_pages: פעיל={wikipedia_active:,} מראה={wikipedia_new:,} | "
        f"mechalol_pages: פעיל={mechalol_active:,} מראה={mechalol_new:,}"
    )

    wikipedia_severity, wikipedia_drop = classify_drop(wikipedia_active, wikipedia_new, "wikipedia_pages")
    mechalol_severity, mechalol_drop = classify_drop(mechalol_active, mechalol_new, "mechalol_pages")

    severities = {wikipedia_severity, mechalol_severity}

    if "severe" in severities:
        log("FAIL | ירידה חמורה באחת הטבלאות - עוצר, לא מתבצעת החלפה, נכשל במפורש")
        write_github_output(should_swap=False)
        raise SystemExit(1)

    fresh_issue = freshness_issue(wikipedia_new, count_fresh(client, "wikipedia_pages_temp", FRESH_WINDOW_HOURS))
    if fresh_issue:
        log(f"SEVERE | טריות | {fresh_issue}")
        log("FAIL | הזמנית אינה בנייה טרייה - עוצר, לא מתבצעת החלפה, נכשל במפורש")
        write_github_output(should_swap=False)
        raise SystemExit(1)

    active_stats = collect_quality_stats(client, "mechalol_pages", "wikipedia_pages")
    temp_stats = collect_quality_stats(client, "mechalol_pages_temp", "wikipedia_pages_temp")
    log(f"איכות | פעילה: {active_stats} | בנייה: {temp_stats}")
    issues = quality_issues(active_stats, temp_stats)
    if issues:
        for issue in issues:
            log(f"SEVERE | איכות | {issue}")
        log("FAIL | הבנייה חורגת משער האיכות - עוצר, לא מתבצעת החלפה, נכשל במפורש")
        write_github_output(should_swap=False)
        raise SystemExit(1)

    if "minor" in severities:
        log("PASS | ירידה קלה מתחת לסף (תנודתיות טבעית) - ממשיכים להחלפה")
    else:
        log("PASS | אין ירידה בשתי הטבלאות - ניתן להמשיך להחלפה")
    write_github_output(should_swap=True)

    log("=" * 80)
    log("סיום | validate_before_swap.py (החלפה מאושרת)")


if __name__ == "__main__":
    main()
