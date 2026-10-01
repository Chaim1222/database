"""
בדיקת קישורי המכלול↔ויקיפדיה מול גרסת המקור שבתבנית.

ההתאמה ב-match.py נעשית לפי שם. כאן בודקים את כל הטבלה בכיוון ההפוך: לכל ערך בהיקף
עם `גרסה=` (sort_template_rev) שואלים את ה-API לאיזה דף שייכת הגרסה (גרסה היא זהות
יציבה, גם אחרי שינוי שם), ומשווים ל-wikipedia_id הקיים. מקרה שהדבר חושף: ערך שהועבר
בוויקיפדיה, ואז נוצר ערך אחר בשם הישן - ההתאמה לפי כותרת קושרת לערך הלא נכון, ואף
משימה לא נפתחת.

ממצאים נכתבים ל-rev_link_check (רק שורות חריגות; שורה שחזרה להיות תקינה נמחקת).
הסקריפט לא נוגע ב-mechalol_pages/wikipedia_pages.

סיווגים (status):
  other_page         הגרסה שייכת לדף חי אחר מזה שמקושר (wikipedia_id)
  unlinked_resolves  אין wikipedia_id, והגרסה שייכת לדף חי (מועמד לקישור)
  rev_page_redirect  הדף שהגרסה שייכת לו הפך להפניה (איחוד/העברה בלי המשך)
  rev_missing        הגרסה לא קיימת (דף שנמחק, או מספר שגוי בתבנית)
  other_namespace    הגרסה שייכת לדף מחוץ למרחב הראשי

הרצה:
    python check_rev_links.py                  # סריקה מלאה וכתיבה
    python check_rev_links.py --dry-run        # בלי כתיבה, רק סיכום
    python check_rev_links.py --max-minutes 90
"""
import argparse
import time
from collections import Counter

from config import REQUEST_DELAY_SECONDS
from mechalol_api import log
from normalize import hygiene, normalize_title

PAGE_SIZE = 1000   # מגבלת סופרבייס לשורות בבקשה
API_BATCH = 50     # מגבלת revids בבקשה
DELETE_CHUNK = 200

STATUS_OK = "ok"


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def names_equivalent(mechalol_title, wikipedia_title):
    """האם הכותרות זהות אחרי hygiene והנרמול הסמנטי (אותו כלל שמשמש את match.py)."""
    if not mechalol_title or not wikipedia_title:
        return False
    target = hygiene(wikipedia_title)
    return hygiene(mechalol_title) == target or normalize_title(mechalol_title)[0] == target


def resolve_revisions(wikipedia_get, rev_ids):
    """
    {rev_id: {"page_id", "title", "ns", "redirect"} | None (הגרסה לא קיימת)}.
    בקשה אחת מחזירה גם pageid וגם redirect (prop=revisions|info).
    """
    result = {rev: None for rev in rev_ids}
    data = wikipedia_get({
        "action": "query",
        "revids": "|".join(str(r) for r in rev_ids),
        "prop": "revisions|info",
        "rvprop": "ids",
        "formatversion": "2",
    })
    for page in data.get("query", {}).get("pages", []):
        info = {
            "page_id": page.get("pageid"),
            "title": page.get("title"),
            "ns": page.get("ns"),
            "redirect": bool(page.get("redirect")),
        }
        for revision in page.get("revisions") or []:
            result[revision["revid"]] = info
    if REQUEST_DELAY_SECONDS:
        time.sleep(REQUEST_DELAY_SECONDS)
    return result


def classify(row, resolved):
    """מחזיר שורה לכתיבה ל-rev_link_check, או None כשהקישור תקין."""
    rev = row["sort_template_rev"]
    linked = row.get("wikipedia_id")
    base = {
        "mechalol_id": row["id"],
        "rev_id": rev,
        "linked_wikipedia_id": linked,
        "rev_page_id": None,
        "rev_page_title": None,
        "name_equiv": None,
    }

    if resolved is None:
        return dict(base, status="rev_missing")

    base.update(rev_page_id=resolved["page_id"], rev_page_title=resolved["title"],
                name_equiv=names_equivalent(row["title"], resolved["title"]))

    if resolved["ns"] != 0:
        return dict(base, status="other_namespace")
    if resolved["redirect"]:
        return dict(base, status="rev_page_redirect")
    if linked is None:
        return dict(base, status="unlinked_resolves")
    if resolved["page_id"] != linked:
        return dict(base, status="other_page")
    return None


