import os
import time
import requests
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_KEY
)

WIKIPEDIA_API = "https://he.wikipedia.org/w/api.php"

BATCH_SIZE = 50
SLEEP_BETWEEN_BATCHES = 0.5

session = requests.Session()

session.headers.update({
    "User-Agent": "MechalolImportVerifier/1.0"
})


def get_suspects():

    result = (
        supabase
        .table("mechalol_import_suspects")
        .select("id,title")
        .is_("api_status", "null")
        .order("id")
        .limit(BATCH_SIZE)
        .execute()
    )

    return result.data or []


def check_titles(titles):

    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",

        "titles": "|".join(titles),

        "redirects": "1",
        "converttitles": "1",

        "prop": "info",

        "inprop": "url",

        "iwurl": "1"
    }

    response = session.get(
        WIKIPEDIA_API,
        params=params,
        timeout=30
    )

    response.raise_for_status()

    return response.json()


def build_results(rows, data):

    pages = data.get("query", {}).get("pages", [])

    normalized = {
        x["from"]: x["to"]
        for x in data.get("query", {}).get("normalized", [])
    }

    redirects = {
        x["from"]: x["to"]
        for x in data.get("query", {}).get("redirects", [])
    }

    by_title = {}

    for page in pages:

        title = page.get("title")

        by_title[title] = page

    results = []

    for row in rows:

        original = row["title"]

        # Wikipedia may have normalized the title
        normalized_title = normalized.get(original)

        target_title = normalized_title or original

        page = by_title.get(target_title)

        if page and not page.get("missing", False):

            is_redirect = page.get("redirect", False)

            redirect_target = None

            if original in redirects:
                redirect_target = redirects[original]

            results.append({
                "id": row["id"],
                "api_status": "checked",

                "verification_result":
                    "redirect"
                    if is_redirect
                    else (
                        "normalized_match"
                        if normalized_title
                        else "exact_match"
                    ),

                "wikipedia_page_id":
                    page.get("pageid"),

                "wikipedia_found_title":
                    page.get("title"),

                "wikipedia_normalized_from":
                    original
                    if normalized_title
                    else None,

                "wikipedia_is_redirect":
                    bool(is_redirect),

                "wikipedia_redirect_target":
                    redirect_target
            })

        else:

            results.append({
                "id": row["id"],
                "api_status": "checked",

                "verification_result":
                    "not_found_currently",

                "wikipedia_page_id": None,
                "wikipedia_found_title": None,
                "wikipedia_normalized_from": None,
                "wikipedia_is_redirect": False,
                "wikipedia_redirect_target": None
            })

    return results


def save_result(result):

    update = {
        "api_status": result["api_status"],
        "verification_result": result["verification_result"],
        "wikipedia_page_id": result["wikipedia_page_id"],
        "wikipedia_found_title": result["wikipedia_found_title"],
        "wikipedia_normalized_from":
            result["wikipedia_normalized_from"],
        "wikipedia_is_redirect":
            result["wikipedia_is_redirect"],
        "wikipedia_redirect_target":
            result["wikipedia_redirect_target"],
        "api_checked_at": "now()"
    }

    # Supabase REST does not evaluate now() in JSON,
    # so remove it and let the DB default/function handle time.
    update.pop("api_checked_at")

    (
        supabase
        .table("mechalol_import_suspects")
        .update(update)
        .eq("id", result["id"])
        .execute()
    )


def main():

    total_processed = 0

    while True:

        rows = get_suspects()

        if not rows:
            print("DONE")
            break

        titles = [
            row["title"]
            for row in rows
        ]

        try:

            data = check_titles(titles)

            results = build_results(
                rows,
                data
            )

            for result in results:
                save_result(result)

            total_processed += len(results)

            print(
                f"Processed: {total_processed}"
            )

        except Exception as e:

            print(
                "BATCH ERROR:",
                repr(e)
            )

            # Do not mark the batch as checked.
            # It will be retried.
            time.sleep(5)

        time.sleep(
            SLEEP_BETWEEN_BATCHES
        )


if __name__ == "__main__":
    main()
