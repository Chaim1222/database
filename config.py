"""
הגדרות משותפות לכל סקריפטי התהליך.
כל הערכים הרגישים (מפתחות, כתובות) נטענים ממשתני סביבה,
כדי שיוגדרו כ-secrets בגיטהאב אקשנס ולא יופיעו בקוד עצמו.
"""

import os

# כתובת ה-API של ויקיפדיה העברית
WIKIPEDIA_API = "https://he.wikipedia.org/w/api.php"

# כתובת ה-API של המכלול
MECHALOL_API = "https://www.hamichlol.org.il/w/api.php"

# כותרת User-Agent מזהה - נדרשת על ידי שרתי ויקימדיה, אחרת מוחזרת שגיאת 403.
# לפי מדיניות ויקימדיה יש לכלול פרטי קשר; מומלץ להחליף לכתובת רלוונטית אצלך.
USER_AGENT = "MechalolWikipediaCompareBot/1.0 (https://www.hamichlol.org.il/; geon@hamichlol.org.il)"
REQUEST_HEADERS = {"User-Agent": USER_AGENT}

# פרטי חיבור לסופרבייס
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
# שמות הקטגוריות הרלוונטיות במכלול (ייתכן שיש לתקן/להשלים לפי הכותרות המדויקות באתר)
CATEGORY_CREATED_IN_MECHALOL = "קטגוריה:המכלול: ערכים שנוצרו במכלול"
CATEGORY_MISSING_SORT_TEMPLATE = "קטגוריה:המכלול: ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה"

# תבנית שם קטגוריית "עודכן לאחרונה ב-חודש שנה", לשימוש בסריקת חברי כל תת-קטגוריה
LAST_UPDATE_CATEGORY_PREFIX = "קטגוריה:המכלול: ערכים שעודכנו לאחרונה ב"

# כותרת קיימת אך אין תוכן בדף
CATEGORY_PAGES_TO_OPEN = "קטגוריה:ערכים לפתיחה"

# תקציר מיובא מוויקיפדיה, לא ערך מלא
CATEGORY_DICTIONARY_ENTRIES = "קטגוריה:המכלול: ערכים מילוניים"

# גודל עמוד (כמות תוצאות) לכל בקשת API
BATCH_SIZE = 500

# השהיה בין בקשות, כדי לא להעמיס על השרתים
REQUEST_DELAY_SECONDS = 0.2
