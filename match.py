"""
Match Hamichlol titles against Wikipedia titles.

Order:
1. Manual matches are authoritative.
2. Exact title match.
3. Text hygiene.
4. Semantic normalization.
5. {{מיון ויקיפדיה|דף=...}} fallback.

Normalization never changes the stored title.
"""

import re
import time
import unicodedata
from datetime import datetime, timezone

from config import (
    BATCH_SIZE,
    MECHALOL_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
)
from supabase_client import get_client

import requests


MAX_RETRIES = 5
RETRY_DELAY = 3

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


def log(message):
    now = datetime.now(timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )
    print(f"[{now}] {message}", flush=True)


def execute_with_retry(operation, description):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return operation()

        except Exception as exc:
            if attempt >= MAX_RETRIES:
                log(
                    f"ERROR | {description} | "
                    f"נכשל אחרי {MAX_RETRIES}: {exc}"
                )
                raise

            log(
                f"WARNING | {description} | "
                f"ניסיון {attempt}/{MAX_RETRIES}: {exc}"
            )
            time.sleep(RETRY_DELAY)


def load_wikipedia_title_map(client):
    title_map = {}
    offset = 0

    while True:
        result = execute_with_retry(
            lambda: (
                client.table("wikipedia_pages")
                .select("id, title")
                .range(offset, offset + BATCH_SIZE - 1)
                .execute()
            ),
            f"שליפת ויקיפדיה offset={offset}",
        )

        rows = result.data or []

        if not rows:
            break

        for row in rows:
            if row.get("title"):
                title_map[row["title"]] = row["id"]

        offset += len(rows)

        log(
            f"WIKIPEDIA | נטענו "
            f"{len(title_map):,} כותרות"
        )

        if len(rows) < BATCH_SIZE:
            break

    return title_map


def hygiene(title):
    """
    Cheap text-only normalization.
    Does not change stored titles.
    """
    value = unicodedata.normalize("NFC", title)

    value = value.replace("\u200e", "")
    value = value.replace("\u200f", "")
    value = value.replace("\u202a", "")
    value = value.replace("\u202b", "")
    value = value.replace("\u202c", "")
    value = value.replace("\u202d", "")
    value = value.replace("\u202e", "")

    value = value.replace("\u00a0", " ")
    value = value.replace("״", '"')
    value = value.replace("׳", "'")
    value = value.replace("־", "-")

    return value.strip()


def hygiene_key(title):
    return hygiene(title)


def add_candidate(candidates, title, method):
    if title:
        candidates.setdefault(title, set()).add(method)


def semantic_candidates(title):
    """
    Return possible semantic variants.
    """
    candidates = {}

    base = hygiene(title)

    # "קדוש" quotation marks.
    value = re.sub(
        r'(?<!\w)"(קדוש|קדושה|קדושים)"',
        r"\1",
        base,
    )
    value = re.sub(
        r'"(קדוש|קדושה|קדושים)"',
        r"\1",
        value,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "הסרת_מירכאות_קדוש",
        )

    # אותו האיש <-> ישו
    if "אותו האיש" in base:
        add_candidate(
            candidates,
            base.replace("אותו האיש", "ישו"),
            "אותו_האיש_לישו",
        )

    if "ישו" in base:
        add_candidate(
            candidates,
            base.replace("ישו", "אותו האיש"),
            "ישו_לאותו_האיש",
        )

    # המרכז ה... -> בית הכנסת ה...
    value = re.sub(
        r"^המרכז ה(נאולוגי|רפורמי|קראי|קונסרבטיבי)",
        r"בית הכנסת ה\1",
        base,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "מרכז_לבית_כנסת",
        )

    # קרבן / קרבנות.
    value = re.sub(
        r"\bקרבן\b",
        "קורבן",
        base,
    )
    value = re.sub(
        r"\bקרבנות\b",
        "קורבנות",
        value,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "קרבן_לקורבן",
        )

    # אלוהים spelling.
    value = base
    value = value.replace("א-לוהים", "אלוהים")
    value = value.replace("א־לוהים", "אלוהים")
    value = value.replace("אלוקים", "אלוהים")

    if value != base:
        add_candidate(
            candidates,
            value,
            "כתיב_אלוהים",
        )

    # י-ה -> יה
    value = base.replace("י-ה", "יה").replace("י־ה", "יה")

    if value != base:
        add_candidate(
            candidates,
            value,
            "יה",
        )

    # "(אישיות מהתנך)" <-> "(דמות מקראית)"
    value = base.replace(
        "(אישיות מהתנ\"ך)",
        "(דמות מקראית)",
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "אישיות_מהתנך_לדמות_מקראית",
        )

    value = base.replace(
        "(דמות מקראית)",
        "(אישיות מהתנ\"ך)",
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "דמות_מקראית_לאישיות_מהתנך",
        )

    # אליל -> אל, including common inflections.
    value = re.sub(
        r"\bאלילי\b",
        "אלי",
        base,
    )
    value = re.sub(
        r"\bאלילים\b",
        "אלים",
        value,
    )
    value = re.sub(
        r"\bאליל(?:ים|י|ות)?\b",
        "אל",
        value,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "אליל_לאל",
        )

    # Hebrew-year apostrophe placement.
    value = re.sub(
        r"\b([א-ת]{2,5})['׳]$",
        lambda m: fix_hebrew_year_final_letter(m.group(1)),
        base,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "שנת_עברי_אות_סופית",
        )

    return candidates


