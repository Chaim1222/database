"""
סינון מילים חשודות על קוד ויקיטקסט.

מאחד את שתי רשימות המילים של המכלול למנוע אחד שרץ על **ויקיטקסט**
(לא על HTML מוצג), ומחזיר כל התאמה עם הקטגוריה, התבנית, המיקום
(היסט + שורה) וההקשר - כך שאפשר לבנות ממנו גם בדיקת "נקי/לא נקי",
גם דוח, וגם הדגשה בגאדג'ט.

מקורות הרשימות (מקור האמת - נקראים חי מהמכלול, עם עותק מקומי
ב-suspicious_words_lists/ לבדיקות ולעבודה בלי רשת):
- "המכלול:בדיקת מילים חשודות" (מכ:במח) - שש רשימות צבע, כל אחת שורת
  חלופות אחת מופרדת ב-`|`, עטופה בזוג `<!--  -->`. משמשת את הגאדג'ט
  aspeklaryaCheck שצובע את הדף המוצג.
- "המכלול:בודק מילים חשודות" (מכ:בומח) - תבנית אחת בכל שורה בפורמט
  `*תבנית//`, שני בלוקים מופרדים ב-`<!-- -->`. משמשת את הבודק
  שרץ על תיבת העריכה בסקריפט העדכון.

שלושה דברים שהמנוע עושה מעבר להעברה ישירה של הרשימות:

1. **תיקון תבניות שבורות** (FIXES למטה) - תבניות שבפועל אף פעם לא
   מתאימות (למשל `^ק` במקום `[^ק]`), או שמתאימות לכל דבר (חלופה
   ריקה), או שכוונתן הייתה "לא אחרי המילה X" אבל נכתבו כמחלקת תווים
   (`[^(ת|מ|ארי)]`). כל תיקון מתועד עם הסיבה, והתבנית המקורית נשמרת
   בתוצאה. תבנית שלא מתקמפלת בפייתון לא מפילה את הבדיקה - היא נרשמת
   ב-`problems` ומדולגת.

2. **מיסוך ויקיטקסט** (mask_wikitext) - מחליף ברווחים (באותו אורך
   בדיוק, כך שהמיקומים נשמרים) את מה שהקורא לא רואה: הערות, שמות
   תבניות ושמות פרמטרים, יעדי קישורים עם כינוי, שמות קבצים ואפשרויות
   תמונה, כתובות URL, תגיות HTML ומאפייניהן. הטקסט הגלוי - כולל
   ערכי פרמטרים, כיתובי תמונות, תוכן הערות שוליים וכינויי קישורים -
   נשאר. `scope="raw"` מדלג על המיסוך (שימושי לרשימה הסגולה, שמחפשת
   דווקא סימני ויקי כמו "ויקיפדיה:").

3. **רשימת היתרים** (allowlist) - ביטויים רגולריים שהתאמה שנופלת
   כולה בתוכם לא מדווחת (למשל "מין חדש" = species). ריקה כברירת
   מחדל - ההחלטה מה מותר שייכת לעורכים, לא לקוד.

הבדלים מכוונים מהגאדג'טים ב-JS:
- רישיות כמו במקור: בומח רץ ללא תלות ברישיות (דגל i), במח רץ תלוי רישיות
  (לכן יש בו sex|Sex|SEX בנפרד, ו-ass לא תופס את Assembly).
- lookbehind באורך משתנה (`(?<!ארי|ת)`) לא נתמך בפייתון - התיקונים
  מפצלים אותו ל-lookbehind נפרד לכל חלופה.
- שורה בבומח שלא מתחילה ב-`*` מתעלמים ממנה, בדיוק כמו בגאדג'ט (שם
  היא מתמזגת בשקט לשורה הקודמת) - אבל כאן היא נרשמת ב-`problems`.

שימוש מהיר:
    python scripts/suspicious_words.py --title "שם ערך"            # ויקיפדיה
    python scripts/suspicious_words.py --wiki mechalol --title "..."
    python scripts/suspicious_words.py --file page.wikitext
    python scripts/suspicious_words.py --check-lists               # מצב הרשימות
"""
import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field

