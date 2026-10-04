"""
השלמת הפער שבין הדמפ לבין עכשיו, לטבלת הכותרות של ויקיפדיה (wikipedia_pages).

הדמפ (stub-meta-current) ישן בימים עד שבועות. כדי שדף שנוצר, נמחק או הועבר אחרי הדמפ לא
ייעלם או יופיע בטעות אחרי ההחלפה השבועית, אוספים מ-recentchanges ומ-logevents את הדפים
והכותרות שנגעו בהם מאז, ושואלים את ה-API מה המצב **עכשיו** (prop=info): ערך חי במרחב הראשי
שאינו הפניה נכתב (id, כותרת); כל השאר (נמחק, הפניה, מרחב שם אחר) נמחק מהטבלה.

הפונקציות כאן טהורות (בלי רשת ובלי סופרבייס) ולכן נבדקות ביחידות; הרשת והכתיבה ב-fetch_wikipedia.py.
"""
from datetime import datetime, timedelta, timezone

# אצוות של 50 (מגבלת משתמש רגיל ב-API) לשליפת מצב נוכחי
RESOLVE_BATCH = 50
# הדמפ נכתב שעות, ולכן ה-timestamp המאוחר בו אינו חתך חד; חופפים בכוונה
GAP_MARGIN = timedelta(days=2)
# recentchanges שומר ~90 יום; מעבר לכך הפער לא ניתן להשלמה
MAX_DUMP_AGE = timedelta(days=80)


def parse_ts(value):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def gap_start(newest_dump_ts, now=None):
    """
    נקודת ההתחלה להשלמה (ISO) = ה-timestamp המאוחר בדמפ פחות שולי חפיפה.
    זורק חריגה אם הדמפ ישן מדי כדי שההשלמה תכסה את הפער.
    """
    now = now or datetime.now(timezone.utc)
    newest = parse_ts(newest_dump_ts)
    if now - newest > MAX_DUMP_AGE:
        raise RuntimeError(
            f"הדמפ ישן מדי להשלמת פער ({newest_dump_ts}; מעל {MAX_DUMP_AGE.days} יום) - "
            "recentchanges לא מחזיק היסטוריה כזו"
        )
    return (newest - GAP_MARGIN).strftime("%Y-%m-%dT%H:%M:%SZ")


def log_event_refs(events):
    """
    מאירועי יומן (move/delete) מחלץ מזהי דפים וכותרות שיש לבדוק מחדש.
    מחזיר (set של page_id, set של כותרות). כולל את יעד ההעברה (params.target_title).
    """
    ids, titles = set(), set()
    for event in events:
        page_id = event.get("logpage")
        if page_id:
            ids.add(page_id)
        if event.get("title"):
            titles.add(event["title"])
        target = (event.get("params") or {}).get("target_title")
        if target:
            titles.add(target)
    return ids, titles


def classify_pages(pages):
    """
    pages: ערכי data["query"]["pages"] של שאילתת prop=info (לפי pageids או titles).
    מחזיר (keep, drop_ids, drop_titles):
      keep        - [{"id", "title"}] ערכים חיים במרחב הראשי שאינם הפניות
      drop_ids    - מזהים שיש למחוק (נמחקו, הפכו להפניה או עברו למרחב שם אחר)
      drop_titles - כותרות שאין להן דף (נשאלו לפי כותרת, ולכן אין מזהה)
    """
    keep, drop_ids, drop_titles = [], set(), set()
    for page in pages:
        page_id = page.get("pageid")
        if page.get("missing") is not None or page.get("invalid") is not None:
            if page_id:
                drop_ids.add(page_id)
            elif page.get("title"):
                drop_titles.add(page["title"])
        elif page.get("ns") == 0 and page.get("redirect") is None:
            keep.append({"id": page_id, "title": page["title"]})
        elif page_id:
            drop_ids.add(page_id)
    return keep, drop_ids, drop_titles


def chunks(items, size):
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]
