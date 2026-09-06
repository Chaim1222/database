"""
מבצע את ההחלפה האטומית עצמה (שלב 5 בתכנון - mirror_architecture_
design.md) - קריאה אחת ל-RPC perform_atomic_swap() (ראו
migration_add_swap_function.sql), עטופה בניסיון-חוזר: כישלון בגלל
lock_timeout הוא זמני מטבעו וסביר שיצליח בניסיון הבא, ברגע שהשאילתה
החוסמת מסתיימת (ראו הערה מלאה על lock_timeout ב-schema/migration).

נקרא רק אחרי ש-validate_before_swap.py אישר את ההחלפה (should_swap=
true) - הסקריפט הזה עצמו לא בודק שוב את מספר השורות, זו לא אחריותו.

הרצה:
    python swap_shadow_to_active.py
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


def perform_swap_with_retry(client):
    for attempt in range(1, MAX_SWAP_ATTEMPTS + 1):
        try:
            client.rpc("perform_atomic_swap").execute()
            log(f"עודכן | ההחלפה האטומית הצליחה (ניסיון {attempt}/{MAX_SWAP_ATTEMPTS})")
            return
        except Exception as exc:
            transient = _is_transient_lock_error(exc)
            if attempt >= MAX_SWAP_ATTEMPTS:
                log(
                    f"ERROR | ההחלפה נכשלה אחרי {MAX_SWAP_ATTEMPTS} ניסיונות "
                    f"(זמני={transient}): {exc}"
                )
                raise

            if not transient:
                # שגיאה שלא מזוהה כנעילה זמנית - עדיין מנסים שוב (לפי
                # התכנון: "2-3 ניסיונות") אבל עם אזהרה בולטת יותר, כי
                # סביר שהניסיון החוזר לא יעזור אם זו שגיאה אמיתית אחרת
                # (למשל טבלת מראה חסרה/ריקה).
                log(f"WARNING | שגיאה לא-מזוהה-כזמנית בניסיון {attempt}/{MAX_SWAP_ATTEMPTS}: {exc}")
            else:
                log(
                    f"WARNING | נעילה זמנית (ניסיון {attempt}/{MAX_SWAP_ATTEMPTS}): {exc}. "
                    f"ניסיון חוזר בעוד {RETRY_DELAY_SECONDS}ש"
                )
            time.sleep(RETRY_DELAY_SECONDS)


def main():
    client = get_client()

    log("=" * 80)
    log("START | swap_shadow_to_active.py")

    perform_swap_with_retry(client)

    log("=" * 80)
    log("סיום | swap_shadow_to_active.py")


if __name__ == "__main__":
    main()
