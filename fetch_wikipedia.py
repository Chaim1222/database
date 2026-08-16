"""
שליפת כל כותרות הערכים ממרחב השם הראשי בוויקיפדיה העברית,
והכנסתן/עדכונן בטבלת wikipedia_pages בסופרבייס.

בסוף כל סריקה מלאה ורצופה (לא המשך של initial_run שנעצר) - מנקה גם
שורות wikipedia_pages שה-page_id שלהן לא נצפה בסריקה הנוכחית (הדף כבר
לא קיים במרחב הראשי, מכל סיבה שהיא - מחיקה, העברה למרחב אחר, וכו').
זו השוואת מצב-מול-מצב פשוטה, במקום פענוח יומן אירועים (הגישה הקודמת,
ב-check_wikipedia_deletions.py, שהוסר) - לא מעניין אותנו *מה* קרה
ו*מתי*, רק מה המצב הנוכחי לעומת מה שהיה. מקביל בדיוק ל-
cleanup_deleted_from_mechalol ב-fetch_mechalol.py.

שימוש (הרצה ראשונית ומלאה):
    python fetch_wikipedia.py

הסקריפט תומך בהמשכה: אם הריצה נקטעת (למשל בגלל מגבלת זמן של גיטהאב אקשנס),
הרצה חוזרת תמשיך מנקודת ההמשך האחרונה שנשמרה בקובץ progress.
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
    WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES,
)
from supabase_client import get_client

PROGRESS_FILE = "wikipedia_progress.json"
MAX_SUPABASE_RETRIES = 5


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
    ג'נרטור שמחזיר רשימות של (כותרת, מזהה_עמוד) בעימוד, עד סיום כל מרחב השם הראשי.
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

        response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=30)
        response.raise_for_status()
        data = response.json()

        pages = data.get("query", {}).get("allpages", [])
        yield [(p["title"], p["pageid"]) for p in pages]

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
    on_conflict="page_id", כי title ייחודי גם הוא. שומרים רק את
    המופע האחרון (העדכני יותר, לפי סדר ההופעה בתשובת ה-API).
    """
    by_title = {}
    for title, page_id in batch:
        if title in by_title and by_title[title] != page_id:
            print(
                f"WARNING | כותרת כפולה באותה אצווה | '{title}' - "
                f"page_id {by_title[title]} ו-{page_id} - נשמר רק האחרון"
            )
        by_title[title] = page_id
    return list(by_title.items())


def find_stale_title_collisions(existing_rows, new_rows):
    """
    שורה קיימת נחשבת "מיושנת/מתנגשת" רק אם הכותרת שלה תואמת כותרת
    באצווה החדשה *וגם* ה-page_id שלה שונה מה-page_id שהאצווה משייכת
    לאותה כותרת בדיוק. אם page_id זהה - זו פשוט אותה שורה במדויק (עדכון
    רגיל, לא התנגשות) - לא נוגעים בה. הגרסה הקודמת מחקה כל שורה שהכותרת
    שלה תאמה, גם אם page_id זהה, מה שגרם למחיקת שורות תקינות בטעות -
    כולל שורות שמכלול_pages מקושר אליהן, וקרס על אילוץ מפתח זר.
    """
    new_page_id_by_title = dict(new_rows)
    return [
        row["id"]
        for row in existing_rows
        if row["title"] in new_page_id_by_title
        and row["page_id"] != new_page_id_by_title[row["title"]]
    ]


