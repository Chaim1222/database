"""
בדיקה שוטפת של יומן המחיקות וההעברות-למרחב-אחר בוויקיפדיה העברית, מאז הבדיקה הקודמת.

לכל כותרת שנמחקה או הועברה החוצה ממרחב הערכים הראשי:
- אם קיים ערך תואם במכלול שסטטוסו "מיובא" (לא "נוצר_במכלול") ->
  מסומן דגל נמחק_בוויקיפדיה = true (עובדה ודאית מהיומן, לא ניחוש). לא נמחק שום דבר.
- אם אין ערך תואם במכלול -> השורה המתאימה נמחקת מטבלת wikipedia_pages בלבד
  (אין טעם להמשיך לעקוב אחרי כותרת שלא רלוונטית לאף ערך אצלנו).

שימוש:
    python check_wikipedia_deletions.py
"""

import json
import os
from datetime import datetime, timedelta, timezone

import requests

from config import WIKIPEDIA_API, REQUEST_DELAY_SECONDS
from supabase_client import get_client
import time

PROGRESS_FILE = "deletion_check_progress.json"

# בהרצה הראשונה (אין קובץ התקדמות) - כמה אחורה לבדוק
DEFAULT_LOOKBACK_DAYS = 14


def load_last_checked():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)["last_checked"]
    fallback = datetime.now(timezone.utc) - timedelta(days=DEFAULT_LOOKBACK_DAYS)
    return fallback.strftime("%Y-%m-%dT%H:%M:%SZ")


def save_last_checked(timestamp_iso):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"last_checked": timestamp_iso}, f)


def api_get(params):
    params = {**params, "format": "json"}
    response = requests.get(WIKIPEDIA_API, params=params, timeout=30)
    response.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    return response.json()


def get_deleted_titles(since_iso):
    """
    כותרות שנמחקו ממרחב הערכים הראשי מאז since_iso.
    """
    titles = set()
    lecontinue = None
    while True:
        params = {
            "action": "query",
            "list": "logevents",
            "letype": "delete",
            "lenamespace": 0,
            "leprop": "title|timestamp",
            "ledir": "newer",
            "lestart": since_iso,
            "lelimit": 500,
        }
        if lecontinue:
            params["lecontinue"] = lecontinue

        data = api_get(params)
        for event in data.get("query", {}).get("logevents", []):
            if "title" in event:
                titles.add(event["title"])

        lecontinue = data.get("continue", {}).get("lecontinue")
        if not lecontinue:
            break

    return titles


def get_moved_away_titles(since_iso):
    """
    כותרות שהיו במרחב הערכים הראשי והועברו למרחב שם אחר, מאז since_iso.
    העברות בתוך מרחב הערכים הראשי (שינוי שם רגיל) לא נספרות.
    """
    titles = set()
    lecontinue = None
    while True:
        params = {
            "action": "query",
            "list": "logevents",
            "letype": "move",
            "lenamespace": 0,
            "leprop": "title|timestamp|details",
            "ledir": "newer",
            "lestart": since_iso,
            "lelimit": 500,
        }
        if lecontinue:
            params["lecontinue"] = lecontinue

        data = api_get(params)
        for event in data.get("query", {}).get("logevents", []):
            target_ns = event.get("params", {}).get("target_ns")
            if "title" in event and target_ns is not None and target_ns != 0:
                titles.add(event["title"])

        lecontinue = data.get("continue", {}).get("lecontinue")
        if not lecontinue:
            break

    return titles


def main():
    client = get_client()
    last_checked = load_last_checked()
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    print(f"בודק שינויים מאז {last_checked}")

    gone_titles = get_deleted_titles(last_checked) | get_moved_away_titles(last_checked)
    print(f"נמצאו {len(gone_titles)} כותרות שנמחקו/הועברו")

    flagged = 0
    removed = 0

    for title in gone_titles:
        result = (
            client.table("mechalol_pages")
            .select("id, status")
            .eq("title", title)
            .execute()
        )
        rows = result.data

        if rows:
            row = rows[0]
            if row["status"] != "נוצר_במכלול":
                client.table("mechalol_pages").update(
                    {"נמחק_בוויקיפדיה": True}
                ).eq("id", row["id"]).execute()
                flagged += 1
        else:
            client.table("wikipedia_pages").delete().eq("title", title).execute()
            removed += 1

    save_last_checked(now_iso)
    print(f"סיום. סומנו {flagged} ערכים במכלול, הוסרו {removed} שורות מיותרות מטבלת ויקיפדיה")


if __name__ == "__main__":
    main()
