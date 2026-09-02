"""
עדכון דלתא למכלול - מקביל ל-fetch_wikipedia_delta.py, ראו שם להסבר
כללי על הארכיטקטורה (watermark, bootstrap, סיווג תזוזות, זיהוי
"הפך להפניה"). ההבדל המהותי היחיד: mechalol_pages.status הוא NOT NULL
עם CHECK constraint, ונקבע לפי חברות בקטגוריות (לא זמין מ-
recentchanges/logevents עצמם) - ולכן דף חדש שנמצא בדלתא עדיין חייב
סיווג, בדיוק כמו בסריקה המלאה. כאן יש גם שכבה נוספת שאין בצד
ויקיפדיה: detect_edited_tracked_changes מזהה לא רק "הפך להפניה" אלא
גם תיקון/הוספת תבנית {{מיון ויקיפדיה}} על ערך קיים (עריכה רגילה, לא
יצירה) - שני אלה בלתי-נראים לחלוטין דרך recentchanges type:new/
logevents.

הסיווג עצמו (fetch_own_categories/classify_page_from_own_categories,
מיובאות מ-fetch_mechalol.py) שולף prop=categories רק עבור הכותרות
שבאמת השתנו בריצה הזו - לא כל חברי הקטגוריות (זה מה שהתגלה בפועל
כיקר מדי בדיקה חיה: עד 185,000+ חברים בקטגוריות עדכון-אחרון - ראו
היסטוריית הפרויקט). בזכות זה, עלות סבירה גם בריצה תכופה (לילית).

לוגין (login מ-fetch_mechalol.py) *לא* בשימוש כאן בכוונה - כמות
הדפים בדלתא בודדת-עד-מאות, לא צריך aplimit/cmlimit גבוה (הטעם היחיד
ל-login שם); ריצה אנונימית עם המגבלה הרגילה (500) מספיקה בהחלט.
"""

from datetime import datetime, timezone
import json

from config import MECHALOL_API
from delta_api import (
    fetch_new_pages, fetch_delete_log, fetch_move_log,
    fetch_edited_page_ids, fetch_redirect_status,
)
from fetch_mechalol import fetch_own_categories, classify_page_from_own_categories
from supabase_client import get_client, execute_with_retry

SOURCE = "mechalol"
TABLE = "mechalol_pages"
ID_LOOKUP_BATCH_SIZE = 500


def log(message):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{now}] {message}", flush=True)


def get_watermark(client):
    result = client.table("sync_watermarks").select("last_synced_ts").eq("source", SOURCE).execute()
    if not result.data:
        raise RuntimeError(
            f"אין שורת watermark עבור '{SOURCE}' ב-sync_watermarks - יש להריץ קודם ריצת "
            f"בסיס מלאה ולזרוע ידנית שורת watermark התחלתית (ראו fetch_wikipedia_delta.py "
            f"להסבר מקביל)."
        )
    return result.data[0]["last_synced_ts"]


def classify_moves(moves):
    """זהה ל-fetch_wikipedia_delta.classify_moves - ראו שם לתיעוד מלא."""
    renames, creation_like, deletion_like = [], [], []
    for mv in moves:
        if mv["old_ns"] == 0 and mv["new_ns"] == 0:
            renames.append(mv)
        elif mv["old_ns"] != 0 and mv["new_ns"] == 0:
            creation_like.append(mv)
        elif mv["old_ns"] == 0 and mv["new_ns"] != 0:
            deletion_like.append(mv)
    return renames, creation_like, deletion_like


def find_tracked_ids(client, candidate_ids):
    """זהה ל-fetch_wikipedia_delta.find_tracked_ids - ראו שם לתיעוד מלא."""
    if not client or not candidate_ids:
        return set()
    found = set()
    candidate_ids = sorted(set(candidate_ids))
    for i in range(0, len(candidate_ids), ID_LOOKUP_BATCH_SIZE):
        chunk = candidate_ids[i:i + ID_LOOKUP_BATCH_SIZE]
        result = execute_with_retry(
            lambda chunk=chunk: client.table(TABLE).select("id").in_("id", chunk).execute(),
            f"בדיקת מעקב קיים ({TABLE}) | אצווה {i // ID_LOOKUP_BATCH_SIZE + 1}",
            log_fn=log,
        )
        found.update(row["id"] for row in (result.data or []))
    return found


