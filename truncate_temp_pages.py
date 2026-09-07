"""
מריק את שתי הטבלאות הזמניות (mechalol_pages_temp/wikipedia_pages_temp)
בסוף סבב פיוס מלא - אחרי log_reconciliation_diff.py, לא לפניו. בשלב
הזה הן מחזיקות את מה שהיה פעיל רגע לפני ה-swap (perform_atomic_swap
מעביר אותן לשם הזה בסוף ההחלפה), ו-log_reconciliation_diff.py כבר
ניצל את זה כדי להשוות ולתעד פערים. אחרי הריקון הזה אין יותר עותק של
המצב הקודם - אין חלון rollback (הוסר בכוונה, ראו README.md).

נקרא רק אחרי swap_temp_to_active.py, ורק כשההחלפה באמת קרתה
(should_swap=true) - אם ההחלפה דולגה, אין מה לרוקן (הטבלאות הזמניות
כבר ריקות/לא השתנו הסבב הזה).

הרצה:
    python truncate_temp_pages.py
"""

from mechalol_api import log
from supabase_client import get_client, execute_with_retry


def main():
    client = get_client()

    log("=" * 80)
    log("START | truncate_temp_pages.py")

    execute_with_retry(
        lambda: client.rpc("truncate_temp_pages").execute(),
        "TRUNCATE_TEMP_PAGES",
        log_fn=log,
    )

    log("עודכן | mechalol_pages_temp/wikipedia_pages_temp רוקנו")
    log("=" * 80)
    log("סיום | truncate_temp_pages.py")


if __name__ == "__main__":
    main()
