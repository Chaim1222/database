"""
רולבק חירום בתוך חלון ה-rollback (שלב 6 בתכנון - mirror_architecture_
design.md) - לשימוש ידני בלבד, לא חלק מ-workflow אוטומטי כלשהו.
מריץ את revert_atomic_swap() (ראו migration_add_swap_function.sql) -
אותו בלוק בדיוק כמו perform_atomic_swap, בכיוון הפוך: wikipedia_pages/
mechalol_pages הנוכחיות (שהתגלו כשגויות) הופכות בחזרה ל-_previous,
והעותק _previous הקודם (הטוב) הופך לפעיל.

*רק* בתוך חלון ה-rollback - כלומר לפני שסבב פיוס מלא נוסף רץ (שמריץ
promote_previous_to_shadow_and_truncate ומוחק/ממחזר את העותק
_previous). אם העותק _previous כבר לא קיים, revert_atomic_swap()
תיכשל על ALTER TABLE שמצביע לטבלה לא-קיימת - אין דרך "לתקן" חזרה
אחרי שהחלון נסגר.

הרצה (ידנית בלבד, לא ב-workflow מתוזמן):
    python revert_to_previous.py
"""

import time

from mechalol_api import log
from supabase_client import get_client

# אותם ספים בדיוק כמו ב-swap_shadow_to_active.py - ראו שם לתיעוד המלא.
MAX_REVERT_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 5
TRANSIENT_LOCK_SQLSTATES = {"55P03", "57014"}


def _is_transient_lock_error(exc) -> bool:
    code = getattr(exc, "code", None)
    if code in TRANSIENT_LOCK_SQLSTATES:
        return True
    message = str(exc).lower()
    return "lock timeout" in message or "lock_timeout" in message


def perform_revert_with_retry(client):
    for attempt in range(1, MAX_REVERT_ATTEMPTS + 1):
        try:
            client.rpc("revert_atomic_swap").execute()
            log(f"עודכן | הרולבק הצליח (ניסיון {attempt}/{MAX_REVERT_ATTEMPTS})")
            return
        except Exception as exc:
            transient = _is_transient_lock_error(exc)
            if attempt >= MAX_REVERT_ATTEMPTS:
                log(
                    f"ERROR | הרולבק נכשל אחרי {MAX_REVERT_ATTEMPTS} ניסיונות "
                    f"(זמני={transient}): {exc}"
                )
                log(
                    "ERROR | ייתכן שחלון ה-rollback כבר נסגר (אין עותק _previous) - "
                    "בדיקה ידנית נדרשת לפני ניסיון חוזר נוסף"
                )
                raise

            log(
                f"WARNING | ניסיון {attempt}/{MAX_REVERT_ATTEMPTS} נכשל "
                f"(זמני={transient}): {exc}. ניסיון חוזר בעוד {RETRY_DELAY_SECONDS}ש"
            )
            time.sleep(RETRY_DELAY_SECONDS)


def main():
    client = get_client()

    log("=" * 80)
    log("START | revert_to_previous.py (רולבק חירום - הרצה ידנית)")

    perform_revert_with_retry(client)

    log("=" * 80)
    log("סיום | revert_to_previous.py")


if __name__ == "__main__":
    main()
