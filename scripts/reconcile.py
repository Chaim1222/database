"""
reconcile.py - דוח בלבד (שלב 2 ב-PLAN_SYNC_REDESIGN.md): צילום מקור מול הטבלאות הפעילות, **בלי שום כתיבה**.

מושך צילום של שני המקורות (ויקיפדיה: דמפ + השלמת פער; המכלול: allpages + קטגוריות הסיווג), קורא את
wikipedia_pages ו-mechalol_pages (select בלבד), ומפיק לכל אתר: מה היה נוצר, נמחק, שונה בכותרת, ושונה בסיווג.
ממצא נחשב "הוסבר בחלון" אם הדף נגעו בו בין נקודת הדלתא השמורה (sync_watermarks) לרגע הצילום; זה לא מוכיח
שהשינוי גרם לפער (ראו reconcile_compare.py).

הצילום נשמר (gz) עם מזהה ריצה, כך שהשבועית והדוח אפשר להשוות מול אותו צילום מקור.

הגנה: הקובץ הזה לא קורא ל-insert/upsert/update/delete/rpc (בדיקה ב-tests/test_reconcile.py).

חלון התזמון סגור: [נקודת הדלתא השמורה, רגע סיום הצילום של אותו אתר]. השאילתות מקבלות את שני הקצוות
(rcend/leend) והתוצאות מסוננות גם לפי timestamp. אם נקודת הדלתא התקדמה בזמן הריצה, זה מתועד בדוח.

שימוש:
    python reconcile.py --out-dir reconcile_out
    python reconcile.py --out-dir out --skip-mechalol
    python reconcile.py --out-dir out --snapshot-in out/snapshot_<run>.json.gz   # אותו צילום, בלי שליפה מחדש
"""
import argparse
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import snapshot_io
from config import BATCH_SIZE, MECHALOL_API, WIKIPEDIA_API
from reconcile_compare import (
    CLASSIFICATION_FIELDS, collect_window, compare_classification, compare_titles, render_markdown,
    summarize_site,
)
from supabase_client import execute_with_retry, get_client

PAGE = 1000  # תקרת PostgREST לשורות בתשובה


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(message):
    print(f"{utc_now()} | {message}", flush=True)


def read_table(client, table, columns):
    """קריאת טבלה בדפדוף לפי id (keyset). מחזיר {id: row}. select בלבד."""
    rows, last = {}, -1
    while True:
        res = execute_with_retry(
            lambda: client.table(table).select(columns).gt("id", last).order("id").limit(PAGE).execute(),
            f"קריאת {table} אחרי id={last}", log_fn=log,
        )
        data = res.data
        for row in data:
            rows[row["id"]] = row
        if len(data) < PAGE:
            return rows
        last = data[-1]["id"]


def read_watermarks(client):
    res = execute_with_retry(
        lambda: client.table("sync_watermarks").select("source,last_synced_ts").execute(),
        "קריאת sync_watermarks", log_fn=log,
    )
    return {row["source"]: row["last_synced_ts"] for row in res.data}


def iso_utc(ts):
    """last_synced_ts (timestamptz כמחרוזת) -> YYYY-MM-DDTHH:MM:SSZ, כפי שה-API דורש."""
    parsed = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


# --- ויקיפדיה ---

def snapshot_wikipedia():
    """{id: title} של ערכי ויקיפדיה כפי שהיו עכשיו: דמפ + השלמת פער, בזיכרון בלבד."""
    from fetch_wikipedia import collect_gap_refs, iter_dump_batches, resolve_current_state
    from wikipedia_title_gap import gap_start

    pages, newest = {}, ""
    for batch, newest in iter_dump_batches():
        for row in batch:
            pages[row["id"]] = row["title"]
    log(f"ויקיפדיה | הדמפ נקרא | {len(pages):,} כותרות | הגרסה המאוחרת בדמפ: {newest}")

    since = gap_start(newest)
    ids, titles, edits = collect_gap_refs(since)
    keep, drop_ids, drop_titles = resolve_current_state(ids, titles)
    for page_id in drop_ids:
        pages.pop(page_id, None)
    if drop_titles:
        for page_id in [i for i, t in pages.items() if t in drop_titles]:
            del pages[page_id]
    for row in keep:
        pages[row["id"]] = row["title"]
    log(f"ויקיפדיה | השלמת פער מ-{since} | {edits} עריכות | נכתבו {len(keep)} | הוסרו {len(drop_ids) + len(drop_titles)}")
    return pages, {"dump_newest_ts": newest, "gap_since": since, "gap_edits": edits}


# --- המכלול ---

def snapshot_mechalol():
    """{id: title} ו-{id: סיווג} של המכלול כעת: allpages (ללא הפניות) + קטגוריות הסיווג. בלי קובץ התקדמות."""
    import fetch_mechalol as fm

    if not fm.login():
        fm.MECHALOL_BATCH_SIZE = BATCH_SIZE
    categories, last_update_map = fm.fetch_classification_data()

    titles, classification, apcontinue = {}, {}, None
    while True:
        params = {
            "action": "query", "list": "allpages", "apnamespace": 0,
            "apfilterredir": "nonredirects", "aplimit": fm.MECHALOL_BATCH_SIZE,
        }
        if apcontinue:
            params["apcontinue"] = apcontinue
        data = fm.api_get(params, "כל הדפים")
        for page in data.get("query", {}).get("allpages", []):
            titles[page["pageid"]] = page["title"]
            classification[page["pageid"]] = fm.classify_page(page["title"], categories, last_update_map)
        apcontinue = data.get("continue", {}).get("apcontinue")
        if not apcontinue:
            break
    log(f"מכלול | allpages | {len(titles):,} ערכים")
    return titles, classification


