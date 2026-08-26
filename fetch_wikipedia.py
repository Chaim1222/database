"""
שליפת כל כותרות הערכים ממרחב השם הראשי בוויקיפדיה העברית,
והכנסתן/עדכונן בטבלת wikipedia_pages בסופרבייס.

ארכיטקטורה: בתחילת כל ריצה טרייה (לא המשך של ריצה שנעצרה) - מרוקנת
(TRUNCATE) את wikipedia_pages בלבד ואז ממלאת מחדש מאפס. הריקון עצל
(lazy) - קורה רק ממש לפני כתיבת האצווה הראשונה עם תוכן אמיתי שהתקבלה
בהצלחה מה-API, לא באופן גורף בתחילת הריצה - כך שתקלת API בבקשה
הראשונה לא נוגעת בטבלה הקיימת בכלל. חייבת לרוץ *אחרי* fetch_mechalol.py
בתזמון השבועי (ראו weekly_update.yml) - מפתח זר
mechalol_pages.wikipedia_id -> wikipedia_pages.id, וריקון wikipedia_pages
דורש שכל ה-wikipedia_id ב-mechalol_pages כבר NULL (מובטח מיד אחרי ריקון
+מילוי טרי של mechalol_pages, לפני ש-match.py הריץ). id בטבלה הוא
ה-page_id האמיתי בוויקיפדיה (לא bigserial) - יציב וזהה בכל ריצה. אין
יותר מנגנון "ניקוי דפים שנעלמו" בסוף הריצה - הריקון בתחילתה כבר עושה
את זה.

שימוש (הרצה ראשונית ומלאה):
    python fetch_wikipedia.py

הסקריפט תומך בהמשכה: אם הריצה נקטעת עקב מגבלת זמן של גיטהאב אקשנס (הריגה
חיצונית של התהליך, בלי הזדמנות להגיב) - קובץ ה-progress נשאר במצבו האחרון
השמור, והרצה חוזרת ממשיכה ממנו *בלי* ריקון מחדש (אחרת היו אובדות התוצאות
שכבר נשמרו). לעומת זאת, אם מתרחשת שגיאה אמיתית בתוך הקוד עצמו (חריגה שלא
נפתרה) - קובץ ה-progress נמחק לפני שהחריגה מועלית הלאה, כדי שהריצה הבאה
תתחיל מחדש עם ריקון, ולא "תמשיך" ממצב שאולי לא אמין.
"""

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

PROGRESS_FILE = "wikipedia_progress.json"
MAX_SUPABASE_RETRIES = 5
MAX_API_RETRIES = 5


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
    ג'נרטור שמחזיר רשימות של דפים (כותרת, page_id, תאריך יצירה) בעימוד,
    עד סיום כל מרחב השם הראשי.

    משתמש ב-generator=allpages (במקום list=allpages) יחד עם
    prop=revisions&rvlimit=1&rvdir=newer כדי לקבל את חותמת הזמן של
    הגרסה הראשונה (=תאריך היצירה) לכל דף באותה בקשה בדיוק - בלי סבב
    בקשות נפרד. gapcontinue מחליף את apcontinue כמנגנון העימוד
    (שם אחר לגמרי בתשובת ה-API כשעובדים עם generator).
    """
    while True:
        params = {
            "action": "query",
            "generator": "allpages",
            "gapnamespace": 0,
            "gapfilterredir": "nonredirects",  # לא כולל הפניות - רק ערכים בפועל
            "gaplimit": BATCH_SIZE,
            "prop": "revisions",
            "rvprop": "timestamp",
            "rvlimit": 1,
            "rvdir": "newer",  # הגרסה הראשונה = תאריך היצירה
            "format": "json",
        }
        if apcontinue:
            params["gapcontinue"] = apcontinue

        data = None
        for attempt in range(1, MAX_API_RETRIES + 1):
            try:
                response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=30)
                response.raise_for_status()
                data = response.json()
                # מדיה-ויקי לעיתים מחזיר HTTP 200 תקין עם {"error": ...}
                # בגוף התשובה (לא שגיאת HTTP) - בלי הבדיקה הזו, שגיאה כזו
                # "נבלעת" בשקט: pages ריק מתפרש כ"0 דפים נמצאו", התהליך
                # ממשיך וממשיך "בהצלחה" עד לריקון+מילוי-ריק של הטבלאות.
                # ויקיפדיה העברית לעולם לא מחזירה בפועל 0 דפים בסריקה
                # תקינה - error בתשובה תמיד מטופל כשגיאה הניתנת לניסיון חוזר.
                if "error" in data:
                    raise RuntimeError(f"שגיאת API בגוף התשובה: {data['error']}")
                break
            except (requests.RequestException, ValueError, RuntimeError) as exc:
                if attempt >= MAX_API_RETRIES:
                    print(f"שגיאת API | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
                    raise
                print(f"WARNING | שגיאת API | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
                time.sleep(min(2 ** (attempt - 1), 30))

        # עם generator, הדפים מגיעים כ-dict לפי page_id (לא רשימה כמו
        # עם list=allpages) - סדר לא מובטח, לא משנה לצרכינו.
        pages = data.get("query", {}).get("pages", {})
        batch = []
        for page in pages.values():
            if "pageid" not in page or "title" not in page:
                continue
            revisions = page.get("revisions") or []
            created_at = revisions[0]["timestamp"] if revisions else None
            batch.append({"title": page["title"], "id": page["pageid"], "created_at": created_at})
        yield batch

        apcontinue = data.get("continue", {}).get("gapcontinue")
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
            client.table("wikipedia_pages")
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
            client.table("mechalol_pages").update({"wikipedia_id": None}).in_("wikipedia_id", chunk).execute()

        print(f"WARNING | התנגשות כותרת/id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        client.table("wikipedia_pages").delete().in_("id", stale_ids).execute()

    return bool(stale_ids)


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "wikipedia_pages_title_key" in str(exc)


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
            "created_at": row["created_at"],
        }
        for row in batch
    ]

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table("wikipedia_pages").upsert(rows, on_conflict="id").execute()
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


def main():
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
    # הקיימת בכלל, והנתונים הישנים נשארים שלמים. מרוקן רק את
    # wikipedia_pages - לא נוגע ב-mechalol_pages בכלל (ראו
    # truncate_wikipedia_pages() ב-DB, ותיעוד הסדר הנדרש מול
    # fetch_mechalol.py בהערת המודול למעלה).
    # בהמשך ריצה שנעצרה (is_resumed) - הריקון כבר קרה בריצה הקודמת
    # שהצליחה לקבל לפחות אצווה אחת; לא מרוקנים שוב.
    truncated = is_resumed
    if is_resumed:
        print("ריקון | דולג - זו המשך ריצה שהתחילה בתהליך קודם")

    total = 0

    try:
        for batch in fetch_all_titles(apcontinue):
            if batch and not truncated:
                print("ריקון | מרוקן wikipedia_pages...")
                client.rpc("truncate_wikipedia_pages").execute()
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
