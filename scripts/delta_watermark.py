"""
קידום נקודת ההתקדמות (sync_watermarks) של הדלתא הלילית - מיידי, או דחוי עד שההתאמה הצליחה.

ברירת מחדל (כמו קודם): הסקריפט מקדם את ה-watermark מיד בסיום האיסוף. הבעיה: רשימות
ה-changed_ids הן קבצים זמניים של הריצה, ואם match.py --scoped נכשל אחרי שה-watermark כבר
התקדם, הריצה הבאה לא תבדוק שוב את השורות האלה.

--defer-watermark: הסקריפט כותב את ה-watermark המיועד לקובץ (defer_watermark), וצעד אחרון
ב-workflow (advance_delta_watermarks.py) מקדם אותו רק אחרי ש-match.py הצליח. אם ההתאמה
נכשלת, הלילה הבא יתחיל מה-watermark הישן ויאסוף מחדש את אותו טווח (הכתיבות אידמפוטנטיות,
כמו בכישלון באמצע האיסוף).
"""
import json
from pathlib import Path

from mechalol_api import log
from supabase_client import execute_with_retry

PENDING_DIR = Path(".")
PENDING_SUFFIX = "_delta_watermark_pending.json"


def advance(client, source, ts):
    execute_with_retry(
        lambda: client.table("sync_watermarks").update({"last_synced_ts": ts}).eq("source", source).execute(),
        "עדכון watermark",
        log_fn=log,
    )
    log(f"סיום | watermark של '{source}' עודכן ל-{ts}")


def defer(source, ts):
    path = PENDING_DIR / f"{source}{PENDING_SUFFIX}"
    path.write_text(json.dumps({"source": source, "ts": ts}), encoding="utf-8")
    log(f"נכתב {path} | watermark של '{source}' יקודם רק אחרי הצלחת ההתאמה (יעד {ts})")


def advance_pending(client):
    """מקדם את כל ה-watermark-ים הדחויים ומוחק את הקבצים. מחזיר כמה קודמו."""
    advanced = 0
    for path in sorted(PENDING_DIR.glob(f"*{PENDING_SUFFIX}")):
        data = json.loads(path.read_text(encoding="utf-8"))
        advance(client, data["source"], data["ts"])
        path.unlink()
        advanced += 1
    return advanced
