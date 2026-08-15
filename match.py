"""
התאמת כותרות מכלול מול ויקיפדיה.

סדר ההתאמה:
1. manual_match - קובע, לא נוגעים.
2. היגיינת טקסט (השוואה אחרי ניקוי תווי כיווניות/גרשיים/מקפים - לא משנה
   את הכותרת המאוחסנת).
3. נרמול סמנטי (מכלול -> ויקיפדיה בלבד, ראו normalize.py).
4. {{מיון ויקיפדיה|דף=...}} - קריאת API באצוות, מוצא אחרון בלבד.

normalization_checked=true אומר שהשורה כבר עברה את כל התהליך בעבר. זה
*לא* אומר שריצות עתידיות ידלגו עליה תמיד - ראו get_should_reexamine():
- אם נמצאה התאמה (wikipedia_id) וכותרת המכלול לא זזה מאז (matched_title)
  - דילוג לצמיתות (אין טעם, כלום לא השתנה).
- אם אין התאמה אבל ה-status ודאי לא-ויקיפדי (NOT_REALLY_IMPORTED_STATUSES:
  נוצר במכלול/חב"דפדיה/ויקישיבה) - דילוג לצמיתות (לא רלוונטי לחיפוש
  מלכתחילה). "נשמר במכלול למרות מחיקה בוויקיפדיה" בכוונה *לא* נכלל כאן
  - הוא ממשיך להיבדק בכל ריצה, כדי לאפשר ריפוי עצמי אוטומטי אם הערך
  ייווצר מחדש בוויקיפדיה (ראו should_reexamine).
- אחרת (הכותרת השתנתה מאז ההתאמה, או שאין התאמה ומקור ויקיפדיה/לא-ידוע)
  - בדיקה מחדש בכל ריצה.
manual_match=true תמיד מדלג ללא תנאי, בלי קשר לכל האמור לעיל.

חשוב: fetch_mechalol.py לא שולח match_type בעדכונים שוטפים (רק ב-INSERT
ראשוני), כדי לא לדרוס התאמות שכבר בוצעו כאן.
"""

import re
import time
from datetime import datetime, timezone

import requests

from config import (
    BATCH_SIZE,
    MECHALOL_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
    API_BATCH_SIZE_TEMPLATE_CHECK,
    NOT_REALLY_IMPORTED_STATUSES,
    WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES,
    STATUS_IMPORTED_DOCUMENTED,
    MATCH_TYPE_IMPORTED,
    MATCH_TYPE_SAME_TITLE_UNRELATED,
)
from normalize import hygiene, normalize_title
from supabase_client import get_client


MAX_RETRIES = 5
RETRY_DELAY = 3

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{now}] {message}", flush=True)


def execute_with_retry(operation, description):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return operation()
        except Exception as exc:
            if attempt >= MAX_RETRIES:
                log(f"ERROR | {description} | נכשל אחרי {MAX_RETRIES} ניסיונות: {exc}")
                raise
            log(f"WARNING | {description} | ניסיון {attempt}/{MAX_RETRIES} נכשל: {exc}. ניסיון חוזר בעוד {RETRY_DELAY}ש")
            time.sleep(RETRY_DELAY)


# ---------------------------------------------------------------------------
# ויקיפדיה - טעינת מפת כותרות (מפתח = אחרי hygiene)
# ---------------------------------------------------------------------------

def load_wikipedia_map(client):
    title_map = {}
    collisions = 0
    last_id = 0
    batch_number = 0

    while True:
        batch_number += 1

        result = execute_with_retry(
            lambda: (
                client.table("wikipedia_pages")
                .select("id, title")
                .gt("id", last_id)
                .order("id")
                .limit(BATCH_SIZE)
                .execute()
            ),
            f"WIKIPEDIA batch={batch_number} after_id={last_id}",
        )

        rows = result.data or []
        if not rows:
            break

        for row in rows:
            title = row.get("title")
            if not title:
                continue

            key = hygiene(title)

            if key in title_map and title_map[key] != row["id"]:
                collisions += 1
                continue

            title_map[key] = row["id"]

        last_id = rows[-1]["id"]
        log(f"WIKIPEDIA | batch={batch_number} | נטענו={len(title_map):,}")

        if len(rows) < BATCH_SIZE:
            break

    if collisions:
        log(f"WARNING | {collisions:,} התנגשויות מפתח היגיינה בוויקיפדיה (דולגו)")

    return title_map


# ---------------------------------------------------------------------------
# {{מיון ויקיפדיה|דף=...}} - אצוות
# ---------------------------------------------------------------------------

TEMPLATE_RE = re.compile(
    r"\{\{\s*מיון\s+ויקיפדיה\s*\|\s*דף\s*=\s*([^|}\n]+)"
)


