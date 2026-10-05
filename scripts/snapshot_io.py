"""
שמירה וטעינה של צילום המקור של reconcile.py, כדי שהדוח והסנכרון השבועי ירוצו מול **אותו** צילום.

הקובץ gz של JSON; מזהי העמודים נשמרים כמחרוזות ב-JSON וחוזרים כמספרים בטעינה. בלי רשת ובלי config.
שימוש חוזר: reconcile.py (--snapshot-in), fetch_wikipedia.py (--snapshot) ו-fetch_mechalol.py (RECONCILE_SNAPSHOT).
"""
import gzip
import json


def save(path, snapshot):
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(snapshot, fh, ensure_ascii=False)


def _ints(mapping):
    return {int(key): value for key, value in mapping.items()}


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        snapshot = json.load(fh)
    if "wikipedia" in snapshot:
        snapshot["wikipedia"]["pages"] = _ints(snapshot["wikipedia"]["pages"])
    if "mechalol" in snapshot:
        snapshot["mechalol"]["pages"] = _ints(snapshot["mechalol"]["pages"])
        snapshot["mechalol"]["classification"] = _ints(snapshot["mechalol"]["classification"])
    return snapshot


def _chunks(items, size):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def wikipedia_batches(snapshot, size=1000):
    """אצוות {"id","title"} מהצילום, בסדר id יציב. הצילום כבר כולל את השלמת הפער."""
    if "wikipedia" not in snapshot:
        raise RuntimeError("בצילום אין ויקיפדיה")
    rows = [{"id": i, "title": t} for i, t in sorted(snapshot["wikipedia"]["pages"].items())]
    yield from _chunks(rows, size)


def mechalol_batches(snapshot, size=5000):
    """אצוות של (title, page_id), כמו fetch_all_titles ב-fetch_mechalol.py."""
    if "mechalol" not in snapshot:
        raise RuntimeError("בצילום אין מכלול")
    rows = [(t, i) for i, t in sorted(snapshot["mechalol"]["pages"].items())]
    yield from _chunks(rows, size)
