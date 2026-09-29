"""
עדכון שעתי של מעקב גרסת המקור (source_state), אחרי הטעינות הראשוניות:

  מכלול   - ערכים בהיקף שנערכו מאז הריצה הקודמת מפוענחים מחדש (התבנית עשויה להשתנות, ולכן גם גרסת
            המכלול ו-source_state); שורות ממתינות (ערכים חדשים שהדלתא הוסיפה) מפוענחות גם הן.
  ויקיפדיה - הגרסה האחרונה של דפים שנערכו מאז הריצה הקודמת (recentchanges), ודפים שנוספו לטבלה
            אחרי הטעינה ועדיין בלי גרסה. אחרי זה source_state מחושב מחדש לערכי המכלול המקושרים.

נקודות ההתקדמות (sort_template_sync_state) נקבעות לזמן תחילת הריצה, והקריאה מתחילה 5 דקות
לפניהן (חפיפה): רשומות recentchanges יכולות להופיע באיחור. כשל בשלב אחד לא מקדם את נקודת ההתקדמות
שלו, ולכן הריצה הבאה משלימה; שני האתרים בלתי-תלויים זה בזה.

הרצה:
    python sort_template_hourly.py                    # ריצה רגילה
    python sort_template_hourly.py --dry-run --since-minutes 90   # רק ספירת עריכות, בלי סופרבייס
"""
import argparse
import time
from datetime import datetime, timedelta, timezone

from config import MECHALOL_API, WIKIPEDIA_API
from delta_api import fetch_edited_page_ids
from fetch_sort_templates import chunks, new_stats, pending_pages, process_pages
from fetch_wikipedia_revisions import Writer, api_batch, collect_changes
from mechalol_api import log, login

OVERLAP = timedelta(minutes=5)
PENDING_CAP = 2000
LOOKUP_CHUNK = 200


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read_since(client, stream):
    from supabase_client import execute_with_retry
    response = execute_with_retry(
        lambda: client.table("sort_template_sync_state").select("watermark_ts").eq("stream", stream).execute(),
        f"read state {stream}", log_fn=log,
    )
    if not response.data:
        raise RuntimeError(f"אין שורת מצב ל-{stream} ב-sort_template_sync_state (ראו migration_add_sort_template_sync_state.sql)")
    return parse_ts(response.data[0]["watermark_ts"])