def clean_template_value(raw):
    value = raw.strip()

    # קישור פנימי [[...]] בתוך דף= - מסיר את הסוגריים המרובעים.
    value = re.sub(r"^\[\[(.+)\]\]$", r"\1", value).strip()

    # קו תחתון - MediaWiki משתמש בו כמקביל לרווח בכותרות.
    value = value.replace("_", " ")

    value = re.sub(r"\s+", " ", value).strip()

    return value


# תוצאה מיוחדת עבור fetch_template_titles: הבקשה נדחתה ברמת ה-API כולה
# (למשל דף נעול-לקריאה בהרחבת אספקלריה - מחזיר {"error": {"code":
# "accessdenied", ...}} במקום "query", בלי סימן לאיזו כותרת ספציפית
# מתוך האצווה גרמה לזה). שונה במפורש מ-None (נבדק בפועל, אין תבנית) -
# "לא הצלחנו לבדוק בכלל" לעומת "בדקנו ואין תבנית".
ACCESS_DENIED = object()


def fetch_template_titles(titles):
    """
    שולף תוכן דפים באצווה אחת, מחפש {{מיון ויקיפדיה|דף=...}}.
    מחזיר {title: template_value / None (נבדק, אין תבנית) / ACCESS_DENIED}.

    אם כל הבקשה נדחית (title="error" בתגובה, לדוגמה כי כותרת אחת
    באצווה נעולה-לקריאה) - כל האצווה הייתה מקבלת None באופן שגוי לכל
    הכותרות, כולל התקינות לגמרי. במקום זאת מפצלים את האצווה לשניים
    ומנסים כל חצי בנפרד (חיפוש בינארי) עד לבידוד הכותרת/כותרות
    הבעייתיות בלבד - שאר הכותרות מקבלות תוצאה אמיתית.
    """
    result = {title: None for title in titles}

    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "formatversion": "2",
        "titles": "|".join(titles),
        "format": "json",
    }

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = session.get(MECHALOL_API, params=params, timeout=(15, 60))
            response.raise_for_status()
            data = response.json()
            break
        except (requests.RequestException, ValueError) as exc:
            if attempt >= MAX_RETRIES:
                log(f"ERROR | template batch | נכשל אחרי {MAX_RETRIES}: {exc}")
                raise
            log(f"WARNING | template batch | ניסיון {attempt}/{MAX_RETRIES}: {exc}")
            time.sleep(RETRY_DELAY)
    else:
        return result

    if "error" in data:
        error_code = data["error"].get("code")

        if len(titles) == 1:
            # כותרת בודדת ועדיין נדחית - זו הכותרת הבעייתית עצמה.
            log(f"WARNING | template | \"{titles[0]}\" נדחה ({error_code}) - מדלגים הפעם, ייבדק שוב בריצה הבאה")
            result[titles[0]] = ACCESS_DENIED
            return result

        log(
            f"WARNING | template batch | {len(titles)} כותרות נדחו יחד "
            f"({error_code}) - מפצלים ומנסים כל חצי בנפרד"
        )
        mid = len(titles) // 2
        result.update(fetch_template_titles(titles[:mid]))
        result.update(fetch_template_titles(titles[mid:]))
        return result

    pages = data.get("query", {}).get("pages", [])

    for page in pages:
        title = page.get("title")
        revisions = page.get("revisions") or []

        if not revisions:
            continue

        content = revisions[0].get("slots", {}).get("main", {}).get("content", "")

        match = TEMPLATE_RE.search(content)
        if match:
            result[title] = clean_template_value(match.group(1))

    if REQUEST_DELAY_SECONDS:
        time.sleep(REQUEST_DELAY_SECONDS)

    return result


def resolve_pending_via_template(pending, wikipedia_map):
    """
    pending: [(row, title), ...]
    מחזיר {row_id: (wikipedia_id, matched_title) or None}
    """
    resolved = {}

    titles = [title for _, title in pending]

    for i in range(0, len(titles), API_BATCH_SIZE_TEMPLATE_CHECK):
        chunk = titles[i:i + API_BATCH_SIZE_TEMPLATE_CHECK]

        template_values = fetch_template_titles(chunk)

        for row, title in pending:
            if title not in chunk:
                continue

            template_value = template_values.get(title)

            if template_value is ACCESS_DENIED:
                # לא הצלחנו לבדוק בכלל - לא רושמים מסקנה, לא מוסיפים
                # entry ל-resolved בכלל (ראו הטיפול ב-main()).
                continue

            if not template_value:
                resolved[row["id"]] = None
                continue

            key = hygiene(template_value)
            wikipedia_id = wikipedia_map.get(key)

            if wikipedia_id is not None:
                resolved[row["id"]] = (wikipedia_id, template_value)
            else:
                resolved[row["id"]] = None

        log(f"TEMPLATE API | אצווה {i // API_BATCH_SIZE_TEMPLATE_CHECK + 1} | {len(chunk)} כותרות נבדקו")

    return resolved


