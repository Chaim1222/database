"""
Match Hamichlol titles against Wikipedia titles.

Matching order:

1. Manual matches are authoritative and are never modified.
2. Exact title match.
3. Text hygiene normalization.
4. Semantic normalization.
5. {{מיון ויקיפדיה|דף=...}} fallback.

Normalization never changes the stored title.

Progress:
- normalization_checked=true means the normalization pipeline has already
  been completed for that row.
- Therefore, interrupted runs can safely continue without repeating expensive
  normalization/API work.
"""

import re
import time
import unicodedata
from datetime import datetime, timezone

import requests

from config import (
    BATCH_SIZE,
    MECHALOL_API,
    REQUEST_DELAY_SECONDS,
    REQUEST_HEADERS,
)
from supabase_client import get_client


MAX_RETRIES = 5
RETRY_DELAY = 3

session = requests.Session()
session.headers.update(REQUEST_HEADERS)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message):
    now = datetime.now(timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )
    print(f"[{now}] {message}", flush=True)


# ---------------------------------------------------------------------------
# Retry wrapper
# ---------------------------------------------------------------------------

def execute_with_retry(operation, description):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return operation()

        except Exception as exc:
            if attempt >= MAX_RETRIES:
                log(
                    f"ERROR | {description} | "
                    f"failed after {MAX_RETRIES} attempts: {exc}"
                )
                raise

            log(
                f"WARNING | {description} | "
                f"attempt {attempt}/{MAX_RETRIES} failed: {exc}. "
                f"retrying in {RETRY_DELAY}s..."
            )

            time.sleep(RETRY_DELAY)


# ---------------------------------------------------------------------------
# Wikipedia
# ---------------------------------------------------------------------------

def load_wikipedia_title_map(client):
    """
    Load all Wikipedia titles into memory.

    Returns:
        {
            "Wikipedia title": wikipedia_pages.id
        }
    """

    title_map = {}
    offset = 0
    batch_number = 0

    while True:
        batch_number += 1

        result = execute_with_retry(
            lambda: (
                client.table("wikipedia_pages")
                .select("id, title")
                .range(
                    offset,
                    offset + BATCH_SIZE - 1,
                )
                .execute()
            ),
            f"WIKIPEDIA batch={batch_number} offset={offset}",
        )

        rows = result.data or []

        if not rows:
            break

        for row in rows:
            title = row.get("title")

            if title:
                title_map[title] = row["id"]

        offset += len(rows)

        log(
            f"WIKIPEDIA | batch={batch_number} | "
            f"loaded={len(title_map):,}"
        )

        if len(rows) < BATCH_SIZE:
            break

    return title_map


# ---------------------------------------------------------------------------
# Text hygiene
# ---------------------------------------------------------------------------

def hygiene(title):
    """
    Cheap text-only normalization.

    This is deliberately conservative.
    It does not perform semantic substitutions.
    It does not change the stored title.
    """

    value = unicodedata.normalize("NFC", title)

    # LRM / RLM / bidi control characters.
    value = value.replace("\u200e", "")
    value = value.replace("\u200f", "")
    value = value.replace("\u202a", "")
    value = value.replace("\u202b", "")
    value = value.replace("\u202c", "")
    value = value.replace("\u202d", "")
    value = value.replace("\u202e", "")

    # Non-breaking space.
    value = value.replace("\u00a0", " ")

    # Hebrew quotation marks / apostrophes.
    value = value.replace("״", '"')
    value = value.replace("׳", "'")

    # Hebrew maqaf -> ASCII hyphen.
    value = value.replace("־", "-")

    # Trim surrounding whitespace.
    value = value.strip()

    return value


def hygiene_key(title):
    return hygiene(title)


# ---------------------------------------------------------------------------
# Candidate handling
# ---------------------------------------------------------------------------

def add_candidate(candidates, title, method):
    if not title:
        return

    candidates.setdefault(title, set()).add(method)


# ---------------------------------------------------------------------------
# Hebrew year handling
# ---------------------------------------------------------------------------

