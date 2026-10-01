"""
מילוי ראשוני של משימות הגרסה (rev_task, rev_page_id, rev_page_title) בטבלה הפעילה.

אותה החלטה כמו ב-match.py (rev_match.decide), אבל כותב רק את שלוש העמודות האלה, ורק לשורות שהערך
שלהן השתנה (בלי עדכון של 262 אלף שורות). לא נוגע בקישורים (wikipedia_id): הם יתעדכנו בריצת match.py
הבאה. אחרי המילוי, match.py (שבועי ודלתא) מתחזק את העמודות בעצמו.

הרצה:
    python backfill_rev_task.py                # כתיבה
    python backfill_rev_task.py --dry-run      # בלי כתיבה: סיכום ושורה לכל שינוי
    python backfill_rev_task.py --max-minutes 90
"""
import argparse
import time
from collections import Counter

import rev_match
from mechalol_api import log

PAGE_SIZE = 1000   # מגבלת סופבייס לשורות בבקשה
WRITE_CHUNK = 500
COLUMNS = ("id,title,status,is_dictionary_entry,needs_attention,wikipedia_id,sort_template_rev,"
           "rev_task,rev_page_id,rev_page_title")


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def scoped_rows(client):
    from supabase_client import execute_with_retry

    after = 0
    while True:
        response = execute_with_retry(
            lambda: (
                client.table("mechalol_pages").select(COLUMNS)
                .eq("status", "מיובא ומתועד").eq("is_dictionary_entry", False).eq("needs_attention", False)
                .gt("id", after).order("id").limit(PAGE_SIZE).execute()
            ),
            f"mechalol scope after_id={after}", log_fn=log,
        )
        rows = response.data or []
        if not rows:
            return
        after = rows[-1]["id"]
        yield rows


def title_link_of(title, wikipedia_map):
    from normalize import hygiene, normalize_title

    link = wikipedia_map.get(hygiene(title))
    if link is None:
        normalized, applied = normalize_title(title)
        if applied:
            link = wikipedia_map.get(hygiene(normalized))
    return link


def manual_ids(client):
    from supabase_client import execute_with_retry

    response = execute_with_retry(
        lambda: client.table("manual_matches").select("mechalol_page_id").execute(),
        "manual_matches", log_fn=log,
    )
    return {row["mechalol_page_id"] for row in response.data or []}


def scan(client, wikipedia_get, wikipedia_map, existing_ids, dry_run, deadline, workers, manual=frozenset()):
    from supabase_client import execute_with_retry

    max_rev = rev_match.fetch_max_rev(wikipedia_get)
    log(f"הגרסה האחרונה בוויקיפדיה: {max_rev:,}")
    stats, complete = Counter(), True

    for rows in scoped_rows(client):
        revs = [r["sort_template_rev"] for r in rows if rev_match.valid_rev(r.get("sort_template_rev"))]
        resolved = rev_match.resolve_many(wikipedia_get, revs, workers)
        changes = []
        for row in rows:
            stats["checked"] += 1
            if not row["title"]:
                continue
            # שיוך ידני = הערך טופל; אין משימת גרסה (כמו ב-match.py)
            decision = rev_match.NO_DECISION if row["id"] in manual else rev_match.decide(
                row, resolved.get(row.get("sort_template_rev")),
                title_link_of(row["title"], wikipedia_map), max_rev, existing_ids.__contains__,
                evidence_link_id=row.get("wikipedia_id"),  # הקישור הקיים (שם בתבנית / ידני) הוא העדות
            )
            task = decision.task
            new = {"rev_task": task, "rev_page_id": decision.page_id if task else None,
                   "rev_page_title": decision.page_title if task else None}
            stats[task or "ok"] += 1
            if all(row.get(key) == value for key, value in new.items()):
                continue
            stats["changed"] += 1
            changes.append(dict(new, id=row["id"]))
            log(f"שינוי | {task or 'נוקה'} | מכלול {row['id']} \"{row['title']}\" | גרסה {row['sort_template_rev']} | "
                f"הדף {decision.page_id} \"{decision.page_title}\"")

        if changes and not dry_run:
            for part in chunks(changes, WRITE_CHUNK):
                execute_with_retry(
                    lambda: client.rpc("set_rev_task_batch", {"p_rows": part}).execute(),
                    "set_rev_task_batch", log_fn=log,
                )
        log(f"התקדמות | {dict(stats)}")
        if deadline and time.time() > deadline:
            log("עוצר: תקציב הזמן נגמר. ריצה חוזרת תמשיך כי היא כותבת רק שינויים")
            complete = False
            break
    return stats, complete


def main():
    from fetch_wikipedia_revisions import wikipedia_get
    from match import load_wikipedia_map
    from supabase_client import get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="בלי כתיבה למסד")
    parser.add_argument("--max-minutes", type=float, default=None)
    parser.add_argument("--workers", type=int, default=4, help="בקשות revids במקביל")
    args = parser.parse_args()

    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    client = get_client()
    log(f"START | backfill_rev_task{' (--dry-run)' if args.dry_run else ''}")
    wikipedia_map, existing_ids = load_wikipedia_map(client)
    stats, complete = scan(client, wikipedia_get, wikipedia_map, existing_ids, args.dry_run, deadline, args.workers,
                           manual_ids(client))
    log(f"סיום | {'הושלם' if complete else 'לא הושלם'} | {dict(stats)}")
    if not complete:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
