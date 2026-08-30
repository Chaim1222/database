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
import json
import os

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
from mechalol_api import log, api_get_with_retry, login as mechalol_login


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

def iter_mechalol_rows(client, only_ids=None):
    """
    only_ids=None (ברירת מחדל): סריקה מלאה, בדיוק כמו קודם - לשימוש
    בפיוס התקופתי המלא (חודשי).

    only_ids=רשימת id-ים: מגביל את הסריקה לשורות האלה בלבד - לשימוש
    בריצת דלתא (--scoped, ראו main), אחרי שהוחלט אילו שורות מכלול
    בכלל דורשות בדיקה מחדש (ראו compute_scoped_ids). מפוצל לצ'אנקים
    כמו find_stale_title_collisions/resolve_title_collisions בשאר
    הקוד - אורך URL.
    """
    if only_ids is not None:
        only_ids = sorted(set(only_ids))
        for i in range(0, len(only_ids), BATCH_SIZE):
            chunk = only_ids[i:i + BATCH_SIZE]
            result = execute_with_retry(
                lambda chunk=chunk: (
                    client.table("mechalol_pages").select("*").in_("id", chunk).execute()
                ),
                f"MECHALOL scoped chunk={i // BATCH_SIZE + 1}",
            )
            if result.data:
                yield result.data
        return

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


def compute_scoped_ids(client, mechalol_changed_ids, wikipedia_changed_ids):
    """
    מחזיר את קבוצת ה-id-ים ב-mechalol_pages שצריך להעביר מחדש דרך
    ההתאמה (שלבים 0-3), בהינתן מה השתנה בריצת הדלתא האחרונה:

    - mechalol_changed_ids: id-ים של שורות מכלול שנוצרו/שונה שמן -
      ברור שצריך להתאים אותן מחדש (חדשות, או עם title שונה מקודם).
    - wikipedia_changed_ids: id-ים (page_id בוויקיפדיה) של דפים
      שנוצרו/נמחקו/שונה שמם בוויקיפדיה - לא משפיע ישירות על שום שורת
      מכלול ספציפית *חדשה*, אבל עלול לשבור/לאפשר התאמה קיימת: שורת
      מכלול שכבר הצביעה (wikipedia_id) לדף שנמחק/שונה שמו שם, צריכה
      הערכה מחדש. נמצא בשאילתה הפוכה: כל mechalol_pages.id שה-
      wikipedia_id שלו נמצא בקבוצה הזו.

    לא מטפל בצד ההפוך (דף ויקיפדי *חדש* שאולי סוף-סוף תואם שורת מכלול
    שהייתה maybe_deleted_from_wikipedia) - זה בכוונה נשאר לפיוס
    התקופתי המלא (כמו בתכנון: פערי "התאמה חדשה שנפתחה" ממילא מכוסים
    שם, לא דורשים תגובה מיידית באותה תדירות כמו דלתא שבורה).
    """
    scoped = set(mechalol_changed_ids or [])

    if wikipedia_changed_ids:
        for i in range(0, len(wikipedia_changed_ids), BATCH_SIZE):
            chunk = wikipedia_changed_ids[i:i + BATCH_SIZE]
            result = execute_with_retry(
                lambda chunk=chunk: (
                    client.table("mechalol_pages").select("id").in_("wikipedia_id", chunk).execute()
                ),
                f"MECHALOL affected-by-wikipedia-change chunk={i // BATCH_SIZE + 1}",
            )
            scoped.update(row["id"] for row in (result.data or []))

    return scoped


def get_match_type(row):
    if row.get("status") in NOT_REALLY_IMPORTED_STATUSES:
        return MATCH_TYPE_SAME_TITLE_UNRELATED
    return MATCH_TYPE_IMPORTED


