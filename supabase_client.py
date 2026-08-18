import time

from supabase import create_client

from config import SUPABASE_URL, SUPABASE_KEY

_client = None

MAX_RETRIES = 5
RETRY_DELAY = 3


def get_client():
    global _client
    if _client is None:
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


def execute_with_retry(operation, description, log_fn=print):
    """
    מריץ פעולת סופרבייס (callable בלי ארגומנטים - בדרך כלל lambda
    שעוטפת client.table(...)....execute()) עם ניסיון חוזר על שגיאה,
    עד MAX_RETRIES ניסיונות, השהיה קבועה RETRY_DELAY בין ניסיונות.
    log_fn ברירת מחדל היא print רגיל - אפשר להעביר פונקציית לוג
    מותאמת (למשל עם חותמת זמן) מהקורא.
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return operation()
        except Exception as exc:
            if attempt >= MAX_RETRIES:
                log_fn(f"ERROR | {description} | נכשל אחרי {MAX_RETRIES} ניסיונות: {exc}")
                raise
            log_fn(f"WARNING | {description} | ניסיון {attempt}/{MAX_RETRIES} נכשל: {exc}. ניסיון חוזר בעוד {RETRY_DELAY}ש")
            time.sleep(RETRY_DELAY)
