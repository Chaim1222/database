"""
עדכון דלתא למכלול - מקביל ל-fetch_wikipedia_delta.py, ראו שם להסבר
כללי על הארכיטקטורה (watermark, bootstrap, סיווג תזוזות). ההבדל
המהותי היחיד: mechalol_pages.status הוא NOT NULL עם CHECK constraint,
ונקבע לפי חברות בקטגוריות (לא זמין מ-recentchanges/logevents עצמם) -
ולכן דף חדש שנמצא בדלתא עדיין חייב סיווג, בדיוק כמו בסריקה המלאה.

במקום לשכפל את לוגיקת הסיווג (סיכון לסטייה בין הגרסאות עם הזמן),
משתמש ישירות ב-fetch_classification_data()/classify_page() המיוצאות
מ-fetch_mechalol.py (חולצו לשם בדיוק לצורך זה). עלות זו זולה וקבועה -
שליפת ~10 קטגוריות מוגדרות מראש, לא תלויה בכמות הדפים הכוללת במכלול
(350 אלף) - ולכן סבירה גם בריצת דלתא תכופה (כל 2-3 ימים), לא רק
בסריקה השבועית/עתידית-פחות-תכופה המלאה.

לוגין (login מ-fetch_mechalol.py) *לא* בשימוש כאן בכוונה - כמות
הדפים בדלתא בודדת-עד-מאות, לא צריך aplimit/cmlimit גבוה (הטעם היחיד
ל-login שם); ריצה אנונימית עם המגבלה הרגילה (500) מספיקה בהחלט.
"""

from datetime import datetime, timezone
import json

from config import MECHALOL_API
from delta_api import fetch_new_pages, fetch_delete_log, fetch_move_log
from fetch_mechalol import fetch_own_categories, classify_page_from_own_categories
from supabase_client import get_client, execute_with_retry

SOURCE = "mechalol"
TABLE = "mechalol_pages"


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
    rows = []
    for c in creations:
        classification = classify_page_from_own_categories(
            c["title"], own_categories_by_title.get(c["title"], set())
        )
        rows.append({"id": c["page_id"], "title": c["title"], **classification})

    execute_with_retry(
        lambda: client.table(TABLE).upsert(rows, on_conflict="id").execute(),
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
        execute_with_retry(
            lambda mv=mv: client.table(TABLE).update({"title": mv["new_title"]}).eq("id", mv["page_id"]).execute(),
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


def write_changed_ids_file(all_creations, renames):
    """
    כותב mechalol_delta_changed_ids.json - כל page_id במכלול שהשתנה
    בריצת הדלתא הזו (יצירה/שינוי-שם - מחיקות לא נכללות, אין טעם
    להתאים מחדש שורה שכבר לא קיימת), לשימוש על ידי match.py --scoped.
    נכתב תמיד (גם רשימה ריקה) - ראו התיעוד המקביל ב-fetch_wikipedia_delta.py.
    """
    ids = set()
    ids.update(c["page_id"] for c in all_creations if c.get("page_id"))
    ids.update(mv["page_id"] for mv in renames if mv.get("page_id"))

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
        }
        for mv in move_deletions
    ]
    all_deletions = deletions + move_deletion_events

    log(
        f"נמצאו | יצירות={len(new_pages)} שחזורים={len(restores)} "
        f"תזוזות-כיצירה={len(move_creations)} | מחיקות={len(deletions)} "
        f"תזוזות-כמחיקה={len(move_deletions)} | שינויי-שם={len(renames)}"
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
            log(f"  מחיקה   | id={d['page_id']} | '{d['title']}' | pageid_valid={d['pageid_valid']}")
        for mv in renames[:20]:
            log(f"  שינוי-שם | id={mv['page_id']} | '{mv['old_title']}' -> '{mv['new_title']}' | {mv['action']}")
        if len(all_creations) > 20 or len(all_deletions) > 20 or len(renames) > 20:
            log("  (מוצגות עד 20 שורות מכל סוג)")
        log(f"--- DRY RUN הושלם | watermark היה מתעדכן ל-{run_started_at} ---")
        return

    try:
        write_delta_tables(client, all_creations, all_deletions, renames)
        apply_creations(client, all_creations, own_categories_by_title)
        apply_deletions(client, all_deletions)
        apply_renames(client, renames)
        write_changed_ids_file(all_creations, renames)

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
