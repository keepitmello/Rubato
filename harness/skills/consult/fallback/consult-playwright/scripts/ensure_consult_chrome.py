#!/usr/bin/env python3
"""Own the single headed Chrome process shared by local browser automation."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

from consult_runtime import CDP_PORT, browser_agent_home


ENSURE_TIMEOUT_SECONDS = 15
STOP_TIMEOUT_SECONDS = 3
CHROME_BINARY = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def endpoint_json(path: str) -> object | None:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{CDP_PORT}{path}", timeout=0.5
        ) as response:
            return json.load(response)
    except Exception:
        return None


def endpoint_ready() -> bool:
    return isinstance(endpoint_json("/json/version"), dict)


def owner_pid() -> int | None:
    try:
        output = subprocess.run(
            ["/usr/sbin/lsof", f"-tiTCP:{CDP_PORT}", "-sTCP:LISTEN"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        return int(output[0]) if output else None
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def owner_command(pid: int | None = None) -> str:
    pid = pid or owner_pid()
    if pid is None:
        return ""
    try:
        return subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "command="],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def endpoint_uses_profile(profile: Path) -> bool:
    command = owner_command()
    return (
        f"--remote-debugging-port={CDP_PORT}" in command
        and f"--user-data-dir={profile.resolve()}" in command
    )


def nonblank_page_count() -> int:
    pages = endpoint_json("/json/list")
    if not isinstance(pages, list):
        return 0
    return sum(
        1
        for page in pages
        if isinstance(page, dict)
        and page.get("type") == "page"
        and page.get("url") not in {None, "", "about:blank"}
    )


def stop_owner(profile: Path) -> bool:
    pid = owner_pid()
    if pid is None:
        return True
    if not endpoint_uses_profile(profile):
        print(
            f"refusing to stop unexpected owner of CDP port {CDP_PORT}: {owner_command(pid)}",
            file=sys.stderr,
        )
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return True


def launch_owner(profile: Path, log_path: Path) -> None:
    chrome = Path(os.environ.get("CONSULT_CHROME_BIN", str(CHROME_BINARY))).expanduser()
    if not chrome.is_file():
        raise FileNotFoundError(f"Google Chrome not found: {chrome}")
    profile.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log_handle:
        subprocess.Popen(
            [
                str(chrome),
                "--remote-debugging-address=127.0.0.1",
                f"--remote-debugging-port={CDP_PORT}",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-features=MacAppCodeSignClone,OptimizationGuideOnDeviceModel,OptimizationGuideModelDownloading",
                "about:blank",
            ],
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )


def ensure(profile: Path, log_path: Path) -> int:
    if endpoint_ready():
        if endpoint_uses_profile(profile):
            return 0
        print(
            f"CDP port {CDP_PORT} is owned by a different Chrome profile; expected {profile}",
            file=sys.stderr,
        )
        return 1
    try:
        launch_owner(profile, log_path)
    except FileNotFoundError as error:
        print(str(error), file=sys.stderr)
        return 1
    deadline = time.monotonic() + ENSURE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if endpoint_ready() and endpoint_uses_profile(profile):
            return 0
        time.sleep(0.05)
    print(
        f"Chrome debugging endpoint did not become ready at http://127.0.0.1:{CDP_PORT}; "
        f"see {log_path}",
        file=sys.stderr,
    )
    return 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--ensure", action="store_true")
    actions.add_argument("--hide-if-idle", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    profile = browser_agent_home() / "browser-profile"
    temp = Path(tempfile.gettempdir())
    lock_path = temp / f"consult-chrome-{os.getuid()}-{CDP_PORT}.lock"
    log_path = temp / f"consult-chrome-{os.getuid()}-{CDP_PORT}.log"
    with lock_path.open("a+") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        if args.ensure:
            return ensure(profile, log_path)
        if endpoint_ready() and endpoint_uses_profile(profile) and nonblank_page_count() == 0:
            return 0 if stop_owner(profile) else 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
