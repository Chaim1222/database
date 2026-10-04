"""
מריץ את forward_fill_enrichment_temp() (ראו migration_add_forward_
fill_function.sql + migration_finalize_temp_pages_naming.sql) - שלב 3 בתכנון (mirror_architecture_design.md).
מעתיק את עמודות ההעשרה (wikidata_desc, created_at, easy_import_*,
mechalol_redirect_exists, עמודות גרסת המקור) מהטבלה הפעילה לזמנית, כך שסקריפטי ההעשרה
(fetch_wikidata_descriptions.py וכו', שרצים אחרי הפיוס דרך
enrichment_after_reconciliation.yml) לא יצטרכו להתחיל מאפס על כל
שורה אחרי כל החלפה.

נקרא אחרי ההתאמה על הזמנית (match.py) ולפני שער האימות
(validate_before_swap.py) - סדר קבוע, לא תלוי בתוצאת ה-match עצמה.

ברירת מחדל: בטווחי id (forward_fill_enrichment_temp_range, migration_add_forward_fill_range.sql),
כי הפונקציה המלאה חצתה ב-4.10.2026 את statement_timeout של 5 דקות. אין ניסיון חוזר *אוטומטי* על
timeout של הקליינט: הפעולה ממשיכה במסד, וניסיון שני נתקע על הנעילות שלה (lock_timeout). טווח
שנכשל נבדק מחדש רק אחרי שהמסד סיים אותו (ניסיון חוזר רק אחרי השהיה). הטווחים אידמפוטנטיים.
--full: הפונקציה המלאה בקריאה אחת (המצב הישן).

הרצה:
    python forward_fill_enrichment.py
"""

import argparse
import time

from mechalol_api import log
from supabase_client import get_client, execute_with_retry

RANGE_SIZE = 50000
RANGE_ATTEMPTS = 3


def max_id(client, table):
    top = client.table(table).select("id").order("id", desc=True).limit(1).execute().data
    return top[0]["id"] if top else 0


def run_range(client, start, end):
    """טווח אחד, עם ניסיון חוזר על שגיאה; הפעולה אידמפוטנטית (כותבת מהפעילה לזמנית)."""
    for attempt in range(1, RANGE_ATTEMPTS + 1):
        try:
            client.rpc("forward_fill_enrichment_temp_range", {"p_from": start, "p_to": end}).execute()
            return
        except Exception as exc:
            if attempt >= RANGE_ATTEMPTS:
                raise
            log(f"WARNING | טווח {start}-{end} | ניסיון {attempt}/{RANGE_ATTEMPTS} נכשל: {exc}")
            # אם זה timeout של הקליינט, הפעולה עוד רצה במסד: ממתינים שתסתיים לפני ניסיון נוסף
            time.sleep(30 * attempt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="הפונקציה המלאה בקריאה אחת (ישן)")
    args = parser.parse_args()

    client = get_client()

    log("=" * 80)
    log("START | forward_fill_enrichment.py" + (" (--full)" if args.full else ""))

    if args.full:
        execute_with_retry(
            lambda: client.rpc("forward_fill_enrichment_temp").execute(),
            "FORWARD_FILL_ENRICHMENT",
            log_fn=log,
        )
    else:
        top = max(max_id(client, "wikipedia_pages_temp"), max_id(client, "mechalol_pages_temp"))
        started = time.monotonic()
        for start in range(0, top + 1, RANGE_SIZE):
            run_range(client, start, start + RANGE_SIZE)
            log(f"טווח {start}-{start + RANGE_SIZE} הושלם | {time.monotonic() - started:,.0f} שניות מההתחלה")

    log("עודכן | עמודות ההעשרה הועתקו מהטבלה הפעילה לזמנית")
    log("=" * 80)
    log("סיום | forward_fill_enrichment.py")


if __name__ == "__main__":
    main()
