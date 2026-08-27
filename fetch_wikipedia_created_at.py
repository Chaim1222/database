"""
סקריפט עצמאי - לא חלק מ-weekly_update.yml (ראו fetch_wikidata_descriptions.py
ו-fetch_easy_import_candidates.py לתקדים דומה).

שולף תאריך יצירה (חותמת הזמן של הגרסה הראשונה) עבור הכותרות שמופיעות
כרגע בדוח report_missing_from_mechalol (חסר במכלול) בלבד - שומר את
התוצאה בעמודה wikipedia_pages.created_at.

חשוב - למה בקשה אחת לכל כותרת, לא אצווה: מדיה-ויקי דוחה
("invalidparammix") כל ניסיון לשלב rvdir=newer (הדרך היחידה לקבל את
הגרסה הראשונה של דף) עם titles/generator שמספקים כמה דפים בבת אחת -
"...titles, pageids or a generator was used to supply multiple pages,
but the rvlimit, rvstartid, rvendid, rvdir=newer, ... parameters may
only be used on a single page". זו מגבלה מוצהרת ומתועדת של ה-API עצמו
(https://www.mediawiki.org/wiki/API_talk:Query), לא ניתנת לעקיפה עם
batching. זו הסיבה שהשליפה לא (ולא יכולה להיות) חלק מהסריקה השבועית
המלאה על כל 350 אלף הדפים ב-fetch_wikipedia.py - שם בכלל לא ניתן
לבקש את זה בבת אחת עבור יותר מדף אחד.

בלי login - המגבלה כאן היא מבנית (סוג פרמטרים לא-תואם), לא תלוית-
הרשאות, אז אין שום יתרון בהתחברות עבור הבקשה הספציפית הזו (בניגוד
ל-check_missing_redirects.py, ששם ההתחברות כן עוזרת - שם ה-titles=
מוגבל לפי apihighlimits, לא לפי תאימות פרמטרים).

מיועד להרצה ידנית (workflow_dispatch). מריצים אותו שוב בכל פעם שרוצים
לרענן את התוצאה - העמודה חוזרת ל-NULL אוטומטית בכל ריקון שבועי (ראו
migration_add_wikipedia_created_at.sql).

שימוש:
    python fetch_wikipedia_created_at.py
"""
import time
from datetime import datetime, timezone

import requests

from config import WIKIPEDIA_API, BATCH_SIZE, REQUEST_DELAY_SECONDS, REQUEST_HEADERS
from supabase_client import get_client, execute_with_retry

MAX_API_RETRIES = 5

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def load_missing_rows():
    """
    שולף את כל השורות מ-report_missing_from_mechalol (id, title) -
    בעימוד מבוסס-מפתח (id), אותו דפוס בדיוק כמו שאר הסקריפטים
    המקבילים.
    """
    client = get_client()
    rows = []
    last_id = 0
    while True:
        def query():
            return (
                client.table("report_missing_from_mechalol")
                .select("id,title")
                .gt("id", last_id)
                .order("id")
                .limit(BATCH_SIZE)
                .execute()
            )

        result = execute_with_retry(query, "שליפת דוח חסרים במכלול", log)
        batch = result.data or []
        if not batch:
            break
        rows.extend(batch)
        last_id = batch[-1]["id"]
        if len(batch) < BATCH_SIZE:
            break

    return rows


