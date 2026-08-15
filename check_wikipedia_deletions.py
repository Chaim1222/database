"""
בדיקה שוטפת של יומן המחיקות וההעברות-למרחב-אחר בוויקיפדיה העברית, מאז הבדיקה הקודמת.

לכל כותרת שנמחקה או הועברה החוצה ממרחב הערכים הראשי:
- מוצאים קודם את שורת wikipedia_pages שלה (אם קיימת) כדי לאתר גם שורות
  מכלול שהותאמו אליה דרך wikipedia_id (נרמול/תבנית מיון - כותרת המכלול
  אינה זהה בהכרח לכותרת שנמחקה בוויקיפדיה). כגיבוי, מתאימים גם לפי
  כותרת מדויקת בטבלת mechalol_pages (מקרה שבו אין עדיין wikipedia_id).
- לכל שורת מכלול שנמצאה כך ושסטטוסה מעיד על ייבוא אמיתי מוויקיפדיה
  (לא WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES - ראו config.py) ->
  מסומן דגל deleted_from_wikipedia = true (עובדה ודאית מהיומן, לא ניחוש). לא נמחק שום דבר.
- אם אין אף שורת מכלול תואמת (לא דרך wikipedia_id, לא דרך כותרת) ->
  שורת wikipedia_pages המתאימה נמחקת (אין טעם להמשיך לעקוב אחרי כותרת
  שלא רלוונטית לאף ערך אצלנו). אם יש שורת מכלול תואמת, השורה לא נמחקת -
  גם כדי לשמר עדות לחקירה, וגם כי אילוץ מפתח זר ימנע זאת בכל מקרה כל
  עוד wikipedia_id מצביע אליה.

שימוש:
    python check_wikipedia_deletions.py
"""

import json
import os
from datetime import datetime, timedelta, timezone

import requests

from config import (
    WIKIPEDIA_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES,
)
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
    response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=30)
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
        # מוצאים קודם את שורת wikipedia_pages (אם עדיין קיימת בטבלה),
        # כדי שאפשר יהיה להתאים גם לפי wikipedia_id - לא רק לפי כותרת
        # מדויקת - שכן שורת מכלול יכולה להיות מותאמת עם כותרת שונה
        # (נרמול סמנטי או תבנית מיון).
        wp_result = (
            client.table("wikipedia_pages")
            .select("id")
            .eq("title", title)
            .execute()
        )
        wp_rows = wp_result.data
        wikipedia_id = wp_rows[0]["id"] if wp_rows else None

        matched_rows = {}

        if wikipedia_id is not None:
            by_id_result = (
                client.table("mechalol_pages")
                .select("id, status")
                .eq("wikipedia_id", wikipedia_id)
                .execute()
            )
            for row in by_id_result.data or []:
                matched_rows[row["id"]] = row

        # גיבוי: התאמה לפי כותרת מדויקת - תופס גם שורות שעדיין לא עברו
        # match.py כלל (wikipedia_id ריק אך הכותרת זהה במקרה).
        by_title_result = (
            client.table("mechalol_pages")
            .select("id, status")
            .eq("title", title)
            .execute()
        )
        for row in by_title_result.data or []:
            matched_rows.setdefault(row["id"], row)

        for row in matched_rows.values():
            if row["status"] not in WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES:
                client.table("mechalol_pages").update(
                    {"deleted_from_wikipedia": True}
                ).eq("id", row["id"]).execute()
                flagged += 1

        if wikipedia_id is not None and not matched_rows:
            client.table("wikipedia_pages").delete().eq("id", wikipedia_id).execute()
            removed += 1

    save_last_checked(now_iso)
    print(f"סיום. סומנו {flagged} ערכים במכלול, הוסרו {removed} שורות מיותרות מטבלת ויקיפדיה")


if __name__ == "__main__":
    main()
