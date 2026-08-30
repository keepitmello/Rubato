#!/usr/bin/env python3
"""Prepare a ChatGPT web prompt for GPT Consult.

This script is deliberately browser/API agnostic. It only reads the local consult
packet, writes a prompt file, and optionally copies text to the system clipboard
using normal OS clipboard commands. It does not use OpenAI APIs, private
endpoints, browser automation protocols, cookies, or tokens.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Sequence

from consult_prompt_contract import (
    KOREAN_INLINE_PREAMBLE,
    KOREAN_UPLOAD_PREAMBLE,
    add_initial_prompt_contract,
    extract_consult_title,
)

DEFAULT_OUTPUT = ".consult/chatgpt-web-prompt.md"
DEFAULT_UPLOAD_INSTRUCTIONS = ".consult/chatgpt-upload-instructions.md"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def clipboard_command_for_paste() -> list[str] | None:
    if shutil.which("pbcopy"):
        return ["pbcopy"]
    if shutil.which("wl-copy"):
        return ["wl-copy"]
    if shutil.which("xclip"):
        return ["xclip", "-selection", "clipboard"]
    if shutil.which("xsel"):
        return ["xsel", "--clipboard", "--input"]
    if os.name == "nt" and shutil.which("clip"):
        return ["clip"]
    return None


def copy_to_clipboard(text: str) -> None:
    cmd = clipboard_command_for_paste()
    if not cmd:
        raise RuntimeError("no supported clipboard command found: expected pbcopy, wl-copy, xclip, xsel, or clip")
    proc = subprocess.run(
        cmd,
        input=text,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"clipboard command failed ({' '.join(cmd)}): {proc.stderr.strip()}")


def build_full_prompt(
    packet: str,
    source_path: str,
    _model_hint: str,
    title: str | None = None,
) -> str:
    packet_body = packet.rstrip("\r\n")
    prompt = f"""{KOREAN_INLINE_PREAMBLE}

--- 독립형 CONSULT 패킷 시작 ---

{packet_body}

--- 독립형 CONSULT 패킷 끝 ---
"""
    fallback = Path(source_path).stem if source_path else None
    return add_initial_prompt_contract(prompt, extract_consult_title(packet, title, fallback)) + "\n"


def build_upload_instructions(
    packet_path: str,
    _model_hint: str,
    packet: str = "",
    title: str | None = None,
) -> str:
    prompt = KOREAN_UPLOAD_PREAMBLE
    fallback = Path(packet_path).stem if packet_path else None
    return add_initial_prompt_contract(prompt, extract_consult_title(packet, title, fallback)) + "\n"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a ChatGPT web prompt from a GPT consult packet.")
    parser.add_argument("--packet", default=".consult/consult-packet.md", help="Consult packet Markdown file.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Full paste prompt output file.")
    parser.add_argument("--upload-instructions", default=DEFAULT_UPLOAD_INSTRUCTIONS, help="Upload instruction prompt output file.")
    parser.add_argument("--model-hint", default="", help="Deprecated compatibility option; accepted but not added to the prompt.")
    parser.add_argument("--title", default=None, help="Optional short ChatGPT conversation title; otherwise derive it from the packet question.")
    parser.add_argument("--copy", action="store_true", help="Copy the full paste prompt to the system clipboard.")
    parser.add_argument("--copy-upload-instructions", action="store_true", help="Copy only the upload instruction prompt to the system clipboard.")
    parser.add_argument("--warn-chars", type=int, default=120000, help="Warn when the full prompt exceeds this many characters.")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    packet_path = Path(args.packet).expanduser().resolve()
    if not packet_path.exists():
        print(f"packet not found: {packet_path}", file=sys.stderr)
        return 2

    packet = read_text(packet_path)
    full_prompt = build_full_prompt(packet, str(packet_path), args.model_hint, args.title)
    upload_instructions = build_upload_instructions(str(packet_path), args.model_hint, packet, args.title)

    output_path = Path(args.output).expanduser()
    upload_path = Path(args.upload_instructions).expanduser()
    write_text(output_path, full_prompt)
    write_text(upload_path, upload_instructions)

    print(
        f"wrote full ChatGPT web prompt: {output_path.resolve()} "
        f"({len(full_prompt):,} chars, {len(full_prompt.encode('utf-8')):,} UTF-8 bytes)"
    )
    print(
        f"wrote upload instructions: {upload_path.resolve()} "
        f"({len(upload_instructions):,} chars, {len(upload_instructions.encode('utf-8')):,} UTF-8 bytes)"
    )
    if len(full_prompt) > args.warn_chars:
        print(
            f"warning: full prompt is {len(full_prompt):,} chars; if pasting is unreliable, upload {packet_path} and paste {upload_path}",
            file=sys.stderr,
        )

    try:
        if args.copy and args.copy_upload_instructions:
            print("choose only one of --copy or --copy-upload-instructions", file=sys.stderr)
            return 2
        if args.copy:
            copy_to_clipboard(full_prompt)
            print("copied full prompt to clipboard")
        elif args.copy_upload_instructions:
            copy_to_clipboard(upload_instructions)
            print("copied upload instructions to clipboard")
    except RuntimeError as exc:
        print(f"clipboard copy failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