def detect_edited_tracked_changes(client, since_ts, already_handled_ids):
    """
    מזהה שני סוגי שינוי בדפי מכלול *במעקב אצלנו* שנערכו (לא נוצרו/
    נמחקו/הועברו) - הפער המתועד בתכנון: "עריכה רגילה יכולה להפוך
    ערך להפניה, או לתקן/להוסיף את תבנית {{מיון ויקיפדיה}}, בלי שום
    אירוע יצירה/מחיקה/העברה נלווה" (ראו fetch_edited_page_ids ב-
    delta_api.py):

    1. הפכו להפניה -> "מחיקה רכה" (reason='became_redirect') - אותו
       זרם טיפול כמו מחיקה מ-logevents.
    2. עדיין ערך אמיתי, אבל הקטגוריות שלו עשויות היו להשתנות (הוספת/
       תיקון תבנית המיון) -> מסווגים מחדש (classify_page_from_own_categories)
       ומעדכנים את status/source_type/last_update_month/וכו' במקום -
       גם אם בפועל שום דבר לא השתנה (classify מחזיר את אותו סטטוס),
       upsert על נתונים זהים לא מזיק.

    client=None (dry-run בלי DB) - מדלג לגמרי, כמו הגרסה המקבילה
    בוויקיפדיה. מחזיר (became_redirect_deletions, status_updates).
    """
    if not client:
        log("דילוג על זיהוי 'הפך להפניה'/תיקון סיווג - אין חיבור לסופרבייס (--dry-run בלי DB)")
        return [], []

    edited = fetch_edited_page_ids(MECHALOL_API, since_ts)
    candidate_ids = {e["page_id"] for e in edited} - already_handled_ids
    if not candidate_ids:
        return [], []

    tracked_ids = find_tracked_ids(client, candidate_ids)
    if not tracked_ids:
        return [], []

    id_to_title = {e["page_id"]: e["title"] for e in edited if e["page_id"] in tracked_ids}
    redirect_status = fetch_redirect_status(MECHALOL_API, list(id_to_title.values()))

    now_iso = datetime.now(timezone.utc).isoformat()
    became_redirect = []
    still_articles = {}
    for page_id, title in id_to_title.items():
        if redirect_status.get(title) is True:
            became_redirect.append({
                "page_id": page_id, "title": title,
                "deleted_at": now_iso, "pageid_valid": True, "reason": "became_redirect",
            })
        else:
            still_articles[page_id] = title

    status_updates = []
    if still_articles:
        own_cats = fetch_own_categories(list(still_articles.values()))
        for page_id, title in still_articles.items():
            classification = classify_page_from_own_categories(title, own_cats.get(title, set()))
            status_updates.append({"id": page_id, "title": title, **classification})

    if became_redirect:
        log(f"נמצאו {len(became_redirect)} ערכים במעקב שהפכו להפניה בעריכה רגילה")
    if status_updates:
        log(f"נבדק סיווג מחדש (למשל תיקון תבנית מיון) עבור {len(status_updates)} ערכים שנערכו")

    return became_redirect, status_updates


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "mechalol_pages_title_key" in str(exc)


def resolve_title_collisions(client, rows):
    """
    מקביל בדיוק ל-resolve_title_collisions ב-fetch_mechalol.py (הסריקה
    המלאה) - ראו שם ואת ההסבר המקביל ב-fetch_wikipedia_delta.py.
    בניגוד לוויקיפדיה - כאן אין מפתח זר להתחשב בו (שום דבר לא מצביע
    ל-mechalol_pages.id) - מחיקת השורה המיושנת היא צעד יחיד.
    """
    titles = [r["title"] for r in rows]
    existing = []
    for i in range(0, len(titles), ID_LOOKUP_BATCH_SIZE):
        chunk = titles[i:i + ID_LOOKUP_BATCH_SIZE]
        result = execute_with_retry(
            lambda chunk=chunk: client.table(TABLE).select("id, title").in_("title", chunk).execute(),
            "בדיקת התנגשות כותרת",
            log_fn=log,
        )
        existing.extend(result.data or [])

    new_id_by_title = {r["title"]: r["id"] for r in rows}
    stale_ids = [
        row["id"] for row in existing
        if row["title"] in new_id_by_title and row["id"] != new_id_by_title[row["title"]]
    ]

    if stale_ids:
        log(f"WARNING | התנגשות כותרת/id | מוחק {len(stale_ids)} שורות מיושנות: {stale_ids}")
        execute_with_retry(
            lambda: client.table(TABLE).delete().in_("id", stale_ids).execute(),
            "מחיקת שורות מיושנות",
            log_fn=log,
        )

    return bool(stale_ids)


