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

from config import WIKIPEDIA_API, BATCH_SIZE, REQUEST_DELAY_SECONDS, REQUEST_HEADERS
from supabase_client import get_client

PROGRESS_FILE = "wikipedia_progress.json"


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


def upsert_batch(client, batch):
    if not batch:
        return
    rows = [{"title": title, "page_id": page_id} for title, page_id in batch]
    client.table("wikipedia_pages").upsert(rows, on_conflict="page_id").execute()


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
