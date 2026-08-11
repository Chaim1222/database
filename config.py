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

BATCH_SIZE = 500
REQUEST_DELAY_SECONDS = 0.2