def fix_hebrew_year_final_letter(value):
    """
    Converts common non-final Hebrew letters before a year apostrophe
    to their final forms where Hebrew spelling requires it.
    """
    replacements = {
        "כ": "ך",
        "מ": "ם",
        "נ": "ן",
        "פ": "ף",
        "צ": "ץ",
    }

    if not value:
        return value

    last = value[-1]

    return value[:-1] + replacements.get(last, last)


def build_normalized_map(wikipedia_titles):
    result = {}

    for title, page_id in wikipedia_titles.items():
        key = hygiene_key(title)
        result.setdefault(key, []).append(
            (title, page_id)
        )

    return result


def find_hygiene_match(title, normalized_map):
    key = hygiene_key(title)
    matches = normalized_map.get(key, [])

    if len(matches) == 1:
        original_title, page_id = matches[0]

        if original_title != title:
            return (
                original_title,
                page_id,
                "text_hygiene",
            )

        return original_title, page_id, None

    return None


def find_semantic_matches(title, normalized_map):
    candidates = semantic_candidates(title)

    matches = []

    for candidate, methods in candidates.items():
        key = hygiene_key(candidate)

        for original_title, page_id in normalized_map.get(
            key,
            [],
        ):
            matches.append(
                (
                    original_title,
                    page_id,
                    sorted(methods),
                )
            )

    unique = {
        (title, page_id): methods
        for title, page_id, methods in matches
    }

    if len(unique) == 1:
        (matched_title, page_id), methods = next(
            iter(unique.items())
        )

        return (
            matched_title,
            page_id,
            "+".join(methods),
        )

    return None


def get_template_title(title):
    """
    Read {{מיון ויקיפדיה|דף=...}} only as a last resort.
    """
    params = {
        "action": "parse",
        "page": title,
        "prop": "wikitext",
    }

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = session.get(
                MECHALOL_API,
                params={**params, "format": "json"},
                timeout=(15, 60),
            )
            response.raise_for_status()

            data = response.json()

            wikitext = (
                data.get("parse", {})
                .get("wikitext", {})
                .get("*", "")
            )

            match = re.search(
                r"\{\{\s*מיון ויקיפדיה\s*"
                r"\|\s*דף\s*=\s*([^|}\n]+)",
                wikitext,
            )

            if match:
                return hygiene(match.group(1))

            return None

        except (requests.RequestException, ValueError):
            if attempt >= MAX_RETRIES:
                raise

            time.sleep(RETRY_DELAY)


def iter_mechalol_rows(client):
    offset = 0

    while True:
        result = execute_with_retry(
            lambda: (
                client.table("mechalol_pages")
                .select("*")
                .range(offset, offset + BATCH_SIZE - 1)
                .execute()
            ),
            f"שליפת המכלול offset={offset}",
        )

        rows = result.data or []

        if not rows:
            break

        yield rows

        offset += len(rows)

        if len(rows) < BATCH_SIZE:
            break


