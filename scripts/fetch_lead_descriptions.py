"""
סקריפט עצמאי - לא חלק מ-weekly_update.yml.

משלים את wikipedia_pages.wikidata_desc עבור ערכים שחסרים במכלול
(report_missing_from_mechalol) ושבוויקינתונים אין להם תיאור
(wikidata_desc = ""): מחלץ הגדרה קצרה (עד 10 מילים) מהמשפט הראשון של
פתיח הערך בוויקיפדיה - הטקסט אחרי "הוא/היא/הם/הן" - ושומר אותה באותה
עמודה, עם הסיומת " (מתוך הפתיח)" כדי שיהיה ברור שהמקור אינו ויקינתונים.

למה באותה עמודה: forward_fill_enrichment מעתיקה את wikidata_desc בין
הריצות השבועיות, אז ההגדרות שורדות; fetch_wikidata_descriptions.py
פוגע רק בשורות NULL, אז הוא לא ידרוס אותן.

ערך שאין בפתיח שלו משפט הגדרה ברור (פירושון, רשימה וכד') מדולג ונשאר
"" - לא ממציאים הגדרה. ריצה חוזרת בטוחה: שורה שכבר מולאה לא נבחרת שוב.

שימוש:  python scripts/fetch_lead_descriptions.py [--limit N] [--dry-run]
"""
import argparse
import re
import time
from datetime import datetime, timezone

import requests

from config import BATCH_SIZE, REQUEST_DELAY_SECONDS, WIKIPEDIA_API, REQUEST_HEADERS
from supabase_client import get_client, execute_with_retry

SUFFIX = " (מתוך הפתיח)"
MAX_WORDS = 10
MIN_WORDS = 2
MIN_WORDS_BEFORE_COMMA = 3
CLAUSE_BREAK = re.compile(r",|\s[–—-]\s")
# מילים שפותחות פסוקית נלווית - ההגדרה נחתכת לפניהן
RELATIVE_STARTERS = {
    "אשר", "שבו", "שבה", "שבהם", "שבהן", "שהוא", "שהיא", "שהם", "שהן", "שהיה",
    "שהייתה", "שהיו", "שלפיה", "שלפיו", "שלפיהם", "בה", "בו", "בהם", "בהן",
    "שמטרתו", "שמטרתה", "שבמסגרתו", "שבמסגרתה", "שבמהלכו", "שבמהלכה",
}
# מילים שפותחות ביטוי חדש - מותר לחתוך לפניהן כשההגדרה ארוכה מדי
PHRASE_STARTERS = RELATIVE_STARTERS | {
    "של", "מאת", "על", "עם", "בשנת", "בשנים", "במאה", "ב־", "וכן", "כגון",
    "לפי", "בין", "או", "וגם", "ובו", "ובה", "אך",
}
EXTRACT_CHUNK_SIZE = 20  # מגבלת exlimit כשמבקשים רק את הפתיח
MAX_API_RETRIES = 6

COPULA = re.compile(
    r"\s(?:הוא|היא|הם|הן|הינו|הינה|הינם|הינן|היה|הייתה|היו|נחשב|נחשבת|נחשבים|נחשבות)\s"
)
# מילים שאסור שההגדרה תיגמר בהן (אחרי חיתוך ל-MAX_WORDS)
DANGLING = {
    "של", "את", "עם", "על", "אל", "או", "גם", "כי", "אשר", "בין", "כ", "כמו",
    "לפי", "מן", "מאת", "ידי", "יותר", "הכי", "וגם", "בעיקר", "לא",
}

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{timestamp} | {message}", flush=True)


def _strip_parentheses(text):
    # סוגריים מקוננים - מסירים מהפנים החוצה
    prev = None
    while prev != text:
        prev = text
        text = re.sub(r"\([^()]*\)|\[[^\[\]]*\]", "", text)
    return text


def extract_definition(extract):
    """
    מקבל את טקסט הפתיח (טקסט רגיל) ומחזיר הגדרה של עד MAX_WORDS מילים,
    או None אם אין משפט הגדרה ברור.
    """
    if not extract:
        return None
    paragraph = next((p for p in extract.split("\n") if p.strip()), "")
    text = _strip_parentheses(paragraph)
    text = re.sub(r"\s+", " ", text).strip()

    match = COPULA.search(text)
    # הפועל חייב להופיע בתחילת המשפט (אחרי שם הערך), לא עמוק בתוכו
    if not match or match.start() > 120:
        return None
    rest = text[match.end():]

    # סוף המשפט הראשון: נקודה (לפני רווח/סוף) / נקודה-פסיק / נקודתיים
    rest = re.split(r"\.(?=\s|$)|[;:]", rest, maxsplit=1)[0]

    words = _cut_at_natural_boundary(rest.strip(" ,-–—"))
    if words is None:
        return None
    definition = " ".join(words).rstrip(" ,-–—")
    # מרכאה פתוחה אחרי החיתוך - מוותרים עליה
    if definition.count('"') % 2 == 1:
        definition = definition.replace('"', "")
    return definition or None


