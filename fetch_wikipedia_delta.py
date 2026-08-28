"""
עדכון דלתא לוויקיפדיה העברית - מחליף בהדרגה את הריקון+מילוי-מלא
השבועי של fetch_wikipedia.py (עדיין קיים, לא נמחק - ראו הערה בסוף
מודול זה). רץ כל 2-3 ימים (תזמון ב-weekly_update.yml, שם עדכני).

תלוי במיגרציה migration_add_delta_tables.sql (שש טבלאות הדלתא +
sync_watermarks) - יש להריץ אותה לפני שימוש ראשון בסקריפט הזה.

הפעלה ראשונה (bootstrap): אין עדיין שורת watermark לביצוע 'wikipedia'
ב-sync_watermarks - יש להריץ קודם ריצת בסיס מלאה (fetch_wikipedia.py),
ואז לזרוע ידנית שורת watermark התחלתית (זמן סיום ריצת הבסיס), למשל:
    insert into sync_watermarks (source, last_synced_ts) values ('wikipedia', now());
בלי זה, הסקריפט נכשל בכוונה (ראו main) במקום לנחש טווח שרירותי.

זיהוי שינויי-שם (renames): נבנה מתוך logevents letype=move, מסונן
ל-ns=0 בשני הצדדים (מקור ויעד) - שינוי שם בתוך מרחב השם הראשי בלבד.
תזוזה מ/אל מרחב שם אחר מטופלת כיצירה/מחיקה-כמו (ראו סיווג_תזוזות
למטה), לא כשינוי שם - כי הדף בפועל נכנס/יוצא ממרחב הערכים שהפרויקט
עוקב אחריו.

עדכון wikipedia_pages בפועל (בשונה מריקון+מילוי-מלא): יצירות/שחזורים
מ-upsert-ים רק את id/title/checked_at - שאר עמודות ההעשרה (wikidata_desc,
created_at הידני, easy_import_*, mechalol_redirect_exists) *לא*
נדרסות (upsert חלקי, לא כתיבת שורה מלאה) כדי לא לאבד העשרה קיימת על
שורה שכבר עברה עיבוד. מחיקות מוחקות בפועל (DELETE, לא TRUNCATE) - רק
את השורות שהאירוע מזהה. שינויי-שם מעדכנים את title במקום לפי id
(page_id) - שומר את כל שורות ההעשרה הקיימות, כי המפתח (id) לא השתנה.
"""

import json
import sys
from datetime import datetime, timezone

from config import WIKIPEDIA_API
from delta_api import fetch_new_pages, fetch_delete_log, fetch_move_log
from supabase_client import get_client, execute_with_retry

SOURCE = "wikipedia"
TABLE = "wikipedia_pages"


def log(message):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{now}] {message}", flush=True)


def get_watermark(client):
    result = client.table("sync_watermarks").select("last_synced_ts").eq("source", SOURCE).execute()
    if not result.data:
        raise RuntimeError(
            f"אין שורת watermark עבור '{SOURCE}' ב-sync_watermarks - יש להריץ קודם ריצת "
            f"בסיס מלאה ולזרוע ידנית שורת watermark התחלתית (ראו הערת המודול)."
        )
    return result.data[0]["last_synced_ts"]


def classify_moves(moves):
    """
    מסווגת אירועי move גולמיים (מ-fetch_move_log) לשלוש קבוצות, לפי ns
    של המקור והיעד:
    - renames: שני הצדדים ns=0 (בתוך מרחב הערכים הראשי) - שינוי שם אמיתי.
    - creation_like: יעד ns=0, מקור לא-0 (למשל טיוטה -> ראשי) - נחשב
      כיצירה חדשה של הדף (בכותרת ה-target).
    - deletion_like: מקור ns=0, יעד לא-0 (ראשי -> טיוטה וכו') - נחשב
      כיציאה של הדף ממרחב המעקב, כמו מחיקה.
    (שני הצדדים לא-0 - לא רלוונטי לפרויקט, מדולג).
    """
    renames, creation_like, deletion_like = [], [], []
    for mv in moves:
        if mv["old_ns"] == 0 and mv["new_ns"] == 0:
            renames.append(mv)
        elif mv["old_ns"] != 0 and mv["new_ns"] == 0:
            creation_like.append(mv)
        elif mv["old_ns"] == 0 and mv["new_ns"] != 0:
            deletion_like.append(mv)
    return renames, creation_like, deletion_like


