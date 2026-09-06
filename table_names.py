import os

_SUFFIX = os.environ.get("TARGET_TABLE_SUFFIX", "")

# מיפוי שמות פונקציות RPC שיש להן החלפה שונה בשם (לא רק סיומת) כשרצים
# על טבלאות המראה:
# - recompute_missing_flag -> גרסת-המראה הייעודית (ראו שלב 3.5 בתכנון).
# - truncate_wikipedia_pages -> הפונקציה המשולבת שגם "מקדמת" את העותק
#   previous מהסבב הקודם וגם מרוקנת (ראו שלב 6 בתכנון) - נקראת פעם
#   אחת בלבד, מ-fetch_wikipedia.py. שימו לב: truncate_mechalol_pages
#   *לא* מופיעה כאן בכוונה - בסבב מראה לא קוראים לה בכלל (ראו
#   is_shadow_mode() ושימושו ב-fetch_mechalol.py), לא ממפים אותה
#   לפונקציה חלופית.
_RPC_SHADOW_OVERRIDES = {
    "recompute_missing_flag": "recompute_missing_flag_shadow",
    "truncate_wikipedia_pages": "promote_previous_to_shadow_and_truncate",
}


def is_shadow_mode() -> bool:
    """
    True כש-TARGET_TABLE_SUFFIX מוגדר (סבב מילוי טבלאות המראה),
    False בריצה הרגילה על הטבלאות הפעילות. שימושי במקומות שבהם
    הלוגיקה משתנה לגמרי בסבב מראה, לא רק שם הטבלה/פונקציה
    (למשל: fetch_mechalol.py מדלג על ריקון לגמרי בסבב מראה).
    """
    return bool(_SUFFIX)


def table_name(base: str) -> str:
    """
    מחזיר את שם הטבלה בפועל לכתיבה/קריאה - הבסיסי בריצה הרגילה על
    הטבלאות הפעילות, עם הסיומת "_shadow" כש-TARGET_TABLE_SUFFIX=_shadow
    (מוגדר כמשתנה סביבה בצעד ה-workflow שממלא את המראה). מונע שגיאות
    הקלדה עתידיות ומרכז את כל הלוגיקה במקום אחד.
    """
    return f"{base}{_SUFFIX}"


def rpc_name(base: str) -> str:
    """
    מחזיר את שם פונקציית ה-RPC בפועל לקריאה. כשרצים על טבלאות המראה
    (TARGET_TABLE_SUFFIX="_shadow") ולפונקציה יש גרסת-מראה ייעודית
    ב-_RPC_SHADOW_OVERRIDES, מוחזר השם החלופי. אחרת מוחזר השם הבסיסי
    ללא שינוי (למשל פונקציות טהורות שלא תלויות בשם טבלה).
    """
    if _SUFFIX and base in _RPC_SHADOW_OVERRIDES:
        return _RPC_SHADOW_OVERRIDES[base]
    return base
