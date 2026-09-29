"""
מחשב מחדש את mechalol_pages.source_state לכל הטבלה (בטווחי id). רץ אחרי ההחלפה השבועית:
forward_fill_enrichment_temp מעתיק את source_state הישן, אבל match.py על הטבלה הזמנית עשוי
לשנות wikipedia_id או את ההיקף, והמצב המועתק היה נשאר לפי הנתונים הישנים.

הרצה:
    python recompute_source_state_all.py
"""
from fetch_wikipedia_revisions import recompute, summary
from mechalol_api import log
from supabase_client import get_client


def main():
    client = get_client()
    log("START | recompute_source_state_all.py")
    recompute(client)
    summary(client)
    log("סיום | recompute_source_state_all.py")


if __name__ == "__main__":
    main()
