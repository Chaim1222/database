"""
תשתית משותפת לקריאות API מול המכלול: session עם User-Agent, לוג
אחיד, ומנגנון ניסיון-חוזר על שגיאת רשת/שרת. בשימוש על ידי match.py
(בדיקת {{מיון ויקיפדיה}}) ועל ידי check_missing_locked.py (בדיקת
רמת נעילה של כותרות "חסרות").
"""

import time
from datetime import datetime, timezone

import requests

from config import (
    MECHALOL_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    API_BATCH_SIZE_TEMPLATE_CHECK,
)

MAX_RETRIES = 5
RETRY_DELAY = 3

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{now}] {message}", flush=True)


def api_get_with_retry(params, description):
    """
    בקשת GET מול API המכלול, עם ניסיון חוזר על שגיאת רשת/שרת (עד
    MAX_RETRIES ניסיונות, השהיה קבועה RETRY_DELAY בין ניסיונות).
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = session.get(MECHALOL_API, params=params, timeout=(15, 60))
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt >= MAX_RETRIES:
                log(f"ERROR | {description} | נכשל אחרי {MAX_RETRIES}: {exc}")
                raise
            log(f"WARNING | {description} | ניסיון {attempt}/{MAX_RETRIES}: {exc}")
            time.sleep(RETRY_DELAY)


# ---------------------------------------------------------------------------
# בדיקת רמת נעילה - prop=info&inprop=allevel
# ---------------------------------------------------------------------------

def fetch_page_lock_info(titles=None, pageids=None):
    """
    שולף לכל דף: רמת הנעילה (allevel), האם קיים בפועל (missing), ואם
    קיים - גם page_id. שאילתת מטא-נתונים בלבד (לא תוכן) - לכן אפשר
    לשלוח יחד גם דפים נעולים וגם פתוחים באותה בקשה, בלי כישלון של
    הבקשה כולה (בשונה משליפת תוכן, כמו fetch_template_titles ב-match.py,
    ששם דף נעול-לקריאה בודד גורם לדחיית כל האצווה).

    יש להעביר בדיוק אחד מהשניים:
    - titles: כשלא ידוע page_id מראש (למשל בדיקת כותרות "חסרות" -
      עדיין לא ידוע אם קיימות במכלול בכלל).
    - pageids: כש-page_id כבר ידוע (למשל בדיקה חוזרת של דף שכבר תועד
      קודם עם allevel="read", שם יש page_id אמיתי). מחרוזת מספרים
      קצרה משמעותית מכותרות בעברית - מאפשר אצוות גדולות יותר לכל
      בקשה. *לא רלוונטי* לדפים שעשויים להיות נעולים-ליצירה
      (allevel="create") - לדפים כאלה אין page_id בכלל, כי הם לא
      קיימים, אז אי אפשר לבדוק אותם לפי pageids מלכתחילה.

    מחזיר: {title: {"allevel": str, "missing": bool, "pageid": int|None}}
    (המפתח הוא תמיד title, גם כשהבדיקה נשלחה לפי pageids - כדי שהתשובה
    תהיה אחידה לקוראים משני המצבים).
    """
    if (titles is None) == (pageids is None):
        raise ValueError("יש להעביר בדיוק אחד מ-titles/pageids")

    items = titles if titles is not None else pageids
    param_name = "titles" if titles is not None else "pageids"

    result = {}

    for i in range(0, len(items), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = items[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]
        batch_number = i // API_BATCH_SIZE_TEMPLATE_CHECK + 1

        params = {
            "action": "query",
            "prop": "info",
            "inprop": "allevel",
            param_name: "|".join(str(x) for x in chunk),
            "formatversion": "2",
            "format": "json",
        }

        data = api_get_with_retry(params, f"בדיקת נעילה | אצווה {batch_number}")

        for page in data.get("query", {}).get("pages", []):
            title = page.get("title")
            if not title:
                continue
            result[title] = {
                "allevel": page.get("allevel", "none"),
                "missing": bool(page.get("missing", False)),
                "pageid": page.get("pageid"),
            }

        locked_count = sum(1 for v in result.values() if v["allevel"] != "none")
        log(f"נעילה API | אצווה {batch_number} | {len(chunk)} נבדקו | {locked_count} נעולות עד כה")

        if REQUEST_DELAY_SECONDS:
            time.sleep(REQUEST_DELAY_SECONDS)

    return result


def classify_lock_level(info):
    """
    מסווג את info (כפי שמוחזר מ-fetch_page_lock_info) לפי allevel
    במפורש - לא "יש נעילה/אין נעילה" כללי, כדי שרמת נעילה לא-מוכרת
    לעולם לא תסווג אוטומטית בטעות לתוך רשימה שחורה או manual_matches.

    מחזיר אחת מ:
    - "open" - allevel="none", אין נעילה.
    - "create_locked" - allevel="create", הדף לא קיים ולא ניתן ליצור
      אותו - מועמד לרשימה השחורה.
    - "read_locked" - allevel="read", הדף קיים (יש page_id) - מועמד
      ל-manual_matches.
    - "unknown" - כל רמה אחרת שלא זוהתה מפורשות - לא מטופל אוטומטית,
      דורש בדיקה ידנית.
    """
    allevel = info["allevel"]

    if allevel == "none":
        return "open"
    if allevel == "create":
        return "create_locked"
    if allevel == "read":
        return "read_locked"
    return "unknown"