# מוגדרים כאן ולא מיובאים מ-config.py, כי config.py דורש משתני סביבה
# של סופרבייס כבר בזמן import - והמודול הזה צריך לרוץ גם בלעדיהם.
WIKIPEDIA_API = "https://he.wikipedia.org/w/api.php"
MECHALOL_API = "https://www.hamichlol.org.il/w/api.php"
REQUEST_HEADERS = {
    "User-Agent": (
        "MechalolWikipediaCompareBot/1.0 "
        "(https://www.hamichlol.org.il/; bot@hamichlol.org.il)"
    )
}

BMH_PAGE = "המכלול:בדיקת מילים חשודות"
BOMAH_PAGE = "המכלול:בודק מילים חשודות"

LISTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "suspicious_words_lists")

HEBREW = r"\u0590-\u05FF"


# ============================================================
# קטגוריות
# ============================================================

@dataclass(frozen=True)
class Category:
    key: str
    label: str
    color: str
    source: str        # "bmh" / "bomah"
    blocking: bool     # האם התאמה בקטגוריה הופכת דף ל"לא נקי"


# שם הכותרת בדף במח -> קטגוריה. לפי כותרת ולא לפי אינדקס (כמו
# theWords[1], theWords[3]... בגאדג'ט), כך שהוספת רשימה או שינוי סדר
# בדף לא יזיזו רשימה לצבע הלא נכון.
BMH_CATEGORIES = {
    "אדום כהה": Category("bmh_dark_red", "אדום כהה", "#ff5555", "bmh", True),
    "אדום בהיר": Category("bmh_light_red", "אדום בהיר", "#ffcccc", "bmh", False),
    "ירוק": Category("bmh_green", "ירוק", "#99ff99", "bmh", False),
    "כחול": Category("bmh_blue", "כחול", "#ccccff", "bmh", False),
    "צהוב": Category("bmh_yellow", "צהוב", "#eeee99", "bmh", False),
    "סגול": Category("bmh_purple", "סגול", "#9370db", "bmh", False),
}

BOMAH_CATEGORIES = [
    Category("bomah_modesty", "בומח - צניעות", "#ff5555", "bomah", True),
    Category("bomah_general", "בומח - כללי", "#eeee99", "bomah", False),
]

# הרשימה הסגולה מחפשת סימני ויקי ("ויקיפדיה:", "תמונה חילופית") -
# אלה בדרך כלל בדיוק מה שהמיסוך מסיר, ולכן היא רצה על הטקסט הגולמי.
RAW_SCOPE_CATEGORIES = {"bmh_purple"}


# ============================================================
# תיקוני תבניות
# ============================================================

@dataclass(frozen=True)
class Fix:
    replacement: str | None   # None = להשמיט את התבנית
    reason: str


