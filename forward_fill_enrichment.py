"""
מריץ את forward_fill_enrichment_shadow() (ראו migration_add_forward_
fill_function.sql) - שלב 3 בתכנון (mirror_architecture_design.md).
מעתיק את עמודות ההעשרה (wikidata_desc, created_at, easy_import_*,
mechalol_redirect_exists) מהטבלה הפעילה למראה, כך שסקריפטי ההעשרה
(fetch_wikidata_descriptions.py וכו', שרצים אחרי הפיוס דרך
enrichment_after_reconciliation.yml) לא יצטרכו להתחיל מאפס על כל
שורה אחרי כל החלפה.

נקרא אחרי ההתאמה על המראה (match.py) ולפני שער האימות
(validate_before_swap.py) - סדר קבוע, לא תלוי בתוצאת ה-match עצמה.

הרצה:
    python forward_fill_enrichment.py
"""

from mechalol_api import log
from supabase_client import get_client, execute_with_retry


def main():
    client = get_client()

    log("=" * 80)
    log("START | forward_fill_enrichment.py")

    execute_with_retry(
        lambda: client.rpc("forward_fill_enrichment_shadow").execute(),
        "FORWARD_FILL_ENRICHMENT",
        log_fn=log,
    )

    log("עודכן | עמודות ההעשרה הועתקו מהטבלה הפעילה למראה")
    log("=" * 80)
    log("סיום | forward_fill_enrichment.py")


if __name__ == "__main__":
    main()
