"""
שליפת כל כותרות הערכים במכלול, וקביעת סטטוס לכל ערך לפי עץ ההחלטה:

1. משויך (ישירות או דרך תת-קטגוריה) לקטגוריית "ערכים שנוצרו במכלול"
   -> status = נוצר_במכלול

2. אחרת, משויך (ישירות או דרך תת-קטגוריה) לקטגוריית
   "ערכים מוויקיפדיה ללא תבנית מיון ויקיפדיה"
   -> status = מיובא_ללא_תיעוד, ללא תאריך

3. אחרת -> status = מיובא_מתועד, עם תאריך שנשלף מקטגוריית
   "עודכנו לאחרונה ב-X" שהערך משויך אליה (אם נמצאה)

שימוש (הרצה ראשונית ומלאה):
    python fetch_mechalol.py
"""

import json
import os
import re
import time

import requests

from config import (
    MECHALOL_API,
    BATCH_SIZE,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    CATEGORY_CREATED_IN_MECHALOL,
    CATEGORY_MISSING_SORT_TEMPLATE,
    LAST_UPDATE_CATEGORY_PREFIX,
    CATEGORY_PAGES_TO_OPEN,
    CATEGORY_DICTIONARY_ENTRIES,
)
from supabase_client import get_client

PROGRESS_FILE = "mechalol_progress.json"

HEBREW_MONTHS = {
    "ינואר": "01", "פברואר": "02", "מרץ": "03", "אפריל": "04",
    "מאי": "05", "יוני": "06", "יולי": "07", "אוגוסט": "08",
    "ספטמבר": "09", "אוקטובר": "10", "נובמבר": "11", "דצמבר": "12",
}


def api_get(params):
    params = {**params, "format": "json"}
    response = requests.get(MECHALOL_API, params=params, headers=REQUEST_HEADERS, timeout=30)
    response.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    return response.json()


def get_category_members(category_title, member_type="page"):
    """
    שליפת כל החברים הישירים בקטגוריה נתונה (עמודים או תת-קטגוריות), בעימוד.
    member_type: "page" לערכים, "subcat" לתתי-קטגוריות
    """
    cmcontinue = None
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": category_title,
            "cmtype": member_type,
            "cmlimit": BATCH_SIZE,
        }
        if cmcontinue:
            params["cmcontinue"] = cmcontinue

        data = api_get(params)
        members = data.get("query", {}).get("categorymembers", [])
        for m in members:
            yield m["title"], m["pageid"]

        cmcontinue = data.get("continue", {}).get("cmcontinue")
        if not cmcontinue:
            break


def get_all_pages_in_tree(root_category, _seen_categories=None):
    """
    איסוף רקורסיבי של כל כותרות הערכים תחת קטגוריה, כולל כל תתי-הקטגוריות שלה.
    """
    if _seen_categories is None:
        _seen_categories = set()
    if root_category in _seen_categories:
        return
    _seen_categories.add(root_category)

    for title, page_id in get_category_members(root_category, "page"):
        yield title, page_id

    for subcat_title, _ in get_category_members(root_category, "subcat"):
        yield from get_all_pages_in_tree(subcat_title, _seen_categories)


def parse_month_from_category(category_title):
    """
    "קטגוריה:המכלול: ערכים שעודכנו לאחרונה במרץ 2021" -> "2021-03"
    מחזיר None אם התבנית לא זוהתה.
    """
    match = re.search(r"ב([א-ת]+)\s+(\d{4})", category_title)
    if not match:
        return None
    month_name, year = match.groups()
    month_num = HEBREW_MONTHS.get(month_name)
    if not month_num:
        return None
    return f"{year}-{month_num}"


def get_last_update_map():
    """
    מיפוי כותרת_ערך -> חודש_עדכון ("YYYY-MM"), לפי עץ קטגוריות "עודכן לאחרונה ב-X".
    שולף רק פעם אחת את כל תתי-הקטגוריות ואת חבריהן.
    """
    result = {}
    root = "קטגוריה:המכלול: ערכים לפי תאריך עדכון"

    subcats = list(get_category_members(root, "subcat"))
    for subcat_title, _ in subcats:
        month = parse_month_from_category(subcat_title)
        if not month:
            continue
        for page_title, _ in get_category_members(subcat_title, "page"):
            result[page_title] = month

    return result


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("apcontinue")
    return None


def save_progress(apcontinue):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump({"apcontinue": apcontinue}, f)


def clear_progress():
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)


def fetch_all_titles():
    apcontinue = load_progress()
    while True:
        params = {
            "action": "query",
            "list": "allpages",
            "apnamespace": 0,
            "apfilterredir": "nonredirects",  # לא כולל הפניות - רק ערכים בפועל
            "aplimit": BATCH_SIZE,
        }
        if apcontinue:
            params["apcontinue"] = apcontinue

        data = api_get(params)
        pages = data.get("query", {}).get("allpages", [])
        yield [(p["title"], p["pageid"]) for p in pages]

        apcontinue = data.get("continue", {}).get("apcontinue")
        save_progress(apcontinue)
        if not apcontinue:
            break


def main():
    client = get_client()

    print("שולף רשימת ערכים שנוצרו במכלול...")
    created_in_mechalol = {title for title, _ in get_all_pages_in_tree(CATEGORY_CREATED_IN_MECHALOL)}
    print(f"נמצאו {len(created_in_mechalol)} ערכים שנוצרו במכלול")

    print("שולף רשימת ערכים ללא תבנית מיון ויקיפדיה...")
    missing_sort_template = {title for title, _ in get_all_pages_in_tree(CATEGORY_MISSING_SORT_TEMPLATE)}
    print(f"נמצאו {len(missing_sort_template)} ערכים ללא תבנית מיון")

    print("שולף מיפוי תאריכי עדכון אחרון...")
    last_update_map = get_last_update_map()
    print(f"נמצא תאריך עדכון עבור {len(last_update_map)} ערכים")

    print("שולף רשימת דפים לטיפול (ללא תוכן)...")
    pages_to_open = {title for title, _ in get_all_pages_in_tree(CATEGORY_PAGES_TO_OPEN)}
    print(f"נמצאו {len(pages_to_open)} דפים לטיפול")

    print("שולף רשימת ערכים מילוניים...")
    dictionary_entries = {title for title, _ in get_all_pages_in_tree(CATEGORY_DICTIONARY_ENTRIES)}
    print(f"נמצאו {len(dictionary_entries)} ערכים מילוניים")

    total = 0
    for batch in fetch_all_titles():
        rows = []
        for title, page_id in batch:
            if title in created_in_mechalol:
                status = "נוצר_במכלול"
                last_update_month = None
            elif title in missing_sort_template:
                status = "מיובא_ללא_תיעוד"
                last_update_month = None
            else:
                status = "מיובא_מתועד"
                last_update_month = last_update_map.get(title)

            rows.append({
                "title": title,
                "page_id": page_id,
                "status": status,
                "last_update_month": last_update_month,
                # match_type ייקבע בשלב ההתאמה מול ויקיפדיה (match.py), לא כאן
                "match_type": "ללא_התאמה",
                "דף_לטיפול": title in pages_to_open,
                "מילוני": title in dictionary_entries,
            })

        client.table("mechalol_pages").upsert(rows, on_conflict="page_id").execute()
        total += len(rows)
        print(f"נטענו {total} ערכים עד כה")

    clear_progress()
    print(f"סיום. סה\"כ {total} ערכים נטענו מהמכלול")


if __name__ == "__main__":
    main()