FIXES = {
    # --- תבניות שאף פעם לא מתאימות ---
    "(?<!יו)א[ו]*נ[ו]*ס^ק": Fix(
        "(?<!יו)א[ו]*נ[ו]*ס(?!ק)",
        "`^` באמצע תבנית הוא עוגן תחילת טקסט, ולכן התבנית לא התאימה אף פעם. הכוונה: 'לא ואחריו ק'.",
    ),
    "רומ+[נן]+^יה": Fix(
        "רומ+[נן]+(?!יה)",
        "`^` באמצע תבנית - לא התאימה אף פעם. הכוונה: 'לא ואחריו יה'.",
    ),
    "(?<!ל)לסביםוזית": Fix(
        "לסבי(?:ם|ות|ית)",
        "טקסט משובש (כנראה מיזוג של לסבים/לסביות/לסבית) - לא התאים אף פעם.",
    ),
    "{{כ}}(?<=\\s)זין": Fix(
        f"(?<!כלי )(?<![{HEBREW}])זין(?![{HEBREW}])",
        "אחרי `}}` אי אפשר שיבוא lookbehind של רווח - לא התאימה אף פעם. הכוונה: 'זין' כמילה בודדת "
        "(ולא 'כלי זין').",
    ),
    "^שדי$": Fix(
        f"(?<![{HEBREW}])שדי(?![{HEBREW}])",
        "`^...$` בלי דגל m מתאים רק אם כל הדף הוא המילה הזו. הכוונה: מילה בודדת.",
    ),
    "^(אלים)$": Fix(
        f"(?<![{HEBREW}])אלים(?![{HEBREW}])",
        "`^...$` בלי דגל m מתאים רק אם כל הדף הוא המילה הזו. הכוונה: מילה בודדת.",
    ),
    "שדי$": Fix(
        f"(?<![{HEBREW}])שדי(?![{HEBREW}])",
        "`$` בלי דגל m מתאים רק בסוף הדף. הכוונה: מילה בודדת.",
    ),
    # --- מחלקת תווים שנכתבה כאילו היא "לא אחרי המילה" ---
    "[^(ת|מ|ארי)]זונ(ה|ות)": Fix(
        "(?<!ארי)(?<!ת)(?<!מ)זונ(?:ה|ות)",
        "`[^(ת|מ|ארי)]` היא מחלקת תווים (אף אחת מהאותיות ת,מ,א,ר,י), לא 'לא אחרי ארי' - "
        "חסמה למשל גם 'ריזונה'. הוחלף ב-lookbehind לכל מילה.",
    ),
    "[^(ת|ארי)]זונה": Fix(
        "(?<!ארי)(?<!ת)זונה",
        "מחלקת תווים במקום 'לא אחרי המילה' - ראו למעלה.",
    ),
    "[^(דו)]לפין": Fix(
        "(?<!דו)לפין",
        "`[^(דו)]` חוסמת כל ד או ו לפני, לא את 'דו' (דולפין). הוחלף ב-lookbehind.",
    ),
    "האל[^ימות(קט)]": Fix(
        "האל(?![ימות]|קט)",
        "`(קט)` בתוך מחלקת תווים חוסם ק או ט בודדים, לא את הרצף 'קט'.",
    ),
}


# ============================================================
# פירוק דפי הרשימות
# ============================================================

@dataclass
class Pattern:
    category: Category
    source: str               # התבנית כפי שהיא בדף
    effective: str | None     # התבנית שרצה בפועל (None = מושמטת)
    regex: re.Pattern | None
    fix_reason: str | None = None


@dataclass
class Lists:
    patterns: list = field(default_factory=list)
    problems: list = field(default_factory=list)   # [(category_key, source, message)]

    def categories(self):
        seen = {}
        for p in self.patterns:
            seen.setdefault(p.category.key, p.category)
        return list(seen.values())


def split_alternatives(source):
    """
    מפצל שורת חלופות של במח לתבניות בודדות - רק לפי `|` ברמה העליונה,
    לא בתוך סוגריים, מחלקת תווים או אחרי `\\`. כך כל התאמה מדווחת עם
    התבנית הספציפית שתפסה אותה, ולא עם השורה כולה.
    """
    parts, current = [], []
    depth = 0
    in_class = False
    i = 0
    while i < len(source):
        ch = source[i]
        if ch == "\\" and i + 1 < len(source):
            current.append(source[i:i + 2])
            i += 2
            continue
        if in_class:
            if ch == "]":
                in_class = False
        elif ch == "[":
            in_class = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(depth - 1, 0)
        elif ch == "|" and depth == 0:
            parts.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    parts.append("".join(current))
    return parts


def parse_bmh(wikitext):
    """
    {Category: [pattern source, ...]} מדף במח. התוכן של כל רשימה הוא
    מה שבין זוג ה-`<!-- -->` הראשון אחרי הכותרת - אותו תוכן שהגאדג'ט
    לוקח ב-split("<!--  -->").
    """
    result = {}
    sections = re.split(r"^==\s*([^=\n]+?)\s*==\s*$", wikitext, flags=re.M)
    for heading, body in zip(sections[1::2], sections[2::2]):
        category = BMH_CATEGORIES.get(heading)
        if category is None:
            continue
        blocks = re.split(r"<!--\s*-->", body)
        if len(blocks) < 3:
            continue
        result[category] = [s for s in split_alternatives(blocks[1].strip())]
    return result


