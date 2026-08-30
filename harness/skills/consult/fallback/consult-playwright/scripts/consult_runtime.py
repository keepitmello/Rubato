"""Single-browser runtime contract shared by Consult helpers."""

from __future__ import annotations

import os
import json
from pathlib import Path
import subprocess
from typing import Mapping


CDP_PORT = "9222"
DEFAULT_BROWSER_AGENT_HOME = Path.home() / ".codex" / "browser-profiles" / "consult-agbrowse"
DEFAULT_CHROME_LAUNCHER = Path(__file__).with_name("ensure_consult_chrome.py")


def browser_agent_home(source: Mapping[str, str] | None = None) -> Path:
    values = source if source is not None else os.environ
    configured = values.get("CONSULT_BROWSER_AGENT_HOME")
    return Path(configured).expanduser() if configured else DEFAULT_BROWSER_AGENT_HOME


def chrome_launcher(source: Mapping[str, str] | None = None) -> Path:
    values = source if source is not None else os.environ
    configured = values.get("CONSULT_CHROME_LAUNCHER")
    return Path(configured).expanduser() if configured else DEFAULT_CHROME_LAUNCHER


def browser_env(source: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(source if source is not None else os.environ)
    env["BROWSER_AGENT_HOME"] = str(browser_agent_home(env))
    env["CDP_PORT"] = CDP_PORT
    env["AGBROWSE_WEB_AI_AUTO_START"] = "0"
    env.setdefault("AGBROWSE_HEAVY_SITE_COMPAT", "1")
    return env


def close_session_tab(session_id: str | None, env: Mapping[str, str]) -> None:
    """Close only the provider tab owned by this completed invocation."""
    if not session_id:
        return
    try:
        shown = subprocess.run(
            ["agbrowse", "web-ai", "sessions", "show", session_id, "--json"],
            check=True,
            capture_output=True,
            text=True,
            env=dict(env),
            timeout=10,
        )
        payload = json.loads(shown.stdout)
        target_id = payload.get("session", {}).get("targetId")
        if isinstance(target_id, str) and target_id:
            subprocess.run(
                ["agbrowse", "tab-close", target_id],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=dict(env),
                timeout=10,
            )
    except (OSError, ValueError, subprocess.SubprocessError):
        pass


def stop_chrome_if_idle(env: Mapping[str, str]) -> None:
    try:
        subprocess.run(
            [str(chrome_launcher(env)), "--hide-if-idle"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=dict(env),
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass
