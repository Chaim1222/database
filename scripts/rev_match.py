"""
התאמה לפי גרסה (`גרסה=` בתבנית {{מיון ויקיפדיה}}) - השלב הראשון ב-match.py לערכים מתועדים.

גרסה היא זהות יציבה של דף (גם אחרי שינוי שם), ולכן היא קודמת להתאמה לפי כותרת. ה-API של
ויקיפדיה אומר לאיזה דף הגרסה שייכת, וההחלטה (decide) נשמרת בעמודות של mechalol_pages:

  rev_task        rename | redirect | bad_rev | deleted_by_rev | NULL (תקין)
  rev_page_id     הדף שהגרסה שייכת לו (רק כשיש משימה)
  rev_page_title  שמו הנוכחי (רק כשיש משימה; דף שאינו ב-wikipedia_pages אין לו כותרת אחרת)

כללי ההחלטה (הכרעת חיים, 2026-10-01):
  - גרסה ריקה, 0 או 1 = גרסה שגויה (1 היא גרסת העמוד הראשי).
  - הגרסה לא קיימת: אם היא גדולה מהגרסה האחרונה בוויקיפדיה - גרסה שגויה, אחרת הדף נמחק.
  - הגרסה שייכת למרחב שם אחר - גרסה שגויה. הדף הפך להפניה - הפך להפניה.
  - הגרסה שייכת לדף חי, ואין התאמה לפי כותרת: הקישור לדף הגרסה, ואם הכותרות לא תואמות
    (נרמול והסרת "הרב/רבי") - משימת העברת שם.
  - הגרסה שייכת לדף חי שונה מזה שהתאמת הכותרת מצאה: לא ידוע אם הכותרת הייתה נכונה והדף הועבר,
    או שהגרסה שגויה מלכתחילה - גרסה שגויה, והקישור נשאר לפי הכותרת.
"""
import re
import time
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor

from config import REQUEST_DELAY_SECONDS, STATUS_IMPORTED_DOCUMENTED
from normalize import hygiene, normalize_title

TASK_RENAME = "rename"
TASK_REDIRECT = "redirect"
TASK_BAD_REV = "bad_rev"
TASK_DELETED = "deleted_by_rev"
TASKS = (TASK_RENAME, TASK_REDIRECT, TASK_BAD_REV, TASK_DELETED)

API_BATCH = 50  # מגבלת revids בבקשה
INVALID_REVS = (0, 1)
_RAV_PREFIX = re.compile(r"^(הרב|רבי)\s+")

# link_id: הדף שהגרסה קובעת כקישור (None = ממשיכים בהתאמה לפי כותרת).
# page_title: שם הדף שהגרסה שייכת לו, למשימה.
Decision = namedtuple("Decision", "link_id task page_id page_title")
NO_DECISION = Decision(None, None, None, None)


def in_scope(row):
    """אותו היקף של מעקב גרסת המקור (list_pending_sort_template)."""
    return (
        row.get("status") == STATUS_IMPORTED_DOCUMENTED
        and not row.get("is_dictionary_entry")
        and not row.get("needs_attention")
    )


def valid_rev(rev):
    return isinstance(rev, int) and rev not in INVALID_REVS and rev > 0


def _strip_rav(title):
    return _RAV_PREFIX.sub("", title).strip()


def names_match(mechalol_title, wikipedia_title):
    """כותרות תואמות אחרי hygiene, הנרמול הסמנטי והסרת קידומת "הרב/רבי" (מוסכמת המכלול)."""
    if not mechalol_title or not wikipedia_title:
        return False
    wiki = hygiene(wikipedia_title)
    wiki_bare = _strip_rav(wiki)
    for candidate in {hygiene(mechalol_title), normalize_title(mechalol_title)[0]}:
        if candidate == wiki or _strip_rav(candidate) == wiki_bare:
            return True
    return False


def decide(row, resolved, title_link_id, max_rev, page_exists):
    """
    row: שורת mechalol_pages. resolved: תוצאת resolve_revisions לגרסת השורה (None = לא קיימת).
    title_link_id: הדף שהתאמת הכותרת (היגיינה/נרמול) מצאה, או None.
    page_exists(page_id): האם הדף קיים ב-wikipedia_pages (wikipedia_id הוא מפתח זר אליו).
    """
    if not in_scope(row):
        return NO_DECISION

    rev = row.get("sort_template_rev")
    if not valid_rev(rev):
        return Decision(None, TASK_BAD_REV, None, None)

    if resolved is None:
        task = TASK_BAD_REV if max_rev and rev > max_rev else TASK_DELETED
        return Decision(None, task, None, None)

    page_id, title = resolved["page_id"], resolved["title"]
    if resolved["ns"] != 0:
        return Decision(None, TASK_BAD_REV, page_id, title)
    if resolved["redirect"]:
        return Decision(None, TASK_REDIRECT, page_id, title)

    if not page_exists(page_id):
        # דף חי שעוד לא נטען ל-wikipedia_pages (פער דלתא): אין מה לקשר אליו, ייבדק בריצה הבאה.
        return NO_DECISION

    if title_link_id is None:
        if names_match(row.get("title"), title):
            return Decision(page_id, None, None, None)
        return Decision(page_id, TASK_RENAME, page_id, title)

    if title_link_id == page_id:
        return NO_DECISION
    return Decision(None, TASK_BAD_REV, page_id, title)


def resolve_revisions(wikipedia_get, rev_ids):
    """
    {rev_id: {"page_id", "title", "ns", "redirect"} | None (הגרסה לא קיימת)} לבקשה אחת (עד 50).
    בקשה אחת מחזירה גם pageid וגם redirect (prop=revisions|info).
    """
    result = {rev: None for rev in rev_ids}
    data = wikipedia_get({
        "action": "query",
        "revids": "|".join(str(r) for r in rev_ids),
        "prop": "revisions|info",
        "rvprop": "ids",
        "formatversion": "2",
    })
    for page in data.get("query", {}).get("pages", []):
        info = {
            "page_id": page.get("pageid"),
            "title": page.get("title"),
            "ns": page.get("ns"),
            "redirect": bool(page.get("redirect")),
        }
        for revision in page.get("revisions") or []:
            result[revision["revid"]] = info
    if REQUEST_DELAY_SECONDS:
        time.sleep(REQUEST_DELAY_SECONDS)
    return result


def resolve_many(wikipedia_get, rev_ids, workers=4):
    """resolve_revisions לרשימה ארוכה, באצוות של 50 במקביל (מגביל את הזמן בריצה השבועית)."""
    unique = sorted(set(rev_ids))
    batches = [unique[i:i + API_BATCH] for i in range(0, len(unique), API_BATCH)]
    resolved = {}
    if not batches:
        return resolved
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for part in pool.map(lambda batch: resolve_revisions(wikipedia_get, batch), batches):
            resolved.update(part)
    return resolved


def fetch_max_rev(wikipedia_get):
    """מספר הגרסה האחרון בוויקיפדיה (גרסה גדולה ממנו אינה קיימת ולא תהיה מחיקה)."""
    data = wikipedia_get({
        "action": "query", "list": "recentchanges", "rclimit": 1, "rcprop": "ids", "formatversion": "2",
    })
    changes = data.get("query", {}).get("recentchanges") or []
    return max((c["revid"] for c in changes), default=0)