def parse_bomah(wikitext):
    """
    ({Category: [pattern source, ...]}, [שורות שהגאדג'ט מתעלם מהן]).
    כמו בגאדג'ט: רק מה שאחרי `-----`, רק שורות שמתחילות ב-`*` ומכילות
    `//`, והתבנית היא מה שלפני ה-`//` הראשון.
    """
    body = wikitext.split("-----", 1)[1] if "-----" in wikitext else wikitext
    blocks = re.split(r"<!--\s*-->", body)
    result, ignored = {}, []
    for category, block in zip(BOMAH_CATEGORIES, blocks):
        sources = []
        for line in block.splitlines():
            line = line.strip()
            if "//" not in line:
                continue
            if not line.startswith("*"):
                ignored.append((category, line))
                continue
            sources.append(line[1:].split("//")[0].strip())
        result[category] = sources
    return result, ignored


def compile_lists(bmh_text=None, bomah_text=None):
    """בונה Lists משני הדפים (כל אחד אופציונלי)."""
    lists = Lists()
    parsed = {}
    if bmh_text is not None:
        parsed.update(parse_bmh(bmh_text))
    if bomah_text is not None:
        bomah, ignored = parse_bomah(bomah_text)
        parsed.update(bomah)
        for category, line in ignored:
            lists.problems.append((
                category.key, line,
                "השורה לא מתחילה ב-* - הגאדג'ט מתעלם ממנה (ומצרף אותה בשקט לשורה הקודמת).",
            ))

    for category, sources in parsed.items():
        seen = set()
        for source in sources:
            if not source.strip():
                lists.problems.append((category.key, source, "חלופה ריקה (למשל `|` בסוף השורה) - מתאימה לכל מקום; הושמטה."))
                continue
            if source in seen:
                continue
            seen.add(source)

            fix = FIXES.get(source)
            effective = fix.replacement if fix else source
            reason = fix.reason if fix else None
            regex = None
            if effective is not None:
                try:
                    regex = re.compile(effective, re.IGNORECASE if category.source == "bomah" else 0)
                except re.error as exc:
                    lists.problems.append((category.key, source, f"לא מתקמפלת בפייתון: {exc}; הושמטה."))
                    effective = None
            lists.patterns.append(Pattern(category, source, effective, regex, reason))
    return lists


def read_snapshot(name):
    with open(os.path.join(LISTS_DIR, name), encoding="utf-8") as f:
        return f.read()


def fetch_raw(api, title):
    import requests

    response = requests.get(
        api,
        params={
            "action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
            "titles": title, "format": "json", "formatversion": "2",
        },
        headers=REQUEST_HEADERS,
        timeout=(15, 60),
    )
    response.raise_for_status()
    page = response.json()["query"]["pages"][0]
    if page.get("missing"):
        raise LookupError(f"הדף '{title}' לא קיים")
    return page["revisions"][0]["slots"]["main"]["content"]


def load_lists(source="snapshot"):
    """
    source="live" - קורא את שני הדפים מהמכלול (מקור האמת).
    source="snapshot" - העותק שבריפו (suspicious_words_lists/).
    """
    if source == "live":
        return compile_lists(fetch_raw(MECHALOL_API, BMH_PAGE), fetch_raw(MECHALOL_API, BOMAH_PAGE))
    return compile_lists(read_snapshot("bmh.txt"), read_snapshot("bomah.txt"))


# ============================================================
# מיסוך ויקיטקסט
# ============================================================

FILE_NAMESPACES = {"קובץ", "תמונה", "file", "image", "מדיה", "media"}
CATEGORY_NAMESPACES = {"קטגוריה", "category"}
INTERWIKI_RE = re.compile(r"^[a-z]{2,3}(?:-[a-z]+)*$")

