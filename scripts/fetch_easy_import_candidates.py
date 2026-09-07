"""
סקריפט עצמאי - לא חלק מ-weekly_update.yml (ראו fetch_wikidata_descriptions.py
לתקדים דומה).

מחשב מראש (batch) שלוש בדיקות "קלות ייבוא" עבור הכותרות שמופיעות כרגע
בדוח report_missing_from_mechalol (חסר במכלול), ושומר אותן בעמודות
חדשות על wikipedia_pages: אורך התוכן בבתים, האם יש בדף תמונות, והאם
הדף נקי ממילים בעייתיות (ראו problematic_words.py). הדשבורד רק מסנן
לפי מה שכבר מחושב כאן - בלי חישוב בזמן אמת מול ה-API בכל בקשה.

שלוש הבדיקות נשלפות בקריאת API מאוחדת אחת (prop=info|images|revisions)
באצוות - ברגע שממילא צריך להוריד את תוכן הדף המלא (rvprop=content)
כדי לבדוק מילים בעייתיות, אורך הדף וקיום תמונות "רוכבים" על אותה
קריאה בלי עלות נוספת.

מיועד להרצה ידנית (workflow_dispatch) בשלב זה, כדי למדוד כמה זמן הוא
לוקח בפועל על ~24.5 אלף דפים (הורדת תוכן מלא, בשונה משליפת המטא-נתונים
הקלה של fetch_wikidata_descriptions.py) - לפני החלטה אם לשלב אותו
כשלב נוסף בתוך העדכון השבועי (שכבר עומד על ~37 דק' מתוך מגבלה של 60)
או להשאיר אותו כתהליך נפרד.

הבדיקה רצה על תוכן ויקיפדיה (המקור, לפני ייבוא) - לא על תוכן המכלול.
"""
import time
from datetime import datetime, timezone

import requests

from config import WIKIPEDIA_API, BATCH_SIZE, REQUEST_DELAY_SECONDS, REQUEST_HEADERS
from supabase_client import get_client, execute_with_retry
from problematic_words import is_clean_of_problematic_words

