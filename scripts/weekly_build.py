"""Weekly reconciliation with durable recovery checkpoints.

Requires migrations/20261004164955_weekly_build_state.sql. Run with --resume
to continue the recorded build; --check-writable guards other shared writers.
The existing swap RPC remains available for legacy/manual use, but must never
be invoked directly while a recorded build is unfinished.
"""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timezone

from mechalol_api import log
from supabase_client import execute_with_retry, get_client

PHASES = ("building", "matched", "ready", "swapped", "source_recomputed",
          "audited", "cleaned", "classified", "complete")
SCRIPTS = Path(__file__).resolve().parent


def load_state(client):
    rows = execute_with_retry(
        lambda: client.table("weekly_build_state").select("*").eq("singleton", True).execute(),
        "weekly_build_state", log_fn=log,
    ).data or []
    return rows[0] if rows else None


def check_writable(client):
    try:
        state = load_state(client)
    except Exception as exc:
        # Rolling deployment: ordinary writers still work before the migration.
        # All other failures must stop the writer, including unavailable DB/API.
        if getattr(exc, "code", None) in {"42P01", "PGRST205"}:
            log("weekly_build_state not installed yet; continuing existing writer")
            return
        raise
    if state and state["phase"] in {"swapped", "source_recomputed", "audited"}:
        raise RuntimeError(
            f"Weekly build {state['build_id']} is {state['phase']}. "
            "Resume weekly reconciliation before running other writers."
        )


def rpc_state(client, name, params):
    # These RPCs are idempotent for the same build_id/step, including swap.
    data = execute_with_retry(lambda: client.rpc(name, params).execute(), name, log_fn=log).data
    state = data[0] if isinstance(data, list) and data else data
    if not isinstance(state, dict) or state.get("phase") not in PHASES:
        raise RuntimeError(f"{name} returned no valid build state")
    log(f"Weekly build {state['build_id']} | {state['phase']} | audit_id={state.get('audit_id')}")
    return state


def run_script(name, *args, temp=False, optional=False):
    env = os.environ.copy()
    # Caller environment cannot accidentally send the delta to the mirror.
    env.pop("TARGET_TABLE_SUFFIX", None)
    if temp:
        env["TARGET_TABLE_SUFFIX"] = "_temp"
    log(f"RUN | {name} {' '.join(map(str, args))}")
    result = subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)],
                            cwd=SCRIPTS, env=env, check=False)
    if result.returncode:
        if optional:
            log(f"WARNING | {name} failed ({result.returncode}); continuing")
        else:
            raise subprocess.CalledProcessError(result.returncode, result.args)


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def timing_windows(state, fetch_finished):
    """חלון לכל אתר: מנקודת הדלתא השמורה של הבנייה עד סיום השליפה בפועל (None = עד עכשיו)."""
    windows = {}
    for side, start in (state.get("delta_watermarks") or {}).items():
        if side in ("wikipedia", "mechalol"):
            start_dt = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
            windows[side] = (start_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), fetch_finished.get(side))
    return windows


def build(client, source="dump", resume=False, runner=run_script):
    if resume:
        state = load_state(client)
        if not state or state["phase"] == "building":
            raise RuntimeError("No fully matched build to resume. Start a fresh weekly build.")
        if state["phase"] not in PHASES:
            raise RuntimeError(f"Unknown build phase: {state['phase']}")
        if state["phase"] == "complete":
            log("Weekly build already complete; nothing to resume")
            return state
        # Validate the stored physical identities before executing any script.
        state = rpc_state(client, "advance_weekly_build", {
            "p_build_id": state["build_id"], "p_step": state["phase"],
        })
    else:
        state = rpc_state(client, "begin_weekly_build", {"p_build_id": str(uuid.uuid4())})

    fetch_finished = {}  # בהמשך (resume) אחרי השליפה חסר: חלון התזמון נפתח עד עכשיו (קירוב)

    def advance(phase):
        nonlocal state
        state = rpc_state(client, "advance_weekly_build", {
            "p_build_id": state["build_id"], "p_step": phase,
        })

    if state["phase"] == "building":
        runner("fetch_mechalol_delta.py", "--defer-watermark")
        runner("fetch_wikipedia_delta.py", "--defer-watermark")
        runner("match.py", "--scoped", "--login")
        runner("advance_delta_watermarks.py")
        runner("log_db_size.py", "before_fetch", optional=True)
        # Wikipedia fetch clears both mirrors: it must precede Mechalol fetch.
        runner("fetch_wikipedia.py", "--source", source, temp=True)
        fetch_finished["wikipedia"] = iso_now()
        runner("fetch_mechalol.py", temp=True)
        fetch_finished["mechalol"] = iso_now()
        runner("match.py", "--login", temp=True)
        advance("matched")

    if state["phase"] in {"matched", "ready"}:
        # Always revalidate on a pre-swap resume, even if a previous gate passed.
        runner("forward_fill_enrichment.py")
        runner("log_db_size.py", "peak_before_swap", optional=True)
        runner("validate_before_swap.py")
        advance("ready")
        advance("swapped")
    if state["phase"] == "swapped":
        runner("recompute_source_state_all.py")
        advance("source_recomputed")
    if state["phase"] == "source_recomputed":
        advance("audited")
    if state["phase"] == "audited":
        from log_reconciliation_diff import record_full_diff

        # Measurement only and non-blocking (its own statement, own timeout): it must run before cleanup,
        # which discards the previous tables it compares against, but a failure must not block the build.
        record_full_diff(client, state["audit_id"], windows=timing_windows(state, fetch_finished))
        advance("cleaned")
        runner("log_db_size.py", "after_truncate", optional=True)
    if state["phase"] == "cleaned":
        from log_reconciliation_diff import classify_timing, _parse_ts

        watermarks = {k: _parse_ts(v) for k, v in state["delta_watermarks"].items()}
        classify_timing(client, state["audit_id"], watermarks=watermarks)
        advance("classified")
    if state["phase"] == "classified":
        runner("rev_link_scan.py", "--recheck", optional=True)
        runner("refresh_maintenance_tables.py", "--dry-run", optional=True)
        advance("complete")
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("dump", "api"), default="dump")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--check-writable", action="store_true")
    args = parser.parse_args()
    client = get_client()
    if args.check_writable:
        check_writable(client)
    else:
        build(client, args.source, args.resume)


if __name__ == "__main__":
    main()
