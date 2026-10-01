"""
פענוח התבנית {{מיון ויקיפדיה|דף=…|גרסה=…|פריט=…|תאריך=…}} בסוף ערך במכלול.

מה שנחוץ מהתבנית למעקב סנכרון תוכן מול ויקיפדיה:
  title - `דף=`, כותרת הערך בוויקיפדיה (קו תחתון מומר לרווח, קישור פנימי מקולף)
  rev   - `גרסה=`, מזהה גרסת ויקיפדיה שממנה עודכן הערך. 0, ריק או ערך לא מספרי
          נחשבים "אין גרסה" ומחזירים None
  date  - `תאריך=`, חודש העדכון האחרון כתאריך (היום הראשון בחודש), או None

מודול עצמאי בכוונה: בלי ייבוא של config/supabase, כדי שאפשר יהיה לבדוק אותו
בלי משתני סביבה. match.py מחזיק כרגע ביטוי רגולרי משלו ל-`דף=` בלבד.
"""
import re
from datetime import date

TEMPLATE_START_RE = re.compile(r"\{\{\s*מיון\s+ויקיפדיה\s*\|")

_MONTHS = {
    "ינואר": 1, "פברואר": 2, "מרץ": 3, "מארס": 3, "אפריל": 4, "מאי": 5,
    "יוני": 6, "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10,
    "נובמבר": 11, "דצמבר": 12,
}


def _find_template_body(text, start):
    """
    מקבל את מיקום תחילת גוף התבנית (אחרי ה-`|` הראשון) ומחזיר את הגוף עד
    ה-`}}` שסוגר אותה, כולל תבניות מקוננות. None אם התבנית לא נסגרת.
    """
    depth = 1
    i = start
    n = len(text)
    while i < n - 1:
        pair = text[i:i + 2]
        if pair == "{{":
            depth += 1
            i += 2
        elif pair == "}}":
            depth -= 1
            if depth == 0:
                return text[start:i]
            i += 2
        else:
            i += 1
    return None


def _split_params(body):
    """מפצל לפי `|` ברמה העליונה בלבד (לא בתוך [[…]] או {{…}})."""
    params = []
    current = []
    curly = 0
    square = 0
    i = 0
    n = len(body)
    while i < n:
        pair = body[i:i + 2]
        if pair == "{{":
            curly += 1
            current.append(pair)
            i += 2
        elif pair == "}}":
            curly = max(curly - 1, 0)
            current.append(pair)
            i += 2
        elif pair == "[[":
            square += 1
            current.append(pair)
            i += 2
        elif pair == "]]":
            square = max(square - 1, 0)
            current.append(pair)
            i += 2
        elif body[i] == "|" and curly == 0 and square == 0:
            params.append("".join(current))
            current = []
            i += 1
        else:
            current.append(body[i])
            i += 1
    params.append("".join(current))
    return params


def clean_title(raw):
    value = raw.strip()
    value = re.sub(r"^\[\[(.+)\]\]$", r"\1", value).strip()
    value = value.replace("_", " ")
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def parse_rev(raw):
    """מספר גרסה תקין, או None (ריק, 0, 1 או לא מספרי). גרסה 1 היא של העמוד הראשי (הכרעת חיים, 2026-10-01)."""
    value = (raw or "").strip()
    if not re.fullmatch(r"\d+", value):
        return None
    number = int(value)
    return number if number > 1 else None


def parse_month(raw):
    """'פברואר 2026' -> date(2026, 2, 1). None אם לא ניתן לפענח."""
    match = re.fullmatch(r"\s*([א-ת]+)\s+(\d{4})\s*", raw or "")
    if not match:
        return None
    month = _MONTHS.get(match.group(1))
    if not month:
        return None
    return date(int(match.group(2)), month, 1)


def parse_sort_template(text):
    """
    מחזיר {"title", "rev", "date"} לתבנית האחרונה בטקסט, או None אם אין תבנית
    (או שהיא לא נסגרת). ערכים שחסרים או לא תקינים בתוך התבנית הם None.
    """
    if not text:
        return None

    starts = [m.end() for m in TEMPLATE_START_RE.finditer(text)]
    for start in reversed(starts):
        body = _find_template_body(text, start)
        if body is None:
            continue

        values = {}
        for param in _split_params(body):
            if "=" not in param:
                continue
            key, _, value = param.partition("=")
            key = key.strip()
            if key and key not in values:
                values[key] = value

        return {
            "title": clean_title(values["דף"]) if "דף" in values else None,
            "rev": parse_rev(values.get("גרסה")),
            "date": parse_month(values.get("תאריך")),
        }

    return None
