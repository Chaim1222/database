"""
ההשוואה של `reconcile.py` (דוח בלבד): צילום מקור מול הטבלה הפעילה.

הפונקציות כאן טהורות (בלי רשת, בלי סופרבייס ובלי config) ולכן נבדקות ביחידות.
ראו PLAN_SYNC_REDESIGN.md, שלב 2.

מבנה הממצאים: לכל אתר, לכל סוג שינוי (`only_source`, `only_db`, `title`, `status`, ...), רשימת פריטים.
כל פריט מסומן `explained_by_window` אם הדף (לפי מזהה או כותרת) נגעו בו בחלון שבין נקודת הדלתא השמורה
לבין רגע הצילום. סימון כזה אומר רק שהדף השתנה בחלון, לא שהשינוי גרם לפער: הדוח מדווח
"פערים שלא הוסברו בתזמון" ולא "פספוסי דלתא".
"""

# שדות הסיווג של המכלול שמושווים (בדיוק אלה ש-classify_page מחזירה)
CLASSIFICATION_FIELDS = ("status", "source_type", "needs_attention", "is_dictionary_entry")

# match.py מקדם status ל"מיובא ומתועד" אחרי שתבנית המיון אומתה (match.py, "תבנית מיון תקינה... הוכחה ישירה").
# הצילום מסווג רק לפי קטגוריות, לפני ההתאמה, ולכן הפרש בכיוון הזה צפוי ואינו פער. מדווח בנפרד.
STATUS_DOCUMENTED = "מיובא ומתועד"
STATUS_UNDOCUMENTED = "מיובא ללא תיעוד"
PROMOTED_BY_MATCH = "status_promoted_by_match"

# סף התחלתי להצעה בלבד (PLAN_SYNC_REDESIGN.md, שלב 4): הדוח מדווח אם היה נחצה, ואינו עוצר דבר
PROVISIONAL_DELETE_RATE = 0.001


def compare_titles(source, db):
    """
    source, db: {page_id: title}. מחזיר dict של רשימות:
      only_source - [(id, title)] קיים במקור ואין בטבלה (היה נוצר)
      only_db     - [(id, title)] קיים בטבלה ואין במקור (היה נמחק)
      title       - [(id, old_title, new_title)] אותו מזהה, כותרת שונה (old = בטבלה, new = במקור)
    """
    only_source = sorted((i, t) for i, t in source.items() if i not in db)
    only_db = sorted((i, t) for i, t in db.items() if i not in source)
    title = sorted((i, db[i], source[i]) for i in source if i in db and db[i] != source[i])
    return {"only_source": only_source, "only_db": only_db, "title": title}


def compare_classification(source, db, fields=CLASSIFICATION_FIELDS):
    """
    source, db: {page_id: {field: value}}. משווה רק מזהים שקיימים בשני הצדדים.
    מחזיר {field: [(id, old, new)]} (old = בטבלה, new = במקור), רק לשדות שיש בהם שינוי.
    קידום סטטוס על ידי match.py (טבלה "מתועד", צילום "ללא תיעוד") מדווח בנפרד תחת PROMOTED_BY_MATCH.
    """
    changes = {}
    for page_id in sorted(set(source) & set(db)):
        for field in fields:
            old, new = db[page_id].get(field), source[page_id].get(field)
            if old != new:
                name = field
                if field == "status" and old == STATUS_DOCUMENTED and new == STATUS_UNDOCUMENTED:
                    name = PROMOTED_BY_MATCH
                changes.setdefault(name, []).append((page_id, old, new))
    return changes


def explain(items, window_ids, window_titles):
    """
    items: רשימת טאפלים שהאיבר הראשון בהם הוא מזהה והאחרון (או השני, לשינוי כותרת) כותרת; לכן
    מקבלים פונקציית חילוץ בנפרד. כאן: items = [(id, title_or_none)].
    מחזיר (explained, unexplained): דף "מוסבר" אם המזהה או הכותרת נגעו בו בחלון.
    """
    explained, unexplained = [], []
    for page_id, title in items:
        if page_id in window_ids or (title is not None and title in window_titles):
            explained.append((page_id, title))
        else:
            unexplained.append((page_id, title))
    return explained, unexplained


