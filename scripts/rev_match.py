"""
בדיקת קישורי המכלול מול `גרסה=` בתבנית {{מיון ויקיפדיה}} (scripts/rev_link_scan.py, פעם בחודש).

גרסה היא זהות יציבה של דף גם אחרי שינוי שם: ה-API של ויקיפדיה אומר לאיזה דף הגרסה שייכת, ומה
הכותרת הנוכחית שלו. ההחלטה (decide) נשמרת בטבלת העבודה rev_link_check:

  rev_task        rename | redirect | bad_rev | deleted_by_rev  (אין שורה = תקין)
  rev_page_id     הדף שהגרסה שייכת לו, ו-rev_page_title שמו הנוכחי

התהליך אצלנו (חיים, 2026-10-01): בייבוא הכותרת שלנו ושם התבנית (`דף=`) הם שם ויקיפדיה באותו רגע.
בהעברה בעקבות ויקיפדיה מעדכנים גם את הכותרת וגם את התבנית. בהחלטה מקומית משנים רק את הכותרת
ומשאירים את התבנית. לכן שם התבנית הוא שם המקור בעדכון האחרון, והכותרת שלנו חופשית.

כללי ההחלטה:
  - גרסה ריקה, 0 או 1 (גרסת העמוד הראשי) = גרסה שגויה.
  - הגרסה לא קיימת: גדולה מהאחרונה בוויקיפדיה = גרסה שגויה, אחרת הדף נמחק.
  - הגרסה שייכת למרחב שם אחר = גרסה שגויה. דף שהפך להפניה = הפך להפניה.
  - הגרסה שייכת לדף חי: הכותרת הנוכחית שלו שווה לכותרת שלנו או לשם התבנית (נרמול, והסרת
    "הרב/רבי" ו-"(רב)") = אין משימה. שניהם שונים ממנה = ויקיפדיה העבירה ואנחנו לא עקבנו:
    העברת שם. עצם זה שהגרסה שייכת לדף בשם אחר משם התבנית הוא ההוכחה להעברה.
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
# "X (רב)" בוויקיפדיה שקול ל"רבי X" / "הרב X" במכלול (הכרעת חיים, 2026-10-01)
_RAV_SUFFIX = re.compile(r"\s*\(רב\)$")

# needs_template: הגרסה שייכת לדף חי והכותרת שלנו לא תואמת לכותרת הנוכחית שלו - צריך לקרוא את שם
# התבנית (`דף=`) ולקרוא ל-decide שוב עם template_name.
Decision = namedtuple("Decision", "task page_id page_title needs_template", defaults=(False,))
NO_DECISION = Decision(None, None, None)
NEEDS_TEMPLATE = Decision(None, None, None, True)
UNKNOWN = object()  # template_name שעוד לא נקרא (שונה מ-None: נקרא ואין שם)


def in_scope(row):
    """
    אותו היקף של מעקב גרסת המקור (list_pending_sort_template), בלי דפים שהתבנית שלהם לא ניתנת לקריאה
    בגלל נעילה (sort_template_denied_at / template_check_access_denied_at): אין להם גרסה, וזה לא
    "גרסה שגויה" - הם בטאב "נעולים" (ושיוך ידני הוא הדרך לקשר אותם).
    """
    return (
        row.get("status") == STATUS_IMPORTED_DOCUMENTED
        and not row.get("is_dictionary_entry")
        and not row.get("needs_attention")
        and not row.get("sort_template_denied_at")
        and not row.get("template_check_access_denied_at")
    )


def valid_rev(rev):
    return isinstance(rev, int) and rev not in INVALID_REVS and rev > 0


def _strip_rav(title):
    """בלי קידומת "הרב/רבי" ובלי הסיומת המבדלת "(רב)"."""
    return _RAV_SUFFIX.sub("", _RAV_PREFIX.sub("", title)).strip()


def names_match(mechalol_title, wikipedia_title):
    """כותרות תואמות אחרי hygiene, הנרמול הסמנטי והסרת קידומת "הרב/רבי" או הסיומת "(רב)" (מוסכמת המכלול)."""
    if not mechalol_title or not wikipedia_title:
        return False
    wiki = hygiene(wikipedia_title)
    wiki_bare = _strip_rav(wiki)
    for candidate in {hygiene(mechalol_title), normalize_title(mechalol_title)[0]}:
        if candidate == wiki or _strip_rav(candidate) == wiki_bare:
            return True
    return False


def decide(row, resolved, max_rev, page_exists, template_name=UNKNOWN):
    """
    row: שורת mechalol_pages. resolved: תוצאת resolve_revisions לגרסת השורה (None = לא קיימת).
    page_exists(page_id): האם הדף קיים ב-wikipedia_pages (הקישור הוא מפתח זר אליו).
    template_name: `דף=` בתבנית; None = נקרא ואין שם; UNKNOWN = טרם נקרא (ואז, כשצריך אותו,
    מוחזר NEEDS_TEMPLATE).
    """
    if not in_scope(row):
        return NO_DECISION

    rev = row.get("sort_template_rev")
    if not valid_rev(rev):
        return Decision(TASK_BAD_REV, None, None)

    if resolved is None:
        return Decision(TASK_BAD_REV if max_rev and rev > max_rev else TASK_DELETED, None, None)

    page_id, title = resolved["page_id"], resolved["title"]
    if resolved["ns"] != 0:
        return Decision(TASK_BAD_REV, page_id, title)
    if resolved["redirect"]:
        return Decision(TASK_REDIRECT, page_id, title)

    if not page_exists(page_id):
        # דף חי שעוד לא נטען ל-wikipedia_pages (פער דלתא): ייבדק בריצה הבאה.
        return NO_DECISION

    if names_match(row.get("title"), title):
        return NO_DECISION
    if template_name is UNKNOWN:
        return NEEDS_TEMPLATE
    if template_name and names_match(template_name, title):
        return NO_DECISION
    return Decision(TASK_RENAME, page_id, title)


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
