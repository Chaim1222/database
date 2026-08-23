"""
התאמת כותרות מכלול מול ויקיפדיה.

הטבלאות מתרוקנות ומתמלאות מחדש במלואן בכל ריצה שבועית (TRUNCATE +
מילוי מחדש, ראו README) - לכן אין כאן שום מנגנון "דילוג על מה שכבר
נבדק": כל שורה נבדקת מחדש, בכל ריצה, מאפס. אין matched_title, אין
normalization_checked, אין should_reexamine - כל אלה התייתרו לגמרי
עם המעבר לריקון-ומילוי-מחדש.

סדר ההתאמה:
0. manual_matches (טבלה נפרדת, לא מתרוקנת - שרדה בזכות מפתח page_id
   קבוע, לא id פנימי) - למקרים שהאוטומציה לא יכולה לפתור לבד (למשל
   כותרת שונה + דף נעול-לקריאה, ולכן גם תבנית המיון לא ניתנת לבדיקה).
   קובע, לא ממשיכים לשלבים הבאים.
1. היגיינת טקסט (השוואה אחרי ניקוי תווי כיווניות/גרשיים/מקפים - לא משנה
   את הכותרת המאוחסנת).
2. נרמול סמנטי (מכלול -> ויקיפדיה בלבד, ראו normalize.py).
3. {{מיון ויקיפדיה|דף=...}} - קריאת API באצוות, מוצא אחרון בלבד.

חשוב: fetch_mechalol.py לא שולח match_type בעדכונים שוטפים (רק ב-INSERT
ראשוני), כדי לא לדרוס התאמות שכבר בוצעו כאן.
"""

import re
import time

from config import (
    BATCH_SIZE,
    REQUEST_DELAY_SECONDS,
    API_BATCH_SIZE_TEMPLATE_CHECK,
    NOT_REALLY_IMPORTED_STATUSES,
    WIKIPEDIA_MATCH_NOT_EXPECTED_STATUSES,
    STATUS_IMPORTED_DOCUMENTED,
    MATCH_TYPE_IMPORTED,
    MATCH_TYPE_SAME_TITLE_UNRELATED,
)
from normalize import hygiene, normalize_title
from supabase_client import get_client, execute_with_retry as _execute_with_retry
from mechalol_api import log, api_get_with_retry


def execute_with_retry(operation, description):
    # עטיפה דקה - כדי שהלוג יכלול חותמת זמן (log() מ-mechalol_api),
    # בלי לשנות אף call site קיים בקובץ הזה.
    return _execute_with_retry(operation, description, log_fn=log)


# ---------------------------------------------------------------------------
# ויקיפדיה - טעינת מפת כותרות (מפתח = אחרי hygiene)
# ---------------------------------------------------------------------------

def load_wikipedia_map(client):
    """
    מחזיר:
    - title_map: hygiene(title) -> id (לשלבים 1-3 הרגילים)
    - existing_ids: set של כל ה-id (=page_id בוויקיפדיה) הקיימים כרגע -
      לשלב 0 (manual_matches), לוודא שה-wikipedia_page_id השמור עדיין
      קיים בפועל. אין צורך במפה - id בטבלה הוא כבר page_id ישירות.
    """
    title_map = {}
    existing_ids = set()
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
            existing_ids.add(row["id"])

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

    return title_map, existing_ids


def load_manual_matches(client):
    """
    {mechalol_page_id: wikipedia_page_id} - טבלה נפרדת, קטנה, לא
    מתרוקנת עם שאר הטבלאות. תחזוקה ידנית בלבד.
    """
    result = execute_with_retry(
        lambda: client.table("manual_matches").select("mechalol_page_id, wikipedia_page_id").execute(),
        "MANUAL_MATCHES",
    )
    return {row["mechalol_page_id"]: row["wikipedia_page_id"] for row in (result.data or [])}


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

    data = api_get_with_retry(params, "template batch")

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


# ---------------------------------------------------------------------------
# עיקרי
# ---------------------------------------------------------------------------