def fetch_created_at(title):
    """
    בקשה יחידה עבור כותרת יחידה - ראו הערת המודול למעלה למה זה חייב
    להיות כך (לא אצווה). מחזיר חותמת זמן (str) או None אם הכותרת לא
    נמצאה בוויקיפדיה, אין לה גרסאות, או שהאצווה נכשלה סופית.
    """
    params = {
        "action": "query",
        "prop": "revisions",
        "titles": title,
        "rvprop": "timestamp",
        "rvlimit": 1,
        "rvdir": "newer",
        "formatversion": "2",
        "format": "json",
    }

    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            response = session.get(WIKIPEDIA_API, params=params, timeout=(15, 60))

            if response.status_code == 429:
                # הגבלת קצב (429) - שונה מכל שגיאת רשת/שרת אחרת: לא
                # תקלה חולפת אלא הגבלה מכוונת, סביר שנגרמת מה-IP
                # המשותף של ריצי GitHub Actions (לא בהכרח מהתדירות של
                # הריצה הזו עצמה). מכבד Retry-After אם התקבל, אחרת
                # השהיה שגדלה עם מספר הניסיון - לא נספר כאן תחת אותה
                # עלייה מעריכית קצרה של שגיאות רגילות למטה.
                retry_after = response.headers.get("Retry-After")
                wait = float(retry_after) if retry_after else min(10 * attempt, 60)
                log(
                    f"WARNING | '{title}' | הוגבל קצב (429) | ממתין "
                    f"{wait:.0f} שניות (ניסיון {attempt}/{MAX_API_RETRIES})"
                )
                time.sleep(wait)
                continue

            response.raise_for_status()
            data = response.json()
            if "error" in data:
                raise RuntimeError(f"שגיאת API בגוף התשובה: {data['error']}")
            break
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            if attempt >= MAX_API_RETRIES:
                log(f"ERROR | '{title}' | נכשל אחרי {MAX_API_RETRIES} ניסיונות: {exc} - מדלגים")
                return None
            log(f"WARNING | '{title}' | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
            time.sleep(min(2 ** (attempt - 1), 30))
    else:
        data = None

    if data is None:
        log(
            f"ERROR | '{title}' | נכשל אחרי {MAX_API_RETRIES} ניסיונות "
            "(כנראה הגבלת קצב מתמשכת) - מדלגים"
        )
        return None

    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None

    revisions = pages[0].get("revisions") or []
    if not revisions:
        return None

    return revisions[0]["timestamp"]


def compute_all(titles):
    computed = {}
    total = len(titles)

    for i, title in enumerate(titles, start=1):
        created_at = fetch_created_at(title)
        if created_at:
            computed[title] = created_at

        if i % 200 == 0 or i == total:
            log(f"נבדקו {i}/{total} כותרות")

        if REQUEST_DELAY_SECONDS:
            time.sleep(REQUEST_DELAY_SECONDS)

    return computed


def save_results(client, rows, computed):
    """
    מעדכן את wikipedia_pages.created_at לפי id - כולל title (לא רק id)
    למניעת שגיאת not null על ON CONFLICT DO UPDATE, אותו דפוס בדיוק
    כמו בשאר הסקריפטים המקבילים. רק כותרות שקיבלו תשובה בפועל
    (title in computed) מתעדכנות.
    """
    to_update = [
        {"id": row["id"], "title": row["title"], "created_at": computed[row["title"]]}
        for row in rows
        if row["title"] in computed
    ]

    updated = 0
    batches = [to_update[i:i + BATCH_SIZE] for i in range(0, len(to_update), BATCH_SIZE)]
    for i, batch in enumerate(batches):
        def do_upsert(batch=batch):
            return (
                client.table("wikipedia_pages")
                .upsert(batch, on_conflict="id")
                .execute()
            )

        execute_with_retry(do_upsert, f"עדכון קבוצת תאריכי יצירה {i + 1}/{len(batches)}", log)
        updated += len(batch)
        log(f"נשמרו {updated}/{len(to_update)} שורות")

    return updated


def main():
    start = time.monotonic()
    log("מתחיל שליפת תאריכי יצירה לערכים חסרים...")

    client = get_client()
    rows = load_missing_rows()
    log(f"נמצאו {len(rows)} כותרות בדוח 'חסר במכלול'")

    if not rows:
        log("אין כותרות לעיבוד - מסתיים")
        return

    titles = [row["title"] for row in rows]
    log(f"שולף תאריך יצירה - בקשה אחת לכל כותרת ({len(titles)} בקשות בסך הכול, ראו הערת המודול)")
    computed = compute_all(titles)
    log(f"נמצא תאריך יצירה עבור {len(computed)} מתוך {len(titles)} כותרות")

    updated = save_results(client, rows, computed)
    log(f"עודכנו {updated} שורות בטבלת wikipedia_pages")

    duration = time.monotonic() - start
    log(f"הסתיים בהצלחה. משך ריצה כולל: {duration:.1f} שניות ({duration / 60:.1f} דקות)")


if __name__ == "__main__":
    main()
