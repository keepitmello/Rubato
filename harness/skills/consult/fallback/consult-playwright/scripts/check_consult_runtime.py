#!/usr/bin/env python3
"""Read-only prerequisite and runtime-contract check for a packaged Consult skill."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import urllib.request

from consult_runtime import CDP_PORT, browser_agent_home, chrome_launcher
from ensure_consult_chrome import endpoint_uses_profile


def endpoint_ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1):
            return True
    except Exception:
        return False


def main() -> int:
    chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    launcher = chrome_launcher()
    ready = endpoint_ready()
    expected_owner = endpoint_uses_profile(browser_agent_home() / "browser-profile") if ready else None
    report = {
        "agbrowse": shutil.which("agbrowse"),
        "chrome": str(chrome),
        "chromeExists": chrome.is_file(),
        "launcher": str(launcher),
        "launcherExists": launcher.is_file(),
        "cdpPort": int(CDP_PORT),
        "browserAgentHome": str(browser_agent_home()),
        "profileDir": str(browser_agent_home() / "browser-profile"),
        "endpointReady": ready,
        "endpointUsesExpectedProfile": expected_owner,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    prerequisites = report["agbrowse"] and report["chromeExists"] and report["launcherExists"]
    ownership_ok = not ready or expected_owner is True
    return 0 if prerequisites and ownership_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
