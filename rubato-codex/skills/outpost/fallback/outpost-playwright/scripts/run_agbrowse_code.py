#!/usr/bin/env python3
"""Run ChatGPT code mode through agbrowse and save generated zip artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any, Sequence
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile

from outpost_runtime import browser_env, chrome_launcher, close_session_tab, stop_chrome_if_idle


DEFAULT_CONFIG = Path.home() / ".codex" / "outpost.env"
DEFAULT_PACKET = ".outpost/outpost-packet.md"
DEFAULT_OUTPUT_ZIP = ".outpost/code-artifacts/outpost-code.zip"
DEFAULT_OUTPUT_DIR = ".outpost/code-artifacts"
DEFAULT_JSON_OUTPUT = ".outpost/agbrowse-code-response.json"
DEFAULT_STDERR_OUTPUT = ".outpost/agbrowse-code-stderr.log"
DEFAULT_SESSION_FILE = ".outpost/agbrowse-code-session.json"
DEFAULT_TRACE_DIR = ".outpost/agbrowse-code-trace"
QUALITY_PRESETS: dict[str, tuple[str, str | None]] = {
    "xhigh": ("thinking", "xhigh"),
    "pro": ("pro", None),
}


def is_work_project_url(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "chatgpt.com"
        and parsed.path.startswith("/g/g-p-")
        and "-work/" in parsed.path
        and (parsed.path.endswith("/project") or "/c/" in parsed.path)
    )


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def read_config_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        if name.strip() != key:
            continue
        value = value.strip()
        if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
            value = value[1:-1]
        return value or None
    return None


def parse_json_or_none(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def write_session_file(path: Path, payload: Any) -> None:
    if not isinstance(payload, dict):
        return
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        return
    record = {
        "sessionId": session_id,
        "conversationUrl": payload.get("url") or payload.get("conversationUrl"),
        "vendor": payload.get("vendor"),
        "status": payload.get("status"),
        "updatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    write_text(path, json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def zip_has_plan(path: Path) -> bool:
    try:
        with ZipFile(path) as archive:
            names = {name.strip("/") for name in archive.namelist()}
            bad_file = archive.testzip()
    except (BadZipFile, OSError):
        return False
    return bad_file is None and ("PLAN.md" in names or "00_plan.md" in names)


def collect_artifact_paths(payload: Any) -> list[Path]:
    paths: list[Path] = []
    if not isinstance(payload, dict):
        return paths
    artifact = payload.get("artifact")
    if isinstance(artifact, dict):
        output_path = artifact.get("outputPath") or artifact.get("path")
        if isinstance(output_path, str):
            paths.append(Path(output_path))
    artifacts = payload.get("artifacts")
    if isinstance(artifacts, list):
        for item in artifacts:
            if not isinstance(item, dict):
                continue
            output_path = item.get("outputPath") or item.get("path")
            if isinstance(output_path, str):
                paths.append(Path(output_path))
    return paths


def build_prompt(args: argparse.Namespace) -> str:
    if args.prompt and args.prompt_file:
        raise ValueError("choose only one of --prompt or --prompt-file")
    if args.prompt_file:
        path = Path(args.prompt_file).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"prompt file not found: {path}")
        return read_text(path).rstrip("\r\n")
    if args.prompt:
        return args.prompt.rstrip("\r\n")
    raise ValueError("code mode requires --prompt or --prompt-file")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run ChatGPT code mode through agbrowse and save zip artifacts.")
    parser.add_argument("--prompt", default=None, help="Build spec for ChatGPT code mode.")
    parser.add_argument("--prompt-file", default=None, help="Read the build spec from a file.")
    parser.add_argument("--packet", default=DEFAULT_PACKET, help="Outpost packet to upload with the build spec when it exists.")
    parser.add_argument("--no-packet", action="store_true", help="Do not upload the outpost packet.")
    parser.add_argument("--file", action="append", default=[], help="Additional file to upload. Can be repeated.")
    parser.add_argument("--output-zip", default=DEFAULT_OUTPUT_ZIP, help="Output path for a single generated zip.")
    parser.add_argument("--multi-zip", action="store_true", help="Retrieve several named zip artifacts.")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Output directory for --multi-zip.")
    parser.add_argument("--json-output", default=DEFAULT_JSON_OUTPUT)
    parser.add_argument("--stderr-output", default=DEFAULT_STDERR_OUTPUT)
    parser.add_argument("--trace-dir", default=DEFAULT_TRACE_DIR)
    parser.add_argument("--session-file", default=DEFAULT_SESSION_FILE)
    parser.add_argument("--url", default=None)
    parser.add_argument("--conversation", default=None, help="Continue a ChatGPT conversation id or URL.")
    parser.add_argument("--session", default=None, help="Continue an agbrowse web-ai session.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--quality", choices=tuple(QUALITY_PRESETS), default=None, help="Required GPT-5.6 code tier: xhigh or pro.")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--context-refresh", action="store_true")
    parser.add_argument("--extract-only", action="store_true", help="Recover zip artifacts from an existing conversation without sending a new prompt.")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.quality is None:
        print("--quality is required; choose exactly xhigh or pro", file=sys.stderr)
        return 2
    selected_model, selected_effort = QUALITY_PRESETS[args.quality]
    if not shutil.which("agbrowse"):
        print("agbrowse not found. Install with: npm install -g agbrowse", file=sys.stderr)
        return 127

    env = browser_env(os.environ)

    json_path = Path(args.json_output).expanduser()
    stderr_path = Path(args.stderr_output).expanduser()
    session_path = Path(args.session_file).expanduser()
    config_url = read_config_value(Path(args.config).expanduser(), "OUTPOST_CHATGPT_URL")
    chatgpt_url = args.url or os.environ.get("OUTPOST_CHATGPT_URL") or config_url
    if not is_work_project_url(chatgpt_url):
        print(
            "outpost Playwright fallback requires a verified ChatGPT Work project URL; "
            "set OUTPOST_CHATGPT_URL or pass --url",
            file=sys.stderr,
        )
        return 2

    if args.extract_only:
        cmd = ["agbrowse", "web-ai", "code-extract", "--vendor", "chatgpt", "--json"]
    else:
        try:
            prompt = build_prompt(args)
        except (FileNotFoundError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
        cmd = [
            "agbrowse", "web-ai", "code",
            "--vendor", "chatgpt",
            "--url", chatgpt_url,
            "--model", selected_model,
            "--timeout", str(args.timeout),
            "--trace-dir", args.trace_dir,
            "--prompt", prompt,
            "--parallel",
            "--json",
        ]
        if selected_effort:
            cmd.extend(["--effort", selected_effort])

    if args.conversation:
        cmd.extend(["--conversation", args.conversation])
    if args.session:
        cmd.extend(["--session", args.session])
    if args.context_refresh:
        cmd.append("--context-refresh")

    if args.multi_zip:
        cmd.extend(["--multi-zip", "--output-dir", args.output_dir])
    else:
        cmd.extend(["--output-zip", args.output_zip])

    if not args.extract_only:
        upload_files = list(args.file)
        packet_path = Path(args.packet).expanduser()
        if not args.no_packet and packet_path.exists():
            upload_files.insert(0, str(packet_path))
        for upload in upload_files:
            cmd.extend(["--file", upload])

    json_path.parent.mkdir(parents=True, exist_ok=True)
    stderr_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [str(chrome_launcher(env)), "--ensure"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"failed to ensure shared Chrome endpoint: {exc}", file=sys.stderr)
        return 75
    with json_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open("w", encoding="utf-8") as stderr_handle:
        proc = subprocess.run(
            cmd,
            stdout=stdout_handle,
            stderr=stderr_handle,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            check=False,
        )
    stdout = read_text(json_path)
    payload = parse_json_or_none(stdout)
    owned_session_id = payload.get("sessionId") if isinstance(payload, dict) else None
    if proc.returncode != 0:
        close_session_tab(owned_session_id, env)
        stop_chrome_if_idle(env)
        print(f"agbrowse code mode failed with exit code {proc.returncode}; see {stderr_path}", file=sys.stderr)
        return proc.returncode

    write_session_file(session_path, payload)
    artifact_paths = collect_artifact_paths(payload)
    missing_plan = [str(path) for path in artifact_paths if not zip_has_plan(path)]
    if missing_plan:
        close_session_tab(owned_session_id, env)
        stop_chrome_if_idle(env)
        print(f"zip verification failed or PLAN.md missing: {', '.join(missing_plan)}", file=sys.stderr)
        return 1

    if artifact_paths:
        print("wrote code artifact(s):")
        for path in artifact_paths:
            print(f"- {path.resolve()}")
    else:
        print(f"agbrowse completed; inspect {json_path.resolve()} for artifact details")
    print(f"wrote agbrowse evidence: {json_path.resolve()}")
    if session_path.exists():
        print(f"saved code session: {session_path.resolve()}")
    close_session_tab(owned_session_id, env)
    stop_chrome_if_idle(env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