def resolve_title_collisions(client, batch):
    titles = [title for title, _ in batch]

    # פיצול לצ'אנקים - עשרות/מאות כותרות בעברית באצווה אחת חורגות
    # ממגבלת אורך URL של השרת בבקשת .in_() (כמו שכבר טופל באותה צורה
    # ב-fetch_mechalol.py/resolve_title_collisions).
    existing = []
    for i in range(0, len(titles), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = titles[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
        result = (
            client.table("wikipedia_pages")
            .select("id, title, page_id")
            .in_("title", chunk)
            .execute()
        )
        existing.extend(result.data)

    stale_ids = find_stale_title_collisions(existing, batch)

    if stale_ids:
        # לפני מחיקה - לשחרר הפניות מ-mechalol_pages.wikipedia_id לשורות
        # המיושנות האלה (אם יש כאלה - התאמה אמיתית וקיימת שכבר בוצעה
        # דרך match.py), כדי לא ליפול על אילוץ מפתח זר. השורות המשוחררות
        # (wikipedia_id=NULL) ייבדקו מחדש אוטומטית ב-match.py בריצה
        # הבאה, בזכות should_reexamine.
        for i in range(0, len(stale_ids), API_BATCH_SIZE_TEMPLATE_CHECK):
            chunk = stale_ids[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
            client.table("mechalol_pages").update({"wikipedia_id": None}).in_("wikipedia_id", chunk).execute()

        print(f"WARNING | התנגשות כותרת/page_id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
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
        {"title": title, "page_id": page_id, "checked_at": checked_at}
        for title, page_id in batch
    ]

    for attempt in range(1, MAX_SUPABASE_RETRIES + 1):
        try:
            client.table("wikipedia_pages").upsert(rows, on_conflict="page_id").execute()
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


def get_existing_page_ids(client):
    """שולף (id, page_id) עבור כל השורות הקיימות כרגע ב-wikipedia_pages, בעימוד."""
    pairs = []
    last_id = 0

    while True:
        result = (
            client.table("wikipedia_pages")
            .select("id, page_id")
            .gt("id", last_id)
            .order("id")
            .limit(BATCH_SIZE)
            .execute()
        )
        rows = result.data or []
        if not rows:
            break

        pairs.extend((row["page_id"], row["id"]) for row in rows)
        last_id = rows[-1]["id"]

        if len(rows) < BATCH_SIZE:
            break

    return pairs


def cleanup_stale_wikipedia_pages(client, seen_page_ids):
    """
    מוחק שורות wikipedia_pages שה-page_id שלהן לא הופיע בסריקה המלאה
    הנוכחית - הדף כבר לא קיים במרחב הראשי (מכל סיבה: מחיקה, העברה
    למרחב אחר, וכו' - לא מעניין אותנו מה בדיוק, רק שהוא לא שם היום).

    לפני מחיקת כל שורה כזו - משחררים קודם הפניות אליה מ-
    mechalol_pages.wikipedia_id (אם ישנן - התאמה אמיתית שקיימת),
    ומסמנים deleted_from_wikipedia=true על השורות ששוחררו (רק אם ה-
    status שלהן מעיד על ייבוא אמיתי - לא WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES).
    זה מונע קריסה על אילוץ מפתח זר, ומאפשר בדיקה מחדש אוטומטית ב-match.py
    אם הערך ייווצר מחדש בעתיד (ראו should_reexamine).
    """
    existing = get_existing_page_ids(client)
    stale_ids = [row_id for page_id, row_id in existing if page_id not in seen_page_ids]

    if not stale_ids:
        print("ניקוי | לא נמצאו שורות שנעלמו מוויקיפדיה")
        return 0

    print(f"ניקוי | {len(stale_ids):,} שורות עם page_id שלא נמצא בסריקה הנוכחית")

    for i in range(0, len(stale_ids), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = stale_ids[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]

        referencing = (
            client.table("mechalol_pages")
            .select("id, status")
            .in_("wikipedia_id", chunk)
            .execute()
        )
        to_flag = [
            row["id"] for row in (referencing.data or [])
            if row["status"] not in WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES
        ]
        to_release_only = [
            row["id"] for row in (referencing.data or [])
            if row["status"] in WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES
        ]

        if to_flag:
            client.table("mechalol_pages").update(
                {"deleted_from_wikipedia": True, "wikipedia_id": None}
            ).in_("id", to_flag).execute()
        if to_release_only:
            client.table("mechalol_pages").update(
                {"wikipedia_id": None}
            ).in_("id", to_release_only).execute()

        client.table("wikipedia_pages").delete().in_("id", chunk).execute()

    return len(stale_ids)


def main():
    done, apcontinue = load_progress()
    is_resumed = apcontinue is not None

    if done:
        print("שליפת ויקיפדיה כבר הושלמה בעבר - מדלג. (למחוק את wikipedia_progress.json כדי לאלץ שליפה מחדש)")
        return

    client = get_client()
    total = 0
    seen_page_ids = set()

    for batch in fetch_all_titles(apcontinue):
        seen_page_ids.update(page_id for _, page_id in batch)
        upsert_batch(client, batch)
        total += len(batch)
        print(f"נטענו {total} כותרות עד כה")

    save_progress(None, done=True)
    print(f"סיום. סה\"כ {total} כותרות נטענו מוויקיפדיה העברית")

    # ניקוי דפים שנעלמו מוויקיפדיה - רק אם הסריקה בוצעה ברצף אחד בתהליך
    # הזה (לא המשך של initial_run שנעצר), כי אחרת seen_page_ids לא
    # מכיל את הכותרות שכבר נסרקו בתהליכים קודמים ותהיה מחיקה שגויה.
    if is_resumed:
        print("ניקוי | דולג - זו המשך ריצה שהתחילה בתהליך קודם (seen_page_ids חלקי)")
    else:
        removed = cleanup_stale_wikipedia_pages(client, seen_page_ids)
        print(f"ניקוי | הוסרו {removed:,} שורות שלא קיימות עוד בוויקיפדיה")


if __name__ == "__main__":
    main()
