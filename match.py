"""
שלב ההתאמה: מריץ לאחר fetch_wikipedia.py ו-fetch_mechalol.py.
מתאים בין הכותרות בשתי הטבלאות, וקובע לכל ערך במכלול את match_type.

חשוב:
לא משתמשים ב-upsert של רשומות חלקיות. upsert מתייחס לרשומה חסרה גם כאל INSERT,
ולכן עמודות NOT NULL כמו title/status עלולות לקבל NULL.
במקום זאת אנחנו טוענים את הרשומה המלאה ומבצעים upsert עם כל השדות הקיימים.
"""

import time
from datetime import datetime, timezone

from config import BATCH_SIZE
from supabase_client import get_client


MAX_RETRIES = 5
RETRY_DELAY = 3


def log(message):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{now}] {message}", flush=True)


def execute_with_retry(operation, description):
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return operation()
        except Exception as exc:
            last_error = exc
            if attempt >= MAX_RETRIES:
                log(f"ERROR | {description} | נכשל אחרי {MAX_RETRIES} ניסיונות: {exc}")
                raise
            log(
                f"WARNING | {description} | ניסיון {attempt}/{MAX_RETRIES} נכשל: {exc}. "
                f"ממתין {RETRY_DELAY} שניות..."
            )
            time.sleep(RETRY_DELAY)
    raise last_error


def load_wikipedia_title_map(client):
    """שליפת כל הכותרות מטבלת wikipedia_pages עם עימוד."""
    title_map = {}
    offset = 0
    batch_number = 0

    while True:
        batch_number += 1
        result = execute_with_retry(
            lambda: (
                client.table("wikipedia_pages")
                .select("id, title")
                .range(offset, offset + BATCH_SIZE - 1)
                .execute()
            ),
            f"שליפת ויקיפדיה batch {batch_number}",
        )

        rows = result.data or []
        if not rows:
            break

        for row in rows:
            title = row.get("title")
            if title:
                title_map[title] = row["id"]

        offset += len(rows)
        log(f"WIKIPEDIA | נטענו {len(title_map):,} כותרות עד כה")

        if len(rows) < BATCH_SIZE:
            break

    return title_map


def iter_mechalol_rows(client):
    """מחזיר batches מלאים של רשומות המכלול.

    חייבים לשלוף את כל השדות, משום שב-upsert כל שדה שלא נשלח עלול להיחשב
    כחסר ולהוביל ל-NULL בעמודות NOT NULL.
    """
    offset = 0
    batch_number = 0

    while True:
        batch_number += 1
        result = execute_with_retry(
            lambda: (
                client.table("mechalol_pages")
                .select("*")
                .range(offset, offset + BATCH_SIZE - 1)
                .execute()
            ),
            f"שליפת המכלול batch {batch_number}",
        )

        rows = result.data or []
        if not rows:
            break

        yield rows
        offset += len(rows)

        if len(rows) < BATCH_SIZE:
            break


def main():
    started = time.monotonic()
    client = get_client()

    log("START | match.py")
    log("שלב 1/2 | טוען את כל כותרות ויקיפדיה לזיכרון...")
    wikipedia_titles = load_wikipedia_title_map(client)
    log(f"שלב 1/2 הסתיים | נטענו {len(wikipedia_titles):,} כותרות ויקיפדיה")

    total = 0
    matched = 0
    deleted_candidates = 0
    batch_number = 0

    log("שלב 2/2 | מתחיל התאמה של ערכי המכלול...")

    for batch in iter_mechalol_rows(client):
        batch_number += 1
        updates = []
        batch_matched = 0

        for row in batch:
            title = row.get("title")
            status = row.get("status")

            # הגנה מפני נתונים פגומים בבסיס הנתונים.
            # title אמור להיות NOT NULL, אבל לא ניתן לבצע התאמה בלעדיו.
            if not title:
                log(
                    f"WARNING | batch {batch_number} | נמצאה רשומת id={row.get('id')} ללא title. "
                    "מדלג עליה ולא משנה אותה."
                )
                continue

            wikipedia_id = wikipedia_titles.get(title)

            if wikipedia_id is None:
                match_type = "ללא_התאמה"
            elif status == "נוצר_במכלול":
                match_type = "כותרת_זהה_בלי_קשר"
            else:
                match_type = "מיובא"
                matched += 1
                batch_matched += 1

            maybe_deleted = status != "נוצר_במכלול" and wikipedia_id is None
            if maybe_deleted:
                deleted_candidates += 1

            # משמרים את כל השדות הקיימים ומעדכנים רק את שדות ההתאמה.
            updated_row = dict(row)
            updated_row["wikipedia_id"] = wikipedia_id
            updated_row["match_type"] = match_type
            updated_row["maybe_deleted_from_wikipedia"] = maybe_deleted
            updates.append(updated_row)

        if updates:
            execute_with_retry(
                lambda: client.table("mechalol_pages").upsert(
                    updates, on_conflict="id"
                ).execute(),
                f"עדכון התאמות batch {batch_number}",
            )

        total += len(batch)
        log(
            f"PROGRESS | batch {batch_number} | "
            f"עודכנו {total:,} ערכים | "
            f"התאמות במנה: {batch_matched:,} | "
            f"סה\"כ מיובאים: {matched:,} | "
            f"חשודים במחיקה/פער: {deleted_candidates:,}"
        )

    elapsed = time.monotonic() - started
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    log(
        f"DONE | סיום התאמה | {total:,} ערכים נבדקו | "
        f"{matched:,} מיובאים | {deleted_candidates:,} ללא התאמה אצל מיובאים | "
        f"זמן ריצה: {minutes}m {seconds}s"
    )


if __name__ == "__main__":
    main()