def scoped_rows(client):
    """ערכי המכלול בהיקף עם גרסה (source_state לא NULL = בהיקף ולא נעול), בעימוד לפי id."""
    from supabase_client import execute_with_retry

    after = 0
    while True:
        response = execute_with_retry(
            lambda: (
                client.table("mechalol_pages")
                .select("id,title,wikipedia_id,sort_template_rev")
                .gt("id", after)
                .gt("sort_template_rev", 0)
                .not_.is_("source_state", "null")
                .order("id")
                .limit(PAGE_SIZE)
                .execute()
            ),
            f"mechalol scoped after_id={after}", log_fn=log,
        )
        rows = response.data or []
        if not rows:
            return
        after = rows[-1]["id"]
        yield rows


def existing_findings(client):
    from supabase_client import execute_with_retry

    ids, after = set(), 0
    while True:
        response = execute_with_retry(
            lambda: client.table("rev_link_check").select("mechalol_id").gt("mechalol_id", after)
            .order("mechalol_id").limit(PAGE_SIZE).execute(),
            "rev_link_check existing", log_fn=log,
        )
        rows = response.data or []
        if not rows:
            return ids
        ids.update(r["mechalol_id"] for r in rows)
        after = rows[-1]["mechalol_id"]


def scan(client, wikipedia_get, dry_run, deadline):
    from supabase_client import execute_with_retry

    previous = set() if dry_run else existing_findings(client)
    stats = Counter()
    complete = True

    for rows in scoped_rows(client):
        findings, healed = [], []
        for chunk in chunks(rows, API_BATCH):
            resolved = resolve_revisions(wikipedia_get, [r["sort_template_rev"] for r in chunk])
            for row in chunk:
                stats["checked"] += 1
                finding = classify(row, resolved.get(row["sort_template_rev"]))
                if finding is None:
                    stats[STATUS_OK] += 1
                    if row["id"] in previous:
                        healed.append(row["id"])
                else:
                    stats[finding["status"]] += 1
                    findings.append(finding)
                    log(
                        f"ממצא | {finding['status']} | מכלול {row['id']} \"{row['title']}\" | "
                        f"גרסה {finding['rev_id']} | מקושר {finding['linked_wikipedia_id']} | "
                        f"הגרסה שייכת ל-{finding['rev_page_id']} \"{finding['rev_page_title']}\" | "
                        f"שם_תואם={finding['name_equiv']}"
                    )

        if not dry_run:
            if findings:
                execute_with_retry(
                    lambda: client.table("rev_link_check").upsert(findings, on_conflict="mechalol_id").execute(),
                    "rev_link_check upsert", log_fn=log,
                )
            for ids in chunks(healed, DELETE_CHUNK):
                execute_with_retry(
                    lambda: client.table("rev_link_check").delete().in_("mechalol_id", ids).execute(),
                    "rev_link_check delete", log_fn=log,
                )
        log(f"התקדמות | {dict(stats)}")

        if deadline and time.time() > deadline:
            log("עוצר: תקציב הזמן נגמר. הסריקה לא הושלמה; ריצה חוזרת סורקת מההתחלה")
            complete = False
            break

    return stats, complete


def main():
    from fetch_wikipedia_revisions import wikipedia_get
    from supabase_client import get_client

    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="בלי כתיבה ל-rev_link_check")
    parser.add_argument("--max-minutes", type=float, default=None)
    args = parser.parse_args()

    deadline = time.time() + args.max_minutes * 60 if args.max_minutes else None
    log(f"START | check_rev_links{' (--dry-run)' if args.dry_run else ''}")
    stats, complete = scan(get_client(), wikipedia_get, args.dry_run, deadline)
    log(f"סיום | {'הושלם' if complete else 'לא הושלם'} | {dict(stats)}")
    if not complete:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