def main():
    started = time.monotonic()
    client = get_client()

    log("START | match.py")

    wikipedia_titles = load_wikipedia_title_map(client)

    log(
        f"WIKIPEDIA | {len(wikipedia_titles):,} titles"
    )

    normalized_map = build_normalized_map(
        wikipedia_titles
    )

    total = 0
    matched = 0
    normalized = 0
    template_matches = 0

    for batch_number, batch in enumerate(
        iter_mechalol_rows(client),
        1,
    ):
        updates = []

        for row in batch:
            total += 1

            if row.get("manual_match"):
                continue

            title = row.get("title")

            if not title:
                continue

            current_match = row.get("match_type")

            # Exact title first.
            wikipedia_id = wikipedia_titles.get(title)

            if wikipedia_id is not None:
                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_id

                if row.get("status") == "נוצר_במכלול":
                    updated["match_type"] = "כותרת_זהה_בלי_קשר"
                else:
                    updated["match_type"] = "מיובא"

                updated["normalization_checked"] = False
                updated["normalization_match"] = False
                updated["normalization_method"] = None
                updated["title_normalized"] = None

                updates.append(updated)
                matched += 1
                continue

            # Hygiene.
            hygiene_match = find_hygiene_match(
                title,
                normalized_map,
            )

            if hygiene_match:
                matched_title, wikipedia_id, method = (
                    hygiene_match
                )

                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_id
                updated["match_type"] = (
                    "כותרת_זהה_בלי_קשר"
                    if row.get("status") == "נוצר_במכלול"
                    else "מיובא"
                )
                updated["normalization_checked"] = True
                updated["normalization_match"] = True
                updated["normalization_method"] = method
                updated["title_normalized"] = matched_title

                updates.append(updated)
                matched += 1
                normalized += 1
                continue

            if (
                current_match != "ללא_התאמה"
                or row.get("normalization_checked")
            ):
                continue

            semantic_match = find_semantic_matches(
                title,
                normalized_map,
            )

            if semantic_match:
                matched_title, wikipedia_id, method = (
                    semantic_match
                )

                updated = dict(row)
                updated["wikipedia_id"] = wikipedia_id
                updated["match_type"] = "מיובא"
                updated["normalization_checked"] = True
                updated["normalization_match"] = True
                updated["normalization_method"] = method
                updated["title_normalized"] = matched_title

                updates.append(updated)

                matched += 1
                normalized += 1
                continue

            template_title = get_template_title(title)

            if template_title:
                template_key = hygiene_key(
                    template_title
                )

                template_matches_found = normalized_map.get(
                    template_key,
                    [],
                )

                if len(template_matches_found) == 1:
                    matched_title, wikipedia_id = (
                        template_matches_found[0]
                    )

                    updated = dict(row)
                    updated["wikipedia_id"] = wikipedia_id
                    updated["match_type"] = "מיובא"
                    updated["normalization_checked"] = True
                    updated["normalization_match"] = True
                    updated["normalization_method"] = "תבנית_מיון"
                    updated["title_normalized"] = matched_title

                    updates.append(updated)

                    matched += 1
                    template_matches += 1
                    continue

            updated = dict(row)
            updated["normalization_checked"] = True
            updated["normalization_match"] = False
            updated["normalization_method"] = None
            updated["title_normalized"] = None

            updates.append(updated)

        if updates:
            execute_with_retry(
                lambda: client.table(
                    "mechalol_pages"
                ).upsert(
                    updates,
                    on_conflict="id",
                ).execute(),
                f"עדכון התאמות batch {batch_number}",
            )

        log(
            f"PROGRESS | batch={batch_number} | "
            f"נבדקו={total:,} | "
            f"התאמות={matched:,} | "
            f"נרמול={normalized:,} | "
            f"תבנית={template_matches:,}"
        )

    elapsed = int(time.monotonic() - started)

    log(
        f"DONE | נבדקו {total:,} | "
        f"התאמות {matched:,} | "
        f"זמן {elapsed // 60}m {elapsed % 60}s"
    )


if __name__ == "__main__":
    main()
