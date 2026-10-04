"""
פענוח דמפ "stub-meta-current" של ויקיפדיה (XML בלי טקסט) ואיחוד שינויים אחרונים.

עצמאי בכוונה (בלי config/supabase), כדי שאפשר יהיה לבדוק בלי משתני סביבה.
"""
import xml.etree.ElementTree as ET


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def iter_stub_titles(fileobj):
    """
    מפענח בזרימה (זיכרון קבוע) ומחזיר (page_id, title, rev_id, timestamp) לכל דף במרחב
    הראשי שאינו הפניה. הגרסה היא הגרסה הנוכחית בדמפ, והכותרת בלי קידומת מרחב שם
    (כמו ב-list=allpages).
    """
    root = None
    for event, elem in ET.iterparse(fileobj, events=("start", "end")):
        if root is None:
            root = elem
        if event != "end" or _local(elem.tag) != "page":
            continue

        ns = page_id = rev_id = timestamp = title = None
        is_redirect = False
        for child in elem:
            name = _local(child.tag)
            if name == "ns":
                ns = child.text
            elif name == "title":
                title = child.text
            elif name == "id":
                page_id = child.text
            elif name == "redirect":
                is_redirect = True
            elif name == "revision":
                for part in child:
                    part_name = _local(part.tag)
                    if part_name == "id":
                        rev_id = part.text
                    elif part_name == "timestamp":
                        timestamp = part.text

        elem.clear()
        root.clear()

        if ns == "0" and not is_redirect and page_id and rev_id and title:
            yield int(page_id), title, int(rev_id), timestamp


def iter_stub_pages(fileobj):
    """כמו iter_stub_titles, בלי הכותרת: (page_id, rev_id, timestamp)."""
    for page_id, _title, rev_id, timestamp in iter_stub_titles(fileobj):
        yield page_id, rev_id, timestamp


def latest_per_page(changes):
    """
    changes: איטרבל של (page_id, rev_id, timestamp). מחזיר {page_id: (rev_id, timestamp)}
    עם השינוי המאוחר ביותר לכל דף (לפי timestamp ISO, ובשוויון לפי rev_id).
    """
    latest = {}
    for page_id, rev_id, timestamp in changes:
        current = latest.get(page_id)
        if current is None or (timestamp, rev_id) >= (current[1], current[0]):
            latest[page_id] = (rev_id, timestamp)
    return latest
