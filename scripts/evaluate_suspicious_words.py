"""
מדידת מנוע המילים החשודות (suspicious_words.py) מול תוכן אמיתי - לפני
כל שינוי ברשימות, כדי לדעת מה הוא מוסיף ומה הוא מקלקל.

שני מאגרים:
- "חסומים": הערכים שב-blacklist_titles (נעולים ליצירה במכלול), כפי שהם
  בוויקיפדיה. אמורים להיתפס.
- "מכלול": מדגם אקראי של ערכים מהמכלול - תוכן שכבר אושר באתר. כל התאמה
  חוסמת בהם היא (כמעט תמיד) התראת שווא. כדאי שני מדגמים: אחד לבניית
  רשימת המותרות (dev) ואחד לבדיקה עיוורת (holdout).

הרצה:
    # הורדה (נשמר ב-.suspicious_words_corpus/, לא נכנס ל-git):
    python scripts/evaluate_suspicious_words.py fetch-blacklist            # מזהים מסופרבייס
    python scripts/evaluate_suspicious_words.py fetch-blacklist --ids-file ids.txt
    python scripts/evaluate_suspicious_words.py fetch-mechalol dev 500
    python scripts/evaluate_suspicious_words.py fetch-mechalol holdout 1500

    # דוחות:
    python scripts/evaluate_suspicious_words.py report                     # טבלת תצורות
    python scripts/evaluate_suspicious_words.py report --lost              # ערכים חסומים שאבדו בכל שלב
    python scripts/evaluate_suspicious_words.py noisy 40                   # התבניות הרועשות במכלול
    python scripts/evaluate_suspicious_words.py candidates cands.txt       # מדידת תבניות מועמדות

ויקיפדיה מגבילה קצב (HTTP 429) - ההורדה ממתינה ומנסה שוב, וממשיכה מאיפה
שעצרה אם מריצים שוב.
"""
import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict

import requests

import suspicious_words as sw

CORPUS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".suspicious_words_corpus")


def path(name):
    os.makedirs(CORPUS_DIR, exist_ok=True)
    return os.path.join(CORPUS_DIR, name + ".json")


def api_get(api, params):
    for attempt in range(8):
        response = requests.get(api, params=params, headers=sw.REQUEST_HEADERS, timeout=90)
        if response.status_code == 200:
            return response.json()
        wait = min(int(response.headers.get("retry-after") or 0) or 10 * (attempt + 1), 90)
        print(f"HTTP {response.status_code} - ממתין {wait} שניות", flush=True)
        time.sleep(wait)
    raise RuntimeError("יותר מדי כישלונות ברצף")


def content(page):
    revisions = page.get("revisions")
    return revisions[0]["slots"]["main"]["content"] if revisions else None