# גודל אצווה לקריאת API אחת (titles=a|b|c...) מול ויקיפדיה. אין דגל
# בוט בחשבון שמריץ קריאות ישירות לוויקיפדיה (ראו ההערה המקבילה על
# API_BATCH_SIZE_TEMPLATE_CHECK ב-config.py) - חשבון רגיל בלבד, ולכן
# 50 ולא יותר.
API_BATCH_SIZE = 50
MAX_API_RETRIES = 5


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def load_missing_rows():
    """
    שולף את כל השורות מ-report_missing_from_mechalol (id, title) שעדיין
    לא נבדקו לקלות-ייבוא (easy_import_checked = false) - בעימוד מבוסס-
    מפתח (id), אותו דפוס בדיוק כמו ב-fetch_wikidata_descriptions.py
    ו-check_missing_locked.py.

    הסינון הופך ריצות חוזרות לזולות: כותרת שכבר נבדקה בהצלחה בריצה
    קודמת (כולל מקרה של "נבדק ואין תוצאה" - ראו fetch_page_data) לא
    נשלפת ולא נבדקת שוב.
    """
    client = get_client()
    rows = []
    last_id = 0
    while True:
        def query():
            return (
                client.table("report_missing_from_mechalol")
                .select("id,title")
                .eq("easy_import_checked", False)
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


def fetch_page_data(titles):
    """
    שולף באצווה אחת (prop=info|images|revisions) עבור עד API_BATCH_SIZE
    כותרות: אורך בבתים, קיום תמונות, ותוכן מלא (לבדיקת מילים בעייתיות).

    מחזיר {title: {"length": int|None, "has_images": bool|None,
    "clean": bool|None, "checked": bool}}.

    כותרת שהוחזרה בתשובה עם "missing" (למשל נמחקה בדיוק תוך כדי הריצה)
    כן נכללת בתוצאה, עם ערכים None ו-checked=True - זו תוצאה סופית
    ולגיטימית (הדף לא קיים), לא כשל, ולכן לא צריך לבדוק אותה שוב בכל
    ריצה עתידית.

    כותרת שלא הוחזרה בתשובה בכלל, או שהאצווה השלמה נכשלה אחרי כל
    הניסיונות - לא נכללת בתוצאה, checked נשאר False, תיבדק שוב בריצה
    הבאה (כשל זמני, לא תוצאה סופית).

    בדומה ל-fetch_template_titles ב-match.py: אם דף בודד באצווה נעול-
    לקריאה, כל הבקשה עלולה להידחות ברמת ה-API (title="error"). כאן
    זה לא רלוונטי בפועל - הבדיקה רצה על ויקיפדיה, לא על המכלול, ואין
    שם נעילות-לקריאה מסוג זה - אבל הטיפול בשגיאת רשת/HTTP עדיין דרוש.
    """
    params = {
        "action": "query",
        "prop": "info|images|revisions",
        "rvprop": "content",
        "rvslots": "main",
        "formatversion": "2",
        "titles": "|".join(titles),
        "format": "json",
    }

    data = None
    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=(15, 60))
            response.raise_for_status()
            data = response.json()
            break
        except (requests.RequestException, ValueError) as exc:
            if attempt >= MAX_API_RETRIES:
                log(f"ERROR | אצוות API | נכשל אחרי {MAX_API_RETRIES} ניסיונות: {exc} - מדלגים על האצווה")
                return {}
            log(f"WARNING | אצוות API | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
            time.sleep(min(2 ** (attempt - 1), 30))

    result = {}
    for page in data.get("query", {}).get("pages", []):
        title = page.get("title")

        if page.get("missing"):
            result[title] = {"length": None, "has_images": None, "clean": None, "checked": True}
            continue

        length = page.get("length")

        images = page.get("images") or []
        has_images = len(images) > 0

        revisions = page.get("revisions") or []
        content = ""
        if revisions:
            content = revisions[0].get("slots", {}).get("main", {}).get("content", "")

        clean = is_clean_of_problematic_words(content)

        result[title] = {"length": length, "has_images": has_images, "clean": clean, "checked": True}

    return result


def compute_all(titles):
    """
    רץ על כל הכותרות באצוות של API_BATCH_SIZE, מאחד לתוצאה אחת.
    """
    computed = {}
    chunks = [titles[i:i + API_BATCH_SIZE] for i in range(0, len(titles), API_BATCH_SIZE)]
    total = len(chunks)

    for i, chunk in enumerate(chunks):
        log(f"בודק אצווה {i + 1}/{total} ({len(chunk)} כותרות)")
        computed.update(fetch_page_data(chunk))

        if REQUEST_DELAY_SECONDS:
            time.sleep(REQUEST_DELAY_SECONDS)

    return computed


def save_results(client, rows, computed):
    """
    מעדכן את wikipedia_pages (עמודות easy_import_length,
    easy_import_has_images, problematic_words_clean, easy_import_checked)
    לפי id, בקבוצות מאוגדות (upsert) - אותו דפוס בדיוק כמו save_descriptions
    ב-fetch_wikidata_descriptions.py, כולל הכללת title (לא רק id)
    למניעת שגיאת not null על ON CONFLICT DO UPDATE.

    easy_import_checked נשמר True רק לשורות שבאמת נבדקו (כולל "missing" -
    ראו fetch_page_data) - שורה שלא נכללה ב-computed (כשל זמני באצווה
    שלמה) לא מגיעה לכאן בכלל, ותיבדק שוב בריצה הבאה.
    """
    to_update = [
        {
            "id": row["id"],
            "title": row["title"],
            "easy_import_length": computed[row["title"]]["length"],
            "easy_import_has_images": computed[row["title"]]["has_images"],
            "problematic_words_clean": computed[row["title"]]["clean"],
            "easy_import_checked": computed[row["title"]]["checked"],
        }
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

        execute_with_retry(do_upsert, f"עדכון קבוצת קלות-ייבוא {i + 1}/{len(batches)}", log)
        updated += len(batch)
        log(f"נשמרו {updated}/{len(to_update)} שורות")

    return updated


def main():
    start = time.monotonic()
    log("מתחיל חישוב 'קלות ייבוא' לערכים חסרים במכלול...")

    client = get_client()
    rows = load_missing_rows()
    log(f"נמצאו {len(rows)} כותרות בדוח 'חסר במכלול'")

    if not rows:
        log("אין כותרות לעיבוד - מסתיים")
        return

    titles = [row["title"] for row in rows]
    computed = compute_all(titles)
    log(f"חושבו תוצאות עבור {len(computed)} מתוך {len(titles)} כותרות")

    updated = save_results(client, rows, computed)
    log(f"עודכנו {updated} שורות בטבלת wikipedia_pages")

    duration = time.monotonic() - start
    log(f"הסתיים בהצלחה. משך ריצה כולל: {duration:.1f} שניות ({duration / 60:.1f} דקות)")


if __name__ == "__main__":
    main()