def _upsert_with_collision_handling(client, rows):
    """
    זהה ל-fetch_wikipedia_delta._upsert_with_collision_handling - ראו
    שם לתיעוד מלא. הבדל חשוב מה-DB שם: כאן resolve_title_collisions
    לא צריכה לשחרר הפניית wikipedia_id (אין מפתח זר שמצביע ל-
    mechalol_pages), אבל אותה בעיית "התנגשות בתוך האצווה עצמה" (בלי
    שורה מיושנת ב-DB לנקות) קיימת באותה מידה - אותו נפילה-חזרה
    לעדכון שורה-שורה.
    """
    try:
        client.table(TABLE).upsert(rows, on_conflict="id").execute()
        return
    except Exception as exc:
        if not _is_title_collision(exc):
            raise
        resolve_title_collisions(client, rows)

    log(f"upsert | נופל חזרה לעדכון שורה-שורה ({len(rows)} שורות) בגלל התנגשות כותרת בתוך האצווה")
    for row in rows:
        try:
            client.table(TABLE).upsert([row], on_conflict="id").execute()
        except Exception as row_exc:
            if _is_title_collision(row_exc) and resolve_title_collisions(client, [row]):
                client.table(TABLE).upsert([row], on_conflict="id").execute()
            else:
                raise


def apply_status_updates(client, status_updates):
    """
    בדומה ל-apply_creations: status_updates כולל גם title (ראו
    detect_edited_tracked_changes), אז אותה תקלת התנגשות-כותרת
    שאפשרית ביצירות אפשרית גם כאן - למשל אם page_id שערכתו כבר
    במעקב מקבל כותרת שעדיין שייכת בטעות לשורה מיושנת אחרת שלא
    עודכנה/נמחקה בריצה קודמת. משתמש באותה עטיפת collision-handling
    כמו apply_creations, במקום upsert ישיר.
    """
    if not status_updates:
        return
    execute_with_retry(
        lambda: _upsert_with_collision_handling(client, status_updates),
        f"עדכון סיווג ל-{len(status_updates)} ערכים קיימים",
        log_fn=log,
    )
    log(f"עודכן סיווג ל-{len(status_updates)} ערכים ב-{TABLE}")


def apply_creations(client, creations, own_categories_by_title):
    """
    בשונה מהגרסה הקודמת (שהשתמשה ב-fetch_classification_data/
    classify_page הגלובליים - התגלה בפועל כיקר מדי לריצה תכופה, ראו
    fetch_own_categories) - כל שורה חדשה עוברת classify_page_from_own_categories
    על סמך הקטגוריות שהיא עצמה שייכת אליהן, שנשלפו מראש ב-main() רק
    עבור הכותרות שבאמת השתנו. wikipedia_id/match_type לא נשלחים - ראו
    הערה מקורית.
    """
    if not creations:
        return

    # אותה בעיית page_id כפול באותו חלון דלתא כמו ב-
    # fetch_wikipedia_delta.apply_creations (ראו שם לתיעוד המלא) - גם
    # כאן ה-upsert הוא on_conflict="id" יחיד, שנכשל אם page_id מופיע
    # פעמיים באצווה. מצמצם ל-page_id אחד, שומר את האירוע עם created_at
    # המאוחר ביותר.
    latest_by_id = {}
    for c in creations:
        existing = latest_by_id.get(c["page_id"])
        if existing is None or c["created_at"] > existing["created_at"]:
            latest_by_id[c["page_id"]] = c

    rows = []
    for c in latest_by_id.values():
        classification = classify_page_from_own_categories(
            c["title"], own_categories_by_title.get(c["title"], set())
        )
        rows.append({"id": c["page_id"], "title": c["title"], **classification})

    execute_with_retry(
        lambda: _upsert_with_collision_handling(client, rows),
        f"upsert {len(rows)} יצירות ל-{TABLE}",
        log_fn=log,
    )
    log(f"עודכנו {len(rows)} יצירות/שחזורים ב-{TABLE}")


def apply_deletions(client, deletions):
    if not deletions:
        return
    ids = [d["page_id"] for d in deletions if d["page_id"]]
    if not ids:
        return
    # לשחרר קודם הפניות מ-wikipedia_pages דרך match.py לא נדרש כאן -
    # מכלול הוא הטבלה המפנה (child) ב-wikipedia_id, DELETE שורה ממנה
    # לא נתקל באילוץ מפתח זר (בניגוד ל-TRUNCATE של wikipedia_pages,
    # שדורש טיפול מיוחד - ראו schema.sql/truncate_wikipedia_pages).
    execute_with_retry(
        lambda: client.table(TABLE).delete().in_("id", ids).execute(),
        f"מחיקת {len(ids)} דפים מ-{TABLE}",
        log_fn=log,
    )
    log(f"נמחקו {len(ids)} דפים מ-{TABLE}")


