"""
הסבר תזמון למדידת השבועית: אילו שינויים "שלא ידועים לדלתא" נעשו בחלון שבין נקודת הדלתא של הבנייה
לבין סיום השליפה, ולכן לא היה סיכוי שהדלתא תראה אותם.

חשוב להיזהר בניסוח: עריכה בחלון מוכיחה שהדף השתנה, לא שהעריכה גרמה לפער שנמדד (ייתכן פער ישן ועריכה
מאוחרת לא קשורה). לכן התוצאה היא "הוסבר בתזמון (אפשרי)" ו"לא הוסבר בתזמון", ולא "פספוס מוכח".
המסווג עובד על הדוגמאות השמורות בלבד (עד 200 לכל סוג שינוי); מעבר למדגם אין סיווג.
"""
from delta_api import _api_get_with_retry


def fetch_window_activity(api_url, start_ts, end_ts=None):
    """
    כל הפעילות במרחב הראשי בחלון [start_ts, end_ts]: עריכות, יצירות ואירועי יומן (העברה/מחיקה/שחזור).
    מחזיר (page_ids, titles). end_ts=None: עד עכשיו (חלון פתוח, קירוב).
    """
    page_ids, titles = set(), set()
    rccontinue = None
    while True:
        params = {
            "action": "query", "list": "recentchanges", "rcnamespace": 0,
            "rctype": "edit|new|log", "rcdir": "newer", "rcstart": start_ts,
            "rcprop": "title|ids|loginfo", "rclimit": 500, "formatversion": "2", "format": "json",
        }
        if end_ts:
            params["rcend"] = end_ts
        if rccontinue:
            params["rccontinue"] = rccontinue
        data = _api_get_with_retry(api_url, params, "recentchanges (חלון תזמון)")
        for rc in data.get("query", {}).get("recentchanges", []):
            if rc.get("pageid"):
                page_ids.add(rc["pageid"])
            if rc.get("title"):
                titles.add(rc["title"])
            target = (rc.get("logparams") or {}).get("target_title")
            if target:
                titles.add(target)
        rccontinue = data.get("continue", {}).get("rccontinue")
        if not rccontinue:
            return page_ids, titles


def classify_examples(rows, page_ids, titles):
    """
    rows: דוגמאות שאינן known_to_delta (page_id, title, new_value, old_value).
    מחזיר (explained, unexplained): הוסבר = מזהה הדף או הכותרת (או כותרת קודמת/חדשה) מופיעים בפעילות החלון.
    """
    explained, unexplained = [], []
    for row in rows:
        candidates = {row.get("title"), row.get("old_value"), row.get("new_value")}
        if row["page_id"] in page_ids or candidates & titles:
            explained.append(row)
        else:
            unexplained.append(row)
    return explained, unexplained


def summarize(summary_rows, example_rows, activity_by_side):
    """
    summary_rows: שורות reconciliation_diff_summary; example_rows: דוגמאות לא-ידועות (side, change_class, ...).
    activity_by_side: {side: (page_ids, titles)} או חסר לצד שהחלון שלו לא נשלף.
    מחזיר שורות: (side, change_class, unknown, sampled, explained, unexplained, note).
    """
    out = []
    for row in sorted(summary_rows, key=lambda r: (r["side"], r["change_class"])):
        unknown = row["n"] - row["n_known_to_delta"]
        if unknown <= 0:
            continue
        sample = [e for e in example_rows if e["side"] == row["side"] and e["change_class"] == row["change_class"]]
        activity = activity_by_side.get(row["side"])
        if activity is None:
            out.append((row["side"], row["change_class"], unknown, len(sample), None, None, "אין חלון"))
            continue
        explained, unexplained = classify_examples(sample, *activity)
        note = "" if len(sample) >= unknown else f"מדגם בלבד ({len(sample)} מתוך {unknown})"
        out.append((row["side"], row["change_class"], unknown, len(sample), len(explained), len(unexplained), note))
    return out
