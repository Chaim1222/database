"""
סקריפט עצמאי - לא חלק מ-weekly_update.yml (ראו fetch_wikidata_descriptions.py
ו-fetch_easy_import_candidates.py לתקדים דומה).

בודק, עבור הכותרות שמופיעות כרגע בדוח report_missing_from_mechalol
(חסר במכלול) בלבד, האם קיימת במכלול הפניה (redirect) תחת אותה כותרת
בדיוק - שומר את התוצאה בעמודה wikipedia_pages.mechalol_redirect_exists.

חשוב: לא סורק את מרחב ההפניות של המכלול. בודק רק את הכותרות
שכבר בדוח "חסר במכלול" (בד"כ כמה אלפים), באצוות ממוקדות של
prop=info&titles=... - עד API_BATCH_SIZE כותרות בבקשה אחת.

מתחבר לחשבון הבוט במכלול (כמו fetch_mechalol.py) כדי לנצל
apihighlimits: 500 כותרות באצווה במקום 50. שימו לב - זו מגבלה שונה
מ-aplimit/cmlimit (BATCH_SIZE_MECHALOL_API=5000 ב-config.py): titles=
הוא פרמטר "מרובה-ערכים" (multivalue), שהתקרה שלו נשארת 500 גם עם
apihighlimits, לא 5000 - זו מגבלה נפרדת לגמרי בממשק ה-API.

מיועד להרצה ידנית (workflow_dispatch). מריצים אותו שוב בכל פעם שרוצים
לרענן את התוצאה - העמודה חוזרת ל-NULL אוטומטית בכל ריקון שבועי
(ראו migration_add_mechalol_redirect_flag.sql).

שימוש:
    python check_missing_redirects.py
"""
import os
import sys
import time
from datetime import datetime, timezone

import requests

from config import MECHALOL_API, BATCH_SIZE, REQUEST_DELAY_SECONDS, REQUEST_HEADERS
from supabase_client import get_client, execute_with_retry

# גודל אצווה לקריאת API אחת (titles=a|b|c...) מול המכלול - 500, תקרת
# apihighlimits לפרמטר multivalue (ראו הערת מודול לעיל - שונה מ-
# aplimit/cmlimit שמגיע עד 5000 עם אותו דגל בוט).
API_BATCH_SIZE = 500
MAX_API_RETRIES = 5

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def login():
    """
    מתחבר לחשבון הבוט במכלול - זהה בדיוק ל-login() ב-fetch_mechalol.py
    (מועתק, לא מיובא, כדי לשמור על כל סקריפט עצמאי ובר-הרצה בפני עצמו,
    כמו שאר הסקריפטים העצמאיים בפרויקט). בלי session מחובר, apihighlimits
    לא היה מוכר, וה-titles= היה חוזר בשקט למגבלה של 50.
    """
    username = os.getenv("USER_NAME")
    password = os.getenv("PASSWORD")
    if not username or not password:
        log("USER_NAME או PASSWORD לא מוגדרים - לא ניתן להתחבר למכלול")
        return False

    try:
        token_params = {"action": "query", "meta": "tokens", "type": "login", "format": "json"}
        token_resp = session.get(MECHALOL_API, params=token_params, timeout=(15, 60))
        token_resp.raise_for_status()
        login_token = token_resp.json()["query"]["tokens"]["logintoken"]

        login_params = {
            "action": "login",
            "lgname": username,
            "lgpassword": password,
            "lgtoken": login_token,
            "format": "json",
        }
        login_resp = session.post(MECHALOL_API, data=login_params, timeout=(15, 60))
        login_resp.raise_for_status()
        result = login_resp.json().get("login", {})

        if result.get("result") != "Success":
            log(f"התחברות למכלול נכשלה: {result.get('reason', 'סיבה לא ידועה')}")
            return False

        log(f"התחברות למכלול הצליחה | משתמש: {username}")
        return True

    except (requests.RequestException, ValueError, KeyError) as exc:
        log(f"שגיאה בהתחברות למכלול: {type(exc).__name__}: {exc}")
        return False


