#!/usr/bin/env python3
"""Run Outpost through agbrowse web-ai and save the response."""

from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Sequence
from urllib.parse import urlparse

from outpost_prompt_contract import (
    add_initial_prompt_contract,
    add_response_preference,
    extract_outpost_title,
)
from outpost_history import append_event as append_history_event
from outpost_runtime import (
    CDP_PORT,
    browser_env,
    chrome_launcher,
    close_session_tab,
    stop_chrome_if_idle,
)


PREFERRED_KEYS = (
    "answerText",
    "answer",
    "markdown",
    "content",
    "text",
    "response",
    "message",
)

DEFAULT_CONFIG = Path.home() / ".codex" / "outpost.env"
DEFAULT_SESSION_FILE = ".outpost/agbrowse-outpost-session.json"
DEFAULT_TURNS_FILE = ".outpost/agbrowse-outpost-turns.jsonl"
QUALITY_PRESETS: dict[str, tuple[str, str | None]] = {
    "xhigh": ("thinking", "xhigh"),
    "pro": ("pro", None),
}
# agbrowse reports an unenforced model tier as a *warning* on an otherwise
# successful `status: "sent"` payload, so a outpost can silently run on whatever
# model the tab happened to be showing. These are the phrases it uses when the
# requested tier was not actually applied; the success path instead says things
# like "model selected: pro (already selected)".
MODEL_NOT_ENFORCED_MARKERS = (
    "not enforced",
    "not verified",
    "model selector not found",
)
MODEL_UNAVAILABLE_FALLBACKS = (
    "model-selector-unavailable-current-model",
    "model-verification-unavailable-current-model",
)
MODEL_UNENFORCED_EXIT_CODE = 4
DEFAULT_LOCK_TIMEOUT_SECONDS = 65 * 60


def detect_model_not_enforced(send_payload: object, requested_model: str) -> str | None:
    """Return a human-readable reason when agbrowse did not apply the requested model.

    agbrowse fails *open* on model selection: when it cannot drive the ChatGPT
    model picker it keeps the current model, records a warning, and still returns
    ok/sent. The outpost contract is the opposite - an unverified model is not an
    acceptable fallback - so the wrapper has to read those signals itself.
    """
    if not isinstance(send_payload, dict):
        return None

    warnings = send_payload.get("warnings")
    if isinstance(warnings, list):
        for warning in warnings:
            text = str(warning)
            lowered = text.lower()
            if any(marker in lowered for marker in MODEL_NOT_ENFORCED_MARKERS):
                return text.strip()

    fallbacks = send_payload.get("usedFallbacks")
    if isinstance(fallbacks, list):
        for fallback in fallbacks:
            if str(fallback) in MODEL_UNAVAILABLE_FALLBACKS:
                return f"agbrowse fell back to the current model (usedFallbacks: {fallback})"

    selection = send_payload.get("modelSelection")
    if isinstance(selection, dict):
        if selection.get("status") == "unavailable":
            return "agbrowse reported modelSelection.status == 'unavailable'"
        if selection.get("verified") is False:
            return "agbrowse reported modelSelection.verified == false"
        normalized = selection.get("normalizedModel") or selection.get("selected")
        if isinstance(normalized, str) and normalized and normalized != requested_model:
            return f"agbrowse selected '{normalized}' instead of '{requested_model}'"

    return None
LOCK_STATUS_INTERVAL_SECONDS = 30
MISROUTED_EXIT_CODE = 3
RUN_ID_PREFIX = "OUTPOST_RUN_ID: "
PACKET_ID_PREFIX = "OUTPOST_PACKET_ID: "
RAW_PROMPT_ENV = "OUTPOST_AGBROWSE_RAW_PROMPT"
SEND_PHASE_TIMEOUT_SECONDS = 120
FOLLOW_UP_INLINE_CHAR_THRESHOLD = 12_000
FOLLOW_UP_UPLOAD_PREAMBLE = (
    "첨부한 후속 컨텍스트 패킷을 이 대화의 연속으로 검토하고, 그 안의 질문에 답해 주세요.\n\n"
    "판단에 필요한 근거가 패킷과 앞선 대화에 부족하면 그 점을 명확히 밝혀 주세요."
)


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


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def phase_output_path(path: Path, phase: str) -> Path:
    return path.with_name(f"{path.stem}.{phase}{path.suffix}")