def apply_renames(client, renames):
    """זהה ל-fetch_wikipedia_delta.apply_renames - ראו שם לתיעוד מלא."""
    for mv in renames:
        def _update_with_collision_handling(mv=mv):
            try:
                client.table(TABLE).update({"title": mv["new_title"]}).eq("id", mv["page_id"]).execute()
            except Exception as exc:
                if _is_title_collision(exc) and resolve_title_collisions(client, [{"id": mv["page_id"], "title": mv["new_title"]}]):
                    log(f"עדכון כותרת page_id={mv['page_id']} | טופלה התנגשות כותרת, מנסה שוב")
                    client.table(TABLE).update({"title": mv["new_title"]}).eq("id", mv["page_id"]).execute()
                else:
                    raise

        execute_with_retry(
            _update_with_collision_handling,
            f"עדכון כותרת page_id={mv['page_id']} -> '{mv['new_title']}'",
            log_fn=log,
        )
    if renames:
        log(f"עודכנו {len(renames)} שינויי-שם ב-{TABLE}")


def write_delta_tables(client, creations, deletions, renames):
    if creations:
        rows = [
            {"page_id": c["page_id"], "title": c["title"], "created_at": c["created_at"]}
            for c in creations
        ]
        execute_with_retry(
            lambda: client.table("mechalol_creations").upsert(
                rows, on_conflict="page_id,created_at", ignore_duplicates=True
            ).execute(),
            "כתיבת mechalol_creations",
            log_fn=log,
        )

    if deletions:
        rows = [
            {
                "page_id": d["page_id"],
                "title": d["title"],
                "deleted_at": d["deleted_at"],
                "deleted_pageid_valid": d["pageid_valid"],
                "reason": d["reason"],
            }
            for d in deletions
        ]
        execute_with_retry(
            lambda: client.table("mechalol_deletions").upsert(
                rows, on_conflict="page_id,deleted_at", ignore_duplicates=True
            ).execute(),
            "כתיבת mechalol_deletions",
            log_fn=log,
        )

    if renames:
        rows = [
            {
                "page_id": mv["page_id"],
                "old_title": mv["old_title"],
                "new_title": mv["new_title"],
                "renamed_at": mv["renamed_at"],
                "action": mv["action"],
                "suppressredirect": mv["suppressredirect"],
                "old_title_pageid_valid": mv["old_title_pageid_valid"],
            }
            for mv in renames
        ]
        execute_with_retry(
            lambda: client.table("mechalol_renames").upsert(
                rows, on_conflict="page_id,renamed_at", ignore_duplicates=True
            ).execute(),
            "כתיבת mechalol_renames",
            log_fn=log,
        )