# ---------------------------------------------------------------------------
# מכלול - איטרציה
# ---------------------------------------------------------------------------

def iter_mechalol_rows(client):
    last_id = 0
    batch_number = 0

    while True:
        batch_number += 1

        result = execute_with_retry(
            lambda: (
                client.table("mechalol_pages")
                .select("*")
                .gt("id", last_id)
                .order("id")
                .limit(BATCH_SIZE)
                .execute()
            ),
            f"MECHALOL batch={batch_number} after_id={last_id}",
        )

        rows = result.data or []
        if not rows:
            break

        yield rows

        last_id = rows[-1]["id"]
        if len(rows) < BATCH_SIZE:
            break


def get_match_type(row):
    if row.get("status") in NOT_REALLY_IMPORTED_STATUSES:
        return MATCH_TYPE_SAME_TITLE_UNRELATED
    return MATCH_TYPE_IMPORTED


def should_reexamine(row, current_title):
    """
    True אם שורה שכבר עברה בדיקה בעבר (normalization_checked=true)
    בכל זאת צריכה בדיקה מחדש הפעם. ראו הסבר מלא ב-docstring של המודול.
    """
    has_match = row.get("wikipedia_id") is not None
    title_unchanged = row.get("matched_title") == current_title
    # שימו לב: כאן בכוונה NOT_REALLY_IMPORTED_STATUSES (הקבוצה הצרה),
    # לא WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES - כדי ש"נשמר במכלול למרות
    # מחיקה בוויקיפדיה" ימשיך להיבדק בכל ריצה (לא ידלג לצמיתות), ויתאפשר
    # ריפוי עצמי אוטומטי אם הערך ייווצר מחדש בוויקיפדיה בעתיד. השתקת
    # ההתרעה על אי-מציאה (maybe_deleted_from_wikipedia) עדיין קורית
    # בנפרד למטה, עם הקבוצה הרחבה - ראו ההערה שם.
    source_definitely_not_wikipedia = row.get("status") in NOT_REALLY_IMPORTED_STATUSES

    if has_match and title_unchanged:
        return False
    if not has_match and source_definitely_not_wikipedia:
        return False
    return True


# ---------------------------------------------------------------------------
# עיקרי
# ---------------------------------------------------------------------------

