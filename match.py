"""
שלב ההתאמה: מריץ לאחר fetch_wikipedia.py ו-fetch_mechalol.py.
מתאים בין הכותרות בשתי הטבלאות, וקובע לכל ערך במכלול את match_type:

- אם נמצאה כותרת זהה בוויקיפדיה:
    - וסטטוס הערך במכלול הוא מיובא_מתועד / מיובא_ללא_תיעוד -> match_type = "מיובא"
    - וסטטוס הערך במכלול הוא נוצר_במכלול -> match_type = "כותרת_זהה_בלי_קשר"
- אם לא נמצאה כותרת תואמת -> match_type = "ללא_התאמה"

שימוש:
    python match.py
"""

from config import BATCH_SIZE
from supabase_client import get_client


def load_wikipedia_title_map(client):
    """
    שליפת כל הכותרות מטבלת wikipedia_pages, עם עימוד, כדי לא לחרוג ממגבלת שורות לבקשה.
    מחזיר מיפוי כותרת -> מזהה_שורה (id בטבלה, לא page_id).
    """
    title_map = {}
    offset = 0
    while True:
        result = (
            client.table("wikipedia_pages")
            .select("id, title")
            .range(offset, offset + BATCH_SIZE - 1)
            .execute()
        )
        rows = result.data
        if not rows:
            break
        for row in rows:
            title_map[row["title"]] = row["id"]
        offset += BATCH_SIZE
        if len(rows) < BATCH_SIZE:
            break
    return title_map


def iter_mechalol_rows(client):
    offset = 0
    while True:
        result = (
            client.table("mechalol_pages")
            .select("id, title, status")
            .range(offset, offset + BATCH_SIZE - 1)
            .execute()
        )
        rows = result.data
        if not rows:
            break
        yield rows
        offset += BATCH_SIZE
        if len(rows) < BATCH_SIZE:
            break


def main():
    client = get_client()

    print("טוען את כל כותרות ויקיפדיה לזיכרון...")
    wikipedia_titles = load_wikipedia_title_map(client)
    print(f"נטענו {len(wikipedia_titles)} כותרות")

    total = 0
    matched = 0

    for batch in iter_mechalol_rows(client):
        updates = []
        for row in batch:
            wikipedia_id = wikipedia_titles.get(row["title"])

            if wikipedia_id is None:
                match_type = "ללא_התאמה"
            elif row["status"] == "נוצר_במכלול":
                match_type = "כותרת_זהה_בלי_קשר"
            else:
                match_type = "מיובא"
                matched += 1

            # אם הערך מסומן כמיובא (לא נוצר במכלול) ואין לו התאמה בוויקיפדיה הנוכחית -
            # ייתכן שהמקור נמחק או הועבר שם. רק סימון, לא מחיקה בשום מקום.
            maybe_deleted = row["status"] != "נוצר_במכלול" and wikipedia_id is None

            updates.append({
                "id": row["id"],
                "wikipedia_id": wikipedia_id,
                "match_type": match_type,
                "אולי_נמחק_בוויקיפדיה": maybe_deleted,
            })

        # upsert לפי id: מעדכן רק את השדות שסופקו, בבקשה אחת לכל המנה
        client.table("mechalol_pages").upsert(updates, on_conflict="id").execute()

        total += len(batch)
        print(f"עודכנו {total} ערכים עד כה")

    print(f"סיום. {matched} ערכים סומנו כמיובאים מתוך {total}")


if __name__ == "__main__":
    main()
