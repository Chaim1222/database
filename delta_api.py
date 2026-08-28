"""
תשתית משותפת לשליפת דלתא ממדיה-ויקי (recentchanges/logevents), בשימוש
משותף על ידי fetch_wikipedia_delta.py ו-fetch_mechalol_delta.py - ההבדל
היחיד בין שני האתרים הוא כתובת ה-API; מבנה התשובות זהה (שניהם מדיה-ויקי).

מעמד אימות (חשוב לקרוא לפני שינוי): השדות הבאים אומתו בפועל מול ה-API
האמיתי של המכלול בבדיקת ההיתכנות (ראו סיכום התכנון) - pageid, old_revid,
timestamp ב-recentchanges; השם params (לא logparams הישן) ב-logevents;
ה-action "move" מול "move_redir"; suppressredirect; ודפוס pageid=0
כשלא נשאר דבר בכותרת הישנה. לעומת זאת, שמות המפתחות המדויקים בתוך
params של אירוע move (target_title/target_ns כאן למטה) *לא* אומתו
בבדיקה החיה - הם לפי תיעוד ה-API הרשמי הסטנדרטי של מדיה-ויקי, ולא
נבדקו ישירות מול המכלול. מומלץ לאמת מדגם אמיתי (הרצת fetch_move_log
עם start_ts קרוב ולוג הדפסה גולמי) לפני ריצת ייצור ראשונה.
"""

import time

import requests

from config import REQUEST_HEADERS

MAX_API_RETRIES = 5


