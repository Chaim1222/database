"""
טעינת הגרסה העדכנית של כל דף בוויקיפדיה (wikipedia_pages.latest_rev_id / latest_rev_ts) וחישוב
mechalol_pages.source_state (current / ahead) מול sort_template_rev.

מצב dump (ברירת מחדל): מוריד את stub-meta-current של hewiki מ-dumps.wikimedia.org בזרימה (בלי
לשמור קובץ; אין צורך להעלות דמפ לריפו), מפענח (wiki_dump.py), וכותב באצוות דרך
set_wikipedia_revisions_batch. הדמפ ישן ביום עד שבועות, ולכן בסופו משלימים את הפער
מ-recentchanges של ויקיפדיה (מ-timestamp המאוחר בדמפ) - שמירת ה-recentchanges היא כ-90 יום.
מצב api: גרסה עדכנית לפי pageids של הערכים המקושרים בהיקף (~263 אלף), 50 בבקשה, בקצב מתון.
זהו fallback כשהדמפ לא נגיש; שעתיים עד שלוש.

בסוף: recompute_source_state_range בטווחי id (25 אלף), וסיכום ספירות.
הסקריפט כותב רק latest_rev_* ו-source_state (לא נוגע בשאר העמודות). חייב לרוץ בקבוצת ה-
concurrency של שאר ה-workflows (החלפת טבלאות שבועית).

הרצה:
    python fetch_wikipedia_revisions.py                       # dump + gap-fill + recompute
    python fetch_wikipedia_revisions.py --mode api            # fallback
    python fetch_wikipedia_revisions.py --file stub.xml.gz    # דמפ מקומי (בדיקה)
    python fetch_wikipedia_revisions.py --dry-run --file ...  # פענוח וספירה בלבד, בלי סופרבייס
"""
import argparse
import gzip
import time

import requests

from config import REQUEST_HEADERS, WIKIPEDIA_API
from mechalol_api import log
from wiki_dump import iter_stub_pages, latest_per_page

DUMP_URL = "https://dumps.wikimedia.org/hewiki/latest/hewiki-latest-stub-meta-current.xml.gz"
WRITE_BATCH = 2000
RANGE_SIZE = 25000
MAX_ATTEMPTS = 8


def wikipedia_get(params):
    """GET ל-API של ויקיפדיה עם כיבוד Retry-After ו-maxlag וניסיון חוזר על שגיאות."""
    params = dict(params, format="json", maxlag=5)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = requests.get(WIKIPEDIA_API, params=params, headers=REQUEST_HEADERS, timeout=(15, 60))
            if response.status_code == 429:
                wait = int(response.headers.get("Retry-After", 0)) or min(120, 5 * 2 ** attempt)
                log(f"WARNING | 429 מוויקיפדיה, ממתין {wait}ש (ניסיון {attempt}/{MAX_ATTEMPTS})")
                time.sleep(wait)
                continue
            response.raise_for_status()
            data = response.json()
            if data.get("error", {}).get("code") == "maxlag":
                time.sleep(int(response.headers.get("Retry-After", 5)))
                continue
            if "error" in data:
                raise RuntimeError(f"שגיאת API: {data['error']}")
            return data
        except (requests.RequestException, ValueError, RuntimeError) as exc:
            if attempt >= MAX_ATTEMPTS:
                raise
            log(f"WARNING | ויקיפדיה | ניסיון {attempt}/{MAX_ATTEMPTS}: {exc}")
            time.sleep(min(60, 2 ** attempt))
    raise RuntimeError("ויקיפדיה: נגמרו הניסיונות")


class Writer:
    """צובר שורות וכותב באצוות. dry_run: סופר בלבד."""

    def __init__(self, client, dry_run):
        self.client = client
        self.dry_run = dry_run
        self.rows = []
        self.seen = 0
        self.changed = 0

    def add(self, page_id, rev_id, timestamp):
        self.seen += 1
        self.rows.append({"id": page_id, "rev_id": rev_id, "rev_ts": timestamp})
        if len(self.rows) >= WRITE_BATCH:
            self.flush()

    def flush(self):
        if not self.rows:
            return
        rows, self.rows = self.rows, []
        if self.dry_run or self.client is None:
            return
        from supabase_client import execute_with_retry
        response = execute_with_retry(
            lambda: self.client.rpc("set_wikipedia_revisions_batch", {"p_rows": rows}).execute(),
            "set_wikipedia_revisions_batch", log_fn=log,
        )
        self.changed += response.data or 0
        if self.seen % (WRITE_BATCH * 20) < WRITE_BATCH:
            log(f"התקדמות | נקראו {self.seen} | עודכנו {self.changed}")


def open_dump(url, path):
    if path:
        return gzip.open(path, "rb") if path.endswith(".gz") else open(path, "rb")
    response = requests.get(url, stream=True, headers=REQUEST_HEADERS, timeout=(15, 120))
    response.raise_for_status()
    return gzip.GzipFile(fileobj=response.raw)


def load_from_dump(writer, url, path):
    """מחזיר את ה-timestamp המאוחר ביותר בדמפ (נקודת ההתחלה להשלמת הפער)."""
    last_error = None
    for attempt in range(1, 4):
        try:
            newest = ""
            with open_dump(url, path) as stream:
                for page_id, rev_id, timestamp in iter_stub_pages(stream):
                    writer.add(page_id, rev_id, timestamp)
                    if timestamp and timestamp > newest:
                        newest = timestamp
            writer.flush()
            return newest
        except (requests.RequestException, OSError, EOFError) as exc:
            # ההורדה נקטעה: הכתיבה אידמפוטנטית (משנה רק שורות שהשתנו), לכן מתחילים מחדש
            last_error = exc
            log(f"WARNING | הורדת הדמפ נקטעה (ניסיון {attempt}/3): {exc}")
            writer.rows = []
            time.sleep(10 * attempt)
    raise RuntimeError(f"הורדת הדמפ נכשלה: {last_error}")


