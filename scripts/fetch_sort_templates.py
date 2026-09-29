"""
פענוח {{מיון ויקיפדיה}} של ערכי המכלול המיובאים והמתועדים, וכתיבת גרסת המקור
(`גרסה=`) והנתונים הנלווים לעמודות ההעשרה של mechalol_pages.

היקף: status='מיובא ומתועד', לא ערך מילוני ולא "ערכים לפתיחה" - כפי שמגדירה
list_pending_sort_template (migrations/draft_add_sort_template_columns.sql).
שורה "ממתינה" כל עוד sort_template_parsed_rev ריק או שונה מ-rev_id, ולכן הסקריפט
חוזר על עצמו בבטחה: ריצה שנקטעה ממשיכה בדיוק ממה שנשאר. דף נעול לקריאה מסומן
(mark_sort_template_denied) ולא נבדק שוב במשך 30 יום.

הרצה:
    python fetch_sort_templates.py                          # כל השורות הממתינות
    python fetch_sort_templates.py --shard 1 --shards 4     # חלק מתוך ארבעה
    python fetch_sort_templates.py --max-minutes 100        # עוצר בתוך התקציב
    python fetch_sort_templates.py --sample 200             # בדיקה בלי סופרבייס ובלי כתיבה

הסקריפט כותב רק דרך set_sort_template_batch + recompute_source_state (עמודות המעקב
בלבד), ולכן לא דורס עמודות שהדלתא והריצה השבועית כותבות. הוא משתף את קבוצת
ה-concurrency של שאר ה-workflows (ראו sort_template_backfill.yml), כדי לא לרוץ
בזמן החלפת הטבלאות.
"""
import argparse
import random
import time

from config import API_BATCH_SIZE_TEMPLATE_CHECK, REQUEST_DELAY_SECONDS
from mechalol_api import api_get_with_retry, log, login
from sort_template import parse_sort_template

DENIED = object()
PAGE_SIZE = 2000


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def fetch_contents(page_ids):
    """
    {page_id: {"rev_id", "rev_ts", "content"} | DENIED | None (הדף לא קיים)}.

    בקשה שנדחית כולה (דף נעול-לקריאה מפיל את האצווה כולה עם accessdenied, בלי לציין
    איזה) מפוצלת בחיפוש בינארי עד לבידוד הדף הבעייתי - כמו ב-match.py.
    """
    result = {pid: None for pid in page_ids}
    params = {
        "action": "query",
        "pageids": "|".join(str(pid) for pid in page_ids),
        "prop": "revisions",
        "rvprop": "ids|timestamp|content",
        "rvslots": "main",
        "formatversion": "2",
        "format": "json",
    }
    data = api_get_with_retry(params, "sort template batch")

    if "error" in data:
        code = data["error"].get("code")
        if len(page_ids) == 1:
            log(f"WARNING | דף {page_ids[0]} נדחה ({code}) - מדלגים, ייבדק שוב בריצה הבאה")
            result[page_ids[0]] = DENIED
            return result
        mid = len(page_ids) // 2
        result.update(fetch_contents(page_ids[:mid]))
        result.update(fetch_contents(page_ids[mid:]))
        return result

    for page in data.get("query", {}).get("pages", []):
        revisions = page.get("revisions") or []
        if page.get("missing") or not revisions:
            continue
        rev = revisions[0]
        result[page["pageid"]] = {
            "rev_id": rev["revid"],
            "rev_ts": rev["timestamp"],
            "content": rev.get("slots", {}).get("main", {}).get("content", ""),
        }

    if REQUEST_DELAY_SECONDS:
        time.sleep(REQUEST_DELAY_SECONDS)
    return result


def build_row(page_id, fetched):
    parsed = parse_sort_template(fetched["content"]) or {}
    date = parsed.get("date")
    return {
        "id": page_id,
        "rev_id": fetched["rev_id"],
        "rev_ts": fetched["rev_ts"],
        "rev": parsed.get("rev"),
        "title": parsed.get("title"),
        "date": date.isoformat() if date else None,
    }


def pending_pages(client, shard, shards):
    from supabase_client import execute_with_retry

    after = 0
    while True:
        response = execute_with_retry(
            lambda: client.rpc("list_pending_sort_template", {
                "p_after": after, "p_limit": PAGE_SIZE, "p_shard": shard, "p_shards": shards,
            }).execute(),
            "list_pending_sort_template", log_fn=log,
        )
        rows = response.data or []
        if not rows:
            return
        after = rows[-1]["id"]
        yield rows