def _cut_at_natural_boundary(text):
    """
    חותך את ההגדרה בגבול טבעי בלבד, כדי שלא תיגמר באמצע ביטוי:
    1. הפסיק/המקף הראשון שלפניו לפחות שלוש מילים;
    2. לפני מילת פתיחה של פסוקית (אשר, שבו, בה...) ממילה שלישית ואילך;
    3. אם עדיין ארוך מ-MAX_WORDS - בגבול הטבעי האחרון שבתוך החלון
       (לפני של/מאת/על/עם/בשנת...). אין גבול כזה -> None (מדלגים).
    מחזיר רשימת מילים, או None אם אין הגדרה תקינה.
    """
    for m in CLAUSE_BREAK.finditer(text):
        if len(text[:m.start()].split()) >= MIN_WORDS_BEFORE_COMMA:
            text = text[:m.start()]
            break
    words = text.split()
    for i in range(MIN_WORDS, len(words)):
        if words[i] in RELATIVE_STARTERS:
            words = words[:i]
            break
    if len(words) > MAX_WORDS:
        cut = None
        for i in range(MAX_WORDS, MIN_WORDS - 1, -1):
            if words[i] in PHRASE_STARTERS:
                cut = i
                break
        if cut is None:
            return None
        words = words[:cut]
    while words and (words[-1] in DANGLING or len(words[-1]) == 1):
        words.pop()
    if len(words) < MIN_WORDS:
        return None
    return words


def load_candidate_rows(limit):
    """שורות 'חסר במכלול' שוויקינתונים בדק ואין להן תיאור (wikidata_desc = '')."""
    client = get_client()
    rows = []
    last_id = 0
    while True:
        def query():
            return (
                client.table("report_missing_from_mechalol")
                .select("id,title")
                .eq("wikidata_desc", "")
                .gt("id", last_id)
                .order("id")
                .limit(BATCH_SIZE)
                .execute()
            )

        batch = execute_with_retry(query, "שליפת שורות ללא תיאור", log).data or []
        if not batch:
            break
        rows.extend(batch)
        last_id = batch[-1]["id"]
        if limit and len(rows) >= limit:
            return rows[:limit]
        if len(batch) < BATCH_SIZE:
            break
    return rows


def fetch_extracts(page_ids):
    """מחזיר {page_id: טקסט פתיח} עבור קבוצת page_ids."""
    params = {
        "action": "query",
        "prop": "extracts",
        "exintro": 1,
        "explaintext": 1,
        "exsentences": 3,
        "exlimit": EXTRACT_CHUNK_SIZE,
        "pageids": "|".join(str(i) for i in page_ids),
        "format": "json",
        "formatversion": 2,
    }
    for attempt in range(1, MAX_API_RETRIES + 1):
        try:
            response = session.get(WIKIPEDIA_API, params=params, timeout=(15, 60))
            if response.status_code == 429:
                wait = int(response.headers.get("retry-after", 30))
                log(f"WARNING | 429 מוויקיפדיה - ממתין {wait}ש")
                time.sleep(wait)
                continue
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
            return {p["pageid"]: p.get("extract", "") for p in pages}
        except (requests.RequestException, ValueError) as exc:
            log(f"WARNING | ניסיון {attempt}/{MAX_API_RETRIES}: {exc}")
            time.sleep(min(2 ** attempt, 60))
    log("ERROR | קבוצה נכשלה - מדלגים")
    return {}


def save(client, rows_with_desc):
    batches = [rows_with_desc[i:i + BATCH_SIZE] for i in range(0, len(rows_with_desc), BATCH_SIZE)]
    for i, batch in enumerate(batches):
        def do_upsert(batch=batch):
            return client.table("wikipedia_pages").upsert(batch, on_conflict="id").execute()

        execute_with_retry(do_upsert, f"שמירת קבוצה {i + 1}/{len(batches)}", log)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="מספר שורות מקסימלי (0 = הכל)")
    parser.add_argument("--dry-run", action="store_true", help="מדפיס בלי לשמור")
    args = parser.parse_args()

    start = time.monotonic()
    client = get_client()
    rows = load_candidate_rows(args.limit)
    log(f"{len(rows)} ערכים חסרים ללא תיאור ויקינתונים")

    to_save, skipped = [], 0
    for i in range(0, len(rows), EXTRACT_CHUNK_SIZE):
        chunk = rows[i:i + EXTRACT_CHUNK_SIZE]
        extracts = fetch_extracts([r["id"] for r in chunk])
        for row in chunk:
            definition = extract_definition(extracts.get(row["id"], ""))
            if definition is None:
                skipped += 1
                continue
            desc = definition + SUFFIX
            to_save.append({"id": row["id"], "title": row["title"], "wikidata_desc": desc})
            if args.dry_run:
                print(f"{row['title']} -> {desc}")
        if (i // EXTRACT_CHUNK_SIZE) % 25 == 0:
            log(f"עובדו {min(i + EXTRACT_CHUNK_SIZE, len(rows))}/{len(rows)}")
        time.sleep(REQUEST_DELAY_SECONDS)

    log(f"נוצרו {len(to_save)} הגדרות, דולגו {skipped} (אין משפט הגדרה ברור)")
    if not args.dry_run and to_save:
        save(client, to_save)
        log(f"נשמרו {len(to_save)} שורות ב-wikipedia_pages.wikidata_desc")
    log(f"הסתיים. משך: {time.monotonic() - start:.1f} שניות")


if __name__ == "__main__":
    main()
