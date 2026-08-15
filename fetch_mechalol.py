"""
Fetch Wikipedia-derived metadata from Hamichlol into Supabase.

חשוב: match_type לא נשלח כאן בכלל. יש לו ברירת מחדל ברמת הטבלה
(ALTER TABLE ... SET DEFAULT), כדי שרק INSERT של שורה חדשה יקבל אותה,
ולא ידרוס תוצאות התאמה שכבר חושבו ב-match.py. אם עמודה זו נדרשת
ב-INSERT ידני, ראו migration_status_labels.sql.
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
    STATUS_CREATED_IN_MECHALOL,
    STATUS_IMPORTED_DOCUMENTED,
    STATUS_IMPORTED_UNDOCUMENTED,
    STATUS_IMPORTED_FROM_CHABADPEDIA,
    STATUS_IMPORTED_FROM_WIKISHIVA,
    STATUS_KEPT_AFTER_WIKIPEDIA_DELETION,
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

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message, level=logging.INFO):
    logger.log(level, message)


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

            if api_requests % LOG_EVERY_API_REQUESTS == 0:
                log(f"API | בוצעו {api_requests} בקשות עד כה")

            if REQUEST_DELAY_SECONDS:
                time.sleep(REQUEST_DELAY_SECONDS)

            return data

        except (requests.RequestException, ValueError) as exc:
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
            "cmlimit": BATCH_SIZE,
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


def fetch_all_titles(progress):
    apcontinue = progress.get("allpages_apcontinue")
    total = progress.get("allpages_count", 0)

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


# ponytail: כותרת שהייתה שייכת ל-page_id ישן (שונה/נמחק/הועבר בוויקי)
# ונתפסה כעת ע"י page_id חדש. הסריקה היא תמונת מצב חיה של הוויקי - אין
# שני page_id חיים עם אותה כותרת בו-זמנית - אז כל שורה קיימת בטבלה עם
# אותה כותרת ו-page_id שונה מהחדש היא בהכרח מיושנת, ואפשר למחוק אותה
# בבטחון. תקרה: לא מטפל במקרה של שתי שורות *חדשות* באותה אצווה
# שמתחרות על אותה כותרת בו-זמנית - לא אמור לקרות (MediaWiki לא מאפשר
# שתי כותרות חיות זהות), ולא נצפה בפועל.
def find_stale_title_collisions(existing_rows, new_rows):
    new_page_ids = {r["page_id"] for r in new_rows}
    return [row["id"] for row in existing_rows if row["page_id"] not in new_page_ids]


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
            .select("id, title, page_id")
            .in_("title", chunk)
            .execute()
        )
        existing.extend(result.data)

    stale_ids = find_stale_title_collisions(existing, rows)

    if stale_ids:
        log(f"WARNING | התנגשות כותרת/page_id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        client.table("mechalol_pages").delete().in_("id", stale_ids).execute()

    return bool(stale_ids)


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "mechalol_pages_title_key" in str(exc)


def upsert_rows(client, rows, batch_number, total):
    if not rows:
        return

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table("mechalol_pages").upsert(rows, on_conflict="page_id").execute()
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


def get_existing_page_ids(client):
    """שולף (page_id, id) עבור כל השורות הקיימות כרגע ב-mechalol_pages, בעימוד."""
    pairs = set()
    last_id = 0

    while True:
        for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
            try:
                result = (
                    client.table("mechalol_pages")
                    .select("id, page_id")
                    .gt("id", last_id)
                    .order("id")
                    .limit(BATCH_SIZE)
                    .execute()
                )
                break
            except Exception as exc:
                if attempt >= MAX_SUPABASE_RETRIES:
                    raise
                log(
                    f"שגיאת Supabase | שליפת page_id קיימים | ניסיון {attempt}/{MAX_SUPABASE_RETRIES}: {exc}",
                    logging.WARNING,
                )
                time.sleep(min(2 ** (attempt - 1), 30))

        rows = result.data or []
        if not rows:
            break

        for row in rows:
            pairs.add((row["page_id"], row["id"]))

        last_id = rows[-1]["id"]
        if len(rows) < BATCH_SIZE:
            break

    return pairs


def cleanup_deleted_from_mechalol(client, current_page_ids):
    """
    מוחק שורות שה-page_id שלהן לא הופיע בסריקה המלאה הנוכחית - כלומר
    הדף כבר לא קיים במכלול (נמחק). קריאה למחיקה, בלי שמירת תיעוד
    היסטורי, לפי בקשה מפורשת. חייבים לקרוא לפונקציה הזו רק אחרי סריקה
    מלאה ורצופה (לא מחודשת מ-initial_run שנעצר) - ראו main().
    """
    existing = get_existing_page_ids(client)
    stale_ids = [row_id for page_id, row_id in existing if page_id not in current_page_ids]

    if not stale_ids:
        log("ניקוי | לא נמצאו שורות שנמחקו מהמכלול")
        return 0

    log(f"ניקוי | {len(stale_ids):,} שורות עם page_id שלא נמצא בסריקה הנוכחית - נמחקות")

    for i in range(0, len(stale_ids), BATCH_SIZE):
        chunk = stale_ids[i:i + BATCH_SIZE]
        for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
            try:
                client.table("mechalol_pages").delete().in_("id", chunk).execute()
                break
            except Exception as exc:
                if attempt >= MAX_SUPABASE_RETRIES:
                    raise
                log(
                    f"שגיאת Supabase | מחיקת שורות שנעלמו מהמכלול | "
                    f"ניסיון {attempt}/{MAX_SUPABASE_RETRIES}: {exc}",
                    logging.WARNING,
                )
                time.sleep(min(2 ** (attempt - 1), 30))

    return len(stale_ids)


def main():
    progress = load_progress()
    is_resumed = bool(progress)
    client = get_client()

    log("=" * 80)
    log("התחלה | fetch_mechalol.py")

    created = collect_direct_titles(CATEGORY_CREATED_IN_MECHALOL, "ערכים שנוצרו במכלול")
    translated = collect_direct_titles(CATEGORY_TRANSLATED_IN_MECHALOL, "ערכים שתורגמו במכלול")
    pirushonim = collect_direct_titles(CATEGORY_PIRUSHONIM_CREATED_IN_MECHALOL, "פירושונים שנוצרו במכלול")
    missing_sort = collect_direct_titles(CATEGORY_MISSING_SORT_TEMPLATE, "ערכים מוויקיפדיה ללא תבנית מיון")
    pages_to_open = collect_direct_titles(CATEGORY_PAGES_TO_OPEN, "ערכים לפתיחה")
    dictionary_entries = collect_direct_titles(CATEGORY_DICTIONARY_ENTRIES, "ערכים מילוניים")
    chabadpedia = collect_direct_titles(CATEGORY_IMPORTED_FROM_CHABADPEDIA, "דפים שיובאו מחב\"דפדיה")
    wikishiva = collect_direct_titles(CATEGORY_IMPORTED_FROM_WIKISHIVA, "דפים שיובאו מויקישיבה")
    deleted_on_wikipedia_kept = collect_direct_titles(
        CATEGORY_DELETED_ON_WIKIPEDIA_KEPT, "ערכים שנמחקו בוויקיפדיה ונשמרו"
    )

    last_update_map = get_last_update_map()

    # מקור מכלולי-פנימי/חיצוני-לא-ויקיפדי, או ויקיפדי-היסטורי-בלבד,
    # לעניין last_update_month (אין להם קטגוריית עדכון חודשי רלוונטית)
    created_sources = created | translated | pirushonim | chabadpedia | wikishiva | deleted_on_wikipedia_kept

    log(
        f"סיכום | נוצרו={len(created):,} | תורגמו={len(translated):,} | "
        f"פירושונים={len(pirushonim):,} | חסרי_מיון={len(missing_sort):,} | "
        f"חב\"דפדיה={len(chabadpedia):,} | ויקישיבה={len(wikishiva):,} | "
        f"נמחקו_בוויקיפדיה_ונשמרו={len(deleted_on_wikipedia_kept):,}"
    )

    total = progress.get("uploaded_count", 0)
    batch_number = progress.get("upload_batch", 0)
    seen_page_ids = set()

    for batch in fetch_all_titles(progress):
        if not batch:
            continue

        rows = []

        for title, page_id in batch:
            seen_page_ids.add(page_id)

            if title in created:
                status, source_type = STATUS_CREATED_IN_MECHALOL, "created"
            elif title in translated:
                status, source_type = STATUS_CREATED_IN_MECHALOL, "translated"
            elif title in pirushonim:
                status, source_type = STATUS_CREATED_IN_MECHALOL, "pirushon"
            elif title in chabadpedia:
                status, source_type = STATUS_IMPORTED_FROM_CHABADPEDIA, "chabadpedia"
            elif title in wikishiva:
                status, source_type = STATUS_IMPORTED_FROM_WIKISHIVA, "wikishiva"
            elif title in deleted_on_wikipedia_kept:
                status, source_type = STATUS_KEPT_AFTER_WIKIPEDIA_DELETION, "wikipedia_deleted_kept"
            elif title in missing_sort:
                status, source_type = STATUS_IMPORTED_UNDOCUMENTED, "unknown"
            else:
                # ponytail: אין קטגוריית "יש תבנית מיון" חיובית - זה עדיין
                # ניחוש, רק בכיוון הבטוח יותר (undocumented). ערכים ישנים
                # שיובאו לפני שהנוהג של {{מיון ויקיפדיה}}/missing_sort
                # הונהג נופלים לכאן ואין דרך זולה להבדיל "יש תבנית" מ
                # "מעולם לא נבדק". שדרוג: match.py כבר בודק בפועל אם יש
                # תבנית (שלב 4, pending בלבד) - אפשר להרחיב את הבדיקה
                # לכל השורות ולעדכן status בדיעבד לפי
                # normalization_method=='תבנית_מיון' לעומת לא-נמצא.
                status, source_type = STATUS_IMPORTED_UNDOCUMENTED, "unknown"

            last_update_month = (
                None if title in created_sources or title in missing_sort
                else last_update_map.get(title)
            )

            rows.append({
                "title": title,
                "page_id": page_id,
                "status": status,
                "source_type": source_type,
                "last_update_month": last_update_month,
                # match_type לא נשלח - ברירת מחדל בטבלה בלבד (ראו הערת מודול).
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

    log(f"הצלחה | הועלו/עודכנו {total:,} ערכים | בקשות API: {api_requests:,}")

    # ניקוי דפים שנמחקו מהמכלול - רק אם הסריקה בוצעה ברצף אחד בתהליך
    # הזה (לא המשך של initial_run שנעצר), כי אחרת seen_page_ids לא
    # מכיל את הכותרות שכבר נסרקו בתהליכים קודמים ותהיה מחיקה שגויה.
    if is_resumed:
        log("ניקוי | דולג - זו המשך ריצה שהתחילה בתהליך קודם (seen_page_ids חלקי)")
    else:
        deleted = cleanup_deleted_from_mechalol(client, seen_page_ids)
        log(f"ניקוי | נמחקו {deleted:,} שורות שלא קיימות עוד במכלול")


if __name__ == "__main__":
    main()
