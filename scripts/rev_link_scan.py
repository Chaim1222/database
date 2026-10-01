"""
בדיקת קישורי המכלול↔ויקיפדיה מול גרסת המקור שבתבנית (`גרסה=`), פעם בחודש.

ההתאמה ב-match.py נשארת לפי שם. הבדיקה הזו, בנפרד, שואלת את ה-API לאיזה דף כל גרסה שייכת (גרסה היא
זהות יציבה גם אחרי שינוי שם), ומחליטה לפי scripts/rev_match.py (הכללים והנימוקים שם). הממצאים נכתבים
לטבלת העבודה rev_link_check ומוצגים בארבעה טאבים בדשבורד (העברת שם / הפכו להפניה / גרסה שגויה / נמחקו
לפי גרסה) דרך report_rev_tasks. שורה שתוקנה נמחקת בריצה הבאה. הסקריפט לא נוגע בקישורים (wikipedia_id)
ולא בטבלאות הערכים, ולכן לא תלוי בריצה השבועית.

הרצה:
    python rev_link_scan.py                  # סריקה מלאה (~40 דקות) וכתיבה לטבלה
    python rev_link_scan.py --dry-run        # בלי כתיבה: סיכום ושורה לכל ממצא
    python rev_link_scan.py --recheck        # רק הערכים שכבר בטבלה (כמה מאות, בדקה): מסיר מה שתוקן
    python rev_link_scan.py --max-minutes 90
"""
import argparse
import time
from collections import Counter

import rev_match
from mechalol_api import log

PAGE_SIZE = 1000   # מגבלת סופבייס לשורות בבקשה
WRITE_CHUNK = 500
DELETE_CHUNK = 200
COLUMNS = ("id,title,status,is_dictionary_entry,needs_attention,wikipedia_id,sort_template_rev,"
           "sort_template_denied_at,template_check_access_denied_at")
FINDING_FIELDS = ("rev_task", "rev_id", "linked_wikipedia_id", "rev_page_id", "rev_page_title")


def chunks(items, size):
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


class Store:
    """הגישה למסד: שורות המכלול לסריקה, והטבלה rev_link_check."""

    def __init__(self, client):
        from supabase_client import execute_with_retry

        self.client, self.retry = client, execute_with_retry

    def scope_pages(self):
        after = 0
        while True:
            rows = self.retry(
                lambda: (
                    self.client.table("mechalol_pages").select(COLUMNS)
                    .eq("status", "מיובא ומתועד").eq("is_dictionary_entry", False).eq("needs_attention", False)
                    .gt("id", after).order("id").limit(PAGE_SIZE).execute()
                ), f"mechalol scope after_id={after}", log_fn=log,
            ).data or []
            if not rows:
                return
            after = rows[-1]["id"]
            yield rows

    def pages_by_ids(self, ids):
        for part in chunks(sorted(ids), DELETE_CHUNK):
            rows = self.retry(
                lambda: self.client.table("mechalol_pages").select(COLUMNS).in_("id", part).execute(),
                "mechalol by ids", log_fn=log,
            ).data or []
            if rows:
                yield rows

    def previous(self):
        found, after = {}, 0
        while True:
            rows = self.retry(
                lambda: (
                    self.client.table("rev_link_check")
                    .select("mechalol_id," + ",".join(FINDING_FIELDS))
                    .gt("mechalol_id", after).order("mechalol_id").limit(PAGE_SIZE).execute()
                ), "rev_link_check previous", log_fn=log,
            ).data or []
            if not rows:
                return found
            for row in rows:
                found[row["mechalol_id"]] = {field: row.get(field) for field in FINDING_FIELDS}
            after = rows[-1]["mechalol_id"]

    def manual_ids(self):
        rows = self.retry(
            lambda: self.client.table("manual_matches").select("mechalol_page_id").execute(),
            "manual_matches", log_fn=log,
        ).data or []
        return {row["mechalol_page_id"] for row in rows}

    def upsert(self, findings):
        for part in chunks(findings, WRITE_CHUNK):
            self.retry(
                lambda: self.client.table("rev_link_check").upsert(part, on_conflict="mechalol_id").execute(),
                "rev_link_check upsert", log_fn=log,
            )

    def delete(self, ids):
        for part in chunks(sorted(ids), DELETE_CHUNK):
            self.retry(
                lambda: self.client.table("rev_link_check").delete().in_("mechalol_id", part).execute(),
                "rev_link_check delete", log_fn=log,
            )