def _api_get_with_retry(api_url, params, description):
    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            response = requests.get(api_url, params=params, headers=REQUEST_HEADERS, timeout=30)
            response.raise_for_status()
            data = response.json()
            # כמו ב-fetch_wikipedia.py הקיים - מדיה-ויקי לפעמים מחזיר
            # HTTP 200 עם {"error": ...} בגוף התשובה, לא שגיאת HTTP.
            if "error" in data:
                raise RuntimeError(f"שגיאת API בגוף התשובה: {data['error']}")
            return data
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            if attempt >= MAX_API_RETRIES:
                print(f"שגיאת API | {description} | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
                raise
            print(f"WARNING | {description} | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
            time.sleep(min(2 ** (attempt - 1), 30))


def fetch_new_pages(api_url, since_ts):
    """
    list=recentchanges, rcnamespace=0, rctype=new, rcshow=!redirect,
    rcdir=newer, rcstart=since_ts. מחזיר יצירות "רגילות" בלבד - שחזור
    דף מחוק (undelete) *לא* מופיע כאן כ-type:new, אלא כ-action:restore
    בתוך logevents (מטופל ב-fetch_delete_log, ראו שם).

    מחזיר רשימת dict: page_id, title, created_at (ISO 8601 מה-API,
    rcprop=timestamp על אירוע type:new - זהו תאריך היצירה עצמו).
    """
    results = []
    rccontinue = None

    while True:
        params = {
            "action": "query",
            "list": "recentchanges",
            "rcnamespace": 0,
            "rctype": "new",
            "rcshow": "!redirect",
            "rcdir": "newer",
            "rcstart": since_ts,
            "rcprop": "title|ids|timestamp",
            "rclimit": 500,
            "formatversion": "2",
            "format": "json",
        }
        if rccontinue:
            params["rccontinue"] = rccontinue

        data = _api_get_with_retry(api_url, params, "recentchanges (יצירות)")

        for rc in data.get("query", {}).get("recentchanges", []):
            results.append({
                "page_id": rc["pageid"],
                "title": rc["title"],
                "created_at": rc["timestamp"],
            })

        rccontinue = data.get("continue", {}).get("rccontinue")
        if not rccontinue:
            break

    return results


def fetch_delete_log(api_url, since_ts):
    """
    list=logevents, letype=delete, lenamespace=0, ledir=newer,
    lestart=since_ts. lestart הוא חובה (לא ברירת מחדל) - בלעדיו
    ledir=newer מחזיר מתחילת היומן ההיסטורי (2014), לא "מעכשיו" -
    אושר בבדיקת ההיתכנות החיה.

    action:"delete" -> מחיקה אמיתית. action:"restore" -> שחזור דף
    שנמחק בעבר - מטופל לפי החלטת התכנון כיצירה חדשה, לא כמחיקה, ולכן
    מוחזר ברשימה נפרדת (restores) ולא ב-deletions.

    pageid_valid (רק ב-deletions): לפי הדפוס שנמצא בבדיקה החיה (לא
    מתועד רשמית) - pageid==0 עקבי עם "שום דבר לא קיים היום בכותרת
    הזו" (לא הפניה, לא דף שנוצר מחדש); pageid תקין עקבי עם "כן קיים
    שם משהו". נשמר כשדה גולמי - לא נסמך עליו לוגית מעבר לזה.

    מחזיר טאפל (deletions, restores):
    - deletions: page_id, title, deleted_at, pageid_valid
    - restores: page_id, title, created_at
    """
    deletions = []
    restores = []
    lecontinue = None

    while True:
        params = {
            "action": "query",
            "list": "logevents",
            "letype": "delete",
            "lenamespace": 0,
            "ledir": "newer",
            "lestart": since_ts,
            "leprop": "ids|title|timestamp|type",
            "lelimit": 500,
            "formatversion": "2",
            "format": "json",
        }
        if lecontinue:
            params["lecontinue"] = lecontinue

        data = _api_get_with_retry(api_url, params, "logevents (מחיקות)")

        for entry in data.get("query", {}).get("logevents", []):
            action = entry.get("action")
            title = entry.get("title")
            page_id = entry.get("pageid", 0)
            ts = entry["timestamp"]

            if not title:
                # רשומת יומן שנמחקה/הוסתרה (revision deletion על היומן
                # עצמו) - אין כותרת גלויה, אין מה לעשות איתה.
                continue

            if action == "restore":
                restores.append({
                    "page_id": page_id,
                    "title": title,
                    "created_at": ts,
                })
            elif action == "delete":
                deletions.append({
                    "page_id": page_id,
                    "title": title,
                    "deleted_at": ts,
                    "pageid_valid": bool(page_id),
                })
            # action != "delete"/"restore" מדולג בשקט - בכוונה, כולל:
            # - "delete_redir" (אושר בבדיקה חיה 27/08/2026): מחיקת הפניה
            #   קיימת כדי לפנות מקום להעברה - התאום של action:"move_redir"
            #   ב-fetch_move_log. הפניות לא נכנסות ל-wikipedia_pages/
            #   mechalol_pages מלכתחילה (apfilterredir=nonredirects), אז
            #   גם page_id של ההפניה הנמחקת כאן לעולם לא תואם שורה קיימת -
            #   דילוג נכון, לא רק "בטוח במקרה".
            # - "revision" / "event" (מחיקת גרסה בודדת, לא של הדף כולו) -
            #   לא רלוונטי לדלתא הזו.

        lecontinue = data.get("continue", {}).get("lecontinue")
        if not lecontinue:
            break

    return deletions, restores


def fetch_move_log(api_url, since_ts):
    """
    list=logevents, letype=move, ledir=newer, lestart=since_ts.
    *לא* מסונן ל-lenamespace=0 - מעבר בין מרחבי שם רלוונטי גם הוא
    (למשל טיוטה -> ראשי = יצירה-כמו-חדשה; ראשי -> טיוטה = מחיקה-כמו).
    כאן מוחזרים כל האירועים הגולמיים, והסיווג נעשה על ידי הקורא
    (fetch_wikipedia_delta.py / fetch_mechalol_delta.py) לפי ns של
    המקור והיעד.

    action:"move" מול "move_redir" (הכותרת החדשה כבר הייתה קיימת
    כהפניה ונדרסה) - שניהם תחת אותו letype:"move", ההבדל רק ב-action.

    שמות המפתחות בתוך params (target_title/target_ns/suppressredirect)
    לפי תיעוד ה-API הרשמי - *לא* אומתו ישירות מול תשובה חיה של המכלול
    (ראו הערת המודול למעלה) - מומלץ לאמת לפני ריצת ייצור ראשונה.

    old_title_pageid_valid: כמו pageid_valid ב-fetch_delete_log - דפוס
    לא-מתועד-רשמית, גולמי בלבד.

    מחזיר רשימת dict: page_id, old_title, new_title, old_ns, new_ns,
    renamed_at, action, suppressredirect, old_title_pageid_valid.
    """
    results = []
    lecontinue = None

    while True:
        params = {
            "action": "query",
            "list": "logevents",
            "letype": "move",
            "ledir": "newer",
            "lestart": since_ts,
            "leprop": "ids|title|timestamp|type|details",
            "lelimit": 500,
            "formatversion": "2",
            "format": "json",
        }
        if lecontinue:
            params["lecontinue"] = lecontinue

        data = _api_get_with_retry(api_url, params, "logevents (שינויי שם)")

        for entry in data.get("query", {}).get("logevents", []):
            title = entry.get("title")
            if not title:
                continue

            move_params = entry.get("params", {}) or {}
            target_title = move_params.get("target_title")
            if not target_title:
                # לא אמור לקרות באירוע move תקין - מדלגים עם אזהרה
                # במקום להיכשל על כל האצווה.
                print(f"WARNING | אירוע move בלי target_title: {entry}")
                continue

            results.append({
                "page_id": entry.get("pageid", 0),
                "old_title": title,
                "new_title": target_title,
                "old_ns": entry.get("ns", 0),
                "new_ns": move_params.get("target_ns", 0),
                "renamed_at": entry["timestamp"],
                "action": entry.get("action", "move"),
                "suppressredirect": bool(move_params.get("suppressredirect", False)),
                "old_title_pageid_valid": bool(entry.get("pageid", 0)),
            })

        lecontinue = data.get("continue", {}).get("lecontinue")
        if not lecontinue:
            break

    return results