def load_missing_rows():
    """
    שולף את כל השורות מ-report_missing_from_mechalol (id, title) -
    בעימוד מבוסס-מפתח (id), אותו דפוס בדיוק כמו בשני הסקריפטים
    המקבילים (fetch_wikidata_descriptions.py, fetch_easy_import_candidates.py).
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


def fetch_redirect_status(titles):
    """
    שולף באצווה אחת (prop=info, formatversion=2) האם כל כותרת קיימת
    במכלול כהפניה. בלי redirects=1 בבקשה (ברירת המחדל) - כך שאם הכותרת
    עצמה היא דף הפניה, ה-API מחזיר את דף ההפניה עצמו (עם redirect:true),
    ולא "עוקב" אליה אל היעד.

    מחזיר {title: bool} רק עבור כותרות שאכן נמצאו במכלול (עם או בלי
    redirect). כותרת שלא קיימת במכלול כלל (missing) - לא נכללת בתוצאה.
    """
    params = {
        "action": "query",
        "prop": "info",
        "formatversion": "2",
        "titles": "|".join(titles),
        "format": "json",
    }

    data = None
    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            response = session.get(MECHALOL_API, params=params, timeout=(15, 60))
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
        if page.get("missing"):
            continue
        result[page["title"]] = bool(page.get("redirect"))

    return result


def compute_all(titles):
    computed = {}
    chunks = [titles[i:i + API_BATCH_SIZE] for i in range(0, len(titles), API_BATCH_SIZE)]
    total = len(chunks)

    for i, chunk in enumerate(chunks):
        log(f"בודק אצווה {i + 1}/{total} ({len(chunk)} כותרות)")
        computed.update(fetch_redirect_status(chunk))

        if REQUEST_DELAY_SECONDS:
            time.sleep(REQUEST_DELAY_SECONDS)

    return computed


def save_results(client, rows, computed):
    """
    מעדכן את wikipedia_pages.mechalol_redirect_exists לפי id, באותו
    דפוס בדיוק כמו save_descriptions/save_results בשני הסקריפטים
    המקבילים - כולל הכללת title (לא רק id) למניעת שגיאת not null
    על ON CONFLICT DO UPDATE.

    רק כותרות שקיבלו תשובה בפועל מה-API (title in computed) מתעדכנות -
    כותרת שלא נמצאה כלל במכלול (missing בתשובת ה-API) לא נוגעים בה,
    ותיבדק שוב בריצה הבאה.
    """
    to_update = [
        {
            "id": row["id"],
            "title": row["title"],
            "mechalol_redirect_exists": computed[row["title"]],
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

        execute_with_retry(do_upsert, f"עדכון קבוצת הפניות {i + 1}/{len(batches)}", log)
        updated += len(batch)
        log(f"נשמרו {updated}/{len(to_update)} שורות")

    return updated


def main():
    start = time.monotonic()
    log("מתחיל בדיקת הפניות במכלול לערכים חסרים...")

    if not login():
        log("עצירה - לא ניתן להמשיך בלי התחברות תקינה למכלול")
        sys.exit(1)

    client = get_client()
    rows = load_missing_rows()
    log(f"נמצאו {len(rows)} כותרות בדוח 'חסר במכלול'")

    if not rows:
        log("אין כותרות לעיבוד - מסתיים")
        return

    titles = [row["title"] for row in rows]
    computed = compute_all(titles)
    found_as_redirect = sum(1 for v in computed.values() if v)
    log(f"נבדקו {len(computed)} מתוך {len(titles)} כותרות | מהן {found_as_redirect} קיימות כהפניה במכלול")

    updated = save_results(client, rows, computed)
    log(f"עודכנו {updated} שורות בטבלת wikipedia_pages")

    duration = time.monotonic() - start
    log(f"הסתיים בהצלחה. משך ריצה כולל: {duration:.1f} שניות ({duration / 60:.1f} דקות)")


if __name__ == "__main__":
    main()