def apply_creations(client, creations):
    if not creations:
        return
    checked_at = datetime.now(timezone.utc).isoformat()
    rows = [
        {"id": c["page_id"], "title": c["title"], "checked_at": checked_at}
        for c in creations
    ]
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

    # mechalol_pages.wikipedia_id הוא מפתח זר בלי ON DELETE (ברירת מחדל
    # RESTRICT - ראו schema.sql) - DELETE ישיר על wikipedia_pages היה
    # נכשל אם קיימת שורת mechalol_pages שמצביעה לאחד ה-id-ים האלה. לכן
    # קודם משחררים כל הפניה כזו ל-NULL (בדיוק כמו truncate_wikipedia_pages()
    # ו-resolve_title_collisions ב-fetch_wikipedia.py) - match.py יחשב
    # מחדש מאפס בריצה הבאה אם צריך.
    execute_with_retry(
        lambda: client.table("mechalol_pages").update({"wikipedia_id": None}).in_("wikipedia_id", ids).execute(),
        f"שחרור {len(ids)} הפניות wikipedia_id לפני מחיקה",
        log_fn=log,
    )
    execute_with_retry(
        lambda: client.table(TABLE).delete().in_("id", ids).execute(),
        f"מחיקת {len(ids)} דפים מ-{TABLE}",
        log_fn=log,
    )
    log(f"נמחקו {len(ids)} דפים מ-{TABLE}")


def apply_renames(client, renames):
    """
    מעדכנת title בלבד, לפי id (page_id) - לא נוגעת בשום עמודת העשרה
    אחרת. כתובה שורה-שורה (לא upsert-אצווה) כי כל שורה עשויה להתנגש
    עם ה-title הישן שעדיין רשום בטבלה על page_id אחר (אם היה סבב
    שינויי-שם מעגלי) - update לפי id בודד לא רגיש לזה כמו upsert-אצווה.
    """
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
            lambda: client.table("wikipedia_creations").upsert(
                rows, on_conflict="page_id,created_at", ignore_duplicates=True
            ).execute(),
            "כתיבת wikipedia_creations",
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
            lambda: client.table("wikipedia_deletions").upsert(
                rows, on_conflict="page_id,deleted_at", ignore_duplicates=True
            ).execute(),
            "כתיבת wikipedia_deletions",
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
            lambda: client.table("wikipedia_renames").upsert(
                rows, on_conflict="page_id,renamed_at", ignore_duplicates=True
            ).execute(),
            "כתיבת wikipedia_renames",
            log_fn=log,
        )


