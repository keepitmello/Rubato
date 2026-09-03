#!/usr/bin/env python3
"""Persist and list Aside Consult threads across parallel tabs."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import urlparse


DEFAULT_SESSIONS_PATH = Path.home() / ".codex" / "consult-sessions.json"
CONVERSATION_ID_RE = re.compile(r"/c/([0-9a-fA-F-]{8,})")
STATUS_ORDER = {
    "running": 0,
    "submitted_response_unavailable": 1,
    "finished": 2,
    "failed": 3,
}


class UnknownThreadError(LookupError):
    """No stored thread matched the query."""


class AmbiguousThreadError(LookupError):
    """More than one stored thread matched the query."""


class ThreadBusyError(RuntimeError):
    """Another consult still owns this thread."""


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def conversation_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    match = CONVERSATION_ID_RE.search(url)
    return match.group(1) if match else None


def is_chatgpt_conversation_url(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "chatgpt.com"
        and conversation_id_from_url(value) is not None
    )


def canonical_conversation_url(url: str | None) -> str:
    conversation_id = conversation_id_from_url(url)
    if not conversation_id:
        return (url or "").strip()
    return f"https://chatgpt.com/c/{conversation_id}"


def resolve_sessions_path(cli_value: str | None = None) -> Path:
    raw = cli_value or os.environ.get("CONSULT_SESSIONS_PATH") or str(DEFAULT_SESSIONS_PATH)
    return Path(raw).expanduser()


def pid_alive(pid: int | None) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def empty_store() -> dict[str, Any]:
    return {"version": 1, "threads": []}


def _lock_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".lock")


def _thread_lock_path(path: Path, thread_id: str) -> Path:
    return path.with_name(f"{path.name}.thread-{thread_id}.lock")


class SessionStore:
    """Atomic JSON registry of Consult conversation threads."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return empty_store()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeError(f"consult session store is invalid: {self.path}") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("threads"), list):
            raise RuntimeError(f"consult session store is invalid: {self.path}")
        payload["threads"] = [
            self._repair_thread(thread)
            for thread in payload["threads"]
            if isinstance(thread, dict) and isinstance(thread.get("threadId"), str)
        ]
        return payload

    def write(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        lock_path = _lock_path(self.path)
        tmp_path = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        with lock_path.open("a+", encoding="utf-8") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
            fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, self.path)
            os.chmod(self.path, 0o600)

    def threads(self) -> list[dict[str, Any]]:
        return list(self.read()["threads"])

    def get(self, thread_id: str) -> dict[str, Any] | None:
        for thread in self.threads():
            if thread.get("threadId") == thread_id:
                return thread
        return None

    def resolve(self, query: str) -> dict[str, Any]:
        needle = query.strip()
        if not needle:
            raise UnknownThreadError("thread query is empty")
        as_path = Path(needle).expanduser()
        if as_path.is_file() and as_path.suffix == ".json":
            try:
                evidence = json.loads(as_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise UnknownThreadError(f"result file is unreadable: {as_path}") from error
            for key in ("threadId", "conversationUrl", "id"):
                value = evidence.get(key)
                if isinstance(value, str) and value.strip():
                    try:
                        return self.resolve(value)
                    except UnknownThreadError:
                        continue
            raise UnknownThreadError(f"result file has no stored thread: {as_path}")

        threads = self.threads()
        conversation_id = conversation_id_from_url(needle) or (
            needle if CONVERSATION_ID_RE.fullmatch(needle) else None
        )
        exact = [
            thread
            for thread in threads
            if needle in {
                str(thread.get("threadId") or ""),
                str(thread.get("conversationId") or ""),
                str(thread.get("conversationUrl") or ""),
                canonical_conversation_url(str(thread.get("conversationUrl") or "")),
            }
            or (
                conversation_id
                and conversation_id == (thread.get("conversationId") or conversation_id_from_url(str(thread.get("conversationUrl") or "")))
            )
        ]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            raise AmbiguousThreadError(
                "thread lookup matched "
                + ", ".join(str(thread.get("threadId")) for thread in exact)
            )

        lowered = needle.casefold()
        topics = [
            thread
            for thread in threads
            if lowered in str(thread.get("topic") or "").casefold()
        ]
        if len(topics) == 1:
            return topics[0]
        if len(topics) > 1:
            raise AmbiguousThreadError(
                "topic lookup matched "
                + ", ".join(str(thread.get("threadId")) for thread in topics)
            )
        raise UnknownThreadError(f"no consult thread matches {needle!r}")

    def create_thread(
        self,
        *,
        topic: str,
        quality: str,
        project_name: str,
        consult_id: str,
        packet_path: str = "",
        cwd: str = "",
        pid: int | None = None,
    ) -> dict[str, Any]:
        thread = {
            "threadId": self._new_thread_id(),
            "conversationId": "",
            "conversationUrl": "",
            "topic": topic,
            "projectName": project_name,
            "quality": quality,
            "status": "running",
            "targetId": "",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "cwd": cwd,
            "pid": pid or os.getpid(),
            "turns": [
                self._new_turn(
                    consult_id=consult_id,
                    topic=topic,
                    quality=quality,
                    mode="new",
                    packet_path=packet_path,
                )
            ],
        }
        payload = self.read()
        payload["threads"].append(thread)
        self.write(payload)
        return thread

    def adopt_conversation(
        self,
        *,
        conversation_url: str,
        topic: str,
        quality: str,
        project_name: str,
        consult_id: str,
        packet_path: str = "",
        cwd: str = "",
        pid: int | None = None,
    ) -> dict[str, Any]:
        if not is_chatgpt_conversation_url(conversation_url):
            raise ValueError("a chatgpt.com /c/ conversation URL is required")
        try:
            existing = self.resolve(conversation_url)
        except UnknownThreadError:
            existing = None
        if existing is not None:
            return self.start_turn(
                existing["threadId"],
                consult_id=consult_id,
                topic=topic,
                quality=quality,
                mode="continue",
                packet_path=packet_path,
                pid=pid,
            )
        thread = {
            "threadId": self._new_thread_id(),
            "conversationId": conversation_id_from_url(conversation_url) or "",
            "conversationUrl": canonical_conversation_url(conversation_url),
            "topic": topic,
            "projectName": project_name,
            "quality": quality,
            "status": "running",
            "targetId": "",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "cwd": cwd,
            "pid": pid or os.getpid(),
            "turns": [
                self._new_turn(
                    consult_id=consult_id,
                    topic=topic,
                    quality=quality,
                    mode="continue",
                    packet_path=packet_path,
                )
            ],
        }
        payload = self.read()
        payload["threads"].append(thread)
        self.write(payload)
        return thread

    def start_turn(
        self,
        thread_id: str,
        *,
        consult_id: str,
        topic: str,
        quality: str,
        mode: str,
        packet_path: str = "",
        pid: int | None = None,
    ) -> dict[str, Any]:
        def mutate(thread: dict[str, Any]) -> None:
            if thread.get("status") == "running" and pid_alive(thread.get("pid")):
                if thread.get("pid") != (pid or os.getpid()):
                    raise ThreadBusyError(
                        f"thread {thread_id} is already running (pid {thread.get('pid')})"
                    )
            thread["status"] = "running"
            thread["topic"] = topic or thread.get("topic") or ""
            thread["quality"] = quality or thread.get("quality") or ""
            thread["pid"] = pid or os.getpid()
            thread["updatedAt"] = now_iso()
            thread.setdefault("turns", []).append(
                self._new_turn(
                    consult_id=consult_id,
                    topic=topic,
                    quality=quality,
                    mode=mode,
                    packet_path=packet_path,
                )
            )

        return self._update(thread_id, mutate)

    def mark_submitted(
        self,
        thread_id: str,
        *,
        conversation_url: str | None,
        target_id: str | None = None,
        consult_id: str | None = None,
    ) -> dict[str, Any]:
        def mutate(thread: dict[str, Any]) -> None:
            if conversation_url:
                thread["conversationUrl"] = conversation_url
                thread["conversationId"] = conversation_id_from_url(conversation_url) or thread.get("conversationId") or ""
            if target_id:
                thread["targetId"] = target_id
            thread["updatedAt"] = now_iso()
            turn = self._latest_turn(thread, consult_id)
            if turn is not None:
                turn["status"] = "submitted"

        return self._update(thread_id, mutate)

    def finish_turn(
        self,
        thread_id: str,
        *,
        status: str,
        consult_id: str | None = None,
        conversation_url: str | None = None,
        target_id: str | None = None,
        response_output: str = "",
        json_output: str = "",
        submit_elapsed_seconds: float | None = None,
    ) -> dict[str, Any]:
        def mutate(thread: dict[str, Any]) -> None:
            if conversation_url:
                thread["conversationUrl"] = conversation_url
                thread["conversationId"] = conversation_id_from_url(conversation_url) or thread.get("conversationId") or ""
            if target_id:
                thread["targetId"] = target_id
            thread["status"] = status
            thread["pid"] = None
            thread["updatedAt"] = now_iso()
            turn = self._latest_turn(thread, consult_id)
            if turn is not None:
                turn["status"] = status
                turn["finishedAt"] = now_iso()
                if response_output:
                    turn["responseOutput"] = response_output
                if json_output:
                    turn["jsonOutput"] = json_output
                if submit_elapsed_seconds is not None:
                    turn["submitElapsedSeconds"] = submit_elapsed_seconds

        return self._update(thread_id, mutate)

    def listed_threads(self, *, limit: int = 20) -> list[dict[str, Any]]:
        payload = self.read()
        repaired = [self._repair_thread(dict(thread)) for thread in payload["threads"]]
        if repaired != payload["threads"]:
            payload["threads"] = repaired
            self.write(payload)
        repaired.sort(key=lambda thread: str(thread.get("updatedAt") or ""), reverse=True)
        repaired.sort(key=lambda thread: STATUS_ORDER.get(str(thread.get("status") or "failed"), 9))
        return repaired[: max(0, limit)]

    def thread_lock(self, thread_id: str) -> "ThreadLock":
        return ThreadLock(_thread_lock_path(self.path, thread_id), thread_id)

    def _update(self, thread_id: str, mutate) -> dict[str, Any]:
        payload = self.read()
        for thread in payload["threads"]:
            if thread.get("threadId") != thread_id:
                continue
            mutate(thread)
            self.write(payload)
            return thread
        raise UnknownThreadError(f"no consult thread matches {thread_id!r}")

    def _new_thread_id(self) -> str:
        existing = {str(thread.get("threadId") or "") for thread in self.threads()}
        for _attempt in range(16):
            candidate = os.urandom(4).hex()
            if candidate not in existing:
                return candidate
        raise RuntimeError("could not allocate a unique consult thread id")

    def _repair_thread(self, thread: dict[str, Any]) -> dict[str, Any]:
        current = dict(thread)
        if current.get("status") == "running" and not pid_alive(current.get("pid")):
            current["status"] = "failed"
            current["pid"] = None
            turns = current.get("turns")
            if isinstance(turns, list) and turns:
                last = turns[-1]
                if isinstance(last, dict) and last.get("status") in {"running", "submitted"}:
                    last = dict(last)
                    last["status"] = "failed"
                    turns[-1] = last
        if current.get("conversationUrl") and not current.get("conversationId"):
            current["conversationId"] = conversation_id_from_url(str(current["conversationUrl"])) or ""
        return current

    @staticmethod
    def _new_turn(
        *,
        consult_id: str,
        topic: str,
        quality: str,
        mode: str,
        packet_path: str,
    ) -> dict[str, Any]:
        return {
            "id": consult_id,
            "topic": topic,
            "quality": quality,
            "status": "running",
            "mode": mode,
            "packetPath": packet_path,
            "responseOutput": "",
            "jsonOutput": "",
            "startedAt": now_iso(),
            "finishedAt": "",
        }

    @staticmethod
    def _latest_turn(thread: dict[str, Any], consult_id: str | None) -> dict[str, Any] | None:
        turns = thread.get("turns")
        if not isinstance(turns, list) or not turns:
            return None
        if consult_id:
            for turn in reversed(turns):
                if isinstance(turn, dict) and turn.get("id") == consult_id:
                    return turn
        last = turns[-1]
        return last if isinstance(last, dict) else None


class ThreadLock:
    def __init__(self, path: Path, thread_id: str) -> None:
        self.path = path
        self.thread_id = thread_id
        self._handle = None

    def __enter__(self) -> "ThreadLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._handle = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self._handle.close()
            self._handle = None
            raise ThreadBusyError(f"thread {self.thread_id} is already running") from error
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._handle is None:
            return
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None


def format_threads(threads: list[dict[str, Any]], *, as_json: bool = False) -> str:
    if as_json:
        return json.dumps(threads, ensure_ascii=False, indent=2)
    if not threads:
        return "no consult threads"
    lines = ["THREAD\tSTATUS\tTURNS\tQUALITY\tTOPIC\tCONVERSATION"]
    for thread in threads:
        turns = thread.get("turns") if isinstance(thread.get("turns"), list) else []
        lines.append(
            "\t".join(
                [
                    str(thread.get("threadId") or "-"),
                    str(thread.get("status") or "-"),
                    str(len(turns)),
                    str(thread.get("quality") or "-"),
                    str(thread.get("topic") or "-"),
                    str(thread.get("conversationUrl") or "-"),
                ]
            )
        )
    return "\n".join(lines)


def print_list(*, path: Path, as_json: bool = False, limit: int = 20) -> int:
    try:
        store = SessionStore(path)
        text = format_threads(store.listed_threads(limit=limit), as_json=as_json)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(text)
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="List and inspect Aside Consult threads.")
    parser.add_argument("command", choices=("list", "show"), nargs="?", default="list")
    parser.add_argument("query", nargs="?", default=None)
    parser.add_argument("--sessions-file", default=None)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(argv) if argv is not None else sys.argv[1:])
    path = resolve_sessions_path(args.sessions_file)
    store = SessionStore(path)
    if args.command == "list":
        return print_list(path=path, as_json=args.json, limit=args.limit)
    if not args.query:
        print("show requires a thread id, conversation URL, or topic", file=sys.stderr)
        return 2
    try:
        thread = store.resolve(args.query)
    except UnknownThreadError as error:
        print(str(error), file=sys.stderr)
        return 2
    except AmbiguousThreadError as error:
        print(str(error), file=sys.stderr)
        return 3
    print(json.dumps(thread, ensure_ascii=False, indent=2) if args.json else format_threads([thread]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
