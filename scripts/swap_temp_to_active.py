"""
מבצע את ההחלפה האטומית עצמה (שלב 5 בתכנון - mirror_architecture_
design.md) - קריאה אחת ל-RPC perform_atomic_swap() (ראו
migration_add_swap_function.sql + migration_finalize_temp_pages_naming.sql
לעדכון המאוחר), עטופה בניסיון-חוזר: כישלון בגלל lock_timeout הוא זמני
מטבעו וסביר שיצליח בניסיון הבא, ברגע שהשאילתה החוסמת מסתיימת (ראו
הערה מלאה על lock_timeout ב-schema/migration).

נקרא רק אחרי ש-validate_before_swap.py אישר את ההחלפה (should_swap=
true) - הסקריפט הזה עצמו לא בודק שוב את מספר השורות, זו לא אחריותו.

הרצה:
    python swap_temp_to_active.py
"""

import time

from mechalol_api import log
from supabase_client import get_client

MAX_SWAP_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5

# SQLSTATE של שגיאות שקשורות לנעילה/timeout - אותם קודים בדיוק
# שמסווגים כ"זמני" גם בצד הגאדג'ט (isTransientMaintenanceError ב-
# dashboard.html) - 55P03 = lock_not_available (lock_timeout שלנו),
# 57014 = query_canceled (סטטמנט-טיימאאוט כללי, ליתר ביטחון).
TRANSIENT_LOCK_SQLSTATES = {"55P03", "57014"}


def _is_transient_lock_error(exc) -> bool:
    code = getattr(exc, "code", None)
    if code in TRANSIENT_LOCK_SQLSTATES:
        return True
    # גיבוי כשאין code זמין על אובייקט החריגה (תלוי בגרסת supabase-py) -
    # בדיקת מחרוזת על הודעת השגיאה עצמה.
    message = str(exc).lower()
    return "lock timeout" in message or "lock_timeout" in message


SWAP_TABLES = ("wikipedia_pages", "wikipedia_pages_temp", "mechalol_pages", "mechalol_pages_temp")


def snapshot(client):
    """ספירת שורות בארבע הטבלאות. משמשת לזהות אם החלפה כבר בוצעה (ראו swap_happened)."""
    from validate_before_swap import count_rows

    return {table: count_rows(client, table) for table in SWAP_TABLES}


def swap_happened(before, after):
    """
    האם ההחלפה כבר התבצעה, לפי ספירות לפני ואחרי: True = הפעילה היא עכשיו מה שהיה זמני (ולהפך);
    False = שום דבר לא השתנה; None = אי אפשר לקבוע (למשל כל הספירות שוות, או מצב מעורב).
    """
    if after == before:
        return False
    swapped = (
        after["wikipedia_pages"] == before["wikipedia_pages_temp"]
        and after["wikipedia_pages_temp"] == before["wikipedia_pages"]
        and after["mechalol_pages"] == before["mechalol_pages_temp"]
        and after["mechalol_pages_temp"] == before["mechalol_pages"]
    )
    return True if swapped else None


def perform_swap_with_retry(client):
    """
    ניסיון חוזר **רק** על שגיאת נעילה/timeout (55P03/57014): הפונקציה בטרנזקציה אחת, ולכן שגיאה כזו מגלגלת
    הכול לאחור ובטוח לנסות שוב. על כל שגיאה אחרת (למשל ניתוק אחרי commit שהתשובה עליו אבדה) לא מנסים שוב
    בעיוורון: קריאה שנייה הייתה מחליפה בחזרה, והריקון שאחריה היה מוחק דווקא את הנתונים החדשים. במקום זה
    בודקים לפי ספירות אם ההחלפה כבר קרתה; אם כן ממשיכים, אחרת נכשלים בקול.
    """
    before = snapshot(client)
    for attempt in range(1, MAX_SWAP_ATTEMPTS + 1):
        try:
            client.rpc("perform_atomic_swap").execute()
            log(f"עודכן | ההחלפה האטומית הצליחה (ניסיון {attempt}/{MAX_SWAP_ATTEMPTS})")
            return
        except Exception as exc:
            if _is_transient_lock_error(exc):
                if attempt >= MAX_SWAP_ATTEMPTS:
                    log(f"ERROR | ההחלפה נכשלה אחרי {MAX_SWAP_ATTEMPTS} ניסיונות (נעילה): {exc}")
                    raise
                log(
                    f"WARNING | נעילה זמנית (ניסיון {attempt}/{MAX_SWAP_ATTEMPTS}): {exc}. "
                    f"ניסיון חוזר בעוד {RETRY_DELAY_SECONDS}ש"
                )
                time.sleep(RETRY_DELAY_SECONDS)
                continue

            log(f"ERROR | שגיאה לא-מזוהה כנעילה בהחלפה (ייתכן שהיא בוצעה במסד): {exc}")
            try:
                happened = swap_happened(before, snapshot(client))
            except Exception as check_exc:  # noqa: BLE001
                log(f"ERROR | לא ניתן לבדוק אם ההחלפה בוצעה: {check_exc}")
                raise exc
            if happened is True:
                log("עודכן | לפי הספירות ההחלפה כבר בוצעה במסד (התשובה אבדה); לא מנסים שוב וממשיכים")
                return
            log(f"ERROR | ההחלפה לא בוצעה (או שלא ניתן לקבוע: {happened}); לא מנסים שוב בעיוורון")
            raise


def main():
    client = get_client()

    log("=" * 80)
    log("START | swap_temp_to_active.py")

    perform_swap_with_retry(client)

    log("=" * 80)
    log("סיום | swap_temp_to_active.py")


if __name__ == "__main__":
    main()