def main():
    started = time.monotonic()
    client = get_client()

    log("=" * 80)
    log("START | match.py")
    log("=" * 80)

    log("שלב 1 | טוען כותרות ויקיפדיה...")
    wikipedia_map = load_wikipedia_map(client)
    log(f"שלב 1 הושלם | כותרות={len(wikipedia_map):,}")

    total = 0
    exact_matches = 0
    normalization_matches = 0
    template_matches = 0
    unmatched = 0
    access_denied_skipped = 0
    manual_skipped = 0
    already_checked_skipped = 0

    log("שלב 2 | מתאים כותרות מכלול...")

    for batch_number, batch in enumerate(iter_mechalol_rows(client), 1):
        updates = []
        pending = []  # [(row, title)] - דורש בדיקת תבנית מיון

        for row in batch:
            total += 1
            title = row.get("title")

            if not title:
                log(f"WARNING | שורה id={row.get('id')} ללא כותרת - דולגה")
                continue

            if row.get("manual_match"):
                manual_skipped += 1
                continue

            # 1. היגיינת טקסט (כולל התאמה מדויקת - אם הכותרת נקייה, hygiene(title)==title)
            key = hygiene(title)
            wikipedia_id = wikipedia_map.get(key)

            if wikipedia_id is not None:
                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_id
                updated["match_type"] = get_match_type(row)
                updated["maybe_deleted_from_wikipedia"] = False
                updated["matched_title"] = title

                if key != title:
                    updated["normalization_checked"] = True
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "היגיינת_טקסט"
                    updated["title_normalized"] = key

                updates.append(updated)
                exact_matches += 1
                continue

            if row.get("normalization_checked") and not should_reexamine(row, title):
                already_checked_skipped += 1

                # הגנה: אם בעבר נמצאה התאמה (wikipedia_id קיים) או שהמקור
                # ודאי לא-ויקיפדי, אבל הדגל "אולי נמחק" נשאר דלוק מריצה
                # קודמת יותר (למשל מגרסה ישנה של match.py) - מתקנים תוך כדי.
                if row.get("maybe_deleted_from_wikipedia"):
                    updated = dict(row)
                    updated["maybe_deleted_from_wikipedia"] = False
                    updates.append(updated)

                continue

            # 2. נרמול סמנטי
            candidate, applied = normalize_title(title)

            if applied:
                candidate_id = wikipedia_map.get(hygiene(candidate))

                if candidate_id is not None:
                    updated = dict(row)
                    updated["wikipedia_id"] = candidate_id
                    updated["match_type"] = get_match_type(row)
                    updated["normalization_checked"] = True
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "+".join(applied)
                    updated["title_normalized"] = candidate
                    updated["maybe_deleted_from_wikipedia"] = False
                    updated["matched_title"] = title

                    updates.append(updated)
                    normalization_matches += 1
                    continue

            # 3. אין התאמה עד כה - ממתין לבדיקת {{מיון ויקיפדיה}}
            pending.append((row, title))

        # -------------------------------------------------------------
        # 4. בדיקת תבנית מיון - באצוות
        # -------------------------------------------------------------

        if pending:
            resolved = resolve_pending_via_template(pending, wikipedia_map)

            for row, title in pending:
                if row["id"] not in resolved:
                    # לא הוכרע בריצה הזו (למשל דף נעול-לקריאה) - לא
                    # רושמים שום מסקנה, לא מעדכנים את השורה כלל.
                    # should_reexamine ידאג שתיבדק שוב בריצה הבאה.
                    access_denied_skipped += 1
                    continue

                result = resolved[row["id"]]
                updated = dict(row)

                if result:
                    wikipedia_id, template_value = result
                    updated["wikipedia_id"] = wikipedia_id
                    updated["match_type"] = get_match_type(row)
                    updated["normalization_checked"] = True
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "תבנית_מיון"
                    updated["title_normalized"] = template_value
                    updated["maybe_deleted_from_wikipedia"] = False
                    updated["matched_title"] = title

                    # תבנית מיון תקינה שאומתה בפועל מול ה-API היא הוכחה
                    # ישירה לייבוא מתועד - לא ניחוש לפי חברות בקטגוריה.
                    # מקדמים את הסטטוס, חוץ ממקרה שבו הוא כבר מוצהר
                    # כלא-ויקיפדי (למשל נוצר במכלול עם התאמה מקרית בתבנית).
                    if row.get("status") not in NOT_REALLY_IMPORTED_STATUSES:
                        updated["status"] = STATUS_IMPORTED_DOCUMENTED

                    template_matches += 1
                else:
                    updated["normalization_checked"] = True
                    updated["normalization_match"] = False
                    updated["normalization_method"] = None
                    updated["title_normalized"] = None

                    # לא נמצאה התאמה בשום שלב. אם המקור ודאי-ויקיפדי או
                    # לא-ידוע (לא נוצר במכלול/חב"דפדיה/ויקישיבה, ולא ידוע
                    # מראש כערך שנמחק בוויקיפדיה והוחלט להשאירו) - זה חשוד
                    # כמחיקה/בעיית התאמה שדורשת בדיקה ידנית.
                    if row.get("status") not in WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES:
                        updated["maybe_deleted_from_wikipedia"] = True

                    unmatched += 1

                updates.append(updated)

        if updates:
            execute_with_retry(
                lambda: (
                    client.table("mechalol_pages")
                    .upsert(updates, on_conflict="id")
                    .execute()
                ),
                f"UPDATE batch={batch_number}",
            )

        matched_total = exact_matches + normalization_matches + template_matches

        log(
            f"התקדמות | אצווה={batch_number} | נבדקו={total:,} | "
            f"הותאמו={matched_total:,} | מדויק={exact_matches:,} | "
            f"נרמול={normalization_matches:,} | תבנית={template_matches:,} | "
            f"ללא_התאמה={unmatched:,} | נדחה_ללא_הכרעה={access_denied_skipped:,} | "
            f"manual={manual_skipped:,} | כבר_נבדק={already_checked_skipped:,}"
        )

    elapsed = int(time.monotonic() - started)
    matched_total = exact_matches + normalization_matches + template_matches

    log("=" * 80)
    log(
        f"סיום | נבדקו={total:,} | הותאמו={matched_total:,} | "
        f"מדויק={exact_matches:,} | נרמול={normalization_matches:,} | "
        f"תבנית={template_matches:,} | ללא_התאמה={unmatched:,} | "
        f"נדחה_ללא_הכרעה={access_denied_skipped:,}"
    )
    log(f"זמן ריצה | {elapsed // 60} דק' {elapsed % 60} שנ'")
    log("=" * 80)


if __name__ == "__main__":
    main()