def collect_changes(since):
    """
    עריכות ויצירות במרחב הראשי מ-since ואילך, מ-recentchanges.
    מחזיר ({page_id: (rev_id, timestamp)} עם הגרסה האחרונה לכל דף, מספר העריכות שנקראו).
    מדפיס התקדמות כל 20 בקשות, כדי שלא יהיה "שקט" בפערים גדולים.
    """
    changes = []
    requests_made = 0
    params = {
        "action": "query", "list": "recentchanges", "rcnamespace": 0,
        "rctype": "edit|new", "rcprop": "ids|timestamp", "rcdir": "newer",
        "rcstart": since, "rclimit": 500,
    }
    while True:
        data = wikipedia_get(params)
        requests_made += 1
        batch = data.get("query", {}).get("recentchanges", [])
        for change in batch:
            changes.append((change["pageid"], change["revid"], change["timestamp"]))
        if requests_made % 20 == 0 and batch:
            log(f"recentchanges | {requests_made} בקשות | {len(changes)} עריכות | עד {batch[-1]['timestamp']}")
        if "continue" not in data:
            break
        params.update(data["continue"])
        time.sleep(1)
    return latest_per_page(changes), len(changes)


def fill_gap(writer, since):
    """משלים את הפער שאחרי הדמפ: הגרסה האחרונה לכל דף שנערך מאז."""
    latest, edits = collect_changes(since)
    for page_id, (rev_id, timestamp) in latest.items():
        writer.add(page_id, rev_id, timestamp)
    writer.flush()
    return edits, len(latest)


def linked_wikipedia_ids(client):
    """מזהי ויקיפדיה של הערכים בהיקף (לצורך מצב api), בדפדוף של 1000."""
    start = 0
    while True:
        response = (client.table("mechalol_pages").select("wikipedia_id")
                    .eq("status", "מיובא ומתועד").eq("is_dictionary_entry", False)
                    .eq("needs_attention", False).not_.is_("wikipedia_id", "null")
                    .order("id").range(start, start + 999).execute())
        rows = response.data or []
        if not rows:
            return
        yield [r["wikipedia_id"] for r in rows]
        start += 1000


def load_from_api(writer, client, deadline):
    pending = []
    for ids in linked_wikipedia_ids(client):
        pending += ids
        while len(pending) >= 50:
            chunk, pending = pending[:50], pending[50:]
            api_batch(writer, chunk)
            if deadline and time.time() > deadline:
                log("עוצר: תקציב הזמן נגמר")
                writer.flush()
                return
    if pending:
        api_batch(writer, pending)
    writer.flush()


def api_batch(writer, page_ids):
    data = wikipedia_get({
        "action": "query", "pageids": "|".join(str(i) for i in page_ids),
        "prop": "revisions", "rvprop": "ids|timestamp",
    })
    for page in data.get("query", {}).get("pages", {}).values():
        for revision in page.get("revisions", []):
            writer.add(page["pageid"], revision["revid"], revision["timestamp"])
    time.sleep(1)


def recompute(client):
    from supabase_client import execute_with_retry
    top = client.table("mechalol_pages").select("id").order("id", desc=True).limit(1).execute().data
    max_id = top[0]["id"] if top else 0
    for start in range(0, max_id + 1, RANGE_SIZE):
        execute_with_retry(
            lambda: client.rpc("recompute_source_state_range", {"p_from": start, "p_to": start + RANGE_SIZE}).execute(),
            f"recompute_source_state_range {start}", log_fn=log,
        )
    log(f"חושב source_state עד id {max_id}")


def summary(client):
    counts = {}
    for state in ("current", "ahead", "unchecked", "no_baseline"):
        response = client.table("mechalol_pages").select("id", count="exact").eq("source_state", state).limit(1).execute()
        counts[state] = response.count
    log(f"סיכום source_state | {counts}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["dump", "api"], default="dump")
    parser.add_argument("--url", default=DUMP_URL)
    parser.add_argument("--file", help="דמפ מקומי (stub-meta-current, .gz או XML) במקום הורדה")
    parser.add_argument("--no-gap-fill", action="store_true")
    parser.add_argument("--max-minutes", type=float, default=None, help="מצב api: תקציב זמן")
    parser.add_argument("--dry-run", action="store_true", help="בלי כתיבה ובלי סופרבייס (מצב dump בלבד)")
    args = parser.parse_args()

    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    client = None
    if not args.dry_run:
        from supabase_client import get_client
        client = get_client()
    writer = Writer(client, args.dry_run)

    if args.mode == "dump":
        log(f"START | dump | {args.file or args.url}{' | DRY-RUN' if args.dry_run else ''}")
        newest = load_from_dump(writer, args.url, args.file)
        log(f"הדמפ נקרא | דפים {writer.seen} | עודכנו {writer.changed} | הגרסה המאוחרת בדמפ: {newest}")
        if not args.no_gap_fill and not args.dry_run and newest:
            edits, pages = fill_gap(writer, newest)
            log(f"הושלם הפער מ-recentchanges | {edits} עריכות | {pages} דפים | עודכנו בסך הכול {writer.changed}")
    else:
        if client is None:
            raise SystemExit("--mode api דורש סופרבייס (בלי --dry-run)")
        log("START | api")
        load_from_api(writer, client, deadline)
        log(f"נקרא ב-API | דפים {writer.seen} | עודכנו {writer.changed}")

    if client is not None:
        recompute(client)
        summary(client)
    log("סיום | fetch_wikipedia_revisions.py")


if __name__ == "__main__":
    main()