def sample_pages(count):
    """מדגם לבדיקה בלי סופרבייס: חברי קטגוריות "עודכנו לאחרונה" אקראיות."""
    cats = api_get_with_retry({
        "action": "query", "list": "allcategories", "format": "json",
        "acprefix": "המכלול: ערכים שעודכנו לאחרונה ב", "aclimit": 500,
    }, "sample categories")["query"]["allcategories"]
    ids = []
    for cat in random.sample(cats, 4):
        members = api_get_with_retry({
            "action": "query", "list": "categorymembers", "format": "json",
            "cmtitle": "קטגוריה:" + cat["*"], "cmnamespace": 0, "cmlimit": 500,
        }, "sample members")["query"]["categorymembers"]
        ids += [m["pageid"] for m in members]
    random.shuffle(ids)
    return ids[:count]


def process_pages(page_ids, client, stats, examples, batch):
    """שולף, מפענח וכותב את הדפים (באצוות), ומחשב source_state לשורות שנכתבו."""
    for page_chunk in chunks(list(page_ids), batch):
        fetched = fetch_contents(page_chunk)
        rows = []
        denied_ids = []
        for pid in page_chunk:
            item = fetched.get(pid)
            if item is DENIED:
                stats["denied"] += 1
                denied_ids.append(pid)
            elif item is None:
                stats["missing"] += 1
            else:
                row = build_row(pid, item)
                stats["fetched"] += 1
                if row["title"] is None and row["rev"] is None and row["date"] is None:
                    stats["no_template"] += 1
                elif row["rev"] is None:
                    stats["no_rev"] += 1
                else:
                    stats["with_rev"] += 1
                rows.append(row)
        if rows and len(examples) < 3:
            examples.append(rows[0])
        if client is None:
            continue
        from supabase_client import execute_with_retry
        if denied_ids:
            # דף נעול לקריאה: מסומן ויוצא מרשימת הממתינים (נבדק שוב אחרי 30 יום)
            execute_with_retry(
                lambda: client.rpc("mark_sort_template_denied", {"p_ids": denied_ids}).execute(),
                "mark_sort_template_denied", log_fn=log,
            )
        if rows:
            written = execute_with_retry(
                lambda: client.rpc("set_sort_template_batch", {"p_rows": rows}).execute(),
                "set_sort_template_batch", log_fn=log,
            )
            stats["written"] += written.data or 0
            execute_with_retry(
                lambda: client.rpc("recompute_source_state", {"p_ids": [r["id"] for r in rows]}).execute(),
                "recompute_source_state", log_fn=log,
            )


def new_stats():
    return {"fetched": 0, "with_rev": 0, "no_rev": 0, "no_template": 0,
            "denied": 0, "missing": 0, "written": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--batch", type=int, default=API_BATCH_SIZE_TEMPLATE_CHECK)
    parser.add_argument("--max-minutes", type=float, default=None)
    parser.add_argument("--sample", type=int, default=None,
                        help="בדיקה בלבד: מדגם מהמכלול, בלי סופרבייס ובלי כתיבה")
    args = parser.parse_args()

    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    login()

    stats = new_stats()
    examples = []

    if args.sample:
        log(f"START | מצב מדגם ({args.sample} דפים), בלי כתיבה")
        process_pages(sample_pages(args.sample), None, stats, examples, args.batch)
    else:
        from supabase_client import get_client
        client = get_client()
        log(f"START | חלק {args.shard}/{args.shards} | אצווה {args.batch}")
        stop = False
        for page in pending_pages(client, args.shard, args.shards):
            for chunk in chunks([r["id"] for r in page], args.batch):
                process_pages(chunk, client, stats, examples, args.batch)
                if deadline and time.time() > deadline:
                    log("עוצר: תקציב הזמן נגמר. ריצה חוזרת תמשיך מהנשארים")
                    stop = True
                    break
            log(f"התקדמות | {stats}")
            if stop:
                break

    log(f"סיום | {stats}")
    for example in examples:
        log(f"דוגמה | {example}")


if __name__ == "__main__":
    main()
