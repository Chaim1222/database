"""V1: move candidates -> current template -> Wikipedia revision identity -> small proof table.

Only a complete, fresh positive result can suppress a historical-name candidate.
Does not change mirror links, rename history, or revision-task findings.
"""
import argparse
from datetime import datetime, timezone

from sort_template import parse_sort_template
from normalize import hygiene


def proof_of(row, fetched, resolved):
    proof = {"mechalol_id": row["id"], "mechalol_rev_id": None,
             "source_rev_id": None, "source_wikipedia_id": None}
    if not isinstance(fetched, dict):
        return proof
    parsed = parse_sort_template(fetched["content"])
    if (not parsed or not parsed["title"] or not parsed["rev"]
            or fetched["rev_id"] != row.get("rev_id")
            or row.get("sort_template_parsed_rev") != row.get("rev_id")
            or parsed["rev"] != row.get("sort_template_rev")):
        return proof
    source = resolved.get(parsed["rev"])
    if (not source or source["ns"] != 0 or source["redirect"]
            or hygiene(parsed["title"]) != hygiene(source["title"])):
        return proof
    proof.update(mechalol_rev_id=fetched["rev_id"], source_rev_id=parsed["rev"],
                 source_wikipedia_id=source["page_id"])
    return proof


def strict_revision_get(get, params):
    """Missing/invalid revisions are explicit; omitted replies are failures."""
    data = get(params)
    query = data.get("query") if isinstance(data, dict) else None
    if not isinstance(query, dict) or not isinstance(query.get("pages"), list) or "error" in data:
        raise RuntimeError("Incomplete Wikipedia move-source response")
    requested = {int(r) for r in params["revids"].split("|")}
    answered = set()
    for page in query["pages"]:
        if not isinstance(page, dict):
            raise RuntimeError("Malformed Wikipedia page")
        for rev in page.get("revisions", []):
            rid = rev.get("revid") if isinstance(rev, dict) else None
            if (rid not in requested or rid in answered or not isinstance(page.get("pageid"), int)
                    or page["pageid"] <= 0 or not isinstance(page.get("ns"), int)):
                raise RuntimeError("Malformed Wikipedia revision identity")
            answered.add(rid)
    bad = query.get("badrevids", {})
    if not isinstance(bad, dict):
        raise RuntimeError("Malformed badrevids response")
    answered.update(int(r) for r in bad if str(r).isdigit())
    if answered != requested:
        raise RuntimeError("Wikipedia omitted a requested source revision")
    return data


def check(client, fetch_contents, resolve, dry_run=False):
    from supabase_client import execute_with_retry
    from fetch_sort_templates import chunks

    def read(operation):
        rows = execute_with_retry(operation, "move source read").data
        if not isinstance(rows, list):
            raise RuntimeError("Malformed move-source database response")
        return rows

    ids, after = set(), 0
    while True:
        rows = read(lambda: client.table("report_wikipedia_move_candidates")
                    .select("id").gt("id", after).order("id").limit(1000).execute())
        if not rows:
            break
        ids.update(r["id"] for r in rows)
        after = rows[-1]["id"]
    checked = proven = 0
    for part in chunks(sorted(ids), 50):
        rows = read(lambda: client.table("mechalol_pages")
                    .select("id,rev_id,sort_template_rev,sort_template_parsed_rev")
                    .in_("id", part).execute())
        fetched = fetch_contents([r["id"] for r in rows])
        revs = {r["sort_template_rev"] for r in rows if r.get("sort_template_rev")
                and r["sort_template_rev"] > 1}
        resolved = resolve(sorted(revs)) if revs else {}
        proofs = [proof_of(r, fetched.get(r["id"]), resolved) for r in rows]
        for proof in proofs:
            proof["checked_at"] = datetime.now(timezone.utc).isoformat()
        checked += len(proofs)
        proven += sum(p["source_wikipedia_id"] is not None for p in proofs)
        if proofs and not dry_run:
            execute_with_retry(lambda: client.table("maintenance_move_sources")
                               .upsert(proofs, on_conflict="mechalol_id").execute(), "move source proofs")
    return checked, proven


def main():
    from fetch_sort_templates import fetch_contents
    from fetch_wikipedia_revisions import wikipedia_get
    from mechalol_api import login, log
    from rev_match import resolve_many
    from supabase_client import get_client

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    login()
    checked, proven = check(get_client(), fetch_contents,
                           lambda revs: resolve_many(lambda p: strict_revision_get(wikipedia_get, p), revs),
                           args.dry_run)
    log(f"Move sources | checked={checked} | proven={proven} | dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
