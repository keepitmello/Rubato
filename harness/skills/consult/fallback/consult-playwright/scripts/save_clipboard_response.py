#!/usr/bin/env python3
"""Save a copied ChatGPT web answer from the system clipboard.

This script does not automate the browser and does not call any API. The coding
agent should first use computer use to click ChatGPT's visible copy button for
the final answer, then run this script to persist the clipboard text.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Sequence


def clipboard_read_command() -> list[str] | None:
    if shutil.which("pbpaste"):
        return ["pbpaste"]
    if shutil.which("wl-paste"):
        return ["wl-paste"]
    if shutil.which("xclip"):
        return ["xclip", "-selection", "clipboard", "-o"]
    if shutil.which("xsel"):
        return ["xsel", "--clipboard", "--output"]
    if os.name == "nt" and shutil.which("powershell"):
        return ["powershell", "-NoProfile", "-Command", "Get-Clipboard"]
    if os.name == "nt" and shutil.which("pwsh"):
        return ["pwsh", "-NoProfile", "-Command", "Get-Clipboard"]
    return None


def read_clipboard() -> str:
    cmd = clipboard_read_command()
    if not cmd:
        raise RuntimeError("no supported clipboard read command found: expected pbpaste, wl-paste, xclip, xsel, or PowerShell")
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        stderr_body = proc.stderr.rstrip("\r\n")
        raise RuntimeError(f"clipboard read failed ({' '.join(cmd)}): {stderr_body}")
    return proc.stdout


def build_document(content: str, source: str, browser: str, model: str, packet: str) -> str:
    captured = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    content_body = content.rstrip("\r\n")
    return f"""# GPT Consult Response

- Captured: `{captured}`
- Source: {source}
- Browser/app used: {browser or 'unknown'}
- Model/mode selected: {model or 'unknown visible ChatGPT mode'}
- Packet: `{packet}`

---

{content_body}
"""


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Save copied ChatGPT web response from clipboard to Markdown.")
    parser.add_argument("--output", "-o", default=".consult/consult-response.md", help="Output Markdown path.")
    parser.add_argument("--packet", default=".consult/consult-packet.md", help="Packet path to record in metadata.")
    parser.add_argument("--browser", default="", help="Browser/app used, e.g. Chrome.")
    parser.add_argument("--model", default="", help="Visible model/mode selected, if known.")
    parser.add_argument("--source", default="ChatGPT web manual fallback", help="Source metadata string.")
    parser.add_argument("--min-chars", type=int, default=200, help="Warn if clipboard text is shorter than this.")
    parser.add_argument("--allow-short", action="store_true", help="Allow saving short clipboard contents without failing.")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    try:
        content = read_clipboard()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if not content.strip():
        print("clipboard is empty; copy the ChatGPT answer first", file=sys.stderr)
        return 2

    if len(content.strip()) < args.min_chars and not args.allow_short:
        print(
            f"clipboard is only {len(content.strip())} chars; this may not be the full ChatGPT answer. Rerun with --allow-short to save anyway.",
            file=sys.stderr,
        )
        return 3

    doc = build_document(content, args.source, args.browser, args.model, args.packet)
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    print(f"wrote consult response: {out.resolve()} ({len(doc):,} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
