"""
עדכון דלתא לוויקיפדיה העברית - מחליף בהדרגה את הריקון+מילוי-מלא
המלא של fetch_wikipedia.py (עדיין קיים, לא נמחק - ראו הערה בסוף
מודול זה, רץ עכשיו רק כפיוס חודשי). רץ כל לילה (nightly_delta.yml).

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
from delta_api import (
    fetch_new_pages, fetch_delete_log, fetch_move_log,
    fetch_edited_page_ids, fetch_redirect_status,
)
from supabase_client import get_client, execute_with_retry

SOURCE = "wikipedia"
TABLE = "wikipedia_pages"
ID_LOOKUP_BATCH_SIZE = 500


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


def find_tracked_ids(client, table, candidate_ids):
    """
    בהינתן קבוצת page_id מועמדים (למשל - כל מי שנערך בטווח) - מחזירה
    רק את אלה שכבר קיימים בטבלה שלנו (id). לא בודקת שום דבר אחר - רק
    "האם אנחנו כבר עוקבים אחרי הדף הזה בכלל". None/candidate_ids ריק
    -> קבוצה ריקה, בלי קריאת רשת מיותרת.
    """
    if not client or not candidate_ids:
        return set()
    found = set()
    candidate_ids = sorted(set(candidate_ids))
    for i in range(0, len(candidate_ids), ID_LOOKUP_BATCH_SIZE):
        chunk = candidate_ids[i:i + ID_LOOKUP_BATCH_SIZE]
        result = execute_with_retry(
            lambda chunk=chunk: client.table(table).select("id").in_("id", chunk).execute(),
            f"בדיקת מעקב קיים ({table}) | אצווה {i // ID_LOOKUP_BATCH_SIZE + 1}",
            log_fn=log,
        )
        found.update(row["id"] for row in (result.data or []))
    return found


def detect_became_redirect(client, since_ts, already_handled_ids):
    """
    מזהה ערכים *במעקב אצלנו* שהפכו להפניה בעריכה רגילה - הפער
    המתועד בתכנון שלא נראה כלל דרך logevents/type:new (ראו הערת
    fetch_edited_page_ids/fetch_redirect_status ב-delta_api.py).

    already_handled_ids: page_id-ים שכבר טופלו השבוע דרך המסלול
    הרגיל (יצירה/מחיקה/שינוי-שם) - מדלגים עליהם כאן, אין טעם לבדוק
    פעמיים. client=None (למשל --dry-run בלי watermark מה-DB) -
    מדלג על השלב הזה כולו ומדפיס אזהרה, כי הוא דורש קריאת הטבלה שלנו.

    מחזירה רשימת "מחיקות" רגילות (reason='became_redirect') - נכנסות
    לאותו זרם טיפול בדיוק כמו מחיקה שהגיעה מ-logevents.
    """
    if not client:
        log("דילוג על זיהוי 'הפך להפניה' - אין חיבור לסופרבייס (--dry-run בלי DB)")
        return []

    edited = fetch_edited_page_ids(WIKIPEDIA_API, since_ts)
    candidate_ids = {e["page_id"] for e in edited} - already_handled_ids
    if not candidate_ids:
        return []

    tracked_ids = find_tracked_ids(client, TABLE, candidate_ids)
    if not tracked_ids:
        return []

    id_to_title = {e["page_id"]: e["title"] for e in edited if e["page_id"] in tracked_ids}
    redirect_status = fetch_redirect_status(WIKIPEDIA_API, list(id_to_title.values()))

    now_iso = datetime.now(timezone.utc).isoformat()
    became_redirect = [
        {
            "page_id": page_id, "title": title,
            "deleted_at": now_iso, "pageid_valid": True, "reason": "became_redirect",
        }
        for page_id, title in id_to_title.items()
        if redirect_status.get(title) is True
    ]
    if became_redirect:
        log(f"נמצאו {len(became_redirect)} ערכים במעקב שהפכו להפניה בעריכה רגילה")
    return became_redirect


def _is_title_collision(exc):
    return getattr(exc, "code", None) == "23505" and "wikipedia_pages_title_key" in str(exc)


def resolve_title_collisions(client, rows):
    """
    מקביל בדיוק ל-resolve_title_collisions ב-fetch_wikipedia.py (הסריקה
    המלאה) - ראו שם לתיעוד המלא. שורה קיימת "מיושנת" רק אם הכותרת שלה
    תואמת כותרת באצווה החדשה *וגם* ה-id שונה (אותה שורה בדיוק, id
    זהה, זה לא התנגשות - זה upsert רגיל). משחררת קודם כל הפניית
    wikipedia_id אליה (בדיוק כמו ב-apply_deletions) לפני המחיקה - אותו
    מפתח זר RESTRICT.

    קורה בפועל רק אם עברו 30+ יום בלי שהמחיקה המקורית של השורה הישנה
    נתפסה בדלתא (חלון השמירה של recentchanges) - נדיר, אבל אפשרי גם
    עם דלתא לילית (למשל אחרי תקלה ממושכת בהרצות). בלי הטיפול הזה,
    upsert/update על כותרת שכבר תפוסה על id אחר פשוט נכשל עם שגיאת
    אילוץ ייחודיות - ולא באג "שקט", אבל עוצר את כל הריצה עד שמישהו
    יתערב ידנית.
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
            lambda: client.table("mechalol_pages").update({"wikipedia_id": None}).in_("wikipedia_id", stale_ids).execute(),
            "שחרור הפניות לפני מחיקת שורות מיושנות",
            log_fn=log,
        )
        execute_with_retry(
            lambda: client.table(TABLE).delete().in_("id", stale_ids).execute(),
            "מחיקת שורות מיושנות",
            log_fn=log,
        )

    return bool(stale_ids)