def fix_hebrew_year_final_letter(value):
    """
    Convert a Hebrew final-letter case where a year notation has a
    non-final letter immediately before the apostrophe.

    Example:
        תשפג' -> תשפג/appropriate final form where applicable
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


# ---------------------------------------------------------------------------
# Semantic normalization
# ---------------------------------------------------------------------------

def semantic_candidates(title):
    """
    Return all possible semantic variants for a Hamichlol title.

    Multiple rules may generate candidates.

    The original title is never modified in the database.
    """

    candidates = {}

    base = hygiene(title)

    # ---------------------------------------------------------------
    # 1. "קדוש" / "קדושה" / "קדושים"
    # ---------------------------------------------------------------

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

    # ---------------------------------------------------------------
    # 2. אותו האיש <-> ישו
    # ---------------------------------------------------------------

    if "אותו האיש" in base:
        add_candidate(
            candidates,
            base.replace(
                "אותו האיש",
                "ישו",
            ),
            "אותו_האיש_לישו",
        )

    if "ישו" in base:
        add_candidate(
            candidates,
            base.replace(
                "ישו",
                "אותו האיש",
            ),
            "ישו_לאותו_האיש",
        )

    # ---------------------------------------------------------------
    # 3. המרכז ה... -> בית הכנסת ה...
    #
    # Only the requested four streams.
    # ---------------------------------------------------------------

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

    # ---------------------------------------------------------------
    # 4. קרבן / קרבנות -> קורבן / קורבנות
    # ---------------------------------------------------------------

    value = re.sub(
        r"\bקרבנות\b",
        "קורבנות",
        base,
    )

    value = re.sub(
        r"\bקרבן\b",
        "קורבן",
        value,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "קרבן_לקורבן",
        )

    # ---------------------------------------------------------------
    # 5. אלוהים spelling
    # ---------------------------------------------------------------

    value = base

    value = value.replace(
        "א-לוהים",
        "אלוהים",
    )

    value = value.replace(
        "א־לוהים",
        "אלוהים",
    )

    value = value.replace(
        "אלוקים",
        "אלוהים",
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "כתיב_אלוהים",
        )

    # ---------------------------------------------------------------
    # 6. י-ה -> יה
    # ---------------------------------------------------------------

    value = (
        base
        .replace("י-ה", "יה")
        .replace("י־ה", "יה")
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "יה",
        )

    # ---------------------------------------------------------------
    # 7. (אישיות מהתנ"ך) <-> (דמות מקראית)
    # ---------------------------------------------------------------

    value = base.replace(
        '(אישיות מהתנ"ך)',
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
        '(אישיות מהתנ"ך)',
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "דמות_מקראית_לאישיות_מהתנך",
        )

    # ---------------------------------------------------------------
    # 8. אליל -> אל
    #
    # Explicit common inflections first.
    # ---------------------------------------------------------------

    value = base

    value = re.sub(
        r"\bאלילי\b",
        "אלי",
        value,
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

    # ---------------------------------------------------------------
    # 9. Hebrew year apostrophe
    # ---------------------------------------------------------------

    value = re.sub(
        r"\b([א-ת]{2,5})['׳]$",
        lambda m: fix_hebrew_year_final_letter(
            m.group(1)
        ),
        base,
    )

    if value != base:
        add_candidate(
            candidates,
            value,
            "שנת_עברי_אות_סופית",
        )

    return candidates


# ---------------------------------------------------------------------------
# Normalized Wikipedia map
# ---------------------------------------------------------------------------

def build_normalized_map(wikipedia_titles):
    """
    Build:

        hygiene(title) ->
            [(original_title, wikipedia_id), ...]

    Lists are intentional because multiple Wikipedia titles can theoretically
    collapse to the same hygiene key.
    """

    result = {}

    for title, page_id in wikipedia_titles.items():
        key = hygiene_key(title)

        result.setdefault(
            key,
            [],
        ).append(
            (title, page_id)
        )

    return result


# ---------------------------------------------------------------------------
# Hygiene matching
# ---------------------------------------------------------------------------

def find_hygiene_match(title, normalized_map):
    key = hygiene_key(title)

    matches = normalized_map.get(
        key,
        [],
    )

    # Only accept an unambiguous match.
    if len(matches) != 1:
        return None

    original_title, page_id = matches[0]

    # Exact match should already have been handled before this function.
    return (
        original_title,
        page_id,
        "טקסט_היגיינה",
    )


# ---------------------------------------------------------------------------
# Semantic matching
# ---------------------------------------------------------------------------

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

    # Deduplicate.
    unique = {
        (matched_title, page_id): tuple(methods)
        for matched_title, page_id, methods in matches
    }

    # Exactly one distinct Wikipedia target is required.
    if len(unique) != 1:
        return None

    (
        matched_title,
        page_id,
    ), methods = next(
        iter(unique.items())
    )

    return (
        matched_title,
        page_id,
        "+".join(methods),
    )


# ---------------------------------------------------------------------------
# Wikipedia sorting template
# ---------------------------------------------------------------------------

def get_template_title(title):
    """
    Read {{מיון ויקיפדיה|דף=...}} from the Hamichlol page.

    This is intentionally a last-resort API call because it is expensive.
    """

    params = {
        "action": "parse",
        "page": title,
        "prop": "wikitext",
        "format": "json",
    }

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = session.get(
                MECHALOL_API,
                params=params,
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
                r"\{\{\s*מיון\s+ויקיפדיה\s*"
                r"\|\s*דף\s*=\s*([^|}\n]+)",
                wikitext,
            )

            if match:
                return hygiene(
                    match.group(1)
                )

            return None

        except (
            requests.RequestException,
            ValueError,
        ) as exc:

            if attempt >= MAX_RETRIES:
                log(
                    f"ERROR | template lookup | "
                    f"title={title} | "
                    f"failed after {MAX_RETRIES}: {exc}"
                )
                raise

            log(
                f"WARNING | template lookup | "
                f"title={title} | "
                f"attempt={attempt}/{MAX_RETRIES}"
            )

            time.sleep(RETRY_DELAY)

    return None


# ---------------------------------------------------------------------------
# Hamichlol rows
# ---------------------------------------------------------------------------

def iter_mechalol_rows(client):
    """
    Iterate over the entire mechalol_pages table.

    We deliberately select all columns because the upsert writes back the
    complete existing row.
    """

    offset = 0
    batch_number = 0

    while True:
        batch_number += 1

        result = execute_with_retry(
            lambda: (
                client.table("mechalol_pages")
                .select("*")
                .range(
                    offset,
                    offset + BATCH_SIZE - 1,
                )
                .execute()
            ),
            f"MECHALOL batch={batch_number} offset={offset}",
        )

        rows = result.data or []

        if not rows:
            break

        yield rows

        offset += len(rows)

        if len(rows) < BATCH_SIZE:
            break


# ---------------------------------------------------------------------------
# Match type
# ---------------------------------------------------------------------------

def get_match_type(row):
    """
    Determine the match_type based on the source status.

    Translated pages are intentionally treated according to their status
    supplied by fetch_mechalol.py.

    Only pages explicitly marked as created in Hamichlol get the special
    "same title without import relation" value.
    """

    if row.get("status") == "נוצר_במכלול":
        return "כותרת_זהה_בלי_קשר"

    return "מיובא"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    started = time.monotonic()

    client = get_client()

    log("=" * 80)
    log("START | match.py")
    log("=" * 80)

    # ---------------------------------------------------------------
    # Load Wikipedia once.
    # ---------------------------------------------------------------

    log("STAGE 1 | loading Wikipedia titles...")

    wikipedia_titles = load_wikipedia_title_map(
        client
    )

    log(
        f"STAGE 1 DONE | "
        f"Wikipedia titles={len(wikipedia_titles):,}"
    )

    # ---------------------------------------------------------------
    # Build hygiene lookup.
    # ---------------------------------------------------------------

    log("STAGE 2 | building normalized Wikipedia map...")

    normalized_map = build_normalized_map(
        wikipedia_titles
    )

    log(
        f"STAGE 2 DONE | "
        f"normalized keys={len(normalized_map):,}"
    )

    # ---------------------------------------------------------------
    # Counters.
    # ---------------------------------------------------------------

    total = 0
    exact_matches = 0
    hygiene_matches = 0
    semantic_matches = 0
    template_matches = 0
    unmatched = 0
    manual_skipped = 0
    already_checked_skipped = 0

    # ---------------------------------------------------------------
    # Process Hamichlol.
    # ---------------------------------------------------------------

    log("STAGE 3 | matching Hamichlol titles...")

    for batch_number, batch in enumerate(
        iter_mechalol_rows(client),
        1,
    ):
        updates = []

        batch_exact = 0
        batch_hygiene = 0
        batch_semantic = 0
        batch_template = 0
        batch_unmatched = 0

        for row in batch:
            total += 1

            title = row.get("title")

            if not title:
                log(
                    f"WARNING | row id={row.get('id')} "
                    f"has no title; skipped"
                )
                continue

            # -------------------------------------------------------
            # Manual match is authoritative.
            # -------------------------------------------------------

            if row.get("manual_match"):
                manual_skipped += 1
                continue

            # -------------------------------------------------------
            # 1. Exact match.
            #
            # IMPORTANT:
            # Do not reset normalization columns here.
            # A previous normalization result must not be erased.
            # -------------------------------------------------------

            wikipedia_id = wikipedia_titles.get(
                title
            )

            if wikipedia_id is not None:
                updated = dict(row)

                updated["wikipedia_id"] = (
                    wikipedia_id
                )

                updated["match_type"] = (
                    get_match_type(row)
                )

                updated[
                    "maybe_deleted_from_wikipedia"
                ] = False

                updates.append(updated)

                exact_matches += 1
                batch_exact += 1

                continue

            # -------------------------------------------------------
            # If normalization was already completed and no exact
            # match exists, there is nothing more to do.
            # -------------------------------------------------------

            if row.get("normalization_checked"):
                already_checked_skipped += 1
                continue

            # -------------------------------------------------------
            # 2. Text hygiene.
            # -------------------------------------------------------

            hygiene_match = find_hygiene_match(
                title,
                normalized_map,
            )

            if hygiene_match:
                (
                    matched_title,
                    wikipedia_id,
                    method,
                ) = hygiene_match

                updated = dict(row)

                updated["wikipedia_id"] = (
                    wikipedia_id
                )

                updated["match_type"] = (
                    get_match_type(row)
                )

                updated[
                    "normalization_checked"
                ] = True

                updated[
                    "normalization_match"
                ] = True

                updated[
                    "normalization_method"
                ] = method

                updated[
                    "title_normalized"
                ] = matched_title

                updated[
                    "maybe_deleted_from_wikipedia"
                ] = False

                updates.append(updated)

                hygiene_matches += 1
                batch_hygiene += 1

                continue

            # -------------------------------------------------------
            # 3. Semantic normalization.
            # -------------------------------------------------------

            semantic_match = find_semantic_matches(
                title,
                normalized_map,
            )

            if semantic_match:
                (
                    matched_title,
                    wikipedia_id,
                    method,
                ) = semantic_match

                updated = dict(row)

                updated["wikipedia_id"] = (
                    wikipedia_id
                )

                updated["match_type"] = (
                    get_match_type(row)
                )

                updated[
                    "normalization_checked"
                ] = True

                updated[
                    "normalization_match"
                ] = True

                updated[
                    "normalization_method"
                ] = method

                updated[
                    "title_normalized"
                ] = matched_title

                updated[
                    "maybe_deleted_from_wikipedia"
                ] = False

                updates.append(updated)

                semantic_matches += 1
                batch_semantic += 1

                continue

            # -------------------------------------------------------
            # 4. {{מיון ויקיפדיה}}
            #
            # API request only happens here.
            # -------------------------------------------------------

            template_title = get_template_title(
                title
            )

            if template_title:
                template_key = hygiene_key(
                    template_title
                )

                template_candidates = (
                    normalized_map.get(
                        template_key,
                        [],
                    )
                )

                if len(template_candidates) == 1:
                    (
                        matched_title,
                        wikipedia_id,
                    ) = template_candidates[0]

                    updated = dict(row)

                    updated[
                        "wikipedia_id"
                    ] = wikipedia_id

                    updated[
                        "match_type"
                    ] = get_match_type(row)

                    updated[
                        "normalization_checked"
                    ] = True

                    updated[
                        "normalization_match"
                    ] = True

                    updated[
                        "normalization_method"
                    ] = "תבנית_מיון"

                    updated[
                        "title_normalized"
                    ] = matched_title

                    updated[
                        "maybe_deleted_from_wikipedia"
                    ] = False

                    updates.append(updated)

                    template_matches += 1
                    batch_template += 1

                    continue

            # -------------------------------------------------------
            # No match.
            #
            # Mark normalization as completed.
            # Preserve all other existing fields.
            # -------------------------------------------------------

            updated = dict(row)

            updated[
                "normalization_checked"
            ] = True

            updated[
                "normalization_match"
            ] = False

            updated[
                "normalization_method"
            ] = None

            updated[
                "title_normalized"
            ] = None

            updates.append(updated)

            unmatched += 1
            batch_unmatched += 1

        # -----------------------------------------------------------
        # Write complete rows back.
        # -----------------------------------------------------------

        if updates:
            execute_with_retry(
                lambda: (
                    client.table(
                        "mechalol_pages"
                    )
                    .upsert(
                        updates,
                        on_conflict="id",
                    )
                    .execute()
                ),
                f"UPDATE batch={batch_number}",
            )

        # -----------------------------------------------------------
        # Progress log.
        # -----------------------------------------------------------

        matched_total = (
            exact_matches
            + hygiene_matches
            + semantic_matches
            + template_matches
        )

        log(
            f"PROGRESS | "
            f"batch={batch_number} | "
            f"checked={total:,} | "
            f"matched={matched_total:,} | "
            f"exact={exact_matches:,} | "
            f"hygiene={hygiene_matches:,} | "
            f"normalization={semantic_matches:,} | "
            f"template={template_matches:,} | "
            f"unmatched={unmatched:,} | "
            f"manual_skipped={manual_skipped:,} | "
            f"already_checked={already_checked_skipped:,}"
        )

    # ---------------------------------------------------------------
    # Finish.
    # ---------------------------------------------------------------

    elapsed = int(
        time.monotonic() - started
    )

    matched_total = (
        exact_matches
        + hygiene_matches
        + semantic_matches
        + template_matches
    )

    log("=" * 80)

    log(
        f"DONE | "
        f"checked={total:,} | "
        f"matched={matched_total:,} | "
        f"exact={exact_matches:,} | "
        f"hygiene={hygiene_matches:,} | "
        f"normalization={semantic_matches:,} | "
        f"template={template_matches:,} | "
        f"unmatched={unmatched:,}"
    )

    log(
        f"TIME | "
        f"{elapsed // 60}m {elapsed % 60}s"
    )

    log("=" * 80)


if __name__ == "__main__":
    main()
