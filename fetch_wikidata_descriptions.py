"""
סקריפט עצמאי - לא חלק מ-weekly_update.yml.

שולף תיאורים קצרים מוויקינתונים עבור הכותרות שמופיעות כרגע בדוח
report_missing_from_mechalol (חסר במכלול), ושומר אותם בעמודה
wikipedia_pages.wikidata_desc. מריץ לוגיקה זהה לזו שכבר קיימת בדשבורד
(dashboard.html, fetchWikidataDescriptions) - אותו endpoint, אותו
פורמט בקשה, אותה קבוצות של 50 כותרות - כדי לשמור על עקביות בין השניים.

מיועד להרצה ידנית (workflow_dispatch) בשלב זה, כדי למדוד כמה זמן הוא
לוקח בפועל, לפני החלטה אם לשלב אותו כשלב נוסף בתוך העדכון השבועי
או להשאיר אותו כתהליך נפרד (ראו check_missing_locked.py לתקדים דומה
של תהליך תחזוקה נפרד).

לא דורש התחברות/דגל בוט - ויקינתונים ציבורי לגמרי לקריאה, וכמות
הכותרות (רק אלה שחסרות במכלול, לא כל ויקיפדיה) קטנה מספיק שלא צריך
מגבלת קצב גבוהה יותר מהרגילה.
"""
import time
from datetime import datetime, timezone

import requests

from config import BATCH_SIZE, REQUEST_DELAY_SECONDS
from supabase_client import get_client, execute_with_retry

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = (
    "MechalolWikipediaCompareBot/1.0 "
    "(https://www.hamichlol.org.il/; geon@hamichlol.org.il)"
)
WIKIDATA_CHUNK_SIZE = 50  # אותו גודל בדיוק כמו בדשבורד - אין דגל בוט בוויקינתונים

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def load_missing_rows():
    """
    שולף את כל השורות מ-report_missing_from_mechalol (id, title) -
    בעימוד לפי BATCH_SIZE, באותו דפוס עימוד מבוסס-מפתח (id) שכבר בשימוש
    ב-match.py, כדי להימנע מבעיות עימוד-טווח על view שעלול להשתנות.
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


def fetch_descriptions(titles):
    """
    שולף תיאורים בעברית מוויקינתונים עבור קבוצת כותרות, בקבוצות של
    WIKIDATA_CHUNK_SIZE. מחזיר מיפוי כותרת (כפי שמופיעה בוויקיפדיה
    העברית, לפי sitelinks.hewiki.title) -> תיאור (מחרוזת ריקה אם
    אין ישות/תיאור בוויקינתונים בכלל).
    """
    descriptions = {}
    chunks = [titles[i:i + WIKIDATA_CHUNK_SIZE] for i in range(0, len(titles), WIKIDATA_CHUNK_SIZE)]
    total = len(chunks)

    for i, chunk in enumerate(chunks):
        log(f"שולף תיאורים מוויקינתונים - קבוצה {i + 1}/{total}")
        params = {
            "action": "wbgetentities",
            "sites": "hewiki",
            "titles": "|".join(chunk),
            "props": "descriptions|sitelinks",
            "languages": "he",
            "format": "json",
        }
        try:
            response = session.get(WIKIDATA_API, params=params, timeout=(15, 60))
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            log(f"שגיאה בקבוצה {i + 1}: {type(exc).__name__}: {exc} - מדלג על הקבוצה")
            continue

        for entity in data.get("entities", {}).values():
            if "missing" in entity:
                continue
            sitelinks = entity.get("sitelinks", {})
            hewiki = sitelinks.get("hewiki")
            if not hewiki:
                continue
            linked_title = hewiki.get("title")
            if not linked_title:
                continue
            desc_obj = entity.get("descriptions", {}).get("he")
            descriptions[linked_title] = desc_obj["value"] if desc_obj else ""

        time.sleep(REQUEST_DELAY_SECONDS)

    return descriptions


def save_descriptions(client, rows, descriptions):
    """
    מעדכן את wikipedia_pages.wikidata_desc לפי id, רק עבור שורות
    שבאמת נמצא להן תיאור (גם ריק - "" - נשמר, כדי לדעת להבדיל בין
    "נבדק ואין תיאור" לבין "עדיין לא נבדק" בריצה הבאה של הדשבורד).
    """
    updated = 0
    for row in rows:
        title = row["title"]
        if title not in descriptions:
            continue  # לא הוחזר בכלל מוויקינתונים (למשל שגיאת קבוצה) - לא נוגעים

        def update():
            return (
                client.table("wikipedia_pages")
                .update({"wikidata_desc": descriptions[title]})
                .eq("id", row["id"])
                .execute()
            )

        execute_with_retry(update, f"עדכון תיאור | {title}", log)
        updated += 1

    return updated


def main():
    start = time.monotonic()
    log("מתחיל שליפת תיאורי ויקינתונים לערכים חסרים במכלול...")

    client = get_client()
    rows = load_missing_rows()
    log(f"נמצאו {len(rows)} כותרות בדוח 'חסר במכלול'")

    if not rows:
        log("אין כותרות לעיבוד - מסתיים")
        return

    titles = [row["title"] for row in rows]
    descriptions = fetch_descriptions(titles)
    log(f"התקבלו תיאורים עבור {len(descriptions)} מתוך {len(titles)} כותרות")

    updated = save_descriptions(client, rows, descriptions)
    log(f"עודכנו {updated} שורות בטבלת wikipedia_pages")

    duration = time.monotonic() - start
    log(f"הסתיים בהצלחה. משך ריצה כולל: {duration:.1f} שניות")


if __name__ == "__main__":
    main()
