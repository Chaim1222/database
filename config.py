"""
Shared configuration for all process scripts.
Sensitive values are loaded from environment variables.
"""
import os

WIKIPEDIA_API = "https://he.wikipedia.org/w/api.php"
MECHALOL_API = "https://www.hamichlol.org.il/w/api.php"

USER_AGENT = (
    "MechalolWikipediaCompareBot/1.0 "
    "(https://www.hamichlol.org.il/; "
    "geon@hamichlol.org.il)"
)
REQUEST_HEADERS = {"User-Agent": USER_AGENT}

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

CATEGORY_CREATED_IN_MECHALOL = (
    "קטגוריה:המכלול: ערכים שנוצרו במכלול"
)
CATEGORY_PIRUSHONIM_CREATED_IN_MECHALOL = (
    "קטגוריה:המכלול: פירושונים שנוצרו במכלול"
)
CATEGORY_TRANSLATED_IN_MECHALOL = (
    "קטגוריה:המכלול: ערכים שתורגמו במכלול"
)
CATEGORY_MISSING_SORT_TEMPLATE = (
    "קטגוריה:המכלול: ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה"
)
LAST_UPDATE_CATEGORY_PREFIX = (
    "קטגוריה:המכלול: ערכים שעודכנו לאחרונה ב"
)
CATEGORY_PAGES_TO_OPEN = "קטגוריה:ערכים לפתיחה"
CATEGORY_DICTIONARY_ENTRIES = "קטגוריה:המכלול: ערכים מילוניים"
CATEGORY_IMPORTED_FROM_CHABADPEDIA = (
    'קטגוריה:המכלול: דפים שיובאו מחב"דפדיה'
)
CATEGORY_IMPORTED_FROM_WIKISHIVA = (
    "קטגוריה:המכלול: דפים שיובאו מויקישיבה"
)
CATEGORY_DELETED_ON_WIKIPEDIA_KEPT = (
    "קטגוריה:המכלול: ערכים שנמחקו בוויקיפדיה"
)
CATEGORY_SPLIT_FROM_WIKIPEDIA = (
    "קטגוריה:המכלול: ערכים מוויקיפדיה שפוצלו במכלול"
)

BATCH_SIZE = 500
REQUEST_DELAY_SECONDS = 0.2

# גודל אצווה לקריאת API אחת (titles=a|b|c...) בבדיקת {{מיון ויקיפדיה}}.
# 50 = חשבון רגיל. 500 = חשבון עם דגל בוט/סיסופ במכלול.
# יש לעדכן בהתאם לחשבון שמריץ את match.py.
API_BATCH_SIZE_TEMPLATE_CHECK = 50

# תוויות סטטוס - עברית מדוברת רשמית, ללא קווים תחתונים.
# חשוב: אלה חייבות להיות תואמות בדיוק ל-CHECK constraint על העמודה
# בסופרבייס (ראו migration_add_chabadpedia_status.sql). כל שינוי כאן
# דורש מיגרציה מקבילה ב-DB, אחרת ה-INSERT/UPDATE ייכשל.
STATUS_CREATED_IN_MECHALOL = "נוצר במכלול"
STATUS_IMPORTED_DOCUMENTED = "מיובא ומתועד"
STATUS_IMPORTED_UNDOCUMENTED = "מיובא ללא תיעוד"
STATUS_IMPORTED_FROM_CHABADPEDIA = 'ייבוא מחב"דפדיה'
STATUS_IMPORTED_FROM_WIKISHIVA = "ייבוא מוויקישיבה"
STATUS_KEPT_AFTER_WIKIPEDIA_DELETION = "נשמר במכלול למרות מחיקה בוויקיפדיה"
STATUS_SPLIT_FROM_WIKIPEDIA = "פוצל מתוכן ויקיפדי"

# סטטוסים שבהם כותרת זהה לוויקיפדיה היא צירוף מקרים בלבד, לא עדות
# לייבוא אמיתי - נוצר עצמאית במכלול, או יובא ממקור אחר (חב"דפדיה/ויקישיבה),
# או פוצל מתוכן ויקיפדי לכותרת חדשה שמעולם לא הייתה קיימת שם (הכותרת
# עצמה "נוצרה במכלול" לצורך כל בדיקה טכנית - רק מקור התוכן/זכויות
# היוצרים שונה, ונשמר כסטטוס נפרד לצורך תיעוד ומעקב, לא לצורך התאמה).
# בכוונה לא כולל STATUS_KEPT_AFTER_WIKIPEDIA_DELETION - שם הכותרת כן
# מייצגת ייבוא אמיתי-היסטורי מוויקיפדיה (רק שהערך שם כבר לא קיים),
# ולכן אם אי-פעם תימצא בכל זאת התאמה (למשל הערך נוצר מחדש בוויקיפדיה),
# זו התאמה אמיתית ולא צירוף מקרים - ראו get_match_type.
# מקור אמת יחיד: match.py (get_match_type) קורא מכאן, כדי שלא יתפצל
# שוב כמו שקרה עם התווית הישנה בקו תחתון.
NOT_REALLY_IMPORTED_STATUSES = (
    STATUS_CREATED_IN_MECHALOL,
    STATUS_IMPORTED_FROM_CHABADPEDIA,
    STATUS_IMPORTED_FROM_WIKISHIVA,
    STATUS_SPLIT_FROM_WIKIPEDIA,
)

# סטטוסים שבהם אין טעם לחפש/להתריע על חוסר התאמה לוויקיפדיה - כולל גם
# את NOT_REALLY_IMPORTED_STATUSES (מקור לא-ויקיפדי מלכתחילה), וגם
# STATUS_KEPT_AFTER_WIKIPEDIA_DELETION (מקור ויקיפדי היסטורית, אבל
# ידוע מראש וללא צורך בהתרעה - הוחלט במפורש להשאיר במכלול). בשימוש
# ב-match.py (should_reexamine + מניעת maybe_deleted_from_wikipedia)
# וב-check_wikipedia_deletions.py (החרגה מ-deleted_from_wikipedia).
WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES = NOT_REALLY_IMPORTED_STATUSES + (
    STATUS_KEPT_AFTER_WIKIPEDIA_DELETION,
)

MATCH_TYPE_IMPORTED = "יובא מוויקיפדיה"
MATCH_TYPE_SAME_TITLE_UNRELATED = "כותרת זהה ללא קשר"
MATCH_TYPE_NO_MATCH = "ללא התאמה"
