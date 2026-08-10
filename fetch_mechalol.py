"""
שליפת נתוני הערכים מהמכלול והעלאתם ל-Supabase.

הסקריפט כולל לוגים מפורטים כדי שאפשר יהיה לראות ב-GitHub Actions:
- באיזה שלב התהליך נמצא
- כמה בקשות API בוצעו
- כמה ערכים/קטגוריות נמצאו עד כה
- כמה ערכים הועלו ל-Supabase
- כמה זמן לקח כל שלב
- שגיאות API / Supabase וניסיונות חוזרים
- heartbeat תקופתי כדי לוודא שהתהליך עדיין פעיל

קובץ לוג מקומי:
    mechalol.log

קובץ התקדמות:
    mechalol_progress.json

שימוש:
    python fetch_mechalol.py
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
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    CATEGORY_CREATED_IN_MECHALOL,
    CATEGORY_MISSING_SORT_TEMPLATE,
    LAST_UPDATE_CATEGORY_PREFIX,
    CATEGORY_PAGES_TO_OPEN,
    CATEGORY_DICTIONARY_ENTRIES,
)
from supabase_client import get_client

PROGRESS_FILE = "mechalol_progress.json"
LOG_FILE = "mechalol.log"

# כמה פעמים לנסות שוב בקשת API שנכשלה
MAX_API_RETRIES = 5
# כמה פעמים לנסות שוב העלאה ל-Supabase
MAX_SUPABASE_RETRIES = 5
# כל כמה שניות להדפיס heartbeat גם אם אין אירוע אחר
HEARTBEAT_SECONDS = 60
# כל כמה ערכים להדפיס התקדמות במהלך סריקת קטגוריות
LOG_EVERY_ITEMS = 5000
# כל כמה בקשות API להדפיס סטטיסטיקה
LOG_EVERY_API_REQUESTS = 100

HEBREW_MONTHS = {
    "ינואר": "01", "פברואר": "02", "מרץ": "03", "אפריל": "04",
    "מאי": "05", "יוני": "06", "יולי": "07", "אוגוסט": "08",
    "ספטמבר": "09", "אוקטובר": "10", "נובמבר": "11", "דצמבר": "12",
}


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger("fetch_mechalol")
logger.setLevel(logging.INFO)
logger.handlers.clear()

formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

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


def log(message, level=logging.INFO):
    """לוג גם ל-GitHub Actions וגם לקובץ."""
    logger.log(level, message)


def heartbeat(force=False):
    """מדפיס סימן חיים תקופתי כדי שלא יהיה ספק שהתהליך תקוע."""
    global last_heartbeat
    now = time.monotonic()
    if force or now - last_heartbeat >= HEARTBEAT_SECONDS:
        elapsed = format_duration(now - start_time)
        log(f"HEARTBEAT | התהליך עדיין פעיל | זמן ריצה: {elapsed} | API requests: {api_requests}")
        last_heartbeat = now


def format_duration(seconds):
    seconds = int(seconds)
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# HTTP / API
# ---------------------------------------------------------------------------

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def api_get(params, description="API request"):
    """בקשת API עם retry, timeout ולוגים."""
    global api_requests, api_failures

    params = {**params, "format": "json"}

    for attempt in range(1, MAX_API_RETRIES + 1):
        heartbeat()
        api_requests += 1
        try:
            response = session.get(
                MECHALOL_API,
                params=params,
                headers=REQUEST_HEADERS,
                timeout=(15, 60),
            )
            response.raise_for_status()
            data = response.json()

            if api_requests % LOG_EVERY_API_REQUESTS == 0:
                log(f"API | בוצעו {api_requests} בקשות עד כה")

            if REQUEST_DELAY_SECONDS > 0:
                time.sleep(REQUEST_DELAY_SECONDS)
            return data

        except (requests.RequestException, ValueError) as exc:
            api_failures += 1
            log(
                f"API ERROR | {description} | ניסיון {attempt}/{MAX_API_RETRIES} | {type(exc).__name__}: {exc}",
                logging.WARNING,
            )
            if attempt < MAX_API_RETRIES:
                wait = min(2 ** (attempt - 1), 30)
                log(f"API | ממתין {wait} שניות לפני ניסיון חוזר...")
                time.sleep(wait)
            else:
                log(f"API ERROR | ויתרתי לאחר {MAX_API_RETRIES} ניסיונות | {description}", logging.ERROR)
                raise


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------


def load_progress():
    if not os.path.exists(PROGRESS_FILE):
        return {}

    try:
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception as exc:
        log(f"PROGRESS WARNING | לא ניתן לקרוא {PROGRESS_FILE}: {exc}", logging.WARNING)

    return {}


def save_progress(progress):
    """כתיבה אטומית יחסית כדי לא להשאיר JSON שבור אם התהליך נעצר."""
    temp_file = PROGRESS_FILE + ".tmp"
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)
    os.replace(temp_file, PROGRESS_FILE)


def clear_progress():
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)


# ---------------------------------------------------------------------------
# Category traversal
# ---------------------------------------------------------------------------


def get_category_members(category_title, member_type="page"):
    """
    שליפת כל החברים הישירים בקטגוריה נתונה (עמודים או תתי-קטגוריות), בעימוד.
    """
    cmcontinue = None
    page_count = 0

    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": category_title,
            "cmtype": member_type,
            "cmlimit": BATCH_SIZE,
        }
        if cmcontinue:
            params["cmcontinue"] = cmcontinue

        data = api_get(params, f"categorymembers | {category_title}")
        members = data.get("query", {}).get("categorymembers", [])

        for m in members:
            page_count += 1
            yield m["title"], m["pageid"]

        cmcontinue = data.get("continue", {}).get("cmcontinue")
        if not cmcontinue:
            break

    return page_count


def get_all_pages_in_tree(root_category, _seen_categories=None, _stats=None):
    """
    איסוף רקורסיבי של כל כותרות הערכים תחת קטגוריה, כולל כל תתי-הקטגוריות.
    מוסיף לוגים בזמן אמת כדי שניתן יהיה לראות שהסריקה מתקדמת.
    """
    if _seen_categories is None:
        _seen_categories = set()
    if _stats is None:
        _stats = {"categories": 0, "pages": 0}

    if root_category in _seen_categories:
        return

    _seen_categories.add(root_category)
    _stats["categories"] += 1

    log(
        f"CATEGORY | סורק: {root_category} | קטגוריות שנבדקו: {_stats['categories']} | ערכים שנמצאו: {_stats['pages']}"
    )

    for title, page_id in get_category_members(root_category, "page"):
        _stats["pages"] += 1
        if _stats["pages"] % LOG_EVERY_ITEMS == 0:
            log(
                f"CATEGORY PROGRESS | {_stats['pages']:,} ערכים נמצאו | {_stats['categories']:,} קטגוריות נסרקו"
            )
            heartbeat(force=True)
        yield title, page_id

    subcategories = list(get_category_members(root_category, "subcat"))
    log(f"CATEGORY | {root_category} מכילה {len(subcategories):,} תתי-קטגוריות ישירות")

    for subcat_title, _ in subcategories:
        yield from get_all_pages_in_tree(subcat_title, _seen_categories, _stats)


def collect_tree_titles(root_category, label):
    """אוסף titles מקטגוריה ועץ תתי-הקטגוריות עם סיכום ברור."""
    stage_start = time.monotonic()
    log("=" * 80)
    log(f"START STAGE | {label}")
    log(f"ROOT CATEGORY | {root_category}")

    titles = set()
    stats = {"categories": 0, "pages": 0}

    for title, _ in get_all_pages_in_tree(root_category, _stats=stats):
        titles.add(title)

    log(
        f"END STAGE | {label} | {len(titles):,} ערכים ייחודיים | "
        f"{stats['categories']:,} קטגוריות | זמן: {format_duration(time.monotonic() - stage_start)}"
    )
    return titles


# ---------------------------------------------------------------------------
# Specific data extraction
# ---------------------------------------------------------------------------


def parse_month_from_category(category_title):
    """
    "קטגוריה:המכלול: ערכים שעודכנו לאחרונה במרץ 2021" -> "2021-03"
    """
    match = re.search(r"ב([א-ת]+)\s+(\d{4})", category_title)
    if not match:
        return None
    month_name, year = match.groups()
    month_num = HEBREW_MONTHS.get(month_name)
    if not month_num:
        return None
    return f"{year}-{month_num}"


def get_last_update_map():
    """מיפוי כותרת ערך -> חודש עדכון אחרון."""
    stage_start = time.monotonic()
    result = {}
    root = "קטגוריה:המכלול: ערכים לפי תאריך עדכון"

    log("=" * 80)
    log("START STAGE | מיפוי תאריכי עדכון אחרון")
    log(f"ROOT CATEGORY | {root}")

    subcats = list(get_category_members(root, "subcat"))
    log(f"UPDATE MAP | נמצאו {len(subcats):,} תתי-קטגוריות חודשיות")

    valid_months = 0
    pages = 0

    for index, (subcat_title, _) in enumerate(subcats, 1):
        month = parse_month_from_category(subcat_title)
        if not month:
            log(f"UPDATE MAP | דילוג על קטגוריה ללא חודש מזוהה: {subcat_title}", logging.WARNING)
            continue

        valid_months += 1
        month_pages = 0
        log(f"UPDATE MAP | [{index}/{len(subcats)}] {subcat_title} -> {month}")

        for page_title, _ in get_category_members(subcat_title, "page"):
            result[page_title] = month
            pages += 1
            month_pages += 1

            if pages % LOG_EVERY_ITEMS == 0:
                log(f"UPDATE MAP PROGRESS | {pages:,} ערכים מופו עד כה")
                heartbeat(force=True)

        log(f"UPDATE MAP | {month} | {month_pages:,} ערכים")

    log(
        f"END STAGE | מיפוי תאריכים | {len(result):,} ערכים | "
        f"{valid_months:,} חודשים תקינים | זמן: {format_duration(time.monotonic() - stage_start)}"
    )
    return result


# ---------------------------------------------------------------------------
# All pages
# ---------------------------------------------------------------------------


def fetch_all_titles(progress):
    """שליפת כל הערכים שאינם הפניות, עם שמירת apcontinue."""
    apcontinue = progress.get("allpages_apcontinue")
    total = progress.get("allpages_count", 0)

    if apcontinue:
        log(f"ALLPAGES | ממשיך מנקודת ההתקדמות הקודמת | total={total:,}")
    else:
        log("ALLPAGES | מתחיל סריקת כל הערכים שאינם הפניות")

    while True:
        params = {
            "action": "query",
            "list": "allpages",
            "apnamespace": 0,
            "apfilterredir": "nonredirects",
            "aplimit": BATCH_SIZE,
        }
        if apcontinue:
            params["apcontinue"] = apcontinue

        data = api_get(params, "allpages")
        pages = data.get("query", {}).get("allpages", [])

        if pages:
            total += len(pages)
            log(f"ALLPAGES | התקבל batch של {len(pages):,} | סה״כ: {total:,}")

        yield [(p["title"], p["pageid"]) for p in pages]

        apcontinue = data.get("continue", {}).get("apcontinue")
        progress["allpages_apcontinue"] = apcontinue
        progress["allpages_count"] = total
        progress["last_update"] = utc_now()
        save_progress(progress)

        if not apcontinue:
            break

        heartbeat(force=True)

    log(f"ALLPAGES | הסריקה הסתיימה | סה״כ: {total:,}")


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------


def upsert_rows(client, rows, batch_number, total):
    if not rows:
        return

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table("mechalol_pages").upsert(rows, on_conflict="page_id").execute()
            log(
                f"SUPABASE | batch #{batch_number:,} הועלה בהצלחה | "
                f"{len(rows):,} שורות | סה״כ: {total:,}"
            )
            return
        except Exception as exc:
            log(
                f"SUPABASE ERROR | batch #{batch_number:,} | ניסיון {attempt}/{MAX_SUPABASE_RETRIES} | {type(exc).__name__}: {exc}",
                logging.WARNING,
            )
            if attempt < MAX_SUPABASE_RETRIES:
                wait = min(2 ** (attempt - 1), 30)
                log(f"SUPABASE | ממתין {wait} שניות לפני ניסיון חוזר...")
                time.sleep(wait)
            else:
                log(f"SUPABASE ERROR | כישלון סופי ב-batch #{batch_number:,}", logging.ERROR)
                raise


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    progress = load_progress()
    client = get_client()

    log("=" * 80)
    log("START | fetch_mechalol.py")
    log(f"UTC start: {utc_now()}")
    log(f"API: {MECHALOL_API}")
    log(f"BATCH_SIZE: {BATCH_SIZE}")
    log(f"REQUEST_DELAY_SECONDS: {REQUEST_DELAY_SECONDS}")
    log(f"LOG_FILE: {LOG_FILE}")
    log(f"PROGRESS_FILE: {PROGRESS_FILE}")
    log("Supabase client initialized successfully")

    try:
        created_in_mechalol = collect_tree_titles(
            CATEGORY_CREATED_IN_MECHALOL,
            "ערכים שנוצרו במכלול",
        )

        missing_sort_template = collect_tree_titles(
            CATEGORY_MISSING_SORT_TEMPLATE,
            "ערכים מוויקיפדיה ללא תבנית מיון",
        )

        last_update_map = get_last_update_map()

        pages_to_open = collect_tree_titles(
            CATEGORY_PAGES_TO_OPEN,
            "דפים לטיפול / ערכים לפתיחה",
        )

        dictionary_entries = collect_tree_titles(
            CATEGORY_DICTIONARY_ENTRIES,
            "ערכים מילוניים",
        )

        log("=" * 80)
        log("PREPARATION SUMMARY")
        log(f"created_in_mechalol: {len(created_in_mechalol):,}")
        log(f"missing_sort_template: {len(missing_sort_template):,}")
        log(f"last_update_map: {len(last_update_map):,}")
        log(f"pages_to_open: {len(pages_to_open):,}")
        log(f"dictionary_entries: {len(dictionary_entries):,}")
        log("=" * 80)

        total = progress.get("uploaded_count", 0)
        batch_number = progress.get("upload_batch", 0)
        stage_start = time.monotonic()

        for batch in fetch_all_titles(progress):
            if not batch:
                continue

            rows = []
            for title, page_id in batch:
                if title in created_in_mechalol:
                    status = "נוצר_במכלול"
                    last_update_month = None
                elif title in missing_sort_template:
                    status = "מיובא_ללא_תיעוד"
                    last_update_month = None
                else:
                    status = "מיובא_מתועד"
                    last_update_month = last_update_map.get(title)

                rows.append({
                    "title": title,
                    "page_id": page_id,
                    "status": status,
                    "last_update_month": last_update_month,
                    "match_type": "ללא_התאמה",
                    "needs_attention": title in pages_to_open,
                    "is_dictionary_entry": title in dictionary_entries,
                })

            batch_number += 1
            total += len(rows)
            upsert_rows(client, rows, batch_number, total)

            progress["upload_batch"] = batch_number
            progress["uploaded_count"] = total
            progress["last_update"] = utc_now()
            save_progress(progress)

            heartbeat(force=True)

        clear_progress()

        elapsed = format_duration(time.monotonic() - start_time)
        log("=" * 80)
        log("SUCCESS | הסקריפט הסתיים בהצלחה")
        log(f"סה״כ ערכים שהועלו/עודכנו: {total:,}")
        log(f"API requests: {api_requests:,}")
        log(f"API failures/retries: {api_failures:,}")
        log(f"זמן ריצה כולל: {elapsed}")
        log("=" * 80)

    except Exception as exc:
        elapsed = format_duration(time.monotonic() - start_time)
        log("=" * 80)
        log("FAILED | הסקריפט נכשל", logging.ERROR)
        log(f"Error: {type(exc).__name__}: {exc}", logging.ERROR)
        log(f"API requests: {api_requests:,}", logging.ERROR)
        log(f"זמן ריצה עד הכישלון: {elapsed}", logging.ERROR)
        log(f"קובץ ההתקדמות נשמר: {PROGRESS_FILE}", logging.ERROR)
        log("=" * 80)
        raise


if __name__ == "__main__":
    main()