def save_success(client, stream, started):
    from supabase_client import execute_with_retry
    execute_with_retry(
        lambda: client.table("sort_template_sync_state").update({
            "watermark_ts": started.isoformat(), "last_success_at": datetime.now(timezone.utc).isoformat(),
            "consecutive_failures": 0, "last_error": None, "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("stream", stream).execute(),
        f"save state {stream}", log_fn=log,
    )


def save_failure(client, stream, error):
    from supabase_client import execute_with_retry
    current = client.table("sort_template_sync_state").select("consecutive_failures").eq("stream", stream).execute().data
    failures = (current[0]["consecutive_failures"] if current else 0) + 1
    execute_with_retry(
        lambda: client.table("sort_template_sync_state").update({
            "consecutive_failures": failures, "last_error": str(error)[:500],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("stream", stream).execute(),
        f"save failure {stream}", log_fn=log,
    )


def mechalol_step(client, since, batch):
    from supabase_client import execute_with_retry
    edited = fetch_edited_page_ids(MECHALOL_API, iso(since - OVERLAP))
    edited_ids = sorted({row["page_id"] for row in edited})
    in_scope = []
    for chunk in chunks(edited_ids, LOOKUP_CHUNK):
        response = execute_with_retry(
            lambda: client.table("mechalol_pages").select("id").in_("id", chunk)
            .eq("status", "מיובא ומתועד").eq("is_dictionary_entry", False)
            .eq("needs_attention", False).execute(),
            "in-scope lookup", log_fn=log,
        )
        in_scope += [row["id"] for row in response.data or []]

    stats = new_stats()
    examples = []
    process_pages(in_scope, client, stats, examples, batch)
    log(f"מכלול | נערכו {len(edited_ids)} דפים | בהיקף {len(in_scope)} | {stats}")

    pending_stats = new_stats()
    handled = 0
    for page in pending_pages(client, 0, 1):
        process_pages([row["id"] for row in page], client, pending_stats, examples, batch)
        handled += len(page)
        if handled >= PENDING_CAP:
            break
    log(f"מכלול | ממתינים שטופלו {handled} | {pending_stats}")


def wikipedia_step(client, since):
    from supabase_client import execute_with_retry
    latest, edits = collect_changes(iso(since - OVERLAP))
    writer = Writer(client, False)
    for page_id, (rev_id, timestamp) in latest.items():
        writer.add(page_id, rev_id, timestamp)
    writer.flush()
    changed_ids = list(latest)
    log(f"ויקיפדיה | {edits} עריכות | {len(latest)} דפים | עודכנו {writer.changed}")

    # דפים שנוספו לטבלה אחרי הטעינה (הדלתא הלילית) ועדיין בלי גרסה
    missing = execute_with_retry(
        lambda: client.table("wikipedia_pages").select("id").is_("latest_rev_id", "null").limit(1000).execute(),
        "missing revisions", log_fn=log,
    ).data or []
    missing_ids = [row["id"] for row in missing]
    for chunk in chunks(missing_ids, 50):
        api_batch(writer, chunk)
    writer.flush()
    changed_ids += missing_ids
    log(f"ויקיפדיה | דפים בלי גרסה שהושלמו: {len(missing_ids)}")

    linked = []
    for chunk in chunks(changed_ids, LOOKUP_CHUNK):
        response = execute_with_retry(
            lambda: client.table("mechalol_pages").select("id").in_("wikipedia_id", chunk).execute(),
            "linked lookup", log_fn=log,
        )
        linked += [row["id"] for row in response.data or []]
    for chunk in chunks(linked, 2000):
        execute_with_retry(
            lambda: client.rpc("recompute_source_state", {"p_ids": chunk}).execute(),
            "recompute_source_state", log_fn=log,
        )
    log(f"ויקיפדיה | source_state חושב מחדש ל-{len(linked)} ערכי מכלול מקושרים")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true", help="בלי סופרבייס: רק ספירת עריכות משני האתרים")
    parser.add_argument("--since-minutes", type=int, default=90, help="עם --dry-run: כמה דקות אחורה")
    args = parser.parse_args()

    started = datetime.now(timezone.utc)

    if args.dry_run:
        since = started - timedelta(minutes=args.since_minutes)
        m_edits = fetch_edited_page_ids(MECHALOL_API, iso(since))
        w_latest, w_edits = collect_changes(iso(since))
        log(f"DRY-RUN | מכלול: {len(m_edits)} עריכות ({len({r['page_id'] for r in m_edits})} דפים) | "
            f"ויקיפדיה: {w_edits} עריכות ({len(w_latest)} דפים) | מ-{iso(since)}")
        return

    from supabase_client import get_client
    client = get_client()
    login()
    failures = []

    for stream, step in (
        ("mechalol_changes", lambda since: mechalol_step(client, since, args.batch)),
        ("wikipedia_changes", lambda since: wikipedia_step(client, since)),
    ):
        try:
            since = read_since(client, stream)
            lag = started - since
            log(f"START | {stream} | מאז {iso(since)} (פער {int(lag.total_seconds() // 60)} דקות)")
            step(since)
            save_success(client, stream, started)
        except Exception as exc:  # noqa: BLE001 - מתעדים וממשיכים לזרם השני
            log(f"ERROR | {stream} | {type(exc).__name__}: {exc}")
            try:
                save_failure(client, stream, exc)
            except Exception as inner:  # noqa: BLE001
                log(f"ERROR | לא ניתן לשמור כשל ב-{stream}: {inner}")
            failures.append(stream)

    elapsed = int((datetime.now(timezone.utc) - started).total_seconds())
    log(f"סיום | {elapsed} שניות | כשלים: {failures or 'אין'}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
