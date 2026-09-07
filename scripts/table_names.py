import os

_SUFFIX = os.environ.get("TARGET_TABLE_SUFFIX", "")

# מיפוי שמות פונקציות RPC שיש להן החלפה שונה בשם (לא רק סיומת) כשרצים
# על הטבלאות הזמניות:
# - recompute_missing_flag -> גרסת-הזמנית הייעודית (ראו שלב 3.5 בתכנון).
# - truncate_wikipedia_pages -> מרוקנת את שתי הטבלאות הזמניות יחד
#   (truncate_temp_pages, ראו שלב 6 בתכנון) - נקראת פעם אחת בלבד,
#   מ-fetch_wikipedia.py, כרשת ביטחון בתחילת סבב (הן כבר אמורות להיות
#   ריקות מסוף הסבב הקודם). שימו לב: truncate_mechalol_pages *לא*
#   מופיעה כאן בכוונה - בסבב זמני לא קוראים לה בכלל (ראו is_temp_mode()
#   ושימושו ב-fetch_mechalol.py), לא ממפים אותה לפונקציה חלופית.
_RPC_TEMP_OVERRIDES = {
    "recompute_missing_flag": "recompute_missing_flag_temp",
    "truncate_wikipedia_pages": "truncate_temp_pages",
}


def is_temp_mode() -> bool:
    """
    True כש-TARGET_TABLE_SUFFIX מוגדר (סבב מילוי הטבלאות הזמניות),
    False בריצה הרגילה על הטבלאות הפעילות. שימושי במקומות שבהם
    הלוגיקה משתנה לגמרי בסבב זמני, לא רק שם הטבלה/פונקציה
    (למשל: fetch_mechalol.py מדלג על ריקון לגמרי בסבב זמני).
    """
    return bool(_SUFFIX)


def table_name(base: str) -> str:
    """
    מחזיר את שם הטבלה בפועל לכתיבה/קריאה - הבסיסי בריצה הרגילה על
    הטבלאות הפעילות, עם הסיומת "_temp" כש-TARGET_TABLE_SUFFIX=_temp
    (מוגדר כמשתנה סביבה בצעד ה-workflow שממלא את הטבלה הזמנית). מונע
    שגיאות הקלדה עתידיות ומרכז את כל הלוגיקה במקום אחד.
    """
    return f"{base}{_SUFFIX}"


def rpc_name(base: str) -> str:
    """
    מחזיר את שם פונקציית ה-RPC בפועל לקריאה. כשרצים על הטבלאות
    הזמניות (TARGET_TABLE_SUFFIX="_temp") ולפונקציה יש גרסה זמנית
    ייעודית ב-_RPC_TEMP_OVERRIDES, מוחזר השם החלופי. אחרת מוחזר השם
    הבסיסי ללא שינוי (למשל פונקציות טהורות שלא תלויות בשם טבלה).
    """
    if _SUFFIX and base in _RPC_TEMP_OVERRIDES:
        return _RPC_TEMP_OVERRIDES[base]
    return base


def current_suffix() -> str:
    """
    מחזיר את הסיומת הגולמית (""/"_temp") - לשימוש במקומות שצריכים
    להעביר אותה כפרמטר לפונקציית RPC גנרית (כמו analyze_pages_tables),
    ולא רק לבנות שם טבלה מקומי. עדיפות ל-table_name()/rpc_name() בכל
    מקום אחר - זה רק למקרה שבו הפונקציה עצמה מקבלת סיומת כארגומנט.
    """
    return _SUFFIX
