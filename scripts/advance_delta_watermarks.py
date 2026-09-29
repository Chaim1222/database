"""
מקדם את נקודות ההתקדמות של הדלתא שנדחו (--defer-watermark). רץ בסוף nightly_delta.yml,
רק אחרי ש-match.py --scoped הצליח - ראו delta_watermark.py.

הרצה:
    python advance_delta_watermarks.py
"""
from delta_watermark import advance_pending
from mechalol_api import log
from supabase_client import get_client


def main():
    count = advance_pending(get_client())
    if count == 0:
        log("WARNING | לא נמצאו קבצי watermark דחויים - אין מה לקדם (ריצת האיסוף לא כתבה אותם?)")


if __name__ == "__main__":
    main()
