#!/usr/bin/env python3
"""Append and inspect the shared Consult run history."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterable, Sequence


DEFAULT_BROWSER_HOME = Path.home() / ".codex" / "browser-profiles" / "consult-agbrowse"
HISTORY_FILENAME = "consult-history.jsonl"
SESSION_STORE_FILENAME = "web-ai-sessions.json"
ACTIVE_COMMANDS_FILENAME = "web-ai-active-commands.json"


def browser_home(env: dict[str, str] | os._Environ[str] = os.environ) -> Path:
    configured = env.get("CONSULT_BROWSER_AGENT_HOME") or env.get("BROWSER_AGENT_HOME")
    return Path(configured).expanduser() if configured else DEFAULT_BROWSER_HOME


def history_path(env: dict[str, str] | os._Environ[str] = os.environ) -> Path:
    return browser_home(env) / HISTORY_FILENAME


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def append_event(path: Path, event: dict[str, Any]) -> None:
    """Append one complete event under a process-safe lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    payload = dict(event)
    payload.setdefault("at", now_iso())
    with lock_path.open("a+", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as history_handle:
            history_handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
            history_handle.flush()
            os.fsync(history_handle.fileno())


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"consult history is invalid at {path}:{line_number}") from error
        if isinstance(value, dict) and isinstance(value.get("runId"), str):
            events.append(value)
    return events


def collapse_runs(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    for event in events:
        run_id = event["runId"]
        current = runs.setdefault(run_id, {"runId": run_id})
        current.update({key: value for key, value in event.items() if value is not None})
        current["lastEvent"] = event.get("event")
        current["updatedAt"] = event.get("at") or current.get("updatedAt")
    return sorted(runs.values(), key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


def resolve_run(runs: Sequence[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    needle = query.casefold().strip()
    exact = [run for run in runs if needle in {
        str(run.get("runId") or "").casefold(),
        str(run.get("sessionId") or "").casefold(),
        str(run.get("requestedSessionId") or "").casefold(),
    }]
    if exact:
        return exact
    return [run for run in runs if needle in str(run.get("topic") or "").casefold()]


def read_session_store(home: Path) -> list[dict[str, Any]]:
    store_path = home / SESSION_STORE_FILENAME
    if not store_path.exists():
        return []
    try:
        payload = json.loads(store_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    sessions = payload.get("sessions") if isinstance(payload, dict) else None
    return [session for session in sessions if isinstance(session, dict)] if isinstance(sessions, list) else []


def enrich_runs(home: Path, runs: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    sessions = {session.get("sessionId"): session for session in read_session_store(home)}
    active_path = home / ACTIVE_COMMANDS_FILENAME
    try:
        active_payload = json.loads(active_path.read_text(encoding="utf-8")) if active_path.exists() else {}
    except json.JSONDecodeError:
        active_payload = {}
    commands = active_payload.get("commands") if isinstance(active_payload, dict) else None
    live_commands = [
        command for command in commands or []
        if isinstance(command, dict) and command.get("status") == "running"
    ]
    enriched = []
    for run in runs:
        current = dict(run)
        session = sessions.get(run.get("sessionId"))
        if session:
            current.update({
                "providerStatus": session.get("status"),
                "providerUpdatedAt": session.get("updatedAt"),
                "providerLastError": session.get("lastError"),
                "providerResponseChars": session.get("lastResponseCharCount"),
                "conversationUrl": session.get("conversationUrl") or current.get("conversationUrl"),
            })
        command = next((item for item in live_commands if item.get("sessionId") in {
            run.get("sessionId"), run.get("requestedSessionId"),
        }), None)
        if command:
            current.update({
                "runtimeStatus": "running",
                "runtimeCommand": command.get("command"),
                "runtimeHeartbeatAt": command.get("heartbeatAt"),
            })
        enriched.append(current)
    return enriched


def session_candidates(home: Path, run: dict[str, Any]) -> list[dict[str, Any]]:
    sessions = read_session_store(home)
    expected_hash = str(run.get("promptHash") or "")
    if expected_hash and not expected_hash.startswith("sha256:"):
        expected_hash = f"sha256:{expected_hash}"
    candidates = []
    for session in sessions:
        if session.get("promptHash") != expected_hash:
            continue
        candidates.append({
            "sessionId": session.get("sessionId"),
            "status": session.get("status"),
            "conversationUrl": session.get("conversationUrl"),
            "createdAt": session.get("createdAt"),
            "updatedAt": session.get("updatedAt"),
            "lastError": session.get("lastError"),
        })
    return sorted(candidates, key=lambda item: str(item.get("createdAt") or ""), reverse=True)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect recent Consult topics and recovery evidence.")
    parser.add_argument("command", choices=("recent", "show", "recover"))
    parser.add_argument("query", nargs="?", default=None, help="Run ID, session ID, or topic substring.")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    try:
        home = browser_home()
        runs = enrich_runs(home, collapse_runs(read_events(history_path())))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2

    if args.command == "recent":
        selected = runs[: max(0, args.limit)]
        result: Any = selected
    else:
        if not args.query:
            print(f"{args.command} requires a run ID, session ID, or topic substring", file=sys.stderr)
            return 2
        selected = resolve_run(runs, args.query)
        if len(selected) != 1:
            print(f"consult run lookup matched {len(selected)} entries; use an exact run or session ID", file=sys.stderr)
            return 3
        result = selected[0]
        if args.command == "recover":
            result = {"run": result, "sessionCandidates": session_candidates(home, result)}

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0

    rows = result if isinstance(result, list) else [result]
    for row in rows:
        if "run" in row:
            run = row["run"]
            display_status = run.get("runtimeStatus") or run.get("providerStatus") or run.get("status")
            print(f"{run.get('runId')}\t{display_status}\t{run.get('topic')}")
            for candidate in row.get("sessionCandidates", []):
                print(f"  {candidate.get('sessionId')}\t{candidate.get('status')}\t{candidate.get('conversationUrl')}")
        else:
            display_status = row.get("runtimeStatus") or row.get("providerStatus") or row.get("status")
            print(f"{row.get('runId')}\t{display_status}\t{row.get('topic')}\t{row.get('sessionId') or '-'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