# אפשרויות תצוגה של תמונה - לא כיתוב, לא מוצגות לקורא.
FILE_OPTION_RE = re.compile(
    r"^\s*(?:ממוזער|ממוסגר|מסגרת|ללא מסגרת|שמאל|ימין|מרכז|ללא|thumb|thumbnail|frame|framed|frameless|"
    r"border|left|right|center|centre|none|upright(?:\s*=\s*[\d.]+)?|\d*x?\d+\s*px|"
    r"(?:link|קישור|page|דף|class|lang|alt)\s*=.*)\s*$",
    re.IGNORECASE,
)

NON_TEXT_TAGS = (
    "math", "chem", "syntaxhighlight", "source", "pre", "score", "timeline",
    "templatedata", "graph", "mapframe", "maplink", "templatestyles",
)


def mask_wikitext(text):
    """
    מחזיר מחרוזת באורך זהה ל-text שבה כל מה שלא מוצג לקורא הוחלף
    ברווח (ירידות שורה נשמרות, כך שגם מספרי השורות זהים). כך כל
    היסט שנמצא בטקסט הממוסך מצביע בדיוק על אותו מקום במקור.
    """
    buf = list(text)

    def blank(start, end):
        for i in range(max(start, 0), min(end, len(buf))):
            if buf[i] != "\n":
                buf[i] = " "

    def current():
        return "".join(buf)

    for m in re.finditer(r"<!--.*?(?:-->|\Z)", text, re.S):
        blank(m.start(), m.end())

    s = current()
    for tag in NON_TEXT_TAGS:
        for m in re.finditer(rf"<{tag}\b[^>]*?(?:/>|>.*?(?:</{tag}\s*>|\Z))", s, re.S | re.I):
            blank(m.start(), m.end())

    # גלריה: בכל שורה, שם הקובץ עד ה-| הראשון (מה שאחריו הוא כיתוב).
    s = current()
    for m in re.finditer(r"(<gallery\b[^>]*>)(.*?)(?:</gallery\s*>|\Z)", s, re.S | re.I):
        pos = m.start(2)
        for line in m.group(2).split("\n"):
            bar = line.find("|")
            blank(pos, pos + (bar + 1 if bar >= 0 else len(line)))
            pos += len(line) + 1

    s = current()
    for m in re.finditer(r"</?[A-Za-z][^<>\n]*>", s):
        blank(m.start(), m.end())
    for m in re.finditer(r"\[(?:https?:|ftp:)?//[^\s\]]+|\bhttps?://[^\s\]|}<>]+", s):
        blank(m.start(), m.end())
    for m in re.finditer(r"__[A-Zא-ת_]+__|&[A-Za-z]+;|&#x?[0-9A-Fa-f]+;", s):
        blank(m.start(), m.end())
    for m in re.finditer(r"\b[A-Za-z-]+\s*=\s*(\"[^\"\n]*\"|'[^'\n]*')", s):
        blank(m.start(), m.end())

    _mask_links_and_templates(current(), blank)
    return current()


