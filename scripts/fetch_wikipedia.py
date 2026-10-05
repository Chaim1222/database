"""
שליפת כל כותרות הערכים ממרחב השם הראשי בוויקיפדיה העברית,
והכנסתן/עדכונן בטבלת wikipedia_pages בסופרבייס.

תאריך יצירה (created_at) *לא* נשלף כאן: מדיה-ויקי דוחה כל ניסיון
לשלב rvdir=newer (הדרך היחידה לקבל את הגרסה הראשונה=תאריך יצירה) עם
generator/titles שמספקים כמה דפים בבת אחת - "invalidparammix", מגבלה
מוצהרת של ה-API עצמו (מאושר גם בפורום הרשמי של מדיה-ויקי: כדי לקבל
תאריך יצירה חייבים בקשה נפרדת per-title). לכן, במקום לנסות את זה על
350 אלף דפים, created_at נשלף בנפרד, ידנית, רק לכותרות ה"חסר במכלול"
(כמה אלפים) - ראו fetch_wikipedia_created_at.py.

ארכיטקטורה: בתחילת כל ריצה טרייה (לא המשך של ריצה שנעצרה) - מרוקנת
(TRUNCATE) את wikipedia_pages בלבד ואז ממלאת מחדש מאפס. הריקון עצל
(lazy) - קורה רק ממש לפני כתיבת האצווה הראשונה עם תוכן אמיתי שהתקבלה
בהצלחה מה-API, לא באופן גורף בתחילת הריצה - כך שתקלת API בבקשה
הראשונה לא נוגעת בטבלה הקיימת בכלל. חייבת לרוץ *לפני* fetch_mechalol.py
בתזמון השבועי (ראו weekly_update.yml) - truncate_wikipedia_pages()
רץ בפועל עם CASCADE (ראו schema.sql), ומפתח זר
mechalol_pages.wikipedia_id -> wikipedia_pages.id גורם ל-TRUNCATE הזה
לרוקן *לגמרי* גם את mechalol_pages (כל הטבלה, לא רק שורות עם ערך לא-NULL
בעמודה - זו התנהגות TRUNCATE...CASCADE ברמת הטבלה, לא ON DELETE CASCADE
ברמת שורה, ולכן היא לא תלויה בערכי wikipedia_id או בסדר "התיאורטי"). לכן
mechalol_pages *חייב* להתמלא רק אחרי הריקון הזה, לא לפניו - אחרת
fetch_mechalol.py ממלא אותה ואז fetch_wikipedia.py מוחק את מה שהיא
עתה מילאה. id בטבלה הוא
ה-page_id האמיתי בוויקיפדיה (לא bigserial) - יציב וזהה בכל ריצה. אין
יותר מנגנון "ניקוי דפים שנעלמו" בסוף הריצה - הריקון בתחילתה כבר עושה
את זה.

מקור הכותרות: כברירת מחדל (--source dump) הדמפ stub-meta-current של hewiki, בהורדה אחת מ-
dumps.wikimedia.org, ואחריו השלמת הפער מ-recentchanges/logevents (wikipedia_title_gap.py).
כך כמעט אין קריאות ל-API (הסריקה המלאה של allpages, ~800 בקשות רצופות, נחסמה ב-429 ב-4.10.2026).
--source api הוא ה-fallback הישן (allpages). המשך-ריצה (progress) רלוונטי רק ל-api.

שימוש (הרצה ראשונית ומלאה):
    python fetch_wikipedia.py                 # דמפ + השלמת פער
    python fetch_wikipedia.py --source api    # fallback

הסקריפט תומך בהמשכה: אם הריצה נקטעת עקב מגבלת זמן של גיטהאב אקשנס (הריגה
חיצונית של התהליך, בלי הזדמנות להגיב) - קובץ ה-progress נשאר במצבו האחרון
השמור, והרצה חוזרת ממשיכה ממנו *בלי* ריקון מחדש (אחרת היו אובדות התוצאות
שכבר נשמרו). לעומת זאת, אם מתרחשת שגיאה אמיתית בתוך הקוד עצמו (חריגה שלא
נפתרה) - קובץ ה-progress נמחק לפני שהחריגה מועלית הלאה, כדי שהריצה הבאה
תתחיל מחדש עם ריקון, ולא "תמשיך" ממצב שאולי לא אמין.
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone

import requests

from config import (
    WIKIPEDIA_API,
    BATCH_SIZE,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    API_BATCH_SIZE_TEMPLATE_CHECK,
)
from supabase_client import get_client
from table_names import table_name, rpc_name
from wiki_dump import iter_stub_titles
from wikipedia_title_gap import (
    RESOLVE_BATCH, chunks, classify_pages, gap_start, log_event_refs,
)

PROGRESS_FILE = "wikipedia_progress.json"
MAX_SUPABASE_RETRIES = 5
MAX_API_RETRIES = 8  # 429 מחכה לפי Retry-After (ראו retry_wait_seconds), לכן יותר ניסיונות מבעבר


def retry_wait_seconds(exc, attempt):
    """
    כמה לחכות לפני ניסיון חוזר. 429 (Too Many Requests) מכבד את Retry-After של השרת, ובהיעדרו ממתין 5·2^ניסיון
    עד 120 שניות; שגיאה אחרת: 2^(ניסיון-1) עד 30 שניות כמו קודם. ב-4.10.2026 הסריקה נכשלה כי חיכתה כ-15 שניות
    בסך הכול מול 429 (שורש הבעיה היה עומס הבקשות; זה ה-fallback של --source api).
    """
    response = getattr(exc, "response", None)
    if response is not None and getattr(response, "status_code", None) == 429:
        try:
            retry_after = int(response.headers.get("Retry-After", 0))
        except (TypeError, ValueError):
            retry_after = 0
        return min(retry_after, 300) if retry_after > 0 else min(120, 5 * 2 ** attempt)
    return min(2 ** (attempt - 1), 30)


def load_progress():
    """
    מחזיר טאפל: (הושלם_בעבר, נקודת_המשך)
    """
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("done", False), data.get("apcontinue")
    return False, None


def save_progress(apcontinue, done=False):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"apcontinue": apcontinue, "done": done}, f)


def fetch_all_titles(apcontinue):
    """
    ג'נרטור שמחזיר רשימות של דפים (כותרת, page_id) בעימוד, עד סיום כל
    מרחב השם הראשי.

    לא מנסה יותר לקבל תאריך יצירה כאן (ראו הערת המודול למעלה) - מדיה-
    ויקי דוחה json.get("error", {}).get("code") == "invalidparammix"
    כל ניסיון לשלב rvdir=newer עם generator/titles מרובים; זו מגבלה
    מוצהרת של ה-API עצמו, לא ניתנת לעקיפה. תאריך יצירה נשלף בנפרד,
    לכותרות ה"חסר במכלול" בלבד, על ידי fetch_wikipedia_created_at.py.
    """
    while True:
        params = {
            "action": "query",
            "list": "allpages",
            "apnamespace": 0,
            "apfilterredir": "nonredirects",  # לא כולל הפניות - רק ערכים בפועל
            "aplimit": BATCH_SIZE,
            "format": "json",
        }
        if apcontinue:
            params["apcontinue"] = apcontinue

        data = None
        for attempt in range(1, MAX_API_RETRIES + 1):
            try:
                response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=30)
                response.raise_for_status()
                data = response.json()
                # מדיה-ויקי לעיתים מחזיר HTTP 200 תקין עם {"error": ...}
                # בגוף התשובה (לא שגיאת HTTP) - בלי הבדיקה הזו, שגיאה כזו
                # "נבלעת" בשקט: pages ריק מתפרש כ"0 דפים נמצאו", התהליך
                # ממשיך וממשיך "בהצלחה" עד לריקון+מילוי-ריק של הטבלה.
                # ויקיפדיה העברית לעולם לא מחזירה בפועל 0 דפים בסריקה
                # תקינה - error בתשובה תמיד מטופל כשגיאה הניתנת לניסיון חוזר.
                if "error" in data:
                    raise RuntimeError(f"שגיאת API בגוף התשובה: {data['error']}")
                break
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                if attempt >= MAX_API_RETRIES:
                    print(f"שגיאת API | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
                    raise
                wait = retry_wait_seconds(exc, attempt)
                print(f"WARNING | שגיאת API | ניסיון {attempt}/{MAX_API_RETRIES}: {exc} | ממתין {wait}ש")
                time.sleep(wait)

        pages = data.get("query", {}).get("allpages", [])
        yield [{"title": p["title"], "id": p["pageid"]} for p in pages]

        apcontinue = data.get("continue", {}).get("apcontinue")
        save_progress(apcontinue, done=False)

        if not apcontinue:
            break

        time.sleep(REQUEST_DELAY_SECONDS)


def dedupe_batch_titles(batch):
    """
    לפעמים (ככל הנראה שינוי שם חי בוויקיפדיה בדיוק תוך כדי הסריקה) אותה
    כותרת מגיעה פעמיים באצווה אחת עם page_id שונה - זו לא התנגשות מול
    שורה קיימת בטבלה (resolve_title_collisions לא יכול לעזור פה, אין
    שום דבר "ישן" למחוק) אלא התנגשות בין שתי שורות חדשות בתוך אותה
    בקשת API עצמה. postgres לא יכול לקלוט את שתיהן יחד גם עם
    on_conflict="id", כי title ייחודי גם הוא. שומרים רק את המופע האחרון
    (העדכני יותר, לפי סדר ההופעה בתשובת ה-API).
    """
    by_title = {}
    for row in batch:
        title = row["title"]
        if title in by_title and by_title[title]["id"] != row["id"]:
            print(
                f"WARNING | כותרת כפולה באותה אצווה | '{title}' - "
                f"page_id {by_title[title]['id']} ו-{row['id']} - נשמר רק האחרון"
            )
        by_title[title] = row
    return list(by_title.values())


def find_stale_title_collisions(existing_rows, new_rows):
    """
    שורה קיימת נחשבת "מיושנת/מתנגשת" רק אם הכותרת שלה תואמת כותרת
    באצווה החדשה *וגם* ה-id (page_id) שלה שונה מה-page_id שהאצווה
    משייכת לאותה כותרת בדיוק. אם ה-id זהה - זו פשוט אותה שורה במדויק
    (עדכון רגיל, לא התנגשות) - לא נוגעים בה.
    """
    new_page_id_by_title = {row["title"]: row["id"] for row in new_rows}
    return [
        row["id"]
        for row in existing_rows
        if row["title"] in new_page_id_by_title
        and row["id"] != new_page_id_by_title[row["title"]]
    ]


def resolve_title_collisions(client, batch):
    titles = [row["title"] for row in batch]

    # פיצול לצ'אנקים - עשרות/מאות כותרות בעברית באצווה אחת חורגות
    # ממגבלת אורך URL של השרת בבקשת .in_() (כמו שכבר טופל באותה צורה
    # ב-fetch_mechalol.py/resolve_title_collisions).
    existing = []
    for i in range(0, len(titles), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = titles[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
        result = (
            client.table(table_name("wikipedia_pages"))
            .select("id, title")
            .in_("title", chunk)
            .execute()
        )
        existing.extend(result.data)

    stale_ids = find_stale_title_collisions(existing, batch)

    if stale_ids:
        # לפני מחיקה - לשחרר הפניות מ-mechalol_pages.wikipedia_id לשורות
        # המיושנות האלה (אם יש כאלה - התאמה אמיתית וקיימת שכבר בוצעה
        # דרך match.py), כדי לא ליפול על אילוץ מפתח זר. השורות המשוחררות
        # (wikipedia_id=NULL) ייבדקו מחדש אוטומטית ב-match.py בריצה הבאה.
        for i in range(0, len(stale_ids), API_BATCH_SIZE_TEMPLATE_CHECK):
            chunk = stale_ids[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
            client.table(table_name("mechalol_pages")).update({"wikipedia_id": None}).in_("wikipedia_id", chunk).execute()

        print(f"WARNING | התנגשות כותרת/id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        client.table(table_name("wikipedia_pages")).delete().in_("id", stale_ids).execute()

    return bool(stale_ids)


def _is_title_collision(exc):
    # שם האילוץ תלוי-מצב: table_name() בונה את שם הטבלה הנוכחי
    # (wikipedia_pages או wikipedia_pages_temp, לפי TARGET_TABLE_SUFFIX),
    # ו-perform_atomic_swap שומר על כך שהאילוץ ייקרא בהתאם לשם הטבלה
    # בפועל בכל swap (ראו migration_finalize_temp_pages_naming.sql).
    # בלי table_name() כאן וישירות "wikipedia_pages_title_key" קבוע,
    # זיהוי ההתנגשות היה נשבר בשקט בסבב זמני - כל שגיאת 23505 הייתה
    # נופלת לניסיון-חוזר גנרי במקום לטיפול הייעודי (resolve_title_
    # collisions).
    return getattr(exc, "code", None) == "23505" and f"{table_name('wikipedia_pages')}_title_key" in str(exc)


def upsert_batch(client, batch):
    if not batch:
        return

    batch = dedupe_batch_titles(batch)
    checked_at = datetime.now(timezone.utc).isoformat()
    rows = [
        {
            "id": row["id"],
            "title": row["title"],
            "checked_at": checked_at,
        }
        for row in batch
    ]

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table(table_name("wikipedia_pages")).upsert(rows, on_conflict="id").execute()
            return
        except Exception as exc:
            if _is_title_collision(exc) and resolve_title_collisions(client, batch):
                print("WARNING | טופלה התנגשות כותרת, מנסה שוב")
                continue

            print(f"שגיאת Supabase | ניסיון {attempt}/{MAX_SUPABASE_RETRIES}: {exc}")
            if attempt < MAX_SUPABASE_RETRIES:
                time.sleep(min(2 ** (attempt - 1), 30))
            else:
                raise


DUMP_URL = "https://dumps.wikimedia.org/hewiki/latest/hewiki-latest-stub-meta-current.xml.gz"
DUMP_BATCH = 1000
DUMP_ATTEMPTS = 3
DELETE_CHUNK = API_BATCH_SIZE_TEMPLATE_CHECK


def iter_dump_batches(url=DUMP_URL):
    """
    מחזיר (batch, newest_ts): אצוות של {"title","id"} מהדמפ, ובסוף האצווה האחרונה את ה-timestamp
    המאוחר ביותר שנראה. הורדה שנקטעה מתחילה מחדש; הכתיבה אידמפוטנטית (upsert לפי id).
    """
    from fetch_wikipedia_revisions import open_dump  # רק כאן: דורש רק requests/gzip

    last_error = None
    for attempt in range(1, DUMP_ATTEMPTS + 1):
        try:
            batch, newest = [], ""
            with open_dump(url, None) as stream:
                for page_id, title, _rev_id, timestamp in iter_stub_titles(stream):
                    batch.append({"title": title, "id": page_id})
                    if timestamp and timestamp > newest:
                        newest = timestamp
                    if len(batch) >= DUMP_BATCH:
                        yield batch, newest
                        batch = []
            yield batch, newest
            return
        except (requests.RequestException, OSError, EOFError) as exc:
            last_error = exc
            print(f"WARNING | הורדת הדמפ נקטעה (ניסיון {attempt}/{DUMP_ATTEMPTS}): {exc}")
            time.sleep(10 * attempt)
    raise RuntimeError(f"הורדת הדמפ נכשלה: {last_error}")


def collect_gap_refs(since):
    """
    מזהי דפים וכותרות שנגעו בהם מאז since: עריכות ויצירות במרחב הראשי (recentchanges)
    והעברות/מחיקות בכל מרחב שם (logevents; העברה מטיוטה או ממרחב משתמש ל"ראשי" נרשמת
    במרחב המקור, ולכן לא נתפסת ב-recentchanges של המרחב הראשי).
    """
    from fetch_wikipedia_revisions import collect_changes, wikipedia_get

    changes, edits = collect_changes(since)
    ids = set(changes)
    titles = set()
    for log_type in ("move", "delete"):
        params = {
            "action": "query", "list": "logevents", "letype": log_type,
            "leprop": "ids|title|type|details", "ledir": "newer",
            "lestart": since, "lelimit": 500,
        }
        count = 0
        while True:
            data = wikipedia_get(params)
            events = data.get("query", {}).get("logevents", [])
            count += len(events)
            event_ids, event_titles = log_event_refs(events)
            ids |= event_ids
            titles |= event_titles
            if "continue" not in data:
                break
            params.update(data["continue"])
            time.sleep(1)
        print(f"logevents | {log_type} | {count} אירועים")
    return ids, titles, edits


def resolve_current_state(ids, titles):
    """שואל את ה-API מה המצב עכשיו (prop=info), באצוות של 50. מחזיר (keep, drop_ids, drop_titles)."""
    from fetch_wikipedia_revisions import wikipedia_get

    keep, drop_ids, drop_titles = {}, set(), set()
    queries = [("pageids", [str(i) for i in sorted(ids)]), ("titles", sorted(titles))]
    for key, values in queries:
        for chunk in chunks(values, RESOLVE_BATCH):
            data = wikipedia_get({"action": "query", "prop": "info", key: "|".join(chunk)})
            kept, dropped_ids, dropped_titles = classify_pages(data.get("query", {}).get("pages", {}).values())
            for row in kept:
                keep[row["id"]] = row
            drop_ids |= dropped_ids
            drop_titles |= dropped_titles
            time.sleep(1)
    # מצב חי גובר: מזהה שנמצא חי באחת השאילתות לא נמחק
    drop_ids -= set(keep)
    return list(keep.values()), drop_ids, drop_titles


def apply_gap(client, keep, drop_ids, drop_titles):
    """מוחק מהטבלה את מה שכבר לא ערך חי, ואז כותב את הערכים החיים (upsert עם טיפול בהתנגשות כותרת)."""
    table = table_name("wikipedia_pages")
    for chunk in chunks(sorted(drop_ids), DELETE_CHUNK):
        client.table(table).delete().in_("id", chunk).execute()
    for chunk in chunks(sorted(drop_titles), DELETE_CHUNK):
        client.table(table).delete().in_("title", chunk).execute()
    for chunk in chunks(keep, DUMP_BATCH):
        upsert_batch(client, chunk)


def main_dump(url=DUMP_URL):
    client = get_client()
    print(f"START | dump | {url}")

    total, newest, truncated = 0, "", False
    for batch, newest in iter_dump_batches(url):
        if batch and not truncated:
            print(f"ריקון | מרוקן {table_name('wikipedia_pages')}...")
            client.rpc(rpc_name("truncate_wikipedia_pages")).execute()
            truncated = True
        upsert_batch(client, batch)
        total += len(batch)
        if total % (DUMP_BATCH * 50) < DUMP_BATCH:
            print(f"נטענו {total} כותרות מהדמפ עד כה")

    if total == 0:
        raise RuntimeError(
            "הדמפ לא החזיר כותרות - הטבלה לא נגעה בה (הריקון עצל). לא מסמן כהצלחה."
        )
    print(f"הדמפ נקרא | {total} כותרות | הגרסה המאוחרת בדמפ: {newest}")

    since = gap_start(newest)
    ids, titles, edits = collect_gap_refs(since)
    print(f"השלמת פער מ-{since} | {edits} עריכות | {len(ids)} מזהים | {len(titles)} כותרות לבדיקה")
    keep, drop_ids, drop_titles = resolve_current_state(ids, titles)
    apply_gap(client, keep, drop_ids, drop_titles)
    print(f"הושלם הפער | נכתבו {len(keep)} | נמחקו לפי מזהה {len(drop_ids)} ולפי כותרת {len(drop_titles)}")
    print(f"סיום. {total} כותרות מהדמפ, בתוספת השלמת פער")


def main_snapshot(path):
    """
    טוען את הכותרות מצילום שמור של reconcile.py (snapshot_io) במקום מדמפ ומהשלמת פער: הצילום כבר כולל את
    ההשלמה. כך הסנכרון השבועי והדוח רצים מול אותו צילום מקור. אותו ריקון עצל ואותה כתיבה כמו main_dump.
    """
    import snapshot_io

    snapshot = snapshot_io.load(path)
    client = get_client()
    print(f"START | snapshot | {path} | run_id={snapshot.get('run_id')} | captured_at={snapshot['wikipedia'].get('captured_at')}")
    total, truncated = 0, False
    for batch in snapshot_io.wikipedia_batches(snapshot, DUMP_BATCH):
        if batch and not truncated:
            print(f"ריקון | מרוקן {table_name('wikipedia_pages')}...")
            client.rpc(rpc_name("truncate_wikipedia_pages")).execute()
            truncated = True
        upsert_batch(client, batch)
        total += len(batch)
    if total == 0:
        raise RuntimeError("הצילום לא כולל כותרות ויקיפדיה - הטבלה לא נגעה בה. לא מסמן כהצלחה.")
    print(f"סיום. {total} כותרות מהצילום")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["dump", "api"], default="dump")
    parser.add_argument("--url", default=DUMP_URL)
    parser.add_argument("--snapshot", help="צילום שמור של reconcile.py (snapshot_*.json.gz) במקום דמפ והשלמת פער")
    args = parser.parse_args()

    if args.snapshot:
        main_snapshot(args.snapshot)
    elif args.source == "dump":
        main_dump(args.url)
    else:
        main_api()


def main_api():
    done, apcontinue = load_progress()
    is_resumed = apcontinue is not None

    if done:
        print("שליפת ויקיפדיה כבר הושלמה בעבר - מדלג. (למחוק את wikipedia_progress.json כדי לאלץ שליפה מחדש)")
        return

    client = get_client()

    # ריקון מלא (TRUNCATE) - עכשיו "עצל" (lazy): מתבצע רק ממש לפני
    # כתיבת האצווה הראשונה שבאמת מתקבלת מה-API עם תוכן, לא באופן גורף
    # בתחילת הריצה. כך אם יש תקלת API כלשהי בבקשה הראשונה עצמה (רשת,
    # חסימה, שגיאה בגוף התשובה) - הריצה נכשלת *לפני* שנוגעים בטבלה
    # הקיימת בכלל, והנתונים הישנים נשארים שלמים. הריקון הזה, בגלל
    # CASCADE, מרוקן בפועל *גם* את mechalol_pages (ראו
    # truncate_wikipedia_pages() ב-DB, ותיעוד הסדר הנדרש מול
    # fetch_mechalol.py בהערת המודול למעלה) - חייב לרוץ *לפני*
    # fetch_mechalol.py כדי שמכלול יתמלא אחרי הריקון, לא לפניו.
    # בהמשך ריצה שנעצרה (is_resumed) - הריקון כבר קרה בריצה הקודמת
    # שהצליחה לקבל לפחות אצווה אחת; לא מרוקנים שוב.
    truncated = is_resumed
    if is_resumed:
        print("ריקון | דולג - זו המשך ריצה שהתחילה בתהליך קודם")

    total = 0

    try:
        for batch in fetch_all_titles(apcontinue):
            if batch and not truncated:
                # בסבב זמני (TARGET_TABLE_SUFFIX=_temp), rpc_name ממפה
                # לפונקציה truncate_temp_pages - מרוקנת את שתי הטבלאות
                # הזמניות יחד, כרשת ביטחון (הן כבר אמורות להיות ריקות
                # מסוף הסבב הקודם, אחרי truncate_temp_pages.py בסיום
                # אותו סבב). בריצה הרגילה (בלי סיומת) מוחזר השם המקורי
                # ללא שינוי בהתנהגות.
                print(f"ריקון | מרוקן {table_name('wikipedia_pages')}...")
                client.rpc(rpc_name("truncate_wikipedia_pages")).execute()
                truncated = True
            upsert_batch(client, batch)
            total += len(batch)
            print(f"נטענו {total} כותרות עד כה")
    except Exception:
        print("שגיאה אמיתית באמצע הריצה - מוחק את קובץ ההתקדמות כדי שהריצה הבאה תתחיל מחדש עם ריקון")
        if os.path.exists(PROGRESS_FILE):
            os.remove(PROGRESS_FILE)
        raise

    # רשת הגנה אחרונה: ריצה תקינה על ויקיפדיה העברית לעולם לא מסתיימת
    # ב-0 כותרות. אם זה קורה בכל זאת - כנראה שגיאת API/חסימה לא-ודאית
    # לא נתפסה כראוי. עדיף להיכשל בקול (exit code שונה מ-0) מאשר לסמן
    # "done" בשקט. הודות לריקון העצל למעלה, המקרה הזה כבר לא כרוך
    # באובדן נתונים - הטבלה כלל לא נגעו בה אם total==0.
    if not is_resumed and total == 0:
        if os.path.exists(PROGRESS_FILE):
            os.remove(PROGRESS_FILE)
        raise RuntimeError(
            "הריצה הסתיימה עם 0 כותרות מוויקיפדיה העברית - כנראה תקלת "
            "API/חסימה. הטבלה לא נגעה בה (הריקון עצל ומתבצע רק לפני "
            "אצווה ראשונה עם תוכן) - לא מסמן כהצלחה."
        )

    save_progress(None, done=True)
    print(f"סיום. סה\"כ {total} כותרות נטענו מוויקיפדיה העברית")


if __name__ == "__main__":
    main()