def write_changed_ids_file(all_creations, renames, status_updates):
    """
    כותב mechalol_delta_changed_ids.json - כל page_id במכלול שהשתנה
    בריצת הדלתא הזו (יצירה/שינוי-שם/עדכון סיווג - מחיקות לא נכללות,
    אין טעם להתאים מחדש שורה שכבר לא קיימת), לשימוש על ידי
    match.py --scoped. status_updates נכלל כי שינוי status (למשל
    תיקון תבנית מיון) יכול לשנות את match_type (ראו get_match_type
    ב-match.py) גם בלי ששום כותרת השתנתה. נכתב תמיד (גם רשימה ריקה) -
    ראו התיעוד המקביל ב-fetch_wikipedia_delta.py.
    """
    ids = set()
    ids.update(c["page_id"] for c in all_creations if c.get("page_id"))
    ids.update(mv["page_id"] for mv in renames if mv.get("page_id"))
    ids.update(u["id"] for u in status_updates if u.get("id"))

    with open("mechalol_delta_changed_ids.json", "w", encoding="utf-8") as f:
        json.dump(sorted(ids), f)
    log(f"נכתב mechalol_delta_changed_ids.json | {len(ids)} id-ים")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="עדכון דלתא למכלול")
    parser.add_argument("--since", help="ראו --since ב-fetch_wikipedia_delta.py --help")
    parser.add_argument("--dry-run", action="store_true", help="ראו --dry-run ב-fetch_wikipedia_delta.py --help")
    args = parser.parse_args()

    if args.dry_run and not args.since:
        raise SystemExit("--dry-run דורש גם --since (אין קריאת watermark בלי חיבור לסופרבייס)")

    client = None if (args.dry_run and args.since) else get_client()
    since_ts = args.since or get_watermark(client)
    run_started_at = datetime.now(timezone.utc).isoformat()

    log(f"התחלה | דלתא מכלול | מאז {since_ts}" + (" | DRY-RUN" if args.dry_run else ""))

    new_pages = fetch_new_pages(MECHALOL_API, since_ts)
    deletions, restores = fetch_delete_log(MECHALOL_API, since_ts)
    moves = fetch_move_log(MECHALOL_API, since_ts)
    renames, move_creations, move_deletions = classify_moves(moves)
    for d in deletions:
        d["reason"] = "log_event"

    move_creation_events = [
        {"page_id": mv["page_id"], "title": mv["new_title"], "created_at": mv["renamed_at"]}
        for mv in move_creations
    ]
    all_creations = new_pages + restores + move_creation_events

    move_deletion_events = [
        {
            "page_id": mv["page_id"],
            "title": mv["old_title"],
            "deleted_at": mv["renamed_at"],
            "pageid_valid": mv["old_title_pageid_valid"],
            "reason": "log_event",
        }
        for mv in move_deletions
    ]

    already_handled_ids = (
        {c["page_id"] for c in all_creations if c.get("page_id")}
        | {d["page_id"] for d in deletions if d.get("page_id")}
        | {d["page_id"] for d in move_deletion_events if d.get("page_id")}
        | {mv["page_id"] for mv in renames if mv.get("page_id")}
    )
    became_redirect, status_updates = detect_edited_tracked_changes(client, since_ts, already_handled_ids)

    all_deletions = deletions + move_deletion_events + became_redirect

    log(
        f"נמצאו | יצירות={len(new_pages)} שחזורים={len(restores)} "
        f"תזוזות-כיצירה={len(move_creations)} | מחיקות={len(deletions)} "
        f"תזוזות-כמחיקה={len(move_deletions)} הפכו-להפניה={len(became_redirect)} | "
        f"שינויי-שם={len(renames)} | עדכוני-סיווג={len(status_updates)}"
    )

    # קטגוריות עצמיות רק לכותרות שבאמת נוצרו (לא כל האתר) - ראו
    # fetch_own_categories. עדיין נשלף ב-dry-run כדי להציג status אמיתי.
    own_categories_by_title = fetch_own_categories([c["title"] for c in all_creations])

    if args.dry_run:
        log("--- DRY RUN: לא נכתב שום דבר לסופרבייס ---")
        for c in all_creations[:20]:
            classification = classify_page_from_own_categories(
                c["title"], own_categories_by_title.get(c["title"], set())
            )
            log(f"  יצירה   | id={c['page_id']} | '{c['title']}' | status={classification['status']}")
        for d in all_deletions[:20]:
            log(f"  מחיקה   | id={d['page_id']} | '{d['title']}' | {d['deleted_at']} | pageid_valid={d['pageid_valid']} | reason={d['reason']}")
        for mv in renames[:20]:
            log(f"  שינוי-שם | id={mv['page_id']} | '{mv['old_title']}' -> '{mv['new_title']}' | {mv['action']}")
        for u in status_updates[:20]:
            log(f"  עדכון-סיווג | id={u['id']} | '{u['title']}' | status={u['status']}")
        if len(all_creations) > 20 or len(all_deletions) > 20 or len(renames) > 20 or len(status_updates) > 20:
            log("  (מוצגות עד 20 שורות מכל סוג)")
        log(f"--- DRY RUN הושלם | watermark היה מתעדכן ל-{run_started_at} ---")
        return

    try:
        write_delta_tables(client, all_creations, all_deletions, renames)
        apply_creations(client, all_creations, own_categories_by_title)
        apply_deletions(client, all_deletions)
        apply_renames(client, renames)
        apply_status_updates(client, status_updates)
        write_changed_ids_file(all_creations, renames, status_updates)

    except Exception:
        log("שגיאה - ה-watermark לא יתעדכן, הריצה הבאה תכסה מחדש את אותו טווח")
        raise

    execute_with_retry(
        lambda: client.table("sync_watermarks").update(
            {"last_synced_ts": run_started_at}
        ).eq("source", SOURCE).execute(),
        "עדכון watermark",
        log_fn=log,
    )
    log(f"סיום | watermark עודכן ל-{run_started_at}")


if __name__ == "__main__":
    main()