def _mask_links_and_templates(s, blank):
    """
    מעבר יחיד עם מחסנית, כדי לטפל נכון בקינון - `|` בתוך קישור שבתוך
    תבנית שייך לקישור, לא מפריד פרמטרים של התבנית.
    """
    stack = []   # [kind, start] - kind: "tpl" / "param" / "link" / "file"
    n = len(s)
    i = 0
    while i < n:
        top = stack[-1][0] if stack else None

        if s.startswith("{{{", i):
            stack.append(["param", i])
            i += 3
            continue
        if top == "param" and s.startswith("}}}", i):
            start = stack.pop()[1]
            blank(start, i + 3)
            i += 3
            continue
        if s.startswith("{{", i):
            stack.append(["tpl", i])
            end = i + 2
            while end < n and s[end] not in "|{}[\n" and not s.startswith("}}", end):
                end += 1
            blank(i, end)   # {{ + שם התבנית / פונקציית פרסר עם הארגומנט הראשון
            i = end
            continue
        if top == "tpl" and s.startswith("}}", i):
            stack.pop()
            blank(i, i + 2)
            i += 2
            continue
        if s.startswith("[[", i):
            end = i + 2
            while end < n and s[end] not in "|[]{\n":
                end += 1
            target = s[i + 2:end]
            ns = target.lstrip(":").split(":", 1)[0].strip().lower() if ":" in target else ""
            kind = "file" if ns in FILE_NAMESPACES and not target.startswith(":") else "link"
            has_pipe = end < n and s[end] == "|"
            if ns in CATEGORY_NAMESPACES and not target.startswith(":"):
                # שם הקטגוריה כן מוצג לקורא - רק הקידומת ומפתח המיון מוסתרים.
                blank(i, i + 2 + target.index(":") + 1)
                close = s.find("]]", end)
                close = n if close < 0 else close
                blank(end, close + 2)
                i = close + 2
                continue
            if kind == "file" or has_pipe or (ns and INTERWIKI_RE.match(ns)):
                blank(i, end + (1 if has_pipe else 0))
            else:
                blank(i, i + 2)   # [[ערך]] - שם הערך הוא הטקסט המוצג
            stack.append([kind, i])
            i = end + (1 if has_pipe else 0)
            if kind == "file":
                i = _blank_file_option(s, i, blank)
            continue
        if top in ("link", "file") and s.startswith("]]", i):
            stack.pop()
            blank(i, i + 2)
            i += 2
            continue
        if s[i] == "|" and top == "tpl":
            blank(i, i + 1)
            m = re.match(r"[^=|{}\[\]\n]*=", s[i + 1:])
            if m:
                blank(i + 1, i + 1 + m.end())
                i += m.end()
            i += 1
            continue
        if s[i] == "|" and top == "file":
            blank(i, i + 1)
            i = _blank_file_option(s, i + 1, blank)
            continue
        i += 1


def _blank_file_option(s, i, blank):
    end = i
    while end < len(s) and s[end] not in "|[]{\n":
        end += 1
    if FILE_OPTION_RE.match(s[i:end]):
        blank(i, end)
    return i


# ============================================================
# סריקה
# ============================================================

@dataclass
class Match:
    category: Category
    patterns: list      # כל התבניות (כפי שהן בדף הרשימה) שתפסו את אותו קטע
    start: int
    end: int
    text: str
    line: int
    context: str

    def to_dict(self):
        return {
            "category": self.category.key,
            "label": self.category.label,
            "color": self.category.color,
            "blocking": self.category.blocking,
            "patterns": self.patterns,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "line": self.line,
            "context": self.context,
        }


def _context(text, start, end, width=40):
    left = text[max(start - width, 0):start]
    right = text[end:end + width]
    return (left + "【" + text[start:end] + "】" + right).replace("\n", " ⏎ ")


def scan(wikitext, lists, scope="visible", categories=None, allowlist=()):
    """
    מחזיר [Match] ממוין לפי מיקום.

    scope="visible" - רק טקסט שהקורא רואה (ראו mask_wikitext); הקטגוריות
    ב-RAW_SCOPE_CATEGORIES רצות תמיד על הטקסט הגולמי.
    scope="raw" - כל הוויקיטקסט, כמו בבומח.
    categories - קבוצת מפתחות קטגוריה (None = הכל).
    allowlist - ביטויים רגולריים; התאמה שכולה בתוך התאמה של אחד מהם
    לא מדווחת.
    """
    masked = mask_wikitext(wikitext) if scope == "visible" else wikitext
    allowed = []
    for pattern in allowlist:
        allowed.extend((m.start(), m.end()) for m in re.finditer(pattern, wikitext, re.IGNORECASE))

    by_span = {}   # (category, start, end) -> Match
    for p in lists.patterns:
        if p.regex is None or (categories is not None and p.category.key not in categories):
            continue
        haystack = wikitext if p.category.key in RAW_SCOPE_CATEGORIES else masked
        for m in p.regex.finditer(haystack):
            start, end = m.span()
            # תבניות כמו `(\s|^)זונה` כוללות את הרווח שלפני - לא חלק מהמילה.
            while start < end and haystack[start].isspace():
                start += 1
            while end > start and haystack[end - 1].isspace():
                end -= 1
            if start == end:
                continue
            if any(a <= start and end <= b for a, b in allowed):
                continue
            key = (p.category.key, start, end)
            if key in by_span:
                if p.source not in by_span[key].patterns:
                    by_span[key].patterns.append(p.source)
                continue
            by_span[key] = Match(
                p.category, [p.source], start, end, wikitext[start:end],
                wikitext.count("\n", 0, start) + 1, _context(wikitext, start, end),
            )
    return sorted(by_span.values(), key=lambda m: (m.start, m.end, m.category.key))


