"""
מריץ את log_reconciliation_diff() (ראו migration_add_reconciliation_
audit.sql + migration_finalize_temp_pages_naming.sql) - משווה את
הטבלה הפעילה מול הטבלה הזמנית (שמחזיקה, מיד אחרי swap, בדיוק את מה
שהיה פעיל רגע לפני כן) מיד אחרי ההחלפה האטומית, מוציא כל id שטבלאות
הדלתא כבר ידעו עליו (יצירה/מחיקה/שינוי-שם) מאז הריצה המלאה הקודמת,
וסופר כמה מהנשארים בכל זאת קיבלו סיווג שונה. המטרה: לצבור עדות מדידה -
לאורך כמה חודשים - האם הריצה השבועית המלאה עדיין תופסת פערים אמיתיים
שהעדכון היומי (--scoped) לא יכול לתפוס מעצם העיצוב שלו, כדי שיהיה
אפשר להחליט בעתיד אם עדיין נחוצה בתדירות הנוכחית.

נקרא רק אחרי swap_temp_to_active.py, ולפני truncate_temp_pages.py -
ורק כשההחלפה באמת קרתה (should_swap=true) - אם ההחלפה דולגה, הטבלה
הזמנית לא השתנתה הסבב הזה, אין מה להשוות.

הרצה:
    python log_reconciliation_diff.py
"""

from mechalol_api import log
from supabase_client import get_client, execute_with_retry


def main():
    client = get_client()

    log("=" * 80)
    log("START | log_reconciliation_diff.py")

    execute_with_retry(
        lambda: client.rpc("log_reconciliation_diff").execute(),
        "LOG_RECONCILIATION_DIFF",
        log_fn=log,
    )

    log("עודכן | reconciliation_audit קיבלה שורה חדשה")
    log("=" * 80)
    log("סיום | log_reconciliation_diff.py")


if __name__ == "__main__":
    main()
