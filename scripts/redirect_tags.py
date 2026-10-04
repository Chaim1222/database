"""
תגיות שינוי של מדיה-ויקי לשינוי סטטוס הפניה, לשימוש הדלתא (fetch_wikipedia_delta.py, fetch_mechalol_delta.py):

  mw-removed-redirect  - עריכה שהפכה הפניה לדף רגיל (הפניה -> ערך)
  mw-new-redirect      - עריכה שיצרה הפניה או הפכה דף רגיל להפניה (ערך -> הפניה)

אומת חי ב-4.10.2026 (list=recentchanges&rctag=...) בוויקיפדיה העברית ובמכלול, כולל על rctype=edit.

למה: הדלתא ראתה "הפך להפניה" רק עבור דפים שכבר במעקב (מצליבה את כל העריכות מול הטבלה), ולא ראתה בכלל
הפניה שהפכה לערך (הפניות לא נמצאות בטבלאות, ועריכה רגילה אינה אירוע יצירה). הפער מתועד בהערה בסוף
fetch_wikipedia_delta.py ובהערות delta_api.py.

מודול עצמאי בכוונה (בלי config/supabase/רשת): הפונקציות כאן טהורות, והשליפה עצמה ב-delta_api.fetch_tagged_changes.
"""

REDIRECT_REMOVED_TAG = "mw-removed-redirect"
REDIRECT_ADDED_TAG = "mw-new-redirect"


def latest_by_page(events):
    """אירוע אחרון לכל page_id (לפי timestamp, ובשוויון האחרון ברשימה). המצב הסופי נקבע ממילא מול ה-API."""
    latest = {}
    for event in events:
        page_id = event.get("page_id")
        if not page_id:
            continue
        current = latest.get(page_id)
        if current is None or event["timestamp"] >= current["timestamp"]:
            latest[page_id] = event
    return list(latest.values())


def union_candidates(edited, tagged):
    """
    מאחד מועמדים (page_id, title) משני מקורות: כל העריכות ורשימת התגית. מחזיר (רשימה מאוחדת, כמה הגיעו מהתגית בלבד).
    "מהתגית בלבד" הוא מדד: אם הוא תמיד 0, התגית לא מוסיפה כיסוי מעבר לסריקת כל העריכות.
    """
    merged = {}
    for event in edited:
        merged[event["page_id"]] = {"page_id": event["page_id"], "title": event["title"]}
    tag_only = 0
    for event in tagged:
        if event["page_id"] not in merged:
            merged[event["page_id"]] = {"page_id": event["page_id"], "title": event["title"]}
            tag_only += 1
    return list(merged.values()), tag_only


def revived_articles(removed_events, redirect_status):
    """
    מאירועי "הפניה הוסרה" מחזיר אירועי יצירה לדפים שהם **עכשיו** ערך רגיל.
    redirect_status: {title: bool} רק לדפים שקיימים (כמו delta_api.fetch_redirect_status): False = ערך רגיל, True = הפניה
    שוב, וכותרת חסרה = נמחק מאז. המצב הנוכחי גובר על האירוע (דף שחזר להיות הפניה לא נכנס).
    """
    revived = []
    for event in latest_by_page(removed_events):
        if redirect_status.get(event["title"]) is False:
            revived.append({
                "page_id": event["page_id"],
                "title": event["title"],
                "created_at": event["timestamp"],
            })
    return revived