def _load_changed_ids(filename):
    """
    קורא קובץ JSON עם רשימת id-ים שנכתב על ידי סקריפט דלתא (ראו
    fetch_mechalol_delta.py/fetch_wikipedia_delta.py - _write_changed_ids
    שם). מחזיר None אם הקובץ לא קיים בכלל (לא הופעל --scoped אחרי אף
    ריצת דלתא) - שונה במפורש מרשימה ריקה (ריצת דלתא רצה, ופשוט לא היה
    שום שינוי הפעם).
    """
    if not os.path.exists(filename):
        return None
    with open(filename, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# עיקרי
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description="התאמת כותרות מכלול מול ויקיפדיה")
    parser.add_argument(
        "--scoped", action="store_true",
        help=(
            "בודק רק שורות מכלול שהושפעו מריצת הדלתא האחרונה (קורא "
            "mechalol_delta_changed_ids.json / wikipedia_delta_changed_ids.json "
            "אם קיימים - נכתבים על ידי fetch_mechalol_delta.py / "
            "fetch_wikipedia_delta.py). בלי הדגל - סריקה מלאה, כרגיל "
            "(לשימוש בפיוס התקופתי המלא)."
        ),
    )
    parser.add_argument(
        "--skip-template-check", action="store_true",
        help=(
            "מדלג לגמרי על שלב 4 (בדיקת תבנית {{מיון ויקיפדיה}} לדפים "
            "שלא נמצאה להם התאמה בשלבים 0-3) - השלב היחיד שפונה בפועל "
            "ל-API של המכלול באמצע match.py. שימושי כשהמכלול לא זמין "
            "זמנית (למשל 'מצב התקפה') - שלבים 0-3 (התאמות ידניות, "
            "כותרת מדויקת, כותרת מנורמלת) כולם מבוססי נתונים שכבר "
            "נשלפו, בלי שום פנייה חדשה למכלול. דפים שהיו נפתרים רק "
            "בשלב 4 יישארו ללא התאמה הפעם - ייפתרו בריצה הבאה בלי "
            "הדגל, ברגע שה-API זמין שוב."
        ),
    )
    parser.add_argument(
        "--login", action="store_true",
        help=(
            "מתחבר לחשבון הבוט במכלול (USER_NAME/PASSWORD) לפני שלב 4 "
            "(בדיקת תבנית מיון) - הופך את הבקשות שם לתעבורה מחוברת "
            "במקום אנונימית. כישלון התחברות לא עוצר את הריצה - נופל "
            "חזרה לגישה אנונימית, בדיוק כמו fetch_mechalol.py. חסר "
            "תועלת (ולכן ברירת המחדל היא בלי) אלא אם יש סיבה ספציפית "
            "(למשל תעבורה אנונימית נחסמת) - login() עצמו הוא קריאת "
            "רשת נוספת, לא לגמרי חינמית."
        ),
    )
    args = parser.parse_args()

    started = time.monotonic()
    client = get_client()

    log("=" * 80)
    log(
        "START | match.py"
        + (" (--scoped)" if args.scoped else "")
        + (" (--skip-template-check)" if args.skip_template_check else "")
        + (" (--login)" if args.login else "")
    )
    log("=" * 80)

    if args.login:
        mechalol_login()

    log("שלב 0 | טוען מפות ויקיפדיה + התאמות ידניות...")
    wikipedia_map, wikipedia_existing_ids = load_wikipedia_map(client)
    manual_matches = load_manual_matches(client)
    log(f"שלב 0 הושלם | כותרות={len(wikipedia_map):,} | התאמות_ידניות={len(manual_matches):,}")

    only_ids = None
    if args.scoped:
        mechalol_changed = _load_changed_ids("mechalol_delta_changed_ids.json")
        wikipedia_changed = _load_changed_ids("wikipedia_delta_changed_ids.json")

        if mechalol_changed is None and wikipedia_changed is None:
            log(
                "WARNING | --scoped אך לא נמצא אף קובץ changed_ids - "
                "כנראה לא רצה עדיין ריצת דלתא. נופל חזרה לסריקה מלאה."
            )
        else:
            only_ids = compute_scoped_ids(client, mechalol_changed or [], wikipedia_changed or [])
            log(f"שלב 0 | מצומצם ל-{len(only_ids):,} שורות מכלול (--scoped)")

    total = 0
    manual_matched = 0
    manual_unresolved = 0
    exact_matches = 0
    normalization_matches = 0
    template_matches = 0
    unmatched = 0
    access_denied_skipped = 0
    # נאסף רק בשביל --scoped (ראו שלב 2 למטה) - כל wikipedia_id שנגע
    # בשורת מכלול שעברה בלולאה הזו, לפני או אחרי השינוי (row המקורי +
    # updated החדש) - הקבוצה הזו היא בדיוק מה שעשוי להשפיע על
    # is_missing, ולא יותר מזה.
    affected_wikipedia_ids = set()
    template_check_deferred = 0

    log("שלב 1 | מתאים כותרות מכלול...")

    for batch_number, batch in enumerate(iter_mechalol_rows(client, only_ids=only_ids), 1):
        updates = []
        pending = []  # [(row, title)] - דורש בדיקת תבנית מיון

        for row in batch:
            total += 1
            title = row.get("title")
            if row.get("wikipedia_id"):
                affected_wikipedia_ids.add(row["wikipedia_id"])

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

        if args.skip_template_check:
            template_check_deferred += len(pending)
        elif pending:
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
            for u in updates:
                if u.get("wikipedia_id"):
                    affected_wikipedia_ids.add(u["wikipedia_id"])
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

    # שלב 2 | חישוב מחדש של wikipedia_pages.is_missing.
    #
    # בסריקה מלאה (בלי --scoped, או עם --scoped שנפל חזרה לסריקה מלאה
    # כי לא נמצא changed_ids) - עדכון יחיד על הטבלה כולה, כמו תמיד.
    #
    # ב---scoped אמיתי - מריצים גרסה ממוקדת (recompute_missing_flag_scoped,
    # ראו migration_add_delta_tables.sql) על affected_wikipedia_ids
    # בלבד: כל wikipedia_id שנגע בשורת מכלול שנבדקה הלילה, לפני או
    # אחרי השינוי - זו בדיוק הקבוצה שעשויה להשפיע על is_missing, לא
    # יותר. חשוב: בלי זה, כל ריצת --scoped הייתה מפעילה בכל זאת עדכון
    # מלא על 350 אלף+ שורות בכל לילה - בדיוק סוג הפעולה היקרה שהדלתא
    # נועדה למנוע (וגם בדיוק הסוג שגרם בפועל ל-statement timeout על
    # הטבלה המלאה, שנתקלנו בו בהרצה אמיתית).
    log("שלב 2 | מחשב מחדש wikipedia_pages.is_missing...")
    recompute_started = time.monotonic()

    if only_ids is not None:
        if affected_wikipedia_ids:
            execute_with_retry(
                lambda: client.rpc(
                    "recompute_missing_flag_scoped", {"ids": list(affected_wikipedia_ids)}
                ).execute(),
                "RECOMPUTE_MISSING_FLAG_SCOPED",
            )
            log(f"שלב 2 | ממוקד ל-{len(affected_wikipedia_ids):,} wikipedia_id")
        else:
            log("שלב 2 | דולג - אף שורה לא נגעה ב-wikipedia_id כלשהו (--scoped)")
    else:
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
        + (f" | נדחה_ללא_בדיקת_תבנית={template_check_deferred:,}" if args.skip_template_check else "")
    )
    log(f"זמן ריצה | {elapsed // 60} דק' {elapsed % 60} שנ'")
    log("=" * 80)


if __name__ == "__main__":
    main()