def _title_findings(diff):
    """מוציא מכל סוג שינוי כותרת רשימת (id, כותרת) לצורך הסבר בחלון."""
    return {
        "only_source": [(i, t) for i, t in diff["only_source"]],
        "only_db": [(i, t) for i, t in diff["only_db"]],
        "title": [(i, new) for i, _old, new in diff["title"]],
    }


def summarize_site(site, source_count, db_count, title_diff, class_changes, window_ids, window_titles,
                   source_titles=None, examples_per_class=20):
    """
    דוח של אתר אחד. מחזיר dict:
      counts: מספר שורות במקור ובטבלה
      classes: {class: {"n", "explained_by_window", "unexplained", "examples": [...]}}
      delete_rate: only_db / שורות בטבלה, ו-would_exceed_provisional_gate (מידע בלבד)
    source_titles: {id: title} של המקור, להסבר שינויי סיווג גם לפי כותרת.
    """
    source_titles = source_titles or {}
    classes = {}

    def add(name, findings, examples):
        explained, unexplained = explain(findings, window_ids, window_titles)
        classes[name] = {
            "n": len(findings),
            "explained_by_window": len(explained),
            "unexplained": len(unexplained),
            "examples": examples[:examples_per_class],
            "unexplained_examples": [
                {"id": i, "title": t} for i, t in unexplained[:examples_per_class]
            ],
        }

    for name, findings in _title_findings(title_diff).items():
        add(name, findings, [{"id": i, "title": t} for i, t in findings])

    # שינוי כותרת: הדוגמאות כוללות את הכותרת הישנה
    classes["title"]["examples"] = [
        {"id": i, "old": old, "new": new} for i, old, new in title_diff["title"][:examples_per_class]
    ]

    for field, changes in sorted(class_changes.items()):
        findings = [(i, source_titles.get(i)) for i, _o, _n in changes]
        add(field, findings, [{"id": i, "old": o, "new": n} for i, o, n in changes])

    n_delete = len(title_diff["only_db"])
    rate = n_delete / db_count if db_count else 0.0
    return {
        "site": site,
        "counts": {"source": source_count, "db": db_count},
        "classes": classes,
        "delete_rate": {
            "n": n_delete,
            "rate": rate,
            "would_exceed_provisional_gate": rate > PROVISIONAL_DELETE_RATE,
        },
    }


def render_markdown(report):
    """דוח קריא לסיכום הריצה. report = {"run_id", "snapshot": {...}, "sites": [summarize_site(...)]}."""
    lines = [f"# דוח reconcile (דוח בלבד, בלי כתיבה) | ריצה {report['run_id']}", ""]
    snap = report.get("snapshot", {})
    for key, value in sorted(snap.items()):
        lines.append(f"- {key}: {value}")
    lines.append("")
    for site in report["sites"]:
        c = site["counts"]
        lines.append(f"## {site['site']} | מקור {c['source']:,} | טבלה {c['db']:,}")
        lines.append("")
        lines.append("| סוג | סה\"כ | הוסבר בחלון | לא הוסבר בתזמון |")
        lines.append("|---|---|---|---|")
        for name, info in sorted(site["classes"].items()):
            lines.append(f"| {name} | {info['n']} | {info['explained_by_window']} | {info['unexplained']} |")
        d = site["delete_rate"]
        lines.append("")
        lines.append(
            f"שיעור מחיקות: {d['n']} מתוך {c['db']:,} ({d['rate']:.4%}); "
            f"{'חורג' if d['would_exceed_provisional_gate'] else 'לא חורג'} מהסף ההתחלתי "
            f"({PROVISIONAL_DELETE_RATE:.1%}, מידע בלבד)"
        )
        lines.append("")
    lines.append(
        "הערה: \"הוסבר בחלון\" פירושו שהדף נגעו בו בין נקודת הדלתא השמורה לרגע הצילום; "
        "זה לא מוכיח שהעריכה גרמה לפער. \"לא הוסבר בתזמון\" אינו פספוס מוכח."
    )
    return "\n".join(lines) + "\n"
