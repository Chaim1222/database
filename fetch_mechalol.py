"""
Fetch Wikipedia-derived metadata from Hamichlol into Supabase.

חשוב: match_type לא נשלח כאן בכלל. יש לו ברירת מחדל ברמת הטבלה
(ALTER TABLE ... SET DEFAULT), כדי שרק INSERT של שורה חדשה יקבל אותה,
ולא ידרוס תוצאות התאמה שכבר חושבו ב-match.py. אם עמודה זו נדרשת
ב-INSERT ידני, ראו migration_status_labels.sql.

התחברות: login() מנסה להתחבר לחשבון הבוט (apihighlimits, aplimit/
cmlimit עד 5000) אבל *לא עוצרת את הריצה* אם זה נכשל - ממשיכה אנונימית
עם המגבלה הרגילה (500). login() נכשלה בעבר עם 403 כבר בבקשת ה-token
הראשונה (type=login) - נראה כמו חסימה ספציפית לזרימת ה-login עצמה
(הגנה נגד בוטים/ניחוש-סיסמאות), לא לתעבורת API כללית - שאר הקוד תמיד
עבד אנונימי בלי שום login. ראו MECHALOL_BATCH_SIZE.

ארכיטקטורה: בתחילת כל ריצה טרייה - מרוקנת (TRUNCATE) את mechalol_pages
בלבד ואז ממלאת מחדש מאפס. הריקון עצל (lazy) - קורה רק ממש לפני כתיבת
האצווה הראשונה עם תוכן אמיתי שהתקבלה בהצלחה מה-API, לא באופן גורף
בתחילת הריצה - כך שתקלת API בכל אחד משלבי האיסוף (login, קטגוריות,
מיפוי תאריכים, האצווה הראשונה) לא נוגעת בטבלה הקיימת בכלל. wikipedia_id
לא נשלח ב-INSERT כאן (נקבע רק ב-match.py), כך שמיד אחרי ריקון+מילוי
מוצלח כל wikipedia_id הוא NULL - ולכן fetch_wikipedia.py יכול לרוקן את
wikipedia_pages שלו בבטחה גם אם הוא רץ מיד אחרי. בגלל התלות הזו,
fetch_mechalol.py *חייב* לרוץ לפני fetch_wikipedia.py בתזמון השבועי
(ראו weekly_update.yml, וההערה המקבילה בראש fetch_wikipedia.py).
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

from config import (
    MECHALOL_API,
    BATCH_SIZE,
    BATCH_SIZE_MECHALOL_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    API_BATCH_SIZE_TEMPLATE_CHECK,
    CATEGORY_CREATED_IN_MECHALOL,
    CATEGORY_PIRUSHONIM_CREATED_IN_MECHALOL,
    CATEGORY_TRANSLATED_IN_MECHALOL,
    CATEGORY_MISSING_SORT_TEMPLATE,
    CATEGORY_PAGES_TO_OPEN,
    CATEGORY_DICTIONARY_ENTRIES,
    CATEGORY_IMPORTED_FROM_CHABADPEDIA,
    CATEGORY_IMPORTED_FROM_WIKISHIVA,
    CATEGORY_DELETED_ON_WIKIPEDIA_KEPT,
    CATEGORY_SPLIT_FROM_WIKIPEDIA,
    STATUS_CREATED_IN_MECHALOL,
    STATUS_IMPORTED_DOCUMENTED,
    STATUS_IMPORTED_UNDOCUMENTED,
    STATUS_IMPORTED_FROM_CHABADPEDIA,
    STATUS_IMPORTED_FROM_WIKISHIVA,
    STATUS_KEPT_AFTER_WIKIPEDIA_DELETION,
    STATUS_SPLIT_FROM_WIKIPEDIA,
)
from supabase_client import get_client


PROGRESS_FILE = "mechalol_progress.json"
LOG_FILE = "mechalol.log"

MAX_API_RETRIES = 5
MAX_SUPABASE_RETRIES = 5
HEARTBEAT_SECONDS = 60
LOG_EVERY_ITEMS = 5000
LOG_EVERY_API_REQUESTS = 100

HEBREW_MONTHS = {
    "ינואר": "01", "פברואר": "02", "מרץ": "03", "אפריל": "04",
    "מאי": "05", "יוני": "06", "יולי": "07", "אוגוסט": "08",
    "ספטמבר": "09", "אוקטובר": "10", "נובמבר": "11", "דצמבר": "12",
}

logger = logging.getLogger("fetch_mechalol")
logger.setLevel(logging.INFO)
logger.handlers.clear()

formatter = logging.Formatter(
    "%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
)

file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)

stream_handler = logging.StreamHandler(sys.stdout)
stream_handler.setFormatter(formatter)
logger.addHandler(stream_handler)

start_time = time.monotonic()
last_heartbeat = start_time
api_requests = 0
api_failures = 0

# גודל אצווה בפועל ל-aplimit/cmlimit - נקבע ב-main() לפי תוצאת login():
# BATCH_SIZE_MECHALOL_API (5000) אם ההתחברות הצליחה, BATCH_SIZE (500)
# אם לא - ולא עצירה. login() נכשל בעבר על 403 כבר בבקשת ה-token
# הראשונה (type=login) - חסימה שנראית ספציפית לזרימת login עצמה, לא
# לתעבורת API כללית - ולכן נפילה חזרה לגישה אנונימית (שאר הקוד הזה
# תמיד עבד כך, ללא login בכלל) עדיפה בהרבה על עצירה מוחלטת של הריצה.
MECHALOL_BATCH_SIZE = BATCH_SIZE_MECHALOL_API

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message, level=logging.INFO):
    logger.log(level, message)


def login():
    """
    מנסה להתחבר לחשבון הבוט במכלול. הצלחה מזכה ב-apihighlimits
    (aplimit/cmlimit עד 5000, ראו MECHALOL_BATCH_SIZE). *לא עוצרת את
    הריצה בכישלון* - הקורא (main) בוחר בהתאם להמשיך אנונימי עם המגבלה
    הרגילה (500) במקום. login() עצמה כבר תמיד היתה עמידה לכישלון
    (מחזירה False, לא raise) - זה נשאר כך; מה שהשתנה הוא שה-caller
    כבר לא מבצע sys.exit() על False.
    """
    username = os.getenv("USER_NAME")
    password = os.getenv("PASSWORD")
    if not username or not password:
        log("USER_NAME או PASSWORD לא מוגדרים - לא ניתן להתחבר למכלול", logging.ERROR)
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
            log(f"התחברות למכלול נכשלה: {result.get('reason', 'סיבה לא ידועה')}", logging.ERROR)
            return False

        log(f"התחברות למכלול הצליחה | משתמש: {username}")
        return True

    except (requests.RequestException, ValueError, KeyError) as exc:
        log(f"שגיאה בהתחברות למכלול: {type(exc).__name__}: {exc}", logging.ERROR)
        return False


def format_duration(seconds):
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def heartbeat(force=False):
    global last_heartbeat
    now = time.monotonic()
    if force or now - last_heartbeat >= HEARTBEAT_SECONDS:
        log(
            f"HEARTBEAT | התהליך עדיין פעיל | "
            f"זמן ריצה: {format_duration(now - start_time)} | "
            f"בקשות API: {api_requests}"
        )
        last_heartbeat = now


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def api_get(params, description="בקשת API"):
    global api_requests, api_failures
    params = {**params, "format": "json"}

    for attempt in range(1, MAX_API_RETRIES + 1):
        heartbeat()
        api_requests += 1

        try:
            response = session.get(MECHALOL_API, params=params, timeout=(15, 60))
            response.raise_for_status()
            data = response.json()

            # מדיה-ויקי לעיתים מחזיר HTTP 200 תקין עם {"error": ...}
            # בגוף התשובה (לא שגיאת HTTP) - בלי הבדיקה הזו, שגיאה כזו
            # "נבלעת" בשקט: query/pages/allpages ריקים מתפרשים כ"0
            # תוצאות נמצאו", וזה ממשיך "בהצלחה" עד לריקון+מילוי-ריק של
            # הטבלה (בדיוק התקלה שקרתה בפועל בצד ויקיפדיה). מרוכז כאן
            # במקום אחד כי כל הקריאות למכלול עוברות דרך הפונקציה הזו.
            if "error" in data:
                raise RuntimeError(f"שגיאת API בגוף התשובה: {data['error']}")

            if api_requests % LOG_EVERY_API_REQUESTS == 0:
                log(f"API | בוצעו {api_requests} בקשות עד כה")

            if REQUEST_DELAY_SECONDS:
                time.sleep(REQUEST_DELAY_SECONDS)

            return data

        except (requests.RequestException, ValueError, RuntimeError) as exc:
            api_failures += 1
            log(
                f"שגיאת API | {description} | ניסיון {attempt}/{MAX_API_RETRIES} | "
                f"{type(exc).__name__}: {exc}",
                logging.WARNING,
            )
            if attempt < MAX_API_RETRIES:
                time.sleep(min(2 ** (attempt - 1), 30))
            else:
                raise


def load_progress():
    if not os.path.exists(PROGRESS_FILE):
        return {}
    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as exc:
        log(f"אזהרת התקדמות | לא ניתן לקרוא {PROGRESS_FILE}: {exc}", logging.WARNING)
        return {}


def save_progress(progress):
    temp_file = PROGRESS_FILE + ".tmp"
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)
    os.replace(temp_file, PROGRESS_FILE)


def clear_progress():
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)


def get_category_members(category_title, member_type="page", namespace=None):
    """
    חברים ישירים בלבד. ללא רקורסיביות.
    namespace=0 (ברירת המחדל בקריאות לתוכן) מגביל לערכים במרחב הראשי
    בלבד - קטגוריות תוכן לפעמים כוללות גם דפי שיחה/משתמש/תבנית שתויגו
    בהן בטעות, ואלה לא אמורים להיכנס לטבלת mechalol_pages כלל.
    namespace=None (בשימוש לתת-קטגוריות, member_type="subcat") לא מסנן.
    """
    cmcontinue = None

    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": category_title,
            "cmtype": member_type,
            "cmlimit": MECHALOL_BATCH_SIZE,
        }
        if namespace is not None:
            params["cmnamespace"] = namespace
        if cmcontinue:
            params["cmcontinue"] = cmcontinue

        data = api_get(params, f"חברי קטגוריה | {category_title}")
        members = data.get("query", {}).get("categorymembers", [])

        for member in members:
            yield member["title"], member["pageid"]

        cmcontinue = data.get("continue", {}).get("cmcontinue")
        if not cmcontinue:
            break


def collect_direct_titles(category_title, label):
    stage_start = time.monotonic()
    log("=" * 80)
    log(f"תחילת שלב | {label}")
    log(f"קטגוריה | {category_title}")

    titles = set()
    for title, _ in get_category_members(category_title, "page", namespace=0):
        titles.add(title)

    log(
        f"סוף שלב | {label} | {len(titles):,} חברים ישירים | "
        f"זמן: {format_duration(time.monotonic() - stage_start)}"
    )
    return titles


def parse_month_from_category(category_title):
    match = re.search(r"ב([א-ת]+)\s+(\d{4})", category_title)
    if not match:
        return None
    month_name, year = match.groups()
    month_num = HEBREW_MONTHS.get(month_name)
    if not month_num:
        return None
    return f"{year}-{month_num}"


def get_last_update_map():
    stage_start = time.monotonic()
    result = {}
    root = "קטגוריה:המכלול: ערכים לפי תאריך עדכון"

    log("=" * 80)
    log("תחילת שלב | מיפוי תאריכי עדכון אחרון")

    subcats = list(get_category_members(root, "subcat"))
    valid_months = 0
    pages = 0

    for index, (subcat_title, _) in enumerate(subcats, 1):
        month = parse_month_from_category(subcat_title)
        if not month:
            continue

        valid_months += 1

        for page_title, _ in get_category_members(subcat_title, "page", namespace=0):
            result[page_title] = month
            pages += 1

            if pages % LOG_EVERY_ITEMS == 0:
                log(f"התקדמות מיפוי תאריכים | {pages:,} ערכים מופו")
                heartbeat(force=True)

        log(f"מיפוי תאריכים | [{index}/{len(subcats)}] {subcat_title} -> {month}")

    log(f"סוף שלב | מיפוי תאריכים | {len(result):,} ערכים | {valid_months:,} חודשים")
    return result


def fetch_classification_data():
    """
    שולפת את כל קבוצות הקטגוריה (עצמן, לא הדפים המלאים) הדרושות לסיווג
    כל כותרת - ומיפוי תאריכי העדכון האחרון. עלות זולה וקבועה, בלתי
    תלויה בכמות הדפים הכוללת במכלול (~10 קטגוריות מוגדרות מראש, לא
    350 אלף) - ניתנת לשימוש חוזר גם בסריקה המלאה (main, למטה) וגם
    בסקריפט הדלתא (fetch_mechalol_delta.py), כדי לא לשכפל את לוגיקת
    הסיווג בשני מקומות ולהסתכן בסטייה בין הגרסאות.

    מחזירה dict של קבוצות הכותרות (מפתחות תואמים בשם לקטגוריה
    המקורית ב-config), פלוס last_update_map בנפרד.
    """
    categories = {
        "created": collect_direct_titles(CATEGORY_CREATED_IN_MECHALOL, "ערכים שנוצרו במכלול"),
        "translated": collect_direct_titles(CATEGORY_TRANSLATED_IN_MECHALOL, "ערכים שתורגמו במכלול"),
        "pirushonim": collect_direct_titles(CATEGORY_PIRUSHONIM_CREATED_IN_MECHALOL, "פירושונים שנוצרו במכלול"),
        "missing_sort": collect_direct_titles(CATEGORY_MISSING_SORT_TEMPLATE, "ערכים מוויקיפדיה ללא תבנית מיון"),
        "pages_to_open": collect_direct_titles(CATEGORY_PAGES_TO_OPEN, "ערכים לפתיחה"),
        "dictionary_entries": collect_direct_titles(CATEGORY_DICTIONARY_ENTRIES, "ערכים מילוניים"),
        "chabadpedia": collect_direct_titles(CATEGORY_IMPORTED_FROM_CHABADPEDIA, "דפים שיובאו מחב\"דפדיה"),
        "wikishiva": collect_direct_titles(CATEGORY_IMPORTED_FROM_WIKISHIVA, "דפים שיובאו מויקישיבה"),
        "deleted_on_wikipedia_kept": collect_direct_titles(
            CATEGORY_DELETED_ON_WIKIPEDIA_KEPT, "ערכים שנמחקו בוויקיפדיה ונשמרו"
        ),
        "split_from_wikipedia": collect_direct_titles(
            CATEGORY_SPLIT_FROM_WIKIPEDIA, "ערכים שפוצלו מתוכן ויקיפדי"
        ),
    }

    log(
        f"סיכום | נוצרו={len(categories['created']):,} | תורגמו={len(categories['translated']):,} | "
        f"פירושונים={len(categories['pirushonim']):,} | חסרי_מיון={len(categories['missing_sort']):,} | "
        f"חב\"דפדיה={len(categories['chabadpedia']):,} | ויקישיבה={len(categories['wikishiva']):,} | "
        f"נמחקו_בוויקיפדיה_ונשמרו={len(categories['deleted_on_wikipedia_kept']):,} | "
        f"פוצלו_מוויקיפדיה={len(categories['split_from_wikipedia']):,}"
    )

    # מקור מכלולי-פנימי/חיצוני-לא-ויקיפדי, או ויקיפדי-היסטורי-בלבד,
    # לעניין last_update_month (אין להם קטגוריית עדכון חודשי רלוונטית)
    categories["created_sources"] = (
        categories["created"] | categories["translated"] | categories["pirushonim"]
        | categories["chabadpedia"] | categories["wikishiva"]
        | categories["deleted_on_wikipedia_kept"] | categories["split_from_wikipedia"]
    )

    last_update_map = get_last_update_map()

    return categories, last_update_map


def classify_page(title, categories, last_update_map):
    """
    מסווגת כותרת בודדת ל-(status, source_type, last_update_month,
    needs_attention, is_dictionary_entry), לפי בדיוק אותו סדר עדיפויות
    שהיה קודם משוכפל inline בתוך הלולאה הראשית ב-main() - חולץ לכאן
    כדי ששני מקורות הנתונים (הסריקה השבועית המלאה, וסקריפט הדלתא
    fetch_mechalol_delta.py) ישתמשו באותה לוגיקה בדיוק, ולא יסטו זה
    מזה בהדרגה עם הזמן.
    """
    if title in categories["created"]:
        status, source_type = STATUS_CREATED_IN_MECHALOL, "created"
    elif title in categories["translated"]:
        status, source_type = STATUS_CREATED_IN_MECHALOL, "translated"
    elif title in categories["pirushonim"]:
        status, source_type = STATUS_CREATED_IN_MECHALOL, "pirushon"
    elif title in categories["chabadpedia"]:
        status, source_type = STATUS_IMPORTED_FROM_CHABADPEDIA, "chabadpedia"
    elif title in categories["wikishiva"]:
        status, source_type = STATUS_IMPORTED_FROM_WIKISHIVA, "wikishiva"
    elif title in categories["deleted_on_wikipedia_kept"]:
        status, source_type = STATUS_KEPT_AFTER_WIKIPEDIA_DELETION, "wikipedia_deleted_kept"
    elif title in categories["split_from_wikipedia"]:
        status, source_type = STATUS_SPLIT_FROM_WIKIPEDIA, "split_from_wikipedia"
    elif title in last_update_map:
        status, source_type = STATUS_IMPORTED_DOCUMENTED, "wikipedia_documented"
    elif title in categories["missing_sort"]:
        status, source_type = STATUS_IMPORTED_UNDOCUMENTED, "missing_sort"
    else:
        status, source_type = STATUS_IMPORTED_UNDOCUMENTED, "unknown"

    last_update_month = (
        None if title in categories["created_sources"] or title in categories["missing_sort"]
        else last_update_map.get(title)
    )

    return {
        "status": status,
        "source_type": source_type,
        "last_update_month": last_update_month,
        "needs_attention": title in categories["pages_to_open"],
        "is_dictionary_entry": title in categories["dictionary_entries"],
    }


def fetch_all_titles(progress):
    apcontinue = progress.get("allpages_apcontinue")
    total = progress.get("allpages_count", 0)

    while True:
        params = {
            "action": "query",
            "list": "allpages",
            "apnamespace": 0,
            "apfilterredir": "nonredirects",
            "aplimit": MECHALOL_BATCH_SIZE,
        }
        if apcontinue:
            params["apcontinue"] = apcontinue

        data = api_get(params, "כל הדפים")
        pages = data.get("query", {}).get("allpages", [])
        total += len(pages)

        yield [(page["title"], page["pageid"]) for page in pages]

        apcontinue = data.get("continue", {}).get("apcontinue")
        progress["allpages_apcontinue"] = apcontinue
        progress["allpages_count"] = total
        progress["last_update"] = utc_now()
        save_progress(progress)

        if not apcontinue:
            break

        heartbeat(force=True)

    log(f"כל הדפים | הסריקה הסתיימה | {total:,}")


# שורה קיימת נחשבת "מיושנת/מתנגשת" רק אם הכותרת שלה תואמת כותרת
# באצווה החדשה *וגם* ה-id (page_id) שלה שונה מה-page_id שהאצווה משייכת
# לאותה כותרת בדיוק. אם ה-id זהה - זו פשוט אותה שורה במדויק (עדכון
# רגיל, לא התנגשות) - לא נוגעים בה.
def find_stale_title_collisions(existing_rows, new_rows):
    new_id_by_title = {r["title"]: r["id"] for r in new_rows}
    return [
        row["id"]
        for row in existing_rows
        if row["title"] in new_id_by_title
        and row["id"] != new_id_by_title[row["title"]]
    ]


def resolve_title_collisions(client, rows):
    titles = [r["title"] for r in rows]

    # ponytail: .in_() נשלח כ-GET עם הכותרות ב-URL (percent-encoded) -
    # מאות כותרות בעברית באצווה אחת חורגות ממגבלת אורך URL של השרת
    # ומחזירות 400 גנרי. פיצול לצ'אנקים קטנים (כמו שכבר נעשה בבדיקת
    # תבנית המיון ב-match.py) פותר את זה.
    existing = []
    for i in range(0, len(titles), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = titles[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
        result = (
            client.table("mechalol_pages")
            .select("id, title")
            .in_("title", chunk)
            .execute()
        )
        existing.extend(result.data)

    stale_ids = find_stale_title_collisions(existing, rows)

    if stale_ids:
        log(f"WARNING | התנגשות כותרת/id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        client.table("mechalol_pages").delete().in_("id", stale_ids).execute()

    return bool(stale_ids)


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "mechalol_pages_title_key" in str(exc)


def upsert_rows(client, rows, batch_number, total):
    if not rows:
        return

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table("mechalol_pages").upsert(rows, on_conflict="id").execute()
            log(f"Supabase | אצווה #{batch_number:,} | {len(rows):,} שורות | סה״כ {total:,}")
            return
        except Exception as exc:
            if _is_title_collision(exc) and resolve_title_collisions(client, rows):
                log(f"Supabase | אצווה #{batch_number:,} | טופלה התנגשות כותרת, מנסה שוב")
                continue

            log(
                f"שגיאת Supabase | אצווה #{batch_number:,} | "
                f"ניסיון {attempt}/{MAX_SUPABASE_RETRIES}: {exc}",
                logging.WARNING,
            )
            if attempt < MAX_SUPABASE_RETRIES:
                time.sleep(min(2 ** (attempt - 1), 30))
            else:
                raise


def main():
    global MECHALOL_BATCH_SIZE

    logged_in = login()
    if logged_in:
        log(f"מחובר לחשבון הבוט במכלול - עובד עם מגבלת API גבוהה (aplimit/cmlimit={BATCH_SIZE_MECHALOL_API:,})")
    else:
        MECHALOL_BATCH_SIZE = BATCH_SIZE
        log(
            f"לא הצלחתי להתחבר למכלול - ממשיך אנונימי עם מגבלת API רגילה "
            f"(aplimit/cmlimit={BATCH_SIZE:,})",
            logging.WARNING,
        )

    progress = load_progress()
    # progress לא ריק = יש מצב שמור מריצה קודמת שנקטעה עקב הריגה חיצונית
    # (מגבלת זמן של גיטהאב אקשנס) בלי הזדמנות להגיב. לעומת זאת, חריגה
    # אמיתית בתוך הקוד כבר מנקה את קובץ ה-progress בעצמה (ראו except
    # למטה) - אז אם הקובץ קיים כאן, זו בהכרח הריגה חיצונית, לא כשלון-
    # בקוד. במצב כזה - הריקון כבר קרה בריצה הקודמת שהצליחה לקבל לפחות
    # אצווה אחת; לא מרוקנים שוב.
    is_resumed = bool(progress)
    client = get_client()

    log("=" * 80)
    log("התחלה | fetch_mechalol.py")

    categories, last_update_map = fetch_classification_data()

    total = progress.get("uploaded_count", 0)
    batch_number = progress.get("upload_batch", 0)
    # ריקון מלא (TRUNCATE) - עצל (lazy): מתבצע רק ממש לפני כתיבת האצווה
    # הראשונה שבאמת מתקבלת מה-API עם תוכן (בלולאה למטה), לא באופן גורף
    # כאן. כך תקלת API בכל אחד מהשלבים שמעל (login, כל אחד
    # מ-collect_direct_titles, get_last_update_map) - כבר גורמת לחריגה
    # ולא מגיעה לכלל ריקון בכלל. מרוקן רק את mechalol_pages - לא נוגע
    # ב-wikipedia_pages (ראו truncate_mechalol_pages() ב-DB, ותיעוד
    # סדר השלבים הנדרש ב-weekly_update.yml ובהערת המודול של
    # fetch_wikipedia.py - מכלול חייב לרוץ ולהתרוקן+להתמלא לפני ויקיפדיה).
    truncated = is_resumed

    try:
        for batch in fetch_all_titles(progress):
            if not batch:
                continue

            if not truncated:
                log("ריקון | מרוקן mechalol_pages...")
                client.rpc("truncate_mechalol_pages").execute()
                truncated = True

            rows = []

            for title, page_id in batch:
                classification = classify_page(title, categories, last_update_map)
                rows.append({
                    "id": page_id,
                    "title": title,
                    # match_type לא נשלח - ברירת מחדל בטבלה בלבד (ראו הערת מודול).
                    **classification,
                })

            batch_number += 1
            total += len(rows)

            upsert_rows(client, rows, batch_number, total)

            progress["upload_batch"] = batch_number
            progress["uploaded_count"] = total
            progress["last_update"] = utc_now()
            save_progress(progress)
            heartbeat(force=True)
    except Exception:
        log("שגיאה אמיתית באמצע הריצה - מוחק את קובץ ההתקדמות כדי שהריצה הבאה תתחיל מחדש", logging.ERROR)
        clear_progress()
        raise

    # רשת הגנה אחרונה: ריצה תקינה על המכלול לעולם לא מסתיימת ב-0
    # ערכים. אם זה קורה בכל זאת - כנראה תקלת API/חסימה לא-ודאית לא
    # נתפסה כראוי. עדיף להיכשל בקול (exit code שונה מ-0) מאשר לסמן
    # "הצלחה" בשקט. הודות לריקון העצל למעלה, המקרה הזה כבר לא כרוך
    # באובדן נתונים - הטבלה כלל לא נגעה בה אם total==0.
    if not is_resumed and total == 0:
        clear_progress()
        raise RuntimeError(
            "הריצה הסתיימה עם 0 ערכים מהמכלול - כנראה תקלת API/חסימה. "
            "הטבלה לא נגעה בה (הריקון עצל ומתבצע רק לפני אצווה ראשונה "
            "עם תוכן) - לא מסמן כהצלחה."
        )

    clear_progress()

    log(f"הצלחה | הועלו/עודכנו {total:,} ערכים | בקשות API: {api_requests:,}")


if __name__ == "__main__":
    main()
