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
של הדף מול ה-API החי. אחרי שהפערים נשמרים במסד, classify_timing()
בודקת כל שורה חדשה בדיוק ככה ומסמנת is_timing_only בהתאם - כדי
שהמונה untracked_changes_genuine (בניגוד ל-untracked_changes_found
הגולמי, שנשאר ללא שינוי לצורך רציפות) ישקף רק פערים שהדלתא הייתה
אמורה לתפוס ולא תפסה.

בריצה השבועית שני השלבים מופרדים בכוונה: קודם נשמרת הביקורת בזמן
שהטבלה הזמנית עדיין מחזיקה את המצב הקודם; מיד אחר כך הטבלה הזמנית
מתרוקנת; ורק אז מתבצע סיווג התזמון מול הממשקים החיים. כך כשל בסיווג
לא משאיר מאות אלפי שורות בטבלאות הזמניות. אם שמירת הביקורת עצמה
נכשלת, הריקון לא מתבצע והמצב הקודם נשמר לצורך ניסיון חוזר.

הרצה רגילה (שמירה + סיווג, לשימוש ידני):
    python log_reconciliation_diff.py

שמירת ביקורת בלבד, לפני ריקון הטבלאות הזמניות:
    python log_reconciliation_diff.py --record-only

סיווג ביקורת קיימת בלי ליצור חדשה:
    python log_reconciliation_diff.py --classify-only <audit_id>
"""

from datetime import datetime
import sys

from config import WIKIPEDIA_API, MECHALOL_API
from delta_api import fetch_latest_revision_timestamps
from mechalol_api import log
from supabase_client import get_client, execute_with_retry

API_BY_SIDE = {"wikipedia": WIKIPEDIA_API, "mechalol": MECHALOL_API}


def _write_audit_id_output(audit_id):
    import os

    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        log("קובץ הפלט של סביבת ההרצה לא מוגדר - מדלג על כתיבת מזהה הביקורת")
        return

    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"audit_id={audit_id}\n")


def record_audit(client):
    result = execute_with_retry(
        lambda: client.rpc("log_reconciliation_diff").execute(),
        "LOG_RECONCILIATION_DIFF",
        log_fn=log,
    )
    audit_id = result.data
    if audit_id is None:
        raise RuntimeError("log_reconciliation_diff() לא החזירה מזהה ביקורת - לא בטוח לרוקן את הטבלאות הזמניות")

    audit_id = int(audit_id)
    log(f"עודכן | reconciliation_audit קיבלה שורה חדשה | audit_id={audit_id}")
    return audit_id


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

    # מצב שמירה בלבד: יוצר את הביקורת בזמן שהטבלאות הזמניות עדיין
    # מחזיקות את המצב הקודם, וכותב את המזהה לפלט של סביבת ההרצה.
    # אם השמירה עצמה נכשלת או לא מחזירה מזהה - יוצאים בכשל, כדי שהשלב
    # הבא לא ירוקן את הטבלאות הזמניות לפני שההשוואה נשמרה.
    if len(sys.argv) >= 2 and sys.argv[1] == "--record-only":
        if len(sys.argv) != 2:
            log("ERROR | שימוש: python log_reconciliation_diff.py --record-only")
            sys.exit(1)

        audit_id = record_audit(client)
        _write_audit_id_output(audit_id)
        log("=" * 80)
        log("סיום | log_reconciliation_diff.py (שמירה בלבד)")
        return

    # מצב השלמה: --classify-only <audit_id> מדלג לגמרי על קריאת ה-RPC
    # ומריץ רק את שלב הסיווג על ביקורת קיימת. נחוץ כשריצה קודמת יצרה
    # את שורת הביקורת ואת שורות הפרטים בהצלחה (ה-RPC הסתיים) אבל
    # classify_timing נכשל באמצע - קריאה חוזרת ל-RPC הייתה יוצרת
    # ביקורת חדשה עם watermark מתקדם, ומשאירה את הביקורת התקועה בלי
    # סיווג לתמיד. classify_timing אידמפוטנטית - בטוח להריץ שוב.
    if len(sys.argv) >= 2 and sys.argv[1] == "--classify-only":
        if len(sys.argv) != 3:
            log("ERROR | שימוש: python log_reconciliation_diff.py --classify-only <audit_id>")
            sys.exit(1)
        try:
            audit_id = int(sys.argv[2])
        except ValueError:
            log(f"ERROR | audit_id חייב להיות מספר שלם, התקבל: {sys.argv[2]!r}")
            sys.exit(1)

        log(f"מצב השלמה | classify-only | audit_id={audit_id}")
        log("סיווג תזמון מול פער עיצוב אמיתי (בדיקת API חי)...")
        genuine_count = classify_timing(client, audit_id)
        log(f"סיווג הושלם | פערים אמיתיים (לא-תזמון) = {genuine_count:,}")
        log("=" * 80)
        log("סיום | log_reconciliation_diff.py")
        return

    if len(sys.argv) != 1:
        log("ERROR | אפשרויות נתמכות: --record-only או --classify-only <audit_id>")
        sys.exit(1)

    audit_id = record_audit(client)
    log("סיווג תזמון מול פער עיצוב אמיתי (בדיקת API חי)...")
    genuine_count = classify_timing(client, audit_id)
    log(f"סיווג הושלם | פערים אמיתיים (לא-תזמון) = {genuine_count:,}")

    log("=" * 80)
    log("סיום | log_reconciliation_diff.py")


if __name__ == "__main__":
    main()