def read_stable_text(path: Path) -> str:
    """Snapshot an input once and fail if it changes during the read."""
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if before_identity != after_identity:
        raise RuntimeError(f"input changed while being read: {path}")
    return data.decode("utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def option_was_provided(argv: Sequence[str], name: str) -> bool:
    return any(arg == name or arg.startswith(f"{name}=") for arg in argv)


def enable_raw_prompt_transport(env: dict[str, str]) -> dict[str, str]:
    """Send the outpost prompt verbatim without agbrowse's generic USER envelope."""
    register_module = Path(__file__).with_name("agbrowse_raw_prompt_register.mjs").resolve()
    if not register_module.exists():
        raise RuntimeError(f"outpost raw-prompt transport is missing: {register_module}")
    updated = dict(env)
    import_option = f"--import={register_module.as_uri()}"
    current_options = updated.get("NODE_OPTIONS", "").strip()
    if import_option not in current_options.split():
        updated["NODE_OPTIONS"] = " ".join(part for part in (current_options, import_option) if part)
    updated[RAW_PROMPT_ENV] = "1"
    return updated


def expected_prompt_hash(prompt: str, attachment_policy: str) -> str:
    """Mirror agbrowse 0.1.18 web-ai/session.mjs hashPrompt()."""
    # agbrowse hashes the exact prompt string; do not trim Unicode whitespace
    # here or the local correlation check will describe a different payload.
    normalized = prompt
    payload = {
        "vendor": "chatgpt",
        "system": "",
        "prompt": normalized,
        "project": "",
        "goal": "",
        "context": "",
        "question": normalized,
        "output": "",
        "constraints": "",
        "attachmentPolicy": attachment_policy,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def correlation_guard_for_upload(prompt: str, run_id: str) -> str:
    prompt_body = prompt.rstrip("\r\n")
    return (
        f"{prompt_body}\n\n"
        "Routing integrity check (required): the first two non-empty lines of your response "
        "must be the routing receipts below. Do not wrap them in Markdown or a code block.\n"
        f"{RUN_ID_PREFIX}{run_id}\n"
        f"Copy the exact line beginning with {PACKET_ID_PREFIX.strip()} from the attached packet "
        "as the second line. If that line is absent, do not answer the packet."
    )


def correlation_guard_for_inline(prompt: str, run_id: str, packet_id: str) -> str:
    prompt_body = prompt.rstrip("\r\n")
    return (
        f"{prompt_body}\n\n"
        "Routing integrity check (required): the first two non-empty lines of your response "
        "must be exactly the following lines. Do not wrap them in Markdown or a code block.\n"
        f"{RUN_ID_PREFIX}{run_id}\n"
        f"{PACKET_ID_PREFIX}{packet_id}"
    )


def annotated_packet(packet: str, packet_id: str) -> str:
    packet_body = packet.rstrip("\r\n")
    return (
        f"{packet_body}\n\n---\n"
        "Routing metadata: copy the following line verbatim as the second non-empty line "
        "of the response. It is not part of the question.\n"
        f"{PACKET_ID_PREFIX}{packet_id}\n"
    )


def private_active_packet_path(browser_home: str, cdp_port: str, run_id: str) -> Path:
    """Return a private, invocation-owned upload path safe for parallel tabs."""
    browser_key = hashlib.sha256(f"{browser_home}\0{cdp_port}".encode("utf-8")).hexdigest()[:12]
    return (
        Path(tempfile.gettempdir())
        / f"agbrowse-outpost-{os.getuid()}-{browser_key}-{run_id}-packet.md"
    )


def target_lock_path(browser_home: str, cdp_port: str, target_key: str) -> Path:
    """Lock only one provider target; independent tabs must not block each other."""
    key = hashlib.sha256(target_key.encode("utf-8")).hexdigest()[:20]
    return Path(browser_home) / f"outpost-target-{cdp_port}-{key}.lock"


def write_private_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
    finally:
        if fd >= 0:
            os.close(fd)


class OutputClaimConflict(RuntimeError):
    def __init__(self, paths: list[str]):
        self.paths = paths
        super().__init__(f"outpost output paths are already claimed: {', '.join(paths)}")


def process_is_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def claim_is_live(claim: Any) -> bool:
    return isinstance(claim, dict) and process_is_alive(claim.get("pid"))


def read_claims(handle: Any, path: Path) -> list[dict[str, Any]]:
    handle.seek(0)
    raw = handle.read()
    if not raw.strip():
        return []
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"outpost output claim registry is unreadable: {path}") from error
    claims = payload.get("claims") if isinstance(payload, dict) else None
    if not isinstance(claims, list):
        raise RuntimeError(f"outpost output claim registry has invalid shape: {path}")
    return [claim for claim in claims if isinstance(claim, dict)]


def write_claims(handle: Any, claims: list[dict[str, Any]]) -> None:
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps({"claims": claims}, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    handle.flush()


@contextmanager
def reserve_output_claims(path: Path, run_id: str, outputs: Sequence[Path]):
    """Reject overlapping output owners before either invocation can overwrite files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    canonical = sorted({str(output.resolve(strict=False)) for output in outputs})
    record = {
        "runId": run_id,
        "pid": os.getpid(),
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "paths": canonical,
    }
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            claims = [claim for claim in read_claims(handle, path) if claim_is_live(claim)]
            occupied = {
                claimed_path
                for claim in claims
                for claimed_path in claim.get("paths", [])
                if isinstance(claimed_path, str)
            }
            conflicts = sorted(set(canonical) & occupied)
            if conflicts:
                write_claims(handle, claims)
                raise OutputClaimConflict(conflicts)
            claims.append(record)
            write_claims(handle, claims)
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    try:
        yield
    finally:
        with path.open("a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                claims = [
                    claim for claim in read_claims(handle, path)
                    if claim.get("runId") != run_id and claim_is_live(claim)
                ]
                write_claims(handle, claims)
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def provider_target_lock(path: Path, timeout_seconds: float):
    """Serialize calls that own the same provider target/session only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + timeout_seconds
    next_notice = started
    with path.open("a+", encoding="utf-8") as handle:
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                now = time.monotonic()
                if now >= deadline:
                    waited = now - started
                    raise TimeoutError(
                        f"timed out after {waited:.1f}s waiting for outpost target lock: {path}"
                    )
                if now >= next_notice:
                    waited = now - started
                    print(
                        f"outpost target is busy; waiting for its session lock ({waited:.0f}s elapsed)",
                        file=sys.stderr,
                        flush=True,
                    )
                    next_notice = now + LOCK_STATUS_INTERVAL_SECONDS
                time.sleep(min(0.25, max(0.0, deadline - now)))

        waited = time.monotonic() - started
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps({
            "pid": os.getpid(),
            "acquiredAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        }))
        handle.flush()
        if waited >= 0.5:
            print(f"acquired outpost target lock after {waited:.1f}s", file=sys.stderr, flush=True)
        try:
            yield waited
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def normalize_url(value: Any) -> str:
    return value.rstrip("/") if isinstance(value, str) else ""


def validate_response_correlation(
    payload: Any,
    answer: str,
    *,
    run_id: str,
    packet_id: str,
    prompt_hash: str,
) -> tuple[bool, str, str]:
    reasons: list[str] = []
    if not isinstance(payload, dict):
        reasons.append("agbrowse stdout is not a JSON object")
    else:
        baseline = payload.get("baseline")
        actual_prompt_hash = baseline.get("promptHash") if isinstance(baseline, dict) else None
        if actual_prompt_hash != prompt_hash:
            reasons.append("submitted prompt hash does not match this invocation")

        artifact = payload.get("answerArtifact")
        if not isinstance(artifact, dict):
            reasons.append("answer artifact metadata is missing")
        else:
            session_id = payload.get("sessionId")
            if not isinstance(session_id, str) or not session_id or artifact.get("sessionId") != session_id:
                reasons.append("answer artifact session does not match the query session")
            result_url = normalize_url(payload.get("url") or payload.get("conversationUrl"))
            artifact_url = normalize_url(artifact.get("conversationUrl"))
            if not result_url or "/c/" not in result_url or artifact_url != result_url:
                reasons.append("answer artifact conversation URL does not match the query conversation")

    lines = answer.splitlines()
    nonempty = [(index, line.strip()) for index, line in enumerate(lines) if line.strip()]
    expected_run = f"{RUN_ID_PREFIX}{run_id}"
    expected_packet = f"{PACKET_ID_PREFIX}{packet_id}"
    if len(nonempty) < 2:
        reasons.append("response is missing the two routing receipt lines")
        clean_answer = ""
    else:
        if nonempty[0][1] != expected_run:
            reasons.append("response run receipt does not match this invocation")
        if nonempty[1][1] != expected_packet:
            reasons.append("response packet receipt does not match the submitted input snapshot")
        clean_answer = "\n".join(lines[nonempty[1][0] + 1:]).strip("\r\n")
        if not clean_answer:
            reasons.append("response body is empty after routing receipts")

    return not reasons, "; ".join(reasons), clean_answer


def provider_completion_error(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return "agbrowse stdout is not a JSON object"
    if payload.get("ok") is not True or payload.get("status") != "complete":
        return f"provider result is not complete (ok={payload.get('ok')!r}, status={payload.get('status')!r})"
    return None


def misrouted_path(path: Path, run_id: str) -> Path:
    name = path.name if path.name.startswith("MISROUTED-") else f"MISROUTED-{path.name}"
    candidate = path.with_name(name)
    if not candidate.exists():
        return candidate
    return candidate.with_name(f"{candidate.stem}-{run_id[:8]}{candidate.suffix}")


def quarantine_response(
    *,
    response_path: Path,
    json_path: Path,
    answer: str,
    reason: str,
    run_id: str,
    packet_id: str,
) -> tuple[Path, Path | None]:
    quarantined_response = misrouted_path(response_path, run_id)
    quarantined_json = misrouted_path(json_path, run_id) if json_path.exists() else None
    header = (
        "# MISROUTED CONSULT RESPONSE\n\n"
        f"Correlation check failed: {reason}\n\n"
        f"Expected run receipt: {RUN_ID_PREFIX}{run_id}\n\n"
        f"Expected packet receipt: {PACKET_ID_PREFIX}{packet_id}\n\n"
        "---\n\n"
    )
    answer_body = answer.rstrip("\r\n")
    write_text(quarantined_response, header + (answer_body or "(No extractable answer.)") + "\n")
    if quarantined_json is not None:
        json_path.replace(quarantined_json)
    return quarantined_response, quarantined_json


def parse_json_or_none(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def read_json_file(path: Path) -> Any | None:
    if not path.exists():
        return None
    return parse_json_or_none(read_text(path))


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def find_strings(value: Any, key_hint: str = "") -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_hint = str(key)
            if isinstance(child, str):
                priority = 0 if child_hint in PREFERRED_KEYS else 1
                if child.strip():
                    found.append((priority, child))
            else:
                found.extend(find_strings(child, child_hint))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_strings(child, key_hint))
    elif isinstance(value, str) and value.strip():
        priority = 0 if key_hint in PREFERRED_KEYS else 1
        found.append((priority, value))
    return found


def extract_answer(stdout: str) -> str:
    payload = parse_json_or_none(stdout)
    if payload is None:
        return stdout.rstrip("\r\n")

    candidates = find_strings(payload)
    if not candidates:
        return json.dumps(payload, ensure_ascii=False, indent=2)

    candidates.sort(key=lambda item: (item[0], -len(item[1])))
    return candidates[0][1].rstrip("\r\n")


def read_saved_session_id(path: Path) -> str | None:
    payload = read_json_file(path)
    if not isinstance(payload, dict):
        return None
    session_id = payload.get("sessionId")
    return session_id if isinstance(session_id, str) and session_id else None


def write_session_file(path: Path, payload: Any, response_output: Path) -> None:
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
        "responseOutput": str(response_output),
        "updatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    write_text(path, json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Outpost through agbrowse web-ai.")
    parser.add_argument("--packet", default=".outpost/outpost-packet.md")
    parser.add_argument(
        "--prompt-file",
        default=".outpost/chatgpt-web-prompt.md",
        help="Inline prompt file; in upload mode it is also the upload source when explicitly passed without --packet.",
    )
    parser.add_argument("--upload-instructions", default=".outpost/chatgpt-upload-instructions.md")
    parser.add_argument("--response-output", default=".outpost/outpost-response.md")
    parser.add_argument("--json-output", default=".outpost/agbrowse-outpost-response.json")
    parser.add_argument("--stderr-output", default=".outpost/agbrowse-outpost-stderr.log")
    parser.add_argument("--trace-dir", default=".outpost/agbrowse-trace")
    parser.add_argument("--session-file", default=DEFAULT_SESSION_FILE)
    parser.add_argument("--turns-output", default=DEFAULT_TURNS_FILE)
    parser.add_argument("--session", default=None, help="Continue a specific agbrowse web-ai session.")
    parser.add_argument("--follow-up", default=None, help="Send a follow-up prompt in the saved/current outpost session.")
    parser.add_argument(
        "--follow-up-file",
        default=None,
        help="Attach a follow-up packet file; its body is never expanded into the ChatGPT composer.",
    )
    parser.add_argument("--no-save-session", action="store_true")
    parser.add_argument("--url", default=None)
    parser.add_argument(
        "--title",
        default=None,
        help="Optional short ChatGPT conversation title; otherwise derive it from the packet question.",
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument(
        "--quality",
        choices=tuple(QUALITY_PRESETS),
        default=None,
        help="Required GPT-5.6 outpost tier: xhigh or pro.",
    )
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument(
        "--lock-timeout",
        type=float,
        default=DEFAULT_LOCK_TIMEOUT_SECONDS,
        help="Maximum seconds to wait when another call owns the same provider session (default: 3900).",
    )
    parser.add_argument("--transport", choices=("inline", "upload"), default="upload")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)

    if args.lock_timeout < 0:
        print("--lock-timeout must be zero or greater", file=sys.stderr)
        return 2
    if args.quality is None:
        print("--quality is required; choose exactly xhigh or pro", file=sys.stderr)
        return 2
    selected_model, selected_effort = QUALITY_PRESETS[args.quality]
    quality = args.quality

    if not shutil.which("agbrowse"):
        print("agbrowse not found. Install with: npm install -g agbrowse", file=sys.stderr)
        return 127

    packet_path = Path(args.packet).expanduser()
    prompt_path = Path(args.prompt_file).expanduser()
    upload_path = Path(args.upload_instructions).expanduser()
    response_path = Path(args.response_output).expanduser()
    json_path = Path(args.json_output).expanduser()
    stderr_path = Path(args.stderr_output).expanduser()
    session_path = Path(args.session_file).expanduser()
    turns_path = Path(args.turns_output).expanduser()
    trace_path = Path(args.trace_dir).expanduser()

    explicit_packet = option_was_provided(argv, "--packet")
    explicit_prompt = option_was_provided(argv, "--prompt-file")
    upload_source_path = packet_path
    if args.transport == "upload" and explicit_prompt and not explicit_packet:
        upload_source_path = prompt_path
        print(
            f"upload mode: using explicit --prompt-file as the upload source: {upload_source_path}",
            file=sys.stderr,
        )

    follow_up = args.follow_up
    follow_up_source = "--follow-up"
    if args.follow_up_file:
        follow_up_path = Path(args.follow_up_file).expanduser()
        if not follow_up_path.exists():
            print(f"follow-up file not found: {follow_up_path}", file=sys.stderr)
            return 2
        try:
            follow_up = read_stable_text(follow_up_path)
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 2
        follow_up_source = str(follow_up_path)
        if not follow_up.strip():
            print(f"follow-up file is empty: {follow_up_path}", file=sys.stderr)
            return 2

    if follow_up:
        session_id = args.session
    else:
        session_id = args.session
        required_input = upload_source_path if args.transport == "upload" else prompt_path
        if not required_input.exists():
            print(f"outpost input not found: {required_input}", file=sys.stderr)
            return 2
        if args.transport == "upload" and not upload_path.exists():
            print(f"upload instructions not found: {upload_path}", file=sys.stderr)
            return 2

    run_id = secrets.token_hex(16)
    try:
        if follow_up:
            input_snapshot = follow_up
            input_source = follow_up_source
            packet_id = sha256_text(input_snapshot)
            title = extract_outpost_title(input_snapshot, args.title, "follow-up")
            if args.follow_up_file or len(input_snapshot) > FOLLOW_UP_INLINE_CHAR_THRESHOLD:
                preferred_prompt = add_initial_prompt_contract(FOLLOW_UP_UPLOAD_PREAMBLE, title)
                guarded_prompt = correlation_guard_for_upload(preferred_prompt, run_id)
                annotated_upload = annotated_packet(input_snapshot, packet_id)
                attachment_policy = "upload"
                mode = "follow-up-upload"
            else:
                preferred_prompt = add_response_preference(input_snapshot)
                guarded_prompt = correlation_guard_for_inline(preferred_prompt, run_id, packet_id)
                annotated_upload = None
                attachment_policy = "inline-only"
                mode = "follow-up-inline"
        elif args.transport == "upload":
            input_snapshot = read_stable_text(upload_source_path)
            upload_instructions = read_stable_text(upload_path)
            input_source = str(upload_source_path)
            packet_id = sha256_text(input_snapshot)
            title = extract_outpost_title(input_snapshot, args.title, upload_source_path.stem)
            preferred_prompt = add_initial_prompt_contract(upload_instructions, title)
            guarded_prompt = correlation_guard_for_upload(preferred_prompt, run_id)
            annotated_upload = annotated_packet(input_snapshot, packet_id)
            attachment_policy = "upload"
            mode = "initial-upload"
        else:
            input_snapshot = read_stable_text(prompt_path)
            input_source = str(prompt_path)
            packet_id = sha256_text(input_snapshot)
            title = extract_outpost_title(input_snapshot, args.title, prompt_path.stem)
            preferred_prompt = add_initial_prompt_contract(input_snapshot, title)
            guarded_prompt = correlation_guard_for_inline(preferred_prompt, run_id, packet_id)
            annotated_upload = None
            attachment_policy = "inline-only"
            mode = "initial-inline"
    except (OSError, RuntimeError) as error:
        print(f"failed to snapshot outpost input: {error}", file=sys.stderr)
        return 2

    prompt_hash = expected_prompt_hash(guarded_prompt, attachment_policy)

    config_url = read_config_value(Path(args.config).expanduser(), "OUTPOST_CHATGPT_URL")
    chatgpt_url = args.url or os.environ.get("OUTPOST_CHATGPT_URL") or config_url
    if not is_work_project_url(chatgpt_url):
        print(
            "outpost Playwright fallback requires a verified ChatGPT Work project URL; "
            "set OUTPOST_CHATGPT_URL or pass --url",
            file=sys.stderr,
        )
        return 2

    try:
        env = enable_raw_prompt_transport(browser_env(os.environ))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 75
    claims_path = Path(env["BROWSER_AGENT_HOME"]) / f"outpost-query-{env['CDP_PORT']}-claims.json"
    history_path = Path(env["BROWSER_AGENT_HOME"]) / "outpost-history.jsonl"
    send_json_path = phase_output_path(json_path, "send")
    active_packet_path = (
        private_active_packet_path(env["BROWSER_AGENT_HOME"], env["CDP_PORT"], run_id)
        if annotated_upload is not None else None
    )
    protected_outputs = [response_path, json_path, send_json_path, stderr_path, trace_path, turns_path]
    if not args.no_save_session:
        protected_outputs.append(session_path)

    claim_stack = ExitStack()
    try:
        claim_stack.enter_context(reserve_output_claims(claims_path, run_id, protected_outputs))
    except OutputClaimConflict as error:
        print(
            "outpost output path is already owned by another invocation; refusing to launch provider: "
            f"{', '.join(error.paths)}",
            file=sys.stderr,
        )
        return 75
    except (OSError, RuntimeError) as error:
        print(f"failed to reserve outpost output paths: {error}", file=sys.stderr)
        return 75

    owned_session_id: str | None = None
    try:
        try:
            if follow_up and not session_id:
                session_id = read_saved_session_id(session_path)
                if not session_id:
                    print(
                        "no outpost session found; pass --session or run an initial outpost query first "
                        f"({session_path})",
                        file=sys.stderr,
                    )
                    return 2

            # Initial calls each own a new tab, so their locks are intentionally
            # run-specific. Follow-ups use the provider session as the key so
            # two writers can never mutate the same conversation concurrently.
            target_key = f"session:{session_id}" if session_id else f"new-tab:{run_id}"
            lock_path = target_lock_path(env["BROWSER_AGENT_HOME"], env["CDP_PORT"], target_key)
            with provider_target_lock(lock_path, args.lock_timeout) as lock_wait_seconds:
                history_base = {
                    "runId": run_id,
                    "topic": title,
                    "mode": mode,
                    "quality": quality,
                    "requestedModel": selected_model,
                    "requestedEffort": selected_effort,
                    "requestedSessionId": session_id,
                    "cwd": str(Path.cwd()),
                    "inputSource": input_source,
                    "inputSha256": packet_id,
                    "promptHash": prompt_hash,
                    "sessionFile": str(session_path),
                    "responseOutput": str(response_path),
                    "jsonOutput": str(json_path),
                    "sendJsonOutput": str(send_json_path),
                    "stderrOutput": str(stderr_path),
                    "traceDir": str(trace_path),
                    "turnsOutput": str(turns_path),
                    "pid": os.getpid(),
                }

                def record_history(event: str, status: str, **extra: Any) -> None:
                    append_history_event(history_path, {
                        **history_base,
                        "event": event,
                        "status": status,
                        **extra,
                    })

                record_history("started", "starting", lockWaitSeconds=round(lock_wait_seconds, 3))
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
                except (OSError, subprocess.CalledProcessError) as error:
                    record_history("failed", "browser-start-failed", error=str(error))
                    print(f"failed to ensure shared Chrome endpoint: {error}", file=sys.stderr)
                    return 75
                send_cmd = [
                    "agbrowse",
                    "web-ai",
                    "send",
                    "--vendor",
                    "chatgpt",
                    "--url",
                    chatgpt_url,
                    "--model",
                    selected_model,
                    "--allow-copy-markdown-fallback",
                    "--timeout",
                    str(args.timeout),
                    "--trace-dir",
                    args.trace_dir,
                    "--json",
                ]
                if selected_effort:
                    send_cmd.extend(["--effort", selected_effort])
                # An initial outpost must never navigate whichever shared Chrome
                # tab happened to be active. A saved provider session owns and
                # claims its recorded target; otherwise use agbrowse's official
                # parallel mode (a fresh target, bypassing tab-pool reuse).
                if session_id:
                    send_cmd.extend(["--session", session_id])
                else:
                    send_cmd.append("--parallel")

                packet_owned = False
                try:
                    if annotated_upload is not None and active_packet_path is not None:
                        packet_owned = True
                        write_private_text(active_packet_path, annotated_upload)
                        send_cmd.extend(["--file", str(active_packet_path), "--prompt", guarded_prompt])
                    else:
                        send_cmd.extend(["--inline-only", "--prompt", guarded_prompt])

                    json_path.parent.mkdir(parents=True, exist_ok=True)
                    stderr_path.parent.mkdir(parents=True, exist_ok=True)
                    with send_json_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open("w", encoding="utf-8") as stderr_handle:
                        try:
                            send_proc = subprocess.run(
                                send_cmd,
                                stdout=stdout_handle,
                                stderr=stderr_handle,
                                text=True,
                                encoding="utf-8",
                                errors="replace",
                                env=env,
                                check=False,
                                timeout=SEND_PHASE_TIMEOUT_SECONDS,
                            )
                        except subprocess.TimeoutExpired:
                            record_history(
                                "submit-timeout",
                                "submit-unknown",
                                error=f"send phase exceeded {SEND_PHASE_TIMEOUT_SECONDS}s",
                            )
                            print(
                                "outpost send phase timed out before commit was verified; submission state is unknown. "
                                f"Inspect with: python3 {Path(__file__).with_name('outpost_history.py')} recover {run_id}",
                                file=sys.stderr,
                            )
                            return 75
                finally:
                    if packet_owned and active_packet_path is not None:
                        active_packet_path.unlink(missing_ok=True)

                send_stdout = read_text(send_json_path)
                send_payload = parse_json_or_none(send_stdout)
                submitted_session_id = send_payload.get("sessionId") if isinstance(send_payload, dict) else None
                submitted_url = (
                    send_payload.get("url") or send_payload.get("conversationUrl")
                    if isinstance(send_payload, dict) else None
                )
                if (
                    send_proc.returncode != 0
                    or not isinstance(send_payload, dict)
                    or send_payload.get("ok") is not True
                    or send_payload.get("status") != "sent"
                    or not isinstance(submitted_session_id, str)
                    or not submitted_session_id
                ):
                    record_history(
                        "submit-failed",
                        "submit-failed",
                        exitCode=send_proc.returncode,
                        error="agbrowse did not return a commit-verified sent session",
                    )
                    print(f"agbrowse send failed; see {send_json_path} and {args.stderr_output}", file=sys.stderr)
                    return send_proc.returncode or 1

                # Selection fails closed: an unverified model tier invalidates the
                # outpost even though the prompt already went out, so stop here
                # rather than presenting a lesser model's answer as the requested one.
                model_problem = detect_model_not_enforced(send_payload, selected_model)
                if model_problem:
                    owned_session_id = submitted_session_id
                    if not args.no_save_session:
                        write_session_file(session_path, send_payload, response_path)
                    record_history(
                        "model-not-enforced",
                        "model-not-enforced",
                        sessionId=submitted_session_id,
                        conversationUrl=submitted_url,
                        requestedModel=selected_model,
                        error=model_problem,
                    )
                    print(
                        "outpost aborted: requested model "
                        f"'{selected_model}' was not applied by agbrowse.\n"
                        f"  reason: {model_problem}\n"
                        "  The prompt WAS submitted, but on an unverified model, so the\n"
                        "  answer would not be the requested tier. Not polling for it.\n"
                        f"  Evidence: {send_json_path}\n"
                        "  Recovery: select the model manually in the browser, or resume\n"
                        f"  this session id after fixing selection: {submitted_session_id}",
                        file=sys.stderr,
                    )
                    return MODEL_UNENFORCED_EXIT_CODE

                owned_session_id = submitted_session_id

                record_history(
                    "submitted",
                    "submitted",
                    sessionId=submitted_session_id,
                    conversationUrl=submitted_url,
                )
                if not args.no_save_session:
                    write_session_file(session_path, send_payload, response_path)

                poll_cmd = [
                    "agbrowse",
                    "web-ai",
                    "poll",
                    "--vendor",
                    "chatgpt",
                    "--session",
                    submitted_session_id,
                    "--allow-copy-markdown-fallback",
                    "--timeout",
                    str(args.timeout),
                    "--trace-dir",
                    args.trace_dir,
                    "--json",
                ]
                with json_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open("a", encoding="utf-8") as stderr_handle:
                    proc = subprocess.run(
                        poll_cmd,
                        stdout=stdout_handle,
                        stderr=stderr_handle,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        env=env,
                        check=False,
                    )
                stdout = read_text(json_path)

                answer = extract_answer(stdout) if stdout.strip() else ""
                payload = parse_json_or_none(stdout)
                if answer:
                    correlated, reason, clean_answer = validate_response_correlation(
                        payload,
                        answer,
                        run_id=run_id,
                        packet_id=packet_id,
                        prompt_hash=prompt_hash,
                    )
                else:
                    correlated, reason, clean_answer = False, "agbrowse returned no extractable answer", ""

                if answer and not correlated:
                    with stderr_path.open("a", encoding="utf-8") as stderr_handle:
                        stderr_handle.write(f"\n[outpost-helper] response correlation failed: {reason}\n")
                    quarantined_response, quarantined_json = quarantine_response(
                        response_path=response_path,
                        json_path=json_path,
                        answer=answer,
                        reason=reason,
                        run_id=run_id,
                        packet_id=packet_id,
                    )
                    failure_stub = (
                        "# CONSULT RESPONSE REJECTED\n\n"
                        "The returned answer did not pass response correlation and is not safe to use.\n\n"
                        f"Reason: {reason}\n\n"
                        f"Preserved response: {quarantined_response}\n"
                    )
                    write_text(response_path, failure_stub)
                    if not args.no_save_session:
                        write_text(session_path, json.dumps({
                            "sessionId": None,
                            "status": "misrouted",
                            "reason": reason,
                            "misroutedResponseOutput": str(quarantined_response),
                            "updatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                        }, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
                    append_jsonl(turns_path, {
                        "mode": mode,
                        "quality": quality,
                        "requestedModel": selected_model,
                        "requestedEffort": selected_effort,
                        "sessionId": payload.get("sessionId") if isinstance(payload, dict) else session_id,
                        "status": "misrouted",
                        "conversationUrl": (payload.get("url") or payload.get("conversationUrl")) if isinstance(payload, dict) else None,
                        "inputSource": input_source,
                        "inputSha256": packet_id,
                        "promptHash": prompt_hash,
                        "correlationRunId": run_id,
                        "correlationFailure": reason,
                        "lockWaitSeconds": round(lock_wait_seconds, 3),
                        "responseOutput": str(quarantined_response),
                        "jsonOutput": str(quarantined_json) if quarantined_json else None,
                        "createdAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                    })
                    print(
                        "outpost response correlation failed; quarantined instead of publishing: "
                        f"{quarantined_response} ({reason})",
                        file=sys.stderr,
                    )
                    record_history(
                        "misrouted",
                        "misrouted",
                        sessionId=payload.get("sessionId") if isinstance(payload, dict) else submitted_session_id,
                        conversationUrl=(payload.get("url") or payload.get("conversationUrl")) if isinstance(payload, dict) else submitted_url,
                        error=reason,
                    )
                    return MISROUTED_EXIT_CODE

                if proc.returncode != 0:
                    record_history(
                        "poll-failed",
                        "poll-failed",
                        sessionId=submitted_session_id,
                        conversationUrl=submitted_url,
                        exitCode=proc.returncode,
                    )
                    print(f"agbrowse failed with exit code {proc.returncode}; see {args.stderr_output}", file=sys.stderr)
                    if stdout.strip():
                        print(f"partial stdout saved to {args.json_output}", file=sys.stderr)
                    return proc.returncode

                if not answer:
                    record_history(
                        "poll-failed",
                        "poll-failed",
                        sessionId=submitted_session_id,
                        conversationUrl=submitted_url,
                        error="agbrowse returned no extractable answer",
                    )
                    print(f"agbrowse returned no extractable answer; see {args.json_output}", file=sys.stderr)
                    return 1

                completion_reason = provider_completion_error(payload)
                if completion_reason:
                    write_text(response_path, (
                        "# CONSULT RESPONSE REJECTED\n\n"
                        "Response routing matched, but the provider result was incomplete and was not published.\n\n"
                        f"Reason: {completion_reason}\n"
                    ))
                    if not args.no_save_session:
                        write_text(session_path, json.dumps({
                            "sessionId": None,
                            "status": "provider-failed",
                            "reason": completion_reason,
                            "updatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                        }, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
                    append_jsonl(turns_path, {
                        "mode": mode,
                        "quality": quality,
                        "requestedModel": selected_model,
                        "requestedEffort": selected_effort,
                        "sessionId": payload.get("sessionId") if isinstance(payload, dict) else session_id,
                        "status": "provider-failed",
                        "inputSource": input_source,
                        "inputSha256": packet_id,
                        "promptHash": prompt_hash,
                        "correlationRunId": run_id,
                        "correlationStatus": "validated-provider-incomplete",
                        "providerFailure": completion_reason,
                        "lockWaitSeconds": round(lock_wait_seconds, 3),
                        "responseOutput": str(response_path),
                        "jsonOutput": str(json_path),
                        "createdAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                    })
                    print(f"outpost provider result was incomplete: {completion_reason}", file=sys.stderr)
                    record_history(
                        "provider-failed",
                        "provider-failed",
                        sessionId=submitted_session_id,
                        conversationUrl=submitted_url,
                        error=completion_reason,
                    )
                    return 1

                write_text(response_path, clean_answer + "\n")
                if not args.no_save_session:
                    write_session_file(session_path, payload, response_path)
                append_jsonl(turns_path, {
                    "mode": mode,
                    "quality": quality,
                    "requestedModel": selected_model,
                    "requestedEffort": selected_effort,
                    "sessionId": payload.get("sessionId") if isinstance(payload, dict) else session_id,
                    "status": payload.get("status") if isinstance(payload, dict) else None,
                    "conversationUrl": (payload.get("url") or payload.get("conversationUrl")) if isinstance(payload, dict) else None,
                    "inputSource": input_source,
                    "inputSha256": packet_id,
                    "promptHash": prompt_hash,
                    "correlationRunId": run_id,
                    "correlationStatus": "validated",
                    "lockWaitSeconds": round(lock_wait_seconds, 3),
                    "responseOutput": str(response_path),
                    "jsonOutput": str(json_path),
                    "createdAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                })
                record_history(
                    "completed",
                    "complete",
                    sessionId=payload.get("sessionId") if isinstance(payload, dict) else submitted_session_id,
                    conversationUrl=(payload.get("url") or payload.get("conversationUrl")) if isinstance(payload, dict) else submitted_url,
                    correlationStatus="validated",
                )

                print(f"wrote validated outpost response: {response_path.resolve()}")
                print(f"wrote agbrowse evidence: {json_path.resolve()}")
                if not args.no_save_session and session_path.exists():
                    print(f"saved outpost session: {session_path.resolve()}")
                return 0
        except TimeoutError as error:
            print(str(error), file=sys.stderr)
            return 75
    finally:
        close_session_tab(owned_session_id, env)
        stop_chrome_if_idle(env)
        claim_stack.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