def fetch_blacklist(ids_file):
    if ids_file:
        ids = open(ids_file).read().replace("\n", ",").split(",")
    else:
        from supabase_client import get_client
        rows = get_client().table("blacklist_titles").select("wikipedia_id").execute().data
        ids = [str(r["wikipedia_id"]) for r in rows if r.get("wikipedia_id")]
    out = path("blacklist")
    pages = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else {}
    todo = [i for i in dict.fromkeys(x.strip() for x in ids) if i and i not in pages]
    for start in range(0, len(todo), 50):
        chunk = todo[start:start + 50]
        data = api_get(sw.WIKIPEDIA_API, {
            "action": "query", "pageids": "|".join(chunk), "prop": "revisions", "rvprop": "content",
            "rvslots": "main", "format": "json", "formatversion": 2,
        })
        for page in data.get("query", {}).get("pages", []):
            pages[str(page["pageid"])] = {"title": page.get("title"), "text": content(page)}
        for i in chunk:
            pages.setdefault(i, {"title": None, "text": None})
        json.dump(pages, open(out, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"חסומים: {len(pages)}", flush=True)
        time.sleep(2)


def fetch_mechalol(name, target):
    out = path(name)
    pages = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else {}
    while len(pages) < target:
        # אצווה עם דף נעול-לקריאה נדחית כולה (ראו match.py) - מדלגים עליה.
        data = api_get(sw.MECHALOL_API, {
            "action": "query", "generator": "random", "grnnamespace": 0, "grnlimit": 50,
            "prop": "revisions", "rvprop": "content", "rvslots": "main", "format": "json", "formatversion": 2,
        })
        for page in data.get("query", {}).get("pages", []):
            text = content(page)
            if text and not is_redirect(text):
                pages[str(page["pageid"])] = {"title": page["title"], "text": text}
        json.dump(pages, open(out, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"{name}: {len(pages)}", flush=True)
        time.sleep(1)


def is_redirect(text):
    return text.lstrip().lower().startswith(("#הפניה", "#redirect"))


def load_corpora():
    corpora = {}
    for name in sorted(os.listdir(CORPUS_DIR)) if os.path.isdir(CORPUS_DIR) else []:
        if name.endswith(".json"):
            data = json.load(open(os.path.join(CORPUS_DIR, name), encoding="utf-8"))
            corpora[name[:-5]] = {k: v for k, v in data.items() if v.get("text") and not is_redirect(v["text"])}
    if "blacklist" not in corpora:
        sys.exit("אין מאגר חסומים - הריצו קודם fetch-blacklist")
    return corpora


def configurations():
    r = sw.read_snapshot
    return {
        "רשימות המקור": (sw.compile_lists(r("bmh.txt"), r("bomah.txt")), False),
        "+תחילת מילה": (sw.compile_lists(r("bmh.txt"), r("bomah.txt")), True),
        "+מותרות": (sw.compile_lists(r("bmh.txt"), r("bomah.txt"), None, r("allow.txt")), True),
        "+תוספות": (sw.compile_lists(r("bmh.txt"), r("bomah.txt"), r("extra.txt"), r("allow.txt")), True),
    }


def report(show_lost):
    corpora = load_corpora()
    configs = configurations()
    caught = {}
    print(f"{'תצורה':14}" + "".join(f"{name} ({len(pages)})".rjust(22) for name, pages in corpora.items()))
    for config, (lists, word_start) in configs.items():
        cells = []
        for name, pages in corpora.items():
            hit = {k for k, v in pages.items()
                   if any(m.category.blocking for m in sw.scan(v["text"], lists, word_start=word_start))}
            caught[config, name] = hit
            cells.append(f"{100 * len(hit) / len(pages):6.1f}% ({len(hit)})".rjust(22))
        print(f"{config:14}" + "".join(cells))
    if show_lost:
        names = list(configs)
        for before, after in zip(names, names[1:]):
            lost = caught[before, "blacklist"] - caught[after, "blacklist"]
            print(f"\nחסומים שאבדו במעבר {before} -> {after}: {len(lost)}")
            for k in sorted(lost):
                print("  -", corpora["blacklist"][k]["title"])


def noisy(limit):
    corpora = load_corpora()
    lists = sw.load_lists("snapshot")
    stats = defaultdict(lambda: {"blacklist": set(), "mechalol": set(), "words": defaultdict(int)})
    for name, pages in corpora.items():
        side = "blacklist" if name == "blacklist" else "mechalol"
        for k, v in pages.items():
            for m in sw.scan(v["text"], lists):
                if not m.category.blocking:
                    continue
                for p in m.patterns:
                    st = stats[m.category.label, p]
                    st[side].add(name + k)
                    if side == "mechalol":
                        st["words"][m.text] += 1
    rows = sorted(stats.items(), key=lambda kv: -len(kv[1]["mechalol"]))[:limit]
    print("חסומים/מכלול  [קטגוריה] תבנית  <- המילים שנתפסו במכלול")
    for (label, pattern), st in rows:
        words = ", ".join(f"{w}×{n}" for w, n in sorted(st["words"].items(), key=lambda x: -x[1])[:6])
        print(f"{len(st['blacklist']):5}/{len(st['mechalol']):<4} [{label}] {pattern}  <- {words}")


def candidates(file):
    """
    לכל תבנית מועמדת (שורה בקובץ): כמה ערכים חסומים היא תופסת, כמה מהם
    לא נתפסים היום בכלל ("+חסרים"), וכמה ערכי מכלול (התראות שווא) - עם דוגמה.
    """
    corpora = load_corpora()
    lists = sw.load_lists("snapshot")
    masked = {(n, k): sw.mask_wikitext(v["text"]) for n, pages in corpora.items() for k, v in pages.items()}
    missed = {k for k, v in corpora["blacklist"].items()
              if not any(m.category.blocking for m in sw.scan(v["text"], lists))}
    for line in open(file, encoding="utf-8"):
        pattern = line.strip()
        if not pattern or pattern.startswith("#"):
            continue
        regex = re.compile(pattern, re.IGNORECASE)
        hits = defaultdict(set)
        example = ""
        for (n, k), text in masked.items():
            for m in regex.finditer(text):
                if sw._contains_word_start(text, m.start(), m.end(), pattern):
                    hits[n].add(k)
                    if n != "blacklist" and not example:
                        example = text[max(m.start() - 25, 0):m.end() + 25].replace("\n", " ")
                    break
        others = sum(len(v) for n, v in hits.items() if n != "blacklist")
        print(f"+{len(hits['blacklist'] & missed):3} חסרים | חסומים {len(hits['blacklist']):4} | מכלול {others:3} | "
              f"{pattern}" + (f"  | {example}" if example else ""))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    fb = sub.add_parser("fetch-blacklist")
    fb.add_argument("--ids-file", help="קובץ מזהי ויקיפדיה מופרדים בפסיק (במקום שליפה מסופרבייס)")
    fm = sub.add_parser("fetch-mechalol")
    fm.add_argument("name")
    fm.add_argument("count", type=int)
    rp = sub.add_parser("report")
    rp.add_argument("--lost", action="store_true")
    ns = sub.add_parser("noisy")
    ns.add_argument("limit", type=int, nargs="?", default=40)
    cd = sub.add_parser("candidates")
    cd.add_argument("file")
    args = parser.parse_args()

    if args.cmd == "fetch-blacklist":
        fetch_blacklist(args.ids_file)
    elif args.cmd == "fetch-mechalol":
        fetch_mechalol(args.name, args.count)
    elif args.cmd == "report":
        report(args.lost)
    elif args.cmd == "noisy":
        noisy(args.limit)
    else:
        candidates(args.file)


if __name__ == "__main__":
    main()
