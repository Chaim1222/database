"""
כללי נרמול כותרות: מכלול -> ויקיפדיה, כיוון אחד בלבד.

כל כלל מקבל כותרת (אחרי hygiene) ומחזיר (כותרת_חדשה, האם_השתנה, שם_הכלל).
חוק "הרב/רבי" הוסר במפורש (החלטת המשתמש) - לא מיושם כאן.
"""

import re
import unicodedata

FINAL_LETTERS = {"כ": "ך", "מ": "ם", "נ": "ן", "פ": "ף", "צ": "ץ"}

DIRECTIONAL_MARKS = "\u200e\u200f\u061c\u202a\u202b\u202c\u202d\u202e"

QUOTE_MAP = {"״": '"', "׳": "'", "“": '"', "”": '"', "‘": "'", "’": "'"}

DASH_CHARS = "\u2010\u2011\u2012\u2013\u2014\u05be"


def hygiene(title):
    """
    נרמול טקסטואלי זול - לא סמנטי, לא כיווני. משפיע על מפתח ההשוואה בלבד,
    לא על הכותרת המאוחסנת.
    """
    if not title:
        return title

    value = unicodedata.normalize("NFC", title)

    for ch in DIRECTIONAL_MARKS:
        value = value.replace(ch, "")

    for src, dst in QUOTE_MAP.items():
        value = value.replace(src, dst)

    for ch in DASH_CHARS:
        value = value.replace(ch, "-")

    value = value.replace("\u00a0", " ")
    value = re.sub(r"\s+", " ", value).strip()

    return value


# ---------------------------------------------------------------------------
# כללים סמנטיים - מכלול -> ויקיפדיה בלבד
# ---------------------------------------------------------------------------

def rule_quoted_kadosh(t):
    new = re.sub(r'(["\'])(קדוש(?:ה|ים)?)\1', r"\2", t)
    return new, new != t, "מירכאות_קדוש"


def rule_elil_to_el(t):
    new = re.sub(r"(?<![א-ת])אליל([א-ת]*)", r"אל\1", t)
    return new, new != t, "אליל_לאל"


def rule_elohim_spelling(t):
    def repl(m):
        return "אלוה" + (m.group(1) or "")

    new = re.sub(
        r"(?<![א-ת])אלוק(ים|י|ינו|יכם|יכן|יו|יה)?(?![א-ת])",
        repl,
        t,
    )
    new = re.sub(
        r"(?<![א-ת])אלק(ים|י|ינו|יכם|יכן|יו|יה)?(?![א-ת])",
        repl,
        new,
    )
    return new, new != t, "כתיב_אלוהים"


def rule_break_hyphen(t):
    # רק שני הצירופים הספציפיים שביקשת - לא כל מקף בין אותיות עבריות
    # (יש הרבה מקפים לגיטימיים בכותרות, כמו שמות מורכבים).
    # בלי גבולות מילה בכוונה - כדי לתפוס גם "א-לוהים" (המקף אחרי האות
    # הראשונה של המילה, לא בין שתי מילים).
    new = t.replace("א-ל", "אל")
    new = new.replace("י-ה", "יה")
    return new, new != t, "מקף_שובר"


def rule_hebrew_year_final_letter(t):
    """
    שנה עברית מלאה עם קידומת אלפים: אות(א-ה) + גרש + אותיות (משתנה) +
    גרשיים + אות אחרונה. הגרשיים תמיד לפני האות האחרונה, לא אחריה
    (לדוגמה: ה'תש"ף). בוויקיפדיה האות האחרונה נכתבת בצורתה הסופית אם
    היא שייכת למנצפ"ך; במכלול היא נכתבת כאות רגילה. מאומת מול הכותרת
    האמיתית של הערך "ה'תש"ף" בוויקיפדיה העברית.
    """
    def repl(m):
        prefix, letter = m.group(1), m.group(2)
        return prefix + FINAL_LETTERS.get(letter, letter)

    new = re.sub(r"([א-ה]'[א-ת]+\")([כמנפצ])(?![א-ת])", repl, t)
    return new, new != t, "אות_סופית_שנה"


def rule_biblical_figure(t):
    new = t.replace('(אישיות מהתנ"ך)', "(דמות מקראית)")
    return new, new != t, "דמות_מקראית"


def rule_yeshu(t):
    new = t.replace("אותו האיש", "ישו")
    return new, new != t, "ישו"


def rule_center_to_synagogue(t):
    # לא רק בתחילת הכותרת, ולא דורש ה' הידיעה לפני "מרכז".
    new = re.sub(
        r"מרכז ה(נאולוגי|רפורמי|קראי|קונסרבטיבי)",
        r"בית הכנסת ה\1",
        t,
    )
    return new, new != t, "מרכז_לבית_כנסת"


def rule_korban(t):
    new = re.sub(r"(?<![א-ת])קרבן", "קורבן", t)
    return new, new != t, "קרבן_לקורבן"


# סדר ההפעלה לא קריטי - הכללים פועלים על מקטעים שונים של הכותרת.
STANDARD_RULES = [
    rule_quoted_kadosh,
    rule_elil_to_el,
    rule_elohim_spelling,
    rule_break_hyphen,
    rule_hebrew_year_final_letter,
    rule_biblical_figure,
    rule_yeshu,
    rule_center_to_synagogue,
    rule_korban,
]


def normalize_title(title):
    """
    מפעיל hygiene + את כל הכללים הסמנטיים ברצף.
    מחזיר (כותרת_מנורמלת, [שמות_הכללים_שהופעלו]).
    הכותרת המקורית לעולם לא משתנה - זה רק לצורך התאמה.
    """
    t = hygiene(title)
    applied = []

    for rule in STANDARD_RULES:
        t, changed, name = rule(t)
        if changed:
            applied.append(name)

    return t, applied