def _upsert_with_collision_handling(client, rows):
    """
    ניסיון upsert יחיד, עם טיפול מיידי בהתנגשות כותרת (ראו
    resolve_title_collisions) - עטוף כולו ב-execute_with_retry על ידי
    הקוראים, כדי ששגיאות רשת/זמניות רגילות עדיין ייהנו מהניסיון החוזר
    הגנרי, בלי לבזבז אותם ניסיונות על שגיאת התנגשות שלא תיפתר לבד.

    resolve_title_collisions מנקה רק שורה *קיימת ב-DB* שמתנגשת עם
    כותרת חדשה. היא לא עוזרת אם ההתנגשות היא *בתוך האצווה עצמה* - שני
    page_id שונים באותה אצווה עם אותה כותרת בדיוק (מצב מעברי אמיתי,
    לא נדיר כשיש הרבה תזוזות/שחזורים בחלון דלתא אחד) - אז אין שורה
    מיושנת למחוק, resolve_title_collisions מחזירה False, וה-upsert
    הבא ייכשל באותה שגיאה בדיוק, שוב ושוב, גם תחת execute_with_retry
    החיצונית (נצפה בפועל: 5 ניסיונות זהים). הפתרון: ליפול חזרה
    לעדכון שורה-שורה - כל שורה שמתחייבת ל-DB הופכת את השורה הבאה
    שמתנגשת איתה לניתנת-לפתרון ע"י resolve_title_collisions הרגילה
    (עכשיו יש שורה אמיתית ב-DB לזהות מולה) - אותו עיקרון בדיוק לפיו
    apply_renames כבר עובד שורה-שורה מלכתחילה.
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


def _dedupe_creations_by_id(creations):
    """
    all_creations (=new_pages+restores+move_creation_events) יכולה
    להכיל אותו page_id יותר מפעם אחת בתוך אותו חלון דלתא - למשל דף
    שנוצר ואז נמחק ושוחזר תוך אותו לילה (מופיע גם ב-new_pages וגם
    ב-restores), או תזוזה החוצה ובחזרה למרחב הראשי תוך אותו חלון (שתי
    move_creation_events). upsert יחיד עם on_conflict="id" לא יכול
    לגעת באותה שורה פעמיים באותה פקודה - Postgres נכשל עם 'ON CONFLICT
    DO UPDATE command cannot affect row a second time' (21000). מצמצם
    ל-page_id אחד, שומר את האירוע עם created_at המאוחר ביותר - משקף
    את המצב הסופי בפועל בתום החלון.
    """
    latest_by_id = {}
    for c in creations:
        existing = latest_by_id.get(c["page_id"])
        if existing is None or c["created_at"] > existing["created_at"]:
            latest_by_id[c["page_id"]] = c
    return list(latest_by_id.values())


def apply_creations(client, creations):
    if not creations:
        return
    checked_at = datetime.now(timezone.utc).isoformat()
    rows = [
        {"id": c["page_id"], "title": c["title"], "checked_at": checked_at}
        for c in _dedupe_creations_by_id(creations)
    ]
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

    גם UPDATE יחיד יכול לפגוע באילוץ הייחודיות על title (לא רק
    upsert) - אם השורה הישנה שכבר תפוסה על ה-title החדש היא "מיושנת"
    (page_id אחר, לא נמחקה כי המחיקה שלה פוספסה בעבר - ראו
    resolve_title_collisions) - אותו טיפול בדיוק.
    """
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
                "reason": d["reason"],
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
    for d in deletions:
        d["reason"] = "log_event"

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
    became_redirect = detect_became_redirect(client, since_ts, already_handled_ids)

    all_deletions = deletions + move_deletion_events + became_redirect

    log(
        f"נמצאו | יצירות={len(new_pages)} שחזורים={len(restores)} "
        f"תזוזות-כיצירה={len(move_creations)} | מחיקות={len(deletions)} "
        f"תזוזות-כמחיקה={len(move_deletions)} הפכו-להפניה={len(became_redirect)} | "
        f"שינויי-שם={len(renames)}"
    )

    if args.dry_run:
        log("--- DRY RUN: לא נכתב שום דבר לסופרבייס ---")
        for c in all_creations[:20]:
            log(f"  יצירה   | id={c['page_id']} | '{c['title']}' | {c['created_at']}")
        for d in all_deletions[:20]:
            log(f"  מחיקה   | id={d['page_id']} | '{d['title']}' | {d['deleted_at']} | pageid_valid={d['pageid_valid']} | reason={d['reason']}")
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