def main():
    started = time.monotonic()
    client = get_client()

    log("=" * 80)
    log("START | match.py")
    log("=" * 80)

    log("שלב 0 | טוען מפות ויקיפדיה + התאמות ידניות...")
    wikipedia_map, wikipedia_existing_ids = load_wikipedia_map(client)
    manual_matches = load_manual_matches(client)
    log(f"שלב 0 הושלם | כותרות={len(wikipedia_map):,} | התאמות_ידניות={len(manual_matches):,}")

    total = 0
    manual_matched = 0
    manual_unresolved = 0
    exact_matches = 0
    normalization_matches = 0
    template_matches = 0
    unmatched = 0
    access_denied_skipped = 0

    log("שלב 1 | מתאים כותרות מכלול...")

    for batch_number, batch in enumerate(iter_mechalol_rows(client), 1):
        updates = []
        pending = []  # [(row, title)] - דורש בדיקת תבנית מיון

        for row in batch:
            total += 1
            title = row.get("title")

            if not title:
                log(f"WARNING | שורה id={row.get('id')} ללא כותרת - דולגה")
                continue

            # 0. התאמה ידנית - טבלה נפרדת, לא מתרוקנת, לפי id (=page_id) קבוע.
            if row["id"] in manual_matches:
                wikipedia_page_id = manual_matches[row["id"]]

                if wikipedia_page_id not in wikipedia_existing_ids:
                    log(
                        f"WARNING | manual_matches | id={row['id']} "
                        f"(\"{title}\") -> wikipedia_page_id={wikipedia_page_id} "
                        f"לא נמצא ב-wikipedia_pages כרגע - כדאי לבדוק/לעדכן את הרשומה"
                    )
                    manual_unresolved += 1
                    continue

                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_page_id
                updated["match_type"] = get_match_type(row)
                updated["maybe_deleted_from_wikipedia"] = False
                updated["normalization_match"] = True
                updated["normalization_method"] = "התאמה_ידנית"
                updated["title_normalized"] = None

                updates.append(updated)
                manual_matched += 1
                continue

            # 1. היגיינת טקסט (כולל התאמה מדויקת - אם הכותרת נקייה, hygiene(title)==title)
            key = hygiene(title)
            wikipedia_id = wikipedia_map.get(key)

            if wikipedia_id is not None:
                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_id
                updated["match_type"] = get_match_type(row)
                updated["maybe_deleted_from_wikipedia"] = False

                if key != title:
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "היגיינת_טקסט"
                    updated["title_normalized"] = key

                updates.append(updated)
                exact_matches += 1
                continue

            # 2. נרמול סמנטי
            candidate, applied = normalize_title(title)

            if applied:
                candidate_id = wikipedia_map.get(hygiene(candidate))

                if candidate_id is not None:
                    updated = dict(row)
                    updated["wikipedia_id"] = candidate_id
                    updated["match_type"] = get_match_type(row)
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "+".join(applied)
                    updated["title_normalized"] = candidate
                    updated["maybe_deleted_from_wikipedia"] = False

                    updates.append(updated)
                    normalization_matches += 1
                    continue

            # 3. אין התאמה עד כה - ממתין לבדיקת {{מיון ויקיפדיה}}
            pending.append((row, title))

        # -------------------------------------------------------------
        # 3. בדיקת תבנית מיון - באצוות
        # -------------------------------------------------------------

        if pending:
            resolved = resolve_pending_via_template(pending, wikipedia_map)

            for row, title in pending:
                if row["id"] not in resolved:
                    # לא הוכרע בריצה הזו (למשל דף נעול-לקריאה) - לא
                    # רושמים שום מסקנה, לא מעדכנים את השורה כלל.
                    access_denied_skipped += 1
                    continue

                result = resolved[row["id"]]
                updated = dict(row)

                if result:
                    wikipedia_id, template_value = result
                    updated["wikipedia_id"] = wikipedia_id
                    updated["match_type"] = get_match_type(row)
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "תבנית_מיון"
                    updated["title_normalized"] = template_value
                    updated["maybe_deleted_from_wikipedia"] = False

                    # תבנית מיון תקינה שאומתה בפועל מול ה-API היא הוכחה
                    # ישירה לייבוא מתועד - לא ניחוש לפי חברות בקטגוריה.
                    # מקדמים את הסטטוס, חוץ ממקרה שבו הוא כבר מוצהר
                    # כלא-ויקיפדי (למשל נוצר במכלול עם התאמה מקרית בתבנית).
                    if row.get("status") not in NOT_REALLY_IMPORTED_STATUSES:
                        updated["status"] = STATUS_IMPORTED_DOCUMENTED

                    template_matches += 1
                else:
                    updated["normalization_match"] = False
                    updated["normalization_method"] = None
                    updated["title_normalized"] = None

                    # לא נמצאה התאמה בשום שלב. אם המקור ודאי-ויקיפדי או
                    # לא-ידוע (לא נוצר במכלול/חב"דפדיה/ויקישיבה, ולא ידוע
                    # מראש כערך שנמחק בוויקיפדיה והוחלט להשאירו) - זה חשוד
                    # כבעיית התאמה שדורשת בדיקה ידנית (ואולי הוספה ל-
                    # manual_matches, אם המקור הוא כותרת שונה/דף נעול).
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

        matched_total = manual_matched + exact_matches + normalization_matches + template_matches

        log(
            f"התקדמות | אצווה={batch_number} | נבדקו={total:,} | "
            f"הותאמו={matched_total:,} | ידני={manual_matched:,} | "
            f"מדויק={exact_matches:,} | נרמול={normalization_matches:,} | "
            f"תבנית={template_matches:,} | ללא_התאמה={unmatched:,} | "
            f"נדחה_ללא_הכרעה={access_denied_skipped:,} | "
            f"ידני_לא_נמצא={manual_unresolved:,}"
        )

    # שלב 2 | חישוב מחדש של wikipedia_pages.is_missing - עדכון יחיד
    # בסופרבייס (לא שורה-שורה), אחרי שכל mechalol_pages.wikipedia_id כבר
    # סופי לריצה הזו. מחליף הצטרפות חיה שהתבצעה עד כה בתוך
    # report_missing_from_mechalol (ראו migration_add_is_missing_flag.sql).
    log("שלב 2 | מחשב מחדש wikipedia_pages.is_missing...")
    recompute_started = time.monotonic()
    execute_with_retry(
        lambda: client.rpc("recompute_missing_flag").execute(),
        "RECOMPUTE_MISSING_FLAG",
    )
    recompute_elapsed = time.monotonic() - recompute_started
    log(f"שלב 2 הושלם | {recompute_elapsed:.1f} שנ'")

    elapsed = int(time.monotonic() - started)
    matched_total = manual_matched + exact_matches + normalization_matches + template_matches

    log("=" * 80)
    log(
        f"סיום | נבדקו={total:,} | הותאמו={matched_total:,} | ידני={manual_matched:,} | "
        f"מדויק={exact_matches:,} | נרמול={normalization_matches:,} | "
        f"תבנית={template_matches:,} | ללא_התאמה={unmatched:,} | "
        f"נדחה_ללא_הכרעה={access_denied_skipped:,} | ידני_לא_נמצא={manual_unresolved:,}"
    )
    log(f"זמן ריצה | {elapsed // 60} דק' {elapsed % 60} שנ'")
    log("=" * 80)


if __name__ == "__main__":
    main()
