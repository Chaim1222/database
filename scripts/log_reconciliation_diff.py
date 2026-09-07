"""
מריץ את log_reconciliation_diff() (ראו migration_add_reconciliation_
audit.sql + migration_finalize_temp_pages_naming.sql +
migration_add_reconciliation_timing_classification.sql) - משווה את
הטבלה הפעילה מול הטבלה הזמנית (שמחזיקה, מיד אחרי swap, בדיוק את מה
שהיה פעיל רגע לפני כן) מיד אחרי ההחלפה האטומית, מוציא כל id שטבלאות
הדלתא כבר ידעו עליו (יצירה/מחיקה/שינוי-שם) מאז הריצה המלאה הקודמת,
וסופר כמה מהנשארים בכל זאת קיבלו סיווג שונה. המטרה: לצבור עדות מדידה -
לאורך כמה חודשים - האם הריצה השבועית המלאה עדיין תופסת פערים אמיתיים
שהעדכון היומי (--scoped) לא יכול לתפוס מעצם העיצוב שלו, כדי שיהיה
אפשר להחליט בעתיד אם עדיין נחוצה בתדירות הנוכחית.

תוספת (2026-09): שינוי שקרה סתם *אחרי* watermark הדלתא האחרונה הוא
תזמון בלבד - לא פער עיצוב (הדלתא הבאה תתפוס אותו ממילא) - אבל אין
דרך לדעת את זה מתוך המסד המקומי לבד, רק מבדיקת הגרסה האמיתית האחרונה
של הדף מול ה-API החי. אחרי שקוראים ל-log_reconciliation_diff(),
classify_timing() בודקת כל שורה חדשה בדיוק ככה ומסמנת is_timing_only
בהתאם - כדי שהמונה untracked_changes_genuine (בניגוד ל-
untracked_changes_found הגולמי, שנשאר ללא שינוי לצורך רציפות) ישקף
רק פערים שהדלתא הייתה אמורה לתפוס ולא תפסה.

נקרא רק אחרי swap_temp_to_active.py, ולפני truncate_temp_pages.py -
ורק כשההחלפה באמת קרתה (should_swap=true) - אם ההחלפה דולגה, הטבלה
הזמנית לא השתנתה הסבב הזה, אין מה להשוות.

הרצה:
    python log_reconciliation_diff.py
"""

from datetime import datetime

from config import WIKIPEDIA_API, MECHALOL_API
from delta_api import fetch_latest_revision_timestamps
from mechalol_api import log
from supabase_client import get_client, execute_with_retry

API_BY_SIDE = {"wikipedia": WIKIPEDIA_API, "mechalol": MECHALOL_API}


def _parse_ts(ts_str):
    return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))


def _load_watermarks(client):
    result = execute_with_retry(
        lambda: client.table("sync_watermarks").select("source, last_synced_ts").execute(),
        "טעינת sync_watermarks",
        log_fn=log,
    )
    return {row["source"]: _parse_ts(row["last_synced_ts"]) for row in (result.data or [])}


def classify_timing(client, audit_id):
    """
    עבור כל שורה ב-reconciliation_audit_details של audit_id הנתון:
    שולפת את הגרסה האחרונה בפועל של הדף (API חי, לפי side) ומשווה מול
    watermark הדלתא האחרונה לאותו מקור (כפי שהוא כרגע ב-sync_watermarks -
    זה בדיוק ה-watermark שהיה בתוקף כשהדלתא האחרונה רצה, לפני הפיוס
    המלא הזה - הפיוס המלא רץ תמיד אחרי הדלתא, לא לפניה).

    is_timing_only=true כאשר הגרסה האחרונה בפועל מאוחרת-או-שווה
    ל-watermark - השינוי קרה אחרי שהדלתא האחרונה כבר הביטה, ופשוט לא
    היה לה סיכוי לתפוס אותו; ייתפס ממילא בדלתא הבאה. כשלא הצלחנו
    לקבוע (הדף לא נמצא בבדיקה החיה, למשל נמחק שוב מאז) - נשאר
    is_timing_only=false בברירת מחדל: מוצג כפער אמיתי, לא נעלם בשקט.

    מחזיר את מספר הפערים ה"אמיתיים" (לא-תזמון) שנמצאו.
    """
    watermarks = _load_watermarks(client)

    result = execute_with_retry(
        lambda: client.table("reconciliation_audit_details")
        .select("id, side, page_id")
        .eq("audit_id", audit_id)
        .execute(),
        f"טעינת reconciliation_audit_details עבור audit_id={audit_id}",
        log_fn=log,
    )
    rows = result.data or []
    if not rows:
        log("סיווג תזמון | אין שורות לסווג")
        return 0

    by_side = {"wikipedia": [], "mechalol": []}
    for row in rows:
        by_side[row["side"]].append(row)

    latest_by_side = {}
    for side, side_rows in by_side.items():
        if not side_rows:
            continue
        pageids = [r["page_id"] for r in side_rows]
        latest_by_side[side] = fetch_latest_revision_timestamps(API_BY_SIDE[side], pageids)
        log(f"סיווג תזמון | {side} | {len(pageids)} דפים נבדקו מול API חי")

    genuine_count = 0
    for row in rows:
        side = row["side"]
        watermark = watermarks.get(side)
        latest_str = latest_by_side.get(side, {}).get(row["page_id"])

        is_timing_only = False
        if latest_str and watermark is not None:
            is_timing_only = _parse_ts(latest_str) >= watermark

        if not is_timing_only:
            genuine_count += 1

        execute_with_retry(
            lambda row=row, is_timing_only=is_timing_only, latest_str=latest_str: (
                client.table("reconciliation_audit_details")
                .update({
                    "is_timing_only": is_timing_only,
                    "source_latest_edit_at": latest_str,
                })
                .eq("id", row["id"])
                .execute()
            ),
            f"סיווג id={row['id']} | side={side} | page_id={row['page_id']} | timing={is_timing_only}",
            log_fn=log,
        )

    execute_with_retry(
        lambda: client.table("reconciliation_audit")
        .update({"untracked_changes_genuine": genuine_count})
        .eq("id", audit_id)
        .execute(),
        f"עדכון untracked_changes_genuine={genuine_count} | audit_id={audit_id}",
        log_fn=log,
    )

    return genuine_count


def main():
    client = get_client()

    log("=" * 80)
    log("START | log_reconciliation_diff.py")

    result = execute_with_retry(
        lambda: client.rpc("log_reconciliation_diff").execute(),
        "LOG_RECONCILIATION_DIFF",
        log_fn=log,
    )
    audit_id = result.data

    log(f"עודכן | reconciliation_audit קיבלה שורה חדשה | audit_id={audit_id}")

    if audit_id is not None:
        log("סיווג תזמון מול פער עיצוב אמיתי (בדיקת API חי)...")
        genuine_count = classify_timing(client, audit_id)
        log(f"סיווג הושלם | פערים אמיתיים (לא-תזמון) = {genuine_count:,}")
    else:
        log("WARNING | log_reconciliation_diff() לא החזירה audit_id - מדלגים על סיווג התזמון")

    log("=" * 80)
    log("סיום | log_reconciliation_diff.py")


if __name__ == "__main__":
    main()
