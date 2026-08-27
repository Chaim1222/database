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
SAVE_EVERY = 500  # לשמור לסופרבייס כל 500 כותרות שנבדקו, לא רק בסוף הריצה -
                  # ריצה שנקטעת (לדוגמה בגלל תפוגת הזמן של הזרימה) לא
                  # תאבד את מה שכבר נבדק, רק את היתרה

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def load_missing_rows():
    """
    שולף את כל השורות מ-report_missing_from_mechalol (id, title) שעדיין
    אין להן תאריך יצירה שמור - בעימוד מבוסס-מפתח (id), אותו דפוס בדיוק
    כמו שאר הסקריפטים המקבילים. הסינון על created_at ריק הופך ריצות
    חוזרות לזולות: כותרת שכבר טופלה בהצלחה בריצה קודמת (ולא התאפסה מאז
    בריקון שבועי) לא נשלפת ולא נבדקת שוב.
    """
    client = get_client()
    rows = []
    last_id = 0
    while True:
        def query():
            return (
                client.table("report_missing_from_mechalol")
                .select("id,title")
                .is_("created_at", "null")
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

    pages = data.get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None

    revisions = pages[0].get("revisions") or []
    if not revisions:
        return None

    return revisions[0]["timestamp"]


def flush_buffer(client, buffer):
    """
    שומר קבוצת תוצאות (id, title, created_at) לטבלת wikipedia_pages -
    כולל title (לא רק id) למניעת שגיאת not null על ON CONFLICT DO
    UPDATE, אותו דפוס בדיוק כמו בשאר הסקריפטים המקבילים.
    """
    if not buffer:
        return 0

    batches = [buffer[i:i + BATCH_SIZE] for i in range(0, len(buffer), BATCH_SIZE)]
    for batch in batches:
        def do_upsert(batch=batch):
            return (
                client.table("wikipedia_pages")
                .upsert(batch, on_conflict="id")
                .execute()
            )

        execute_with_retry(do_upsert, "עדכון קבוצת תאריכי יצירה (שמירה הדרגתית)", log)

    log(f"נשמרו {len(buffer)} שורות נוספות לסופרבייס")
    return len(buffer)


def compute_all(client, rows):
    """
    שולף תאריך יצירה לכל שורה, ושומר לסופרבייס בהדרגה (כל SAVE_EVERY
    כותרות שכבר נבדקו) ולא רק בסוף הריצה - כך שריצה שנקטעת (לדוגמה
    בגלל תפוגת הזמן שהוגדרה לזרימה בגיטהאב) לא מאבדת את כל מה שכבר
    נעשה, אלא רק את היתרה שעדיין לא נבדקה.
    """
    total = len(rows)
    buffer = []
    total_saved = 0

    for i, row in enumerate(rows, start=1):
        created_at = fetch_created_at(row["title"])
        if created_at:
            buffer.append({"id": row["id"], "title": row["title"], "created_at": created_at})

        if i % 200 == 0 or i == total:
            log(f"נבדקו {i}/{total} כותרות")

        if len(buffer) >= SAVE_EVERY or (i == total and buffer):
            total_saved += flush_buffer(client, buffer)
            buffer = []

        if REQUEST_DELAY_SECONDS:
            time.sleep(REQUEST_DELAY_SECONDS)

    return total_saved


def main():
    start = time.monotonic()
    log("מתחיל שליפת תאריכי יצירה לערכים חסרים...")

    client = get_client()
    rows = load_missing_rows()
    log(f"נמצאו {len(rows)} כותרות בדוח 'חסר במכלול' שעדיין ללא תאריך יצירה שמור")

    if not rows:
        log("אין כותרות לעיבוד - מסתיים")
        return

    log(
        f"שולף תאריך יצירה - בקשה אחת לכל כותרת ({len(rows)} בקשות בסך הכול, "
        f"ראו הערת המודול) - נשמר לסופרבייס בהדרגה כל {SAVE_EVERY} כותרות, לא רק בסוף"
    )
    updated = compute_all(client, rows)
    log(f"עודכנו {updated} שורות בטבלת wikipedia_pages מתוך {len(rows)} כותרות שנבדקו")

    duration = time.monotonic() - start
    log(f"הסתיים בהצלחה. משך ריצה כולל: {duration:.1f} שניות ({duration / 60:.1f} דקות)")


if __name__ == "__main__":
    main()
