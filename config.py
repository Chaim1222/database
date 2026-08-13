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

# סטטוסים שבהם כותרת זהה לוויקיפדיה היא צירוף מקרים בלבד, לא עדות
# לייבוא אמיתי - נוצר עצמאית במכלול, או יובא ממקור אחר (חב"דפדיה).
# מקור אמת יחיד: גם match.py (get_match_type) וגם
# check_wikipedia_deletions.py (החרגה מ-deleted_from_wikipedia) קוראים
# מכאן, כדי שלא יתפצלו שוב כמו שקרה עם התווית הישנה בקו תחתון.
NOT_REALLY_IMPORTED_STATUSES = (STATUS_CREATED_IN_MECHALOL, STATUS_IMPORTED_FROM_CHABADPEDIA)

MATCH_TYPE_IMPORTED = "יובא מוויקיפדיה"
MATCH_TYPE_SAME_TITLE_UNRELATED = "כותרת זהה ללא קשר"
MATCH_TYPE_NO_MATCH = "ללא התאמה"