def title_link_of(title, wikipedia_map):
    from normalize import hygiene, normalize_title

    link = wikipedia_map.get(hygiene(title))
    if link is None:
        normalized, applied = normalize_title(title)
        if applied:
            link = wikipedia_map.get(hygiene(normalized))
    return link


def finding_of(row, decision):
    return {
        "mechalol_id": row["id"], "rev_task": decision.task, "rev_id": row.get("sort_template_rev"),
        "linked_wikipedia_id": row.get("wikipedia_id"), "rev_page_id": decision.page_id,
        "rev_page_title": decision.page_title,
    }


def decide_rows(rows, resolved, wikipedia_map, existing_ids, max_rev, manual):
    """[(שורה, החלטה)]. שיוך ידני = טופל; הקישור הקיים הוא העדות לקישור (שם בתבנית או ידני)."""
    out = []
    for row in rows:
        if not row.get("title") or row["id"] in manual:
            out.append((row, rev_match.NO_DECISION))
            continue
        out.append((row, rev_match.decide(
            row, resolved.get(row.get("sort_template_rev")), title_link_of(row["title"], wikipedia_map),
            max_rev, existing_ids.__contains__, evidence_link_id=row.get("wikipedia_id"),
        )))
    return out


def scan(store, wikipedia_get, wikipedia_map, existing_ids, pages, dry_run, deadline, workers):
    """pages: איטרטור של דפי שורות מכלול (הכול, או רק מה שכבר בטבלה ב-recheck)."""
    manual = store.manual_ids()
    previous = store.previous()
    max_rev = rev_match.fetch_max_rev(wikipedia_get)
    log(f"הגרסה האחרונה בוויקיפדיה: {max_rev:,} | שיוכים ידניים: {len(manual):,} | בטבלה היום: {len(previous):,}")

    stats, seen, complete = Counter(), set(), True
    for rows in pages:
        revs = [r["sort_template_rev"] for r in rows if rev_match.valid_rev(r.get("sort_template_rev"))]
        resolved = rev_match.resolve_many(wikipedia_get, revs, workers)
        changed, healed = [], []
        for row, decision in decide_rows(rows, resolved, wikipedia_map, existing_ids, max_rev, manual):
            stats["checked"] += 1
            seen.add(row["id"])
            stats[decision.task or "ok"] += 1
            if decision.task is None:
                if row["id"] in previous:
                    healed.append(row["id"])
                continue
            finding = finding_of(row, decision)
            if previous.get(row["id"]) != {field: finding[field] for field in FINDING_FIELDS}:
                changed.append(finding)
                log(f"ממצא | {decision.task} | מכלול {row['id']} \"{row['title']}\" | גרסה {row['sort_template_rev']} | "
                    f"מקושר {row.get('wikipedia_id')} | הדף {decision.page_id} \"{decision.page_title}\"")
        stats["written"] += len(changed)
        stats["healed"] += len(healed)
        if not dry_run:
            store.upsert(changed)
            store.delete(healed)
        log(f"התקדמות | {dict(stats)}")
        if deadline and time.time() > deadline:
            log("עוצר: תקציב הזמן נגמר. הסריקה לא הושלמה; ריצה חוזרת סורקת מההתחלה")
            complete = False
            break

    if complete:
        # שורות בטבלה שלא נראו (הערך נמחק, או יצא מההיקף): מוסרות.
        gone = set(previous) - seen
        stats["gone"] = len(gone)
        if gone and not dry_run:
            store.delete(gone)
    return stats, complete


def main():
    from fetch_wikipedia_revisions import wikipedia_get
    from match import load_wikipedia_map
    from supabase_client import get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="בלי כתיבה למסד")
    parser.add_argument("--recheck", action="store_true", help="רק הערכים שכבר בטבלה")
    parser.add_argument("--max-minutes", type=float, default=None)
    parser.add_argument("--workers", type=int, default=4, help="בקשות revids במקביל")
    args = parser.parse_args()

    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    store = Store(get_client())
    log(f"START | rev_link_scan{' (--recheck)' if args.recheck else ''}{' (--dry-run)' if args.dry_run else ''}")
    wikipedia_map, existing_ids = load_wikipedia_map(store.client)
    pages = store.pages_by_ids(store.previous()) if args.recheck else store.scope_pages()
    stats, complete = scan(store, wikipedia_get, wikipedia_map, existing_ids, pages, args.dry_run, deadline,
                           args.workers)
    log(f"סיום | {'הושלם' if complete else 'לא הושלם'} | {dict(stats)}")
    if not complete:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
