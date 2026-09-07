"""
שער האימות שרץ אחרי ההתאמה על טבלאות המראה, לפני ההחלפה האטומית
(שלב 4 בתכנון - mirror_architecture_design.md). משווה את מספר
השורות הפעיל מול המראה בשתי הטבלאות ומחליט אם ההחלפה בטוחה.

שלוש תוצאות אפשריות, מתוקשרות ל-workflow דרך GITHUB_OUTPUT
(should_swap=true/false) וקוד היציאה:

- אין שום ירידה בשתי הטבלאות -> should_swap=true, exit 0.
- יש ירידה, אבל קטנה (מתחת לסף) -> נחשב תנודתיות טבעית (למשל דף
  שנמחק בין הסבבים) - should_swap=false, exit 0 (הריצה "מצליחה",
  בלי Issue - אין טעם להתריע על משהו שקורה מדי פעם בלי להעיד על
  תקלה). ההחלפה מדולגת, הטבלאות הפעילות ממשיכות לשרת כרגיל.
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
        f"ירידה={drop:,} ({percent:.1%}) - מתחת לסף, כנראה תנודתיות טבעית"
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

    if "minor" in severities:
        log("SKIP | ירידה קלה (כנראה תנודתיות טבעית) - עוצר, לא מתבצעת החלפה, בלי Issue")
        write_github_output(should_swap=False)
        log("=" * 80)
        log("סיום | validate_before_swap.py (ללא החלפה)")
        return

    log("PASS | אין ירידה בשתי הטבלאות - ניתן להמשיך להחלפה")
    write_github_output(should_swap=True)

    log("=" * 80)
    log("סיום | validate_before_swap.py (החלפה מאושרת)")


if __name__ == "__main__":
    main()