def window_for(api_url, label, since, until):
    """חלון סגור [since, until] של דפים שנגעו בהם (עריכות, יצירות, העברות, מחיקות, שחזורים)."""
    from delta_api import _api_get_with_retry

    def api_get(params):
        return _api_get_with_retry(api_url, {**params, "format": "json"}, f"חלון תזמון ({label})")

    ids, titles, counts = collect_window(api_get, since, until)
    log(f"{label} | חלון {since} עד {until} | {len(ids)} מזהים | {len(titles)} כותרות | {counts}")
    return ids, titles, {"since": since, "until": until, "refs": len(ids) + len(titles), "counts": counts}


# --- הרצה ---

def main():
    parser = argparse.ArgumentParser(description="reconcile - דוח בלבד, בלי כתיבה")
    parser.add_argument("--out-dir", default="reconcile_out")
    parser.add_argument("--skip-wikipedia", action="store_true")
    parser.add_argument("--skip-mechalol", action="store_true")
    parser.add_argument("--snapshot-in", help="צילום שמור (snapshot_*.json.gz): משתמש בו במקום לשלוף מחדש")
    parser.add_argument("--examples", type=int, default=20)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:6]}"
    started = time.monotonic()
    client = get_client()
    watermarks = read_watermarks(client)
    stored = snapshot_io.load(args.snapshot_in) if args.snapshot_in else None
    log(f"START | run_id={run_id} | נקודות הדלתא: {watermarks} | צילום שמור: {args.snapshot_in or 'לא'}")

    snapshot = {"run_id": run_id, "started": utc_now(), "watermarks": watermarks}
    sites, meta = [], {"watermarks": watermarks, "snapshot_in": args.snapshot_in or "none"}

    if not args.skip_wikipedia:
        if stored and "wikipedia" in stored:
            source, info = stored["wikipedia"]["pages"], stored["wikipedia"]
            until = info["captured_at"]
        else:
            source, info = snapshot_wikipedia()
            until = utc_now()  # סוף הצילום: חלון התזמון נסגר כאן
            info = {**info, "captured_at": until}
        snapshot["wikipedia"] = {"pages": source, **{k: v for k, v in info.items() if k != "pages"}}
        db = {i: r["title"] for i, r in read_table(client, "wikipedia_pages", "id,title").items()}
        log(f"ויקיפדיה | הטבלה | {len(db):,} שורות")
        since = iso_utc(watermarks["wikipedia"])
        ids, titles, window = window_for(WIKIPEDIA_API, "ויקיפדיה", since, until)
        sites.append(summarize_site(
            "wikipedia", len(source), len(db), compare_titles(source, db), {},
            ids, titles, source_titles=source, window=window, examples_per_class=args.examples,
        ))

    if not args.skip_mechalol:
        if stored and "mechalol" in stored:
            titles_src, classification = stored["mechalol"]["pages"], stored["mechalol"]["classification"]
            until = stored["mechalol"]["captured_at"]
        else:
            titles_src, classification = snapshot_mechalol()
            until = utc_now()
        snapshot["mechalol"] = {"pages": titles_src, "classification": classification, "captured_at": until}
        columns = "id,title," + ",".join(CLASSIFICATION_FIELDS)
        rows = read_table(client, "mechalol_pages", columns)
        db_titles = {i: r["title"] for i, r in rows.items()}
        db_class = {i: {f: r[f] for f in CLASSIFICATION_FIELDS} for i, r in rows.items()}
        log(f"מכלול | הטבלה | {len(rows):,} שורות")
        since = iso_utc(watermarks["mechalol"])
        ids, titles, window = window_for(MECHALOL_API, "מכלול", since, until)
        sites.append(summarize_site(
            "mechalol", len(titles_src), len(rows), compare_titles(titles_src, db_titles),
            compare_classification(classification, db_class), ids, titles,
            source_titles=titles_src, window=window, examples_per_class=args.examples,
        ))

    # נקודת הדלתא שהתקדמה בזמן הריצה = הדלתא כתבה לטבלאות בין הצילום לקריאה: ההבדלים אינם נקיים
    after = read_watermarks(client)
    if after != watermarks:
        meta["watermark_moved_during_run"] = {"before": watermarks, "after": after}
        log(f"WARNING | נקודת הדלתא התקדמה בזמן הריצה: {watermarks} -> {after}. הדוח עלול לכלול הבדלים שהדלתא כתבה")

    meta["elapsed_seconds"] = round(time.monotonic() - started)
    report = {"run_id": run_id, "snapshot": meta, "sites": sites}
    (out_dir / f"report_{run_id}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    markdown = render_markdown(report)
    (out_dir / f"report_{run_id}.md").write_text(markdown, encoding="utf-8")
    snapshot_io.save(out_dir / f"snapshot_{run_id}.json.gz", snapshot)
    print(markdown)
    log(f"סיום | {meta['elapsed_seconds']} שניות | {out_dir}")


if __name__ == "__main__":
    main()