def write_changed_ids_file(all_creations, all_deletions, renames):
    """
    כותב wikipedia_delta_changed_ids.json - כל page_id בוויקיפדיה
    שהושפע בריצת הדלתא הזו (יצירה/מחיקה/שינוי-שם), לשימוש על ידי
    match.py --scoped (compute_scoped_ids) - מוצא דרכו שורות מכלול
    שהתאמה שלהן עלולה להישבר/להתאפשר בגלל השינוי הזה בצד ויקיפדיה.
    נכתב תמיד (גם רשימה ריקה) - קיום הקובץ מסמן ל-match.py שריצת
    דלתא בכלל התרחשה (ראו _load_changed_ids ב-match.py).
    """
    ids = set()
    ids.update(c["page_id"] for c in all_creations if c.get("page_id"))
    ids.update(d["page_id"] for d in all_deletions if d.get("page_id"))
    ids.update(mv["page_id"] for mv in renames if mv.get("page_id"))

    with open("wikipedia_delta_changed_ids.json", "w", encoding="utf-8") as f:
        json.dump(sorted(ids), f)
    log(f"נכתב wikipedia_delta_changed_ids.json | {len(ids)} id-ים")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="עדכון דלתא לוויקיפדיה העברית")
    parser.add_argument(
        "--since",
        help=(
            "זמן ISO 8601 (למשל 2026-08-25T00:00:00Z) לשליפה ממנו, "
            "במקום לקרוא watermark מ-sync_watermarks. עם --dry-run, מייתר "
            "לגמרי את הצורך בחיבור לסופרבייס - שימושי לבדיקה נקודתית בלי "
            "אישורי גישה למסד הנתונים."
        ),
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help=(
            "שולף מה-API האמיתי (רשת חובה) ומדפיס בדיוק מה היה נכתב/נמחק/"
            "מתעדכן - בלי לגעת בסופרבייס בכלל (לא כתיבה, ואם ניתן --since "
            "גם לא קריאה). לא כותב changed_ids.json ולא מזיז watermark."
        ),
    )
    args = parser.parse_args()

    if args.dry_run and not args.since:
        raise SystemExit("--dry-run דורש גם --since (אין קריאת watermark בלי חיבור לסופרבייס)")

    client = None if (args.dry_run and args.since) else get_client()
    since_ts = args.since or get_watermark(client)
    run_started_at = datetime.now(timezone.utc).isoformat()

    log(f"התחלה | דלתא ויקיפדיה | מאז {since_ts}" + (" | DRY-RUN" if args.dry_run else ""))

    new_pages = fetch_new_pages(WIKIPEDIA_API, since_ts)
    deletions, restores = fetch_delete_log(WIKIPEDIA_API, since_ts)
    moves = fetch_move_log(WIKIPEDIA_API, since_ts)
    renames, move_creations, move_deletions = classify_moves(moves)

    # שחזורים (restore) ותזוזות-כיצירה (למשל טיוטה->ראשי) נספרים
    # כיצירה - אין להם created_at אמיתי מ-recentchanges (הם לא
    # type:new), אז נעשה בהם שימוש בזמן האירוע עצמו כברירת מחדל
    # סבירה (מדויק מספיק לצורך "השורה קיימת בטבלה עם checked_at
    # עדכני" - created_at ההיסטורי המדויק, אם שונה, יתוקן בפיוס
    # החודשי המלא מול fetch_wikipedia_created_at.py).
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

    if args.dry_run:
        log("--- DRY RUN: לא נכתב שום דבר לסופרבייס ---")
        for c in all_creations[:20]:
            log(f"  יצירה   | id={c['page_id']} | '{c['title']}' | {c['created_at']}")
        for d in all_deletions[:20]:
            log(f"  מחיקה   | id={d['page_id']} | '{d['title']}' | {d['deleted_at']} | pageid_valid={d['pageid_valid']}")
        for mv in renames[:20]:
            log(f"  שינוי-שם | id={mv['page_id']} | '{mv['old_title']}' -> '{mv['new_title']}' | {mv['action']}")
        if len(all_creations) > 20 or len(all_deletions) > 20 or len(renames) > 20:
            log("  (מוצגות עד 20 שורות מכל סוג)")
        log(f"--- DRY RUN הושלם | watermark היה מתעדכן ל-{run_started_at} ---")
        return

    try:
        write_delta_tables(client, all_creations, all_deletions, renames)
        apply_creations(client, all_creations)
        apply_deletions(client, all_deletions)
        apply_renames(client, renames)
        write_changed_ids_file(all_creations, all_deletions, renames)

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

# הערה: fetch_wikipedia.py (ריקון+מילוי-מלא) עדיין קיים ולא הוחלף -
# ריצה תקופתית שלו (מוצע: חודשית, יחד עם check_missing_locked.py
# וסקריפטי ההעשרה) ממשיכה לשמש כפיוס מלא, שתופס בין השאר את הפערים
# הידועים שהדלתא לא רואה במכוון (ראו summary התכנון: שינוי סטטוס
# הפניה<->ערך בלי אירוע יצירה/מחיקה/תזוזה נלווה).