def is_clean(wikitext, lists, scope="visible", allowlist=()):
    """True אם אין אף התאמה בקטגוריה חוסמת (אדום כהה / בומח-צניעות)."""
    blocking = {c.key for c in lists.categories() if c.blocking}
    return not scan(wikitext, lists, scope, blocking, allowlist)


# ============================================================
# CLI
# ============================================================

def _print_report(matches, title):
    print(f"== {title}: {len(matches)} התאמות ==")
    by_category = {}
    for m in matches:
        by_category.setdefault(m.category, []).append(m)
    for category, items in by_category.items():
        flag = " (חוסם)" if category.blocking else ""
        print(f"\n--- {category.label}{flag}: {len(items)} ---")
        for m in items:
            print(f"  שורה {m.line}: {m.text!r}  [{' | '.join(m.patterns)}]")
            print(f"      {m.context}")


def _print_lists_report(lists):
    print(f"תבניות פעילות: {sum(1 for p in lists.patterns if p.regex is not None)}")
    fixed = [p for p in lists.patterns if p.fix_reason]
    print(f"\nתבניות שתוקנו ({len(fixed)}):")
    for p in fixed:
        print(f"  [{p.category.label}] {p.source}  ->  {p.effective}\n      {p.fix_reason}")
    print(f"\nבעיות ({len(lists.problems)}):")
    for key, source, message in lists.problems:
        print(f"  [{key}] {source!r}: {message}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="סריקת ויקיטקסט לפי רשימות המילים החשודות של המכלול")
    what = parser.add_mutually_exclusive_group(required=True)
    what.add_argument("--title", help="שם דף לסריקה")
    what.add_argument("--file", help="קובץ ויקיטקסט לסריקה ('-' = קלט סטנדרטי)")
    what.add_argument("--check-lists", action="store_true", help="הצג תיקונים ובעיות ברשימות")
    parser.add_argument("--wiki", choices=["wikipedia", "mechalol"], default="wikipedia")
    parser.add_argument("--lists", choices=["live", "snapshot"], default="live",
                        help="מקור הרשימות (ברירת מחדל: הדפים החיים במכלול)")
    parser.add_argument("--scope", choices=["visible", "raw"], default="visible")
    parser.add_argument("--only-blocking", action="store_true", help="רק קטגוריות חוסמות")
    parser.add_argument("--allow", action="append", default=[], help="ביטוי רגולרי מותר (אפשר כמה פעמים)")
    parser.add_argument("--json", action="store_true", help="פלט JSON")
    args = parser.parse_args(argv)

    import requests

    try:
        lists = load_lists(args.lists)
        if args.title:
            api = MECHALOL_API if args.wiki == "mechalol" else WIKIPEDIA_API
            wikitext = fetch_raw(api, args.title)
    except (requests.RequestException, LookupError) as exc:
        print(f"שגיאה בקריאה מהאתר: {exc}", file=sys.stderr)
        if args.lists == "live":
            print("אפשר להריץ עם --lists snapshot כדי להשתמש בעותק המקומי של הרשימות.", file=sys.stderr)
        return 2

    if args.check_lists:
        _print_lists_report(lists)
        return 0

    if args.title:
        title = args.title
    elif args.file == "-":
        wikitext, title = sys.stdin.read(), "stdin"
    else:
        with open(args.file, encoding="utf-8") as f:
            wikitext, title = f.read(), args.file

    categories = {c.key for c in lists.categories() if c.blocking} if args.only_blocking else None
    matches = scan(wikitext, lists, args.scope, categories, args.allow)

    if args.json:
        json.dump([m.to_dict() for m in matches], sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        _print_report(matches, title)
    return 1 if any(m.category.blocking for m in matches) else 0


if __name__ == "__main__":
    sys.exit(main())
