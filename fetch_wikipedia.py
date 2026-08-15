"""
שליפת כל כותרות הערכים ממרחב השם הראשי בוויקיפדיה העברית,
והכנסתן/עדכונן בטבלת wikipedia_pages בסופרבייס.

שימוש (הרצה ראשונית ומלאה):
    python fetch_wikipedia.py

הסקריפט תומך בהמשכה: אם הריצה נקטעת (למשל בגלל מגבלת זמן של גיטהאב אקשנס),
הרצה חוזרת תמשיך מנקודת ההמשך האחרונה שנשמרה בקובץ progress.
"""

import json
import os
import time

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


def find_stale_title_collisions(existing_rows, new_rows):
    """
    שורות קיימות ב-wikipedia_pages שהכותרת שלהן מתנגשת עם אחת הכותרות
    באצווה החדשה, אבל ה-page_id שלהן שונה מכל page_id באצווה - כלומר
    זו שורה ישנה/מיושנת (page_id אחר, אולי כבר נמחק בוויקיפדיה) שתפסה
    את הכותרת לפני שהיא שוחררה. קורה למשל כשדף מועבר לכותרת שהייתה
    שייכת לדף אחר שנמחק, לפני ש-check_wikipedia_deletions.py הספיק
    לנקות את השורה הישנה.
    """
    new_page_ids = {page_id for _, page_id in new_rows}
    return [row["id"] for row in existing_rows if row["page_id"] not in new_page_ids]


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
        print(f"WARNING | התנגשות כותרת/page_id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        client.table("wikipedia_pages").delete().in_("id", stale_ids).execute()

    return bool(stale_ids)


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "wikipedia_pages_title_key" in str(exc)


def upsert_batch(client, batch):
    if not batch:
        return

    rows = [{"title": title, "page_id": page_id} for title, page_id in batch]

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


def main():
    done, apcontinue = load_progress()

    if done:
        print("שליפת ויקיפדיה כבר הושלמה בעבר - מדלג. (למחוק את wikipedia_progress.json כדי לאלץ שליפה מחדש)")
        return

    client = get_client()
    total = 0

    for batch in fetch_all_titles(apcontinue):
        upsert_batch(client, batch)
        total += len(batch)
        print(f"נטענו {total} כותרות עד כה")

    save_progress(None, done=True)
    print(f"סיום. סה\"כ {total} כותרות נטענו מוויקיפדיה העברית")


if __name__ == "__main__":
    main()
