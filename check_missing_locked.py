"""
בודק את הכותרות מ-report_missing_from_mechalol (כותרות שקיימות
בוויקיפדיה ואין להן שום שורה מתאימה ב-mechalol_pages) מול רמת
הנעילה שלהן בפועל במכלול, ומעדכן בהתאם:

- allevel="create" (הדף לא קיים במכלול, ולא ניתן ליצור אותו) ->
  נוספת ל-blacklist_titles. אין page_id לדף כזה - הוא לא קיים.
- allevel="read" (הדף כן קיים במכלול, רק חסום לקריאה) -> נוספת
  ל-manual_matches, עם mechalol_page_id שהתקבל מהבדיקה עצמה.
- allevel="none" (פתוח) -> באמת חסרה, שום פעולה - תמשיך להופיע
  בדוח כרגיל.
- כל allevel אחר (לא "none"/"create"/"read") -> רק אזהרה בלוג,
  לא מטופל אוטומטית (ראו classify_lock_level ב-mechalol_api.py).

הבדיקה הראשונית תמיד לפי titles (לא pageids) - אלה כותרות "חסרות",
עדיין לא ידוע אם קיימות במכלול בכלל, ולכן אין page_id זמין מראש.

הרצה:
    python check_missing_locked.py
"""

from mechalol_api import fetch_page_lock_info, classify_lock_level, log
from supabase_client import get_client, execute_with_retry


BATCH_SIZE = 500


def load_missing_titles(client):
    """
    מחזיר {title: wikipedia_id} עבור כל השורות ב-report_missing_from_mechalol.
    """
    result = {}
    last_id = 0

    while True:
        rows = execute_with_retry(
            lambda: (
                client.table("report_missing_from_mechalol")
                .select("id, title")
                .gt("id", last_id)
                .order("id")
                .limit(BATCH_SIZE)
                .execute()
            ),
            f"MISSING_REPORT after_id={last_id}",
            log_fn=log,
        ).data or []

        if not rows:
            break

        for row in rows:
            result[row["title"]] = row["id"]

        last_id = rows[-1]["id"]
        if len(rows) < BATCH_SIZE:
            break

    return result


def main():
    client = get_client()

    log("=" * 80)
    log("START | check_missing_locked.py")

    wikipedia_id_by_title = load_missing_titles(client)
    titles = list(wikipedia_id_by_title)
    log(f"נטענו {len(titles):,} כותרות חסרות לבדיקה")

    if not titles:
        log("אין כותרות חסרות לבדיקה - סיום")
        return

    lock_info = fetch_page_lock_info(titles=titles)

    blacklist_rows = []
    manual_match_rows = []
    open_count = 0
    unknown_count = 0
    not_returned_count = 0

    for title in titles:
        info = lock_info.get(title)

        if info is None:
            # לא הוחזר בתשובת ה-API בכלל (מקרה קצה נדיר) - מדלגים,
            # ייבדק שוב בריצה הבאה.
            not_returned_count += 1
            continue

        level = classify_lock_level(info)

        if level == "open":
            open_count += 1

        elif level == "create_locked":
            blacklist_rows.append({
                "title": title,
                "wikipedia_id": wikipedia_id_by_title[title],
                "reason": "נעול ליצירה במכלול (allevel=create) - זוהה אוטומטית",
            })

        elif level == "read_locked":
            manual_match_rows.append({
                "mechalol_page_id": info["pageid"],
                "wikipedia_page_id": wikipedia_id_by_title[title],
                "reason": "נעול לקריאה במכלול (allevel=read) - זוהה אוטומטית",
            })

        else:  # unknown
            unknown_count += 1
            log(f"WARNING | \"{title}\" | רמת נעילה לא מוכרת: {info['allevel']} - דורש בדיקה ידנית")

    log(
        f"סיווג | פתוח={open_count:,} | נעול_ליצירה={len(blacklist_rows):,} | "
        f"נעול_לקריאה={len(manual_match_rows):,} | לא_מוכר={unknown_count:,} | "
        f"לא_הוחזר={not_returned_count:,}"
    )

    if blacklist_rows:
        execute_with_retry(
            lambda: (
                client.table("blacklist_titles")
                .upsert(blacklist_rows, on_conflict="title")
                .execute()
            ),
            "BLACKLIST upsert",
            log_fn=log,
        )
        log(f"עודכן | {len(blacklist_rows):,} כותרות נוספו/עודכנו ב-blacklist_titles")

    if manual_match_rows:
        execute_with_retry(
            lambda: (
                client.table("manual_matches")
                .upsert(manual_match_rows, on_conflict="mechalol_page_id")
                .execute()
            ),
            "MANUAL_MATCHES upsert",
            log_fn=log,
        )
        log(f"עודכן | {len(manual_match_rows):,} שורות נוספו/עודכנו ב-manual_matches")

    log("=" * 80)
    log("סיום | check_missing_locked.py")


if __name__ == "__main__":
    main()
