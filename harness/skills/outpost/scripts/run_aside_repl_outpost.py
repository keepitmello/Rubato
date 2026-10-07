#!/usr/bin/env python3
"""Submit and recover a ChatGPT project outpost through deterministic Aside REPL calls."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Callable, Sequence
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen
from zipfile import BadZipFile, ZipFile


SUBMIT_TIMEOUT_SECONDS = 120
DEFAULT_RESPONSE_TIMEOUT_SECONDS = 3600
# Aside's daemon serves this without the browser. A daemon that just came back
# still has its browser starting, and a send that lands in that window dies with
# "other side closed" — the failure the keepalive log shows over and over.
ASIDE_HEALTH_URL = os.environ.get("ASIDE_HEALTH_URL", "http://127.0.0.1:21420/health")
DAEMON_SETTLE_SECONDS = 20
# `aside repl` takes the script as one command-line argument, and macOS caps
# arguments at 1 MB (2026-10-03: a 1.26 MB zip inlined as base64 never started
# the REPL). The packet and uploads are staged as files instead and the script
# reads them with the REPL's `fs`, which only reaches the account directory
# (`~/.aside/u/<n>`) and the per-run session directory.
ASIDE_ROOT_ENV = "OUTPOST_ASIDE_ROOT"
ASIDE_ROOT_MARKER = "OUTPOST_ASIDE_SESSION "
STAGING_SUBDIR = Path("tmp") / "outpost-staging"
STAGING_MAX_AGE_SECONDS = 24 * 3600
# Doctor rehearses the whole send path with this throwaway packet. It never
# reaches ChatGPT: the rehearsal stops before the click.
REHEARSAL_TOPIC = "outpost 리허설"
REHEARSAL_PACKET = (
    "# outpost 리허설\n\n"
    "전송 경로를 리허설하려고 만든 패킷이다. 보내지 않는다.\n"
)
DEFAULT_CONFIG = Path.home() / ".codex" / "outpost.env"
LEGACY_CONFIG = Path.home() / ".codex" / "consult.env"
DEFAULT_PROJECT_NAME = "Work"
PROJECT_NAME_KEY = "OUTPOST_PROJECT_NAME"
LEGACY_PROJECT_NAME_KEY = "CONSULT_PROJECT_NAME"
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SUBMIT_MARKER = "ASIDE_REPL_SUBMIT_RESULT "
SUBMIT_UNKNOWN_MARKER = "ASIDE_REPL_SUBMIT_UNKNOWN "
RESPONSE_MARKER = "ASIDE_REPL_RESPONSE_RESULT "
BACKEND_RECOVERY_MARKER = "ASIDE_BACKEND_RECOVERY_RESULT "
REHEARSAL_MARKER = "OUTPOST_REHEARSAL_RESULT "
DIAG_MARKER = "OUTPOST_DIAG "
# Aside drops the whole output of a script that ends in an error once it passes
# roughly 16-20 KB, and a failed step always ends in one, so the page report
# has to fit well under that next to the error itself.
DIAG_TREE_LIMIT = 7000
DIAG_OUTLINE_LIMIT = 4000
# After a send click that threw, how long the page may take to show the user
# turn before the runner asks the backend instead.
CLICK_ERROR_TURN_WAIT_MS = 20_000
# The REPL drops a top-level `return`: the script then stops silently partway,
# with no error and no output. The rehearsal ends with a sentinel throw instead.
REHEARSAL_STOP = "OUTPOST_REHEARSAL_STOP"
FAIL_STAGE_RE = re.compile(r"OUTPOST_FAIL stage=(\S+)\s+(.*)")
STAGE_IN_MESSAGE_RE = re.compile(r"단계:\s*(\S+)")
STAGE_HINTS = {
    "load-staged-files": "스테이징한 패킷·첨부 읽기",
    "open-isolated-tab": "격리 탭",
    "load-work-project": "프로젝트 페이지",
    "load-saved-conversation": "저장된 대화",
    "select-account": "프로젝트가 있는 ChatGPT 워크스페이스",
    "wait-project-composer": "새 채팅 입력창",
    "wait-conversation-composer": "이어가기 입력창",
    "select-chat-surface": "Chat/Work 토글",
    "select-tier": "추론 수준/Pro 버튼",
    "open-tier-slider": "추론 슬라이더 메뉴",
    "read-tier": "추론 단계 읽기",
    "pick-tier": "추론 단계 고르기",
    "open-model-menu": "모델 선택 메뉴",
    "verify-model": "GPT-6 모델 라디오",
    "fill-composer": "입력창 채우기",
    "attach-packet": "패킷 첨부",
    "ready-to-send": "보내기 버튼",
    "commit-user-turn": "제출",
}
# The picker selects the pinned GPT-6 family; the answer's backend slug
# independently verifies the exact model used for the requested tier.
# Each quality is one tier pick, and each tier runs one model. ChatGPT reports
# the slug it actually ran, so a run checks that slug against the tier it asked
# for. Both qualities are pinned to GPT-6; `xhigh` is the cheaper Thinking tier,
# never what a Pro packet should be answered by.
QUALITY_MODEL_SLUGS: dict[str, str] = {
    "pro": "gpt-6-pro",
    "xhigh": "gpt-6-thinking",
}
QUALITIES = tuple(QUALITY_MODEL_SLUGS)
WRONG_MODEL_EXIT = 78
DUPLICATE_SEND_EXIT = 79
NOT_SENT_EXIT = 75
SUBMIT_UNKNOWN_EXIT = 76
CONVERSATION_ID_RE = re.compile(r"/c/([0-9a-fA-F-]{8,})")
PROJECT_GIZMO_RE = re.compile(r"^/g/(g-p-[0-9a-fA-F]+)")
# How long the backend is polled for a turn before "not there" counts as not
# sent: a click that landed a moment before the REPL died is still committing.
LOCATE_TIMEOUT_SECONDS = 20
# Aside cuts `aside repl` at 120 seconds and drops the output; one backend
# lookup ends well before that and the wait for a long reply loops in Python.
REPL_LOOKUP_SECONDS = 90
# A lookup only reads project conversations touched this long before the send
# started, so it stays a handful of reads even in a busy project.
LOCATE_SINCE_SLACK_SECONDS = 120
KOREAN_UPLOAD_PREAMBLE = (
    "첨부한 독립형 컨텍스트 패킷을 검토하고, 그 안의 질문이나 작업에 답해 주세요.\n\n"
    "이 패킷 외의 저장소, 터미널, 이전 대화는 볼 수 없다고 가정하세요. "
    "판단에 필요한 근거가 패킷에 부족하면 그 점을 명확히 밝혀 주세요.\n\n"
    "답변은 한국어 보고서로 작성해 주세요. 문제에 맞는 구조와 표현을 자유롭게 선택하되, "
    "자연스럽고 이해하기 쉽게 설명해 주세요. 기술 용어와 영문 표현은 도움이 될 때 "
    "자유롭게 사용해도 됩니다."
)
KOREAN_FOLLOWUP_PREAMBLE = (
    "같은 대화의 후속 질문입니다. 이전 답변과 첨부한 패킷을 함께 보고 답해 주세요.\n\n"
    "판단에 필요한 근거가 부족하면 그 점을 명확히 밝혀 주세요.\n\n"
    "답변은 한국어 보고서로 작성해 주세요. 문제에 맞는 구조와 표현을 자유롭게 선택하되, "
    "자연스럽고 이해하기 쉽게 설명해 주세요. 기술 용어와 영문 표현은 도움이 될 때 "
    "자유롭게 사용해도 됩니다."
)



def load_ui_module():
    spec = importlib.util.spec_from_file_location(
        "outpost_ui",
        Path(__file__).with_name("outpost_ui.py"),
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("outpost_ui.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UI = load_ui_module()


def tier_name_pattern(aliases: Sequence[str]) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for raw in aliases:
        text = " ".join(str(raw).split())
        if not text:
            continue
        for candidate in (text, re.sub(r"\s+", "", text)):
            if candidate in seen:
                continue
            seen.add(candidate)
            parts.append(re.escape(candidate))
    parts.append(r"[0-9]* ?Pro")
    return r"^(?:" + "|".join(parts) + r")$"


def load_sessions_module():
    spec = importlib.util.spec_from_file_location(
        "outpost_sessions",
        Path(__file__).with_name("outpost_sessions.py"),
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("outpost_sessions.py is missing")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SESSIONS = load_sessions_module()


class SubmitUnknownError(RuntimeError):
    """The send click happened but provider commit could not be proven."""


class SubmittedResponseError(RuntimeError):
    """The turn committed in the live REPL, but response recovery failed."""

    def __init__(
        self,
        submit_payload: dict[str, Any],
        submit_elapsed: float,
        transcript: str,
    ) -> None:
        super().__init__(
            "submission committed but response recovery failed; recover the "
            "same conversation and do not resend\n" + transcript
        )
        self.submit_payload = submit_payload
        self.submit_elapsed = submit_elapsed
        self.transcript = transcript


def extract_topic(packet_body: str) -> str:
    first_line = packet_body.splitlines()[0] if packet_body else ""
    if not first_line.startswith("# "):
        raise ValueError("packet first line must be a Markdown H1: # <topic>")
    topic = first_line[2:].strip()
    if not topic:
        raise ValueError("packet topic is empty")
    if len(topic) > 120:
        raise ValueError("packet topic exceeds 120 characters")
    return topic


def build_composer_prompt(
    topic: str,
    outpost_id: str,
    artifact_output: str | None,
    *,
    follow_up: bool = False,
) -> str:
    artifact_instruction = (
        "\n\n요청한 작업 결과는 zip 파일 하나로도 반환해 주세요."
        if artifact_output
        else ""
    )
    preamble = KOREAN_FOLLOWUP_PREAMBLE if follow_up else KOREAN_UPLOAD_PREAMBLE
    return (
        f"{topic}\n"
        f"ID: {outpost_id}\n\n"
        "답변 첫 줄에 위 ID를 그대로 써 주세요.\n\n"
        f"{preamble}{artifact_instruction}"
    )


def read_config_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        if name.strip() != key:
            continue
        value = value.strip()
        if value.startswith(("'", '"')) and value.endswith(("'", '"')):
            value = value[1:-1]
        return value or None
    return None


def is_chatgpt_project_url(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "chatgpt.com"
        and parsed.path.startswith("/g/g-p-")
        and parsed.path.endswith("/project")
    )


def composer_aria_labels(project_name: str, ui: dict[str, Any] | None = None) -> list[str]:
    ui = ui or UI.load_ui_map()
    return [label.replace("{project}", project_name) for label in ui["projectComposerLabels"]]


def composer_selector(labels: Sequence[str] | None = None, ui: dict[str, Any] | None = None) -> str:
    editors = (ui or UI.load_ui_map())["composer"]
    if not labels:
        return ", ".join(editors)
    return ", ".join(f'{editor}[aria-label="{label}"]' for editor in editors for label in labels)


def resolve_project_name(
    *,
    cli_value: str | None,
    config_path: Path,
) -> str:
    raw = (
        cli_value
        or os.environ.get(PROJECT_NAME_KEY)
        or os.environ.get(LEGACY_PROJECT_NAME_KEY)
        or read_config_value(config_path, PROJECT_NAME_KEY)
        or read_config_value(config_path, LEGACY_PROJECT_NAME_KEY)
        or DEFAULT_PROJECT_NAME
    )
    return raw.strip()


def resolve_config_path(cli_value: str | None) -> Path:
    path = Path(cli_value or DEFAULT_CONFIG).expanduser()
    if path.is_file() or path != DEFAULT_CONFIG:
        return path
    if LEGACY_CONFIG.is_file():
        return LEGACY_CONFIG
    return path


def js(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def conversation_id_from_url(url: str | None) -> str | None:
    if not url:
        return None
    match = CONVERSATION_ID_RE.search(url)
    return match.group(1) if match else None


def chatgpt_message_text(message: dict[str, Any] | None) -> str:
    if not message:
        return ""
    content = message.get("content") or {}
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return ""
    chunks: list[str] = []
    for part in parts:
        if isinstance(part, str):
            chunks.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r'[/\\?%*:|"<>]+', '_', name.strip())
    cleaned = re.sub(r'\s+', '_', cleaned)
    return cleaned or "attachment.bin"


def is_ascii(value: str) -> bool:
    return all(ord(char) < 128 for char in value)


def ascii_upload_name(name: str, index: int) -> str:
    """ChatGPT mangles non-ASCII upload names, so send an ASCII name."""
    if is_ascii(name):
        return name
    suffix = Path(name).suffix
    if not is_ascii(suffix):
        suffix = ".bin"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(name).stem).strip("-")
    if not stem:
        stem = f"attachment-{index + 1}"
    return f"{stem}{suffix}"


def normalized_zip_bytes(path: Path) -> tuple[bytes, list[tuple[str, str]]]:
    """Repack a zip with ASCII inner names; keep the original names in a map."""
    import io

    renames: list[tuple[str, str]] = []
    with ZipFile(path) as source:
        entries = source.infolist()
        if all(is_ascii(entry.filename) for entry in entries):
            return path.read_bytes(), renames
        buffer = io.BytesIO()
        with ZipFile(buffer, "w") as target:
            for index, entry in enumerate(entries):
                if entry.is_dir():
                    continue
                inner = entry.filename
                if is_ascii(inner):
                    safe = inner
                else:
                    parent = str(Path(inner).parent)
                    safe_name = ascii_upload_name(Path(inner).name, index)
                    safe = safe_name if parent in {"", "."} else f"{parent}/{safe_name}"
                    if not is_ascii(safe):
                        safe = safe_name
                    renames.append((inner, safe))
                target.writestr(safe, source.read(entry.filename))
            if renames:
                mapping = "\n".join(f"{safe} <- {original}" for original, safe in renames)
                target.writestr("FILENAMES.txt", mapping + "\n")
    return buffer.getvalue(), renames


def build_uploads(paths: Sequence[str]) -> tuple[list[dict[str, Any]], list[str]]:
    uploads: list[dict[str, Any]] = []
    notes: list[str] = []
    for index, raw in enumerate(paths):
        source = Path(raw).expanduser()
        if not source.is_file():
            raise ValueError(f"attachment not found: {source}")
        if source.suffix.lower() == ".zip":
            payload, renames = normalized_zip_bytes(source)
            for original, safe in renames:
                notes.append(f"{safe} <- {original}")
        else:
            payload = source.read_bytes()
        upload_name = ascii_upload_name(source.name, index)
        if upload_name != source.name:
            notes.append(f"{upload_name} <- {source.name}")
        uploads.append(
            {
                "name": upload_name,
                "mime": "application/zip" if source.suffix.lower() == ".zip" else "application/octet-stream",
                "data": payload,
            }
        )
    return uploads, notes


def aside_project_root() -> Path:
    """The account directory the REPL's `fs` may read, asked of the REPL itself."""
    override = os.environ.get(ASIDE_ROOT_ENV)
    if override:
        return Path(override).expanduser()
    transcript = run_repl_process(
        f"console.log({js(ASIDE_ROOT_MARKER)} + await fs.resolvePath('.'))",
        timeout=20,
    )
    for line in transcript.splitlines():
        clean = ANSI_RE.sub("", line).strip()
        if clean.startswith(ASIDE_ROOT_MARKER):
            session = Path(clean[len(ASIDE_ROOT_MARKER):].strip())
            if session.parent.name == "sessions":
                return session.parent.parent
    raise RuntimeError(f"aside session directory not found: {transcript.strip()[:200]}")


def stage_payload(
    root: Path,
    outpost_id: str,
    packet: bytes,
    uploads: Sequence[dict[str, Any]] = (),
) -> tuple[Path, str, list[dict[str, str]]]:
    """Write the packet and uploads where the REPL can read them; no size limit."""
    base = root / STAGING_SUBDIR
    if base.is_dir():
        cutoff = time.time() - STAGING_MAX_AGE_SECONDS
        for old in base.iterdir():
            if old.is_dir() and old.stat().st_mtime < cutoff:
                shutil.rmtree(old, ignore_errors=True)
    staging = base / outpost_id
    staging.mkdir(parents=True, exist_ok=True)
    packet_path = staging / "packet.md"
    packet_path.write_bytes(packet)
    staged: list[dict[str, str]] = []
    for index, item in enumerate(uploads):
        path = staging / f"upload-{index}"
        path.write_bytes(item["data"])
        staged.append({"name": item["name"], "mime": item["mime"], "path": str(path)})
    return staging, str(packet_path), staged


@contextmanager
def staged_payload(outpost_id: str, packet: bytes, uploads: Sequence[dict[str, Any]] = ()):
    """Stage for one run and remove the files when it ends."""
    staging, packet_path, staged = stage_payload(aside_project_root(), outpost_id, packet, uploads)
    try:
        yield packet_path, staged
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def save_outpost_attachments(
    outpost_id: str,
    downloaded_files: list[dict[str, Any]] | None = None,
    writing_artifacts: list[dict[str, Any]] | None = None,
) -> list[Path]:
    downloaded_files = downloaded_files or []
    writing_artifacts = writing_artifacts or []
    if not downloaded_files and not writing_artifacts:
        return []
    save_dir = Path(f"/tmp/outpost-{outpost_id}")
    save_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    seen_names: set[str] = set()

    for item in downloaded_files:
        name = sanitize_filename(str(item.get("suggestedFilename") or "download.bin"))
        if name in seen_names:
            base, ext = os.path.splitext(name)
            name = f"{base}_{len(seen_names)}{ext}"
        seen_names.add(name)
        dest = save_dir / name
        temp_path = item.get("temporaryPath")
        if temp_path and Path(str(temp_path)).is_file():
            try:
                shutil.copyfile(temp_path, dest)
                saved_paths.append(dest)
            except OSError:
                pass
        elif item.get("contentBase64"):
            try:
                dest.write_bytes(base64.b64decode(item["contentBase64"]))
                saved_paths.append(dest)
            except (OSError, ValueError):
                pass

    for item in writing_artifacts:
        title = str(item.get("title") or "document").strip()
        name = sanitize_filename(title)
        if not name.endswith(".md"):
            name += ".md"
        if name in seen_names:
            base, ext = os.path.splitext(name)
            name = f"{base}_{len(seen_names)}{ext}"
        seen_names.add(name)
        dest = save_dir / name
        content = str(item.get("content") or "")
        try:
            dest.write_text(content + "\n", encoding="utf-8")
            saved_paths.append(dest)
        except OSError:
            pass

    return saved_paths


def format_attachments_section(saved_paths: list[Path]) -> str:
    if not saved_paths:
        return ""
    lines = ["\n\n---\n### 📎 첨부파일 (/tmp 저장됨)"]
    for path in saved_paths:
        lines.append(f"- `{path}`")
    return "\n".join(lines)


def assistant_from_conversation_payload(
    payload: dict[str, Any],
    outpost_id: str | None = None,
) -> dict[str, Any]:
    mapping = payload.get("mapping")
    if not isinstance(mapping, dict):
        return {"text": "", "finished": False, "writingBlocks": None, "attachments": None}
    current_node = payload.get("current_node")
    user_time: float | None = None
    child_ids: set[str] = set()
    user_found = False
    if outpost_id:
        for node in mapping.values():
            if not isinstance(node, dict):
                continue
            message = node.get("message")
            if not isinstance(message, dict):
                continue
            author = message.get("author") or {}
            if isinstance(author, dict) and author.get("role") == "user":
                if outpost_id in chatgpt_message_text(message):
                    user_time = float(message.get("create_time") or 0)
                    user_found = True
                    children = node.get("children") or []
                    if isinstance(children, list):
                        child_ids.update(child for child in children if isinstance(child, str))
                    break
        if not user_found:
            return {"text": "", "finished": False, "writingBlocks": None, "attachments": None}

    # Check current_node first if available
    if current_node and isinstance(mapping.get(current_node), dict):
        curr_entry = mapping[current_node]
        curr_msg = curr_entry.get("message")
        if isinstance(curr_msg, dict):
            curr_role = (curr_msg.get("author") or {}).get("role")
            curr_status = curr_msg.get("status")
            curr_end_turn = curr_msg.get("end_turn")
            curr_meta = curr_msg.get("metadata") or {}
            is_preamble = curr_meta.get("is_thinking_preamble_message") is True
            curr_is_complete = curr_meta.get("is_complete") is True or (
                isinstance(curr_meta.get("finish_details"), dict)
                and curr_meta.get("finish_details", {}).get("type") == "stop"
            )
            if curr_role == "tool" or curr_status == "in_progress" or curr_end_turn is False or is_preamble:
                # Still in progress or preamble
                pass
            elif curr_role == "assistant" and curr_status == "finished_successfully":
                if curr_end_turn is True or curr_is_complete:
                    txt = chatgpt_message_text(curr_msg).strip()
                    if txt:
                        return {
                            "text": txt,
                            "finished": True,
                            "writingBlocks": curr_meta.get("writing_blocks") or None,
                            "attachments": curr_meta.get("attachments") or None,
                        }

    # Check if any node in mapping is in_progress
    has_in_progress = any(
        isinstance(n, dict)
        and isinstance(n.get("message"), dict)
        and n.get("message", {}).get("status") == "in_progress"
        for n in mapping.values()
    )

    assistants: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for node_id, node in mapping.items():
        if not isinstance(node, dict):
            continue
        message = node.get("message")
        if not isinstance(message, dict):
            continue
        author = message.get("author") or {}
        if not isinstance(author, dict) or author.get("role") != "assistant":
            continue
        if not chatgpt_message_text(message).strip():
            continue
        meta = message.get("metadata") or {}
        if meta.get("is_thinking_preamble_message") is True:
            # Skip thinking preamble messages as final response candidates
            continue
        if outpost_id:
            later_than_user = user_time is not None and float(message.get("create_time") or 0) > user_time
            if node_id not in child_ids and not later_than_user:
                continue
        assistants.append((node_id, node, message))
    assistants.sort(key=lambda item: float(item[2].get("create_time") or 0))
    if not assistants:
        return {"text": "", "finished": False, "writingBlocks": None, "attachments": None}

    last_id, last_node, last = assistants[-1]
    last_meta = last.get("metadata") or {}

    if has_in_progress or last.get("end_turn") is False:
        return {
            "text": chatgpt_message_text(last).strip(),
            "finished": False,
            "writingBlocks": last_meta.get("writing_blocks") or None,
            "attachments": last_meta.get("attachments") or None,
        }

    children = last_node.get("children") or []
    if isinstance(children, list) and children:
        has_active_child = False
        for cid in children:
            cnode = mapping.get(cid)
            if isinstance(cnode, dict):
                cmsg = cnode.get("message")
                if isinstance(cmsg, dict):
                    crole = (cmsg.get("author") or {}).get("role")
                    cstatus = cmsg.get("status")
                    if cstatus == "in_progress" or crole == "tool":
                        has_active_child = True
                        break
        if has_active_child:
            return {
                "text": chatgpt_message_text(last).strip(),
                "finished": False,
                "writingBlocks": last_meta.get("writing_blocks") or None,
                "attachments": last_meta.get("attachments") or None,
            }

    is_complete = last_meta.get("is_complete") is True or (
        isinstance(last_meta.get("finish_details"), dict)
        and last_meta.get("finish_details", {}).get("type") == "stop"
    )
    finished = last.get("status") == "finished_successfully"
    if last.get("end_turn") is not None:
        finished = finished and (last.get("end_turn") is True)
    elif last_meta.get("is_complete") is not None:
        finished = finished and is_complete

    return {
        "text": chatgpt_message_text(last).strip(),
        "finished": bool(finished),
        "writingBlocks": last_meta.get("writing_blocks") or None,
        "attachments": last_meta.get("attachments") or None,
    }


def user_message_has_outpost_id(payload: dict[str, Any], outpost_id: str) -> bool:
    mapping = payload.get("mapping")
    if not outpost_id or not isinstance(mapping, dict):
        return False
    for node in mapping.values():
        if not isinstance(node, dict):
            continue
        message = node.get("message")
        if not isinstance(message, dict):
            continue
        author = message.get("author") or {}
        if isinstance(author, dict) and author.get("role") == "user":
            if outpost_id in chatgpt_message_text(message):
                return True
    return False


def build_backend_recovery_script(
    outpost_id: str,
    conversation_url: str | None,
    *,
    timeout_ms: int = 45_000,
    poll_interval_ms: int = 5_000,
    project_url: str | None = None,
    since: float = 0,
    until_found: bool = False,
) -> str:
    return f"""
var outpostId = {js(outpost_id)};
var conversationUrl = {js(conversation_url or "")};
var projectGizmoId = {js(project_gizmo_id(project_url))};
var since = {float(since or 0)};
var untilFound = {js(bool(until_found))};
var deadline = Date.now() + {int(timeout_ms)};
var pollIntervalMs = {int(poll_interval_ms)};
var recoveredModelSlug = '';
var home = await openTab('https://chatgpt.com/');
await home.waitForLoadState('domcontentloaded');
{ACCOUNT_HELPERS}
await ensureProjectAccount(home, projectGizmoId);
var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json();
if (!sess || !sess.accessToken) throw new Error('chatgpt session token missing');
var auth = {{ headers: {{ Authorization: 'Bearer ' + sess.accessToken }} }};
    var conversationId = (conversationUrl.match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
async function readConversation(id) {{
  var response = await fetch('https://chatgpt.com/backend-api/conversation/' + id, auth);
  if (!response.ok) return null;
  return response.json();
}}
function messageText(message) {{
  var parts = message && message.content && message.content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {{
    return typeof part === 'string' ? part : (part && part.text) || '';
  }}).join('');
}}
function assistantFrom(payload) {{
  var mapping = payload.mapping || {{}};
  var currentNode = payload.current_node;
  var userTime = 0;
  var userFound = false;
  var childIds = {{}};
  if (outpostId) {{
    Object.keys(mapping).forEach(function (id) {{
      var node = mapping[id];
      if (node && node.message && node.message.author && node.message.author.role === 'user' && messageText(node.message).includes(outpostId)) {{
        userTime = node.message.create_time || 0;
        userFound = true;
        (node.children || []).forEach(function (child) {{ childIds[child] = true; }});
      }}
    }});
    if (!userFound) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  }}
  if (currentNode && mapping[currentNode]) {{
    var curr = mapping[currentNode];
    var currMsg = curr && curr.message;
    if (currMsg) {{
      var role = currMsg.author && currMsg.author.role;
      var status = currMsg.status;
      var endTurn = currMsg.end_turn;
      var meta = currMsg.metadata || {{}};
      var isPreamble = meta.is_thinking_preamble_message === true;
      var isComplete = meta.is_complete === true || (meta.finish_details && meta.finish_details.type === 'stop');
      if (role === 'tool' || status === 'in_progress' || endTurn === false || isPreamble) {{
        // in progress or preamble
      }} else if (role === 'assistant' && status === 'finished_successfully') {{
        if (endTurn === true || isComplete) {{
          var txt = messageText(currMsg).trim();
          if (txt) {{
            recoveredModelSlug = meta.model_slug || recoveredModelSlug;
            return {{
              text: txt,
              finished: true,
              writingBlocks: meta.writing_blocks || null,
              attachments: meta.attachments || null
            }};
          }}
        }}
      }}
    }}
  }}
  var hasInProgress = Object.values(mapping).some(function (n) {{
    return n && n.message && n.message.status === 'in_progress';
  }});
  var assistants = Object.keys(mapping).map(function (id) {{
    return {{ id: id, node: mapping[id] }};
  }}).filter(function (entry) {{
    var node = entry.node;
    var meta = (node && node.message && node.message.metadata) || {{}};
    var isPreamble = meta.is_thinking_preamble_message === true;
    var later = userTime && node && node.message && (node.message.create_time || 0) > userTime;
    return node && node.message && node.message.author && node.message.author.role === 'assistant' && !isPreamble && messageText(node.message).trim() && (childIds[entry.id] || later);
  }}).sort(function (left, right) {{
    return (left.node.message.create_time || 0) - (right.node.message.create_time || 0);
  }});
  if (!assistants.length) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  var lastEntry = assistants[assistants.length - 1];
  var lastNode = lastEntry.node;
  var last = lastNode.message;
  var lastMeta = last.metadata || {{}};
  recoveredModelSlug = lastMeta.model_slug || recoveredModelSlug;
  if (hasInProgress || last.end_turn === false) {{
    return {{ text: messageText(last).trim(), finished: false, writingBlocks: lastMeta.writing_blocks || null, attachments: lastMeta.attachments || null }};
  }}
  if (Array.isArray(lastNode.children) && lastNode.children.length > 0) {{
    var hasActiveChild = lastNode.children.some(function (cid) {{
      var cnode = mapping[cid];
      return cnode && cnode.message && (cnode.message.status === 'in_progress' || (cnode.message.author && cnode.message.author.role === 'tool'));
    }});
    if (hasActiveChild) {{
      return {{ text: messageText(last).trim(), finished: false, writingBlocks: lastMeta.writing_blocks || null, attachments: lastMeta.attachments || null }};
    }}
  }}
  var isFinished = last.status === 'finished_successfully';
  if (last.end_turn !== undefined) {{
    isFinished = isFinished && (last.end_turn === true);
  }} else if (lastMeta.is_complete !== undefined) {{
    isFinished = isFinished && (lastMeta.is_complete === true);
  }}
  return {{
    text: messageText(last).trim(),
    finished: isFinished,
    writingBlocks: lastMeta.writing_blocks || null,
    attachments: lastMeta.attachments || null
  }};
}}
function userHasId(payload) {{
  return Object.values(payload.mapping || {{}}).some(function (node) {{
    return node && node.message && node.message.author && node.message.author.role === 'user' && messageText(node.message).includes(outpostId);
  }});
}}
// A project conversation is missing from the account-wide list, so the
// project's own list is where a new turn is found. `searched` is true only when
// every place the turn could be was read, so "not found" there means not sent.
var searched = false;
function touchedAt(item) {{
  var stamp = item.update_time || item.create_time || 0;
  return typeof stamp === 'number' ? stamp : Date.parse(stamp) / 1000;
}}
function recentEnough(item) {{
  return !since || !(touchedAt(item) < since);
}}
async function scanList(url) {{
  var list = await fetch(url, auth).catch(function () {{ return null; }});
  if (!list || !list.ok) return {{ complete: false, payload: null }};
  var body = await list.json().catch(function () {{ return null; }});
  var items = body && body.items;
  if (!Array.isArray(items)) return {{ complete: false, payload: null }};
  // The list is newest first. It covers the send only when it reaches past the
  // send's start or has no further page.
  var complete = !body.cursor || (since > 0 && items.some(function (item) {{
    return item && touchedAt(item) < since;
  }}));
  for (var i = 0; i < items.length; i += 1) {{
    if (!items[i] || !items[i].id || !recentEnough(items[i])) continue;
    var candidate = await readConversation(items[i].id).catch(function () {{ return null; }});
    if (!candidate) {{
      complete = false;
      continue;
    }}
    if (userHasId(candidate)) {{
      conversationId = items[i].id;
      return {{ complete: true, payload: candidate }};
    }}
  }}
  return {{ complete: complete, payload: null }};
}}
async function findConversation() {{
  searched = false;
  // The saved conversation first, then the one an earlier poll found.
  var savedId = conversationId;
  if (savedId) {{
    var saved = await readConversation(savedId).catch(function () {{ return null; }});
    if (saved && userHasId(saved)) {{
      conversationId = savedId;
      return saved;
    }}
    // A follow-up turn can only land in its saved conversation.
    if (saved && !projectGizmoId) searched = true;
  }}
  if (projectGizmoId) {{
    var project = await scanList('https://chatgpt.com/backend-api/gizmos/' + projectGizmoId + '/conversations?cursor=0');
    if (project.payload) return project.payload;
    searched = project.complete;
  }}
  var global = await scanList('https://chatgpt.com/backend-api/conversations?offset=0&limit=15&order=updated');
  if (global.payload) return global.payload;
  return null;
}}
var last = {{ ok: false, found: false, searched: false }};
while (Date.now() < deadline) {{
  var payload = await findConversation();
  if (payload && conversationId) {{
    if (untilFound) {{
      var located = assistantFrom(payload);
      last = {{
        ok: true,
        found: true,
        searched: true,
        responseText: located.text,
        finished: located.finished,
        idMatched: located.text.includes(outpostId),
        conversationUrl: 'https://chatgpt.com/c/' + conversationId,
        conversationId: conversationId,
        modelSlug: recoveredModelSlug
      }};
      break;
    }}
    var extracted = assistantFrom(payload);
    var writingArtifacts = [];
    if (extracted.writingBlocks) {{
      Object.keys(extracted.writingBlocks).forEach(function (wid) {{
        var wb = extracted.writingBlocks[wid];
        if (wb && wb.content) {{
          writingArtifacts.push({{
            id: wid,
            title: wb.title || ('artifact-' + wid),
            content: wb.content,
            variant: wb.variant || 'document'
          }});
        }}
      }});
    }}
    var downloadedFiles = [];
    if (Array.isArray(extracted.attachments)) {{
      for (var ai = 0; ai < extracted.attachments.length; ai += 1) {{
        var att = extracted.attachments[ai];
        if (att && att.id) {{
          try {{
            var dres = await fetch('https://chatgpt.com/backend-api/files/' + att.id + '/download', auth);
            if (dres.ok) {{
              var dj = await dres.json();
              if (dj.download_url) {{
                var fres = await fetch(dj.download_url);
                if (fres.ok) {{
                  var ab = await fres.arrayBuffer();
                  var b64 = Buffer.from(ab).toString('base64');
                  downloadedFiles.push({{
                    suggestedFilename: att.name || (att.id + '.bin'),
                    contentBase64: b64
                  }});
                }}
              }}
            }}
          }} catch (e) {{}}
        }}
      }}
    }}
    last = {{
      ok: true,
      found: true,
      searched: true,
      responseText: extracted.text,
      finished: extracted.finished,
      idMatched: extracted.text.includes(outpostId),
      conversationUrl: 'https://chatgpt.com/c/' + conversationId,
      conversationId: conversationId,
      writingArtifacts: writingArtifacts,
      downloadedFiles: downloadedFiles,
      modelSlug: recoveredModelSlug
    }};
    if (extracted.text && extracted.finished) break;
  }} else if (!last.found) {{
    last = {{ ok: false, found: false, searched: searched }};
  }}
  await sleep(pollIntervalMs);
}}
await closeTab(home).catch(function () {{}});
console.log({js(BACKEND_RECOVERY_MARKER)} + JSON.stringify(last));
""".strip()


def project_gizmo_id(project_url: str | None) -> str:
    """The `g-p-...` id of a project URL; the project's conversation list is keyed by it."""
    match = PROJECT_GIZMO_RE.search(urlparse(project_url or "").path)
    return match.group(1) if match else ""


def write_result(path: Path, data: dict[str, Any]) -> None:
    """Write result.json, keeping where the turn was sent from the pending write.

    `recover` finds a turn in its project; a later write that drops `projectUrl`
    sends it to the configured default project instead (2026-10-01: a 커리어 Pro
    turn was looked up in Work and never recovered).
    """
    try:
        prior = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        prior = {}
    kept = {key: prior[key] for key in ("projectUrl", "startedAt") if prior.get(key) and not data.get(key)}
    path.write_text(json.dumps({**data, **kept}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def backend_lookup(
    outpost_id: str,
    conversation_url: str | None = None,
    *,
    timeout: int = 45,
    poll_interval: int = 5,
    project_url: str | None = None,
    since: float = 0,
    until_found: bool = False,
) -> dict[str, Any] | None:
    """What the backend knows about the turn carrying this id; None when it could not be asked.

    One lookup stays under Aside's 120-second `aside repl` cut. A longer script
    loses its output and keeps polling inside the daemon after the caller gave
    up; repeated recovers then stack those pollers until ChatGPT answers 429.
    """
    if not outpost_id:
        return None
    timeout = max(1, min(int(timeout), REPL_LOOKUP_SECONDS))
    transcript = run_repl_process(
        build_backend_recovery_script(
            outpost_id,
            conversation_url,
            timeout_ms=timeout * 1000,
            poll_interval_ms=max(1, int(poll_interval)) * 1000,
            project_url=project_url,
            since=since,
            until_found=until_found,
        ),
        timeout=timeout + 15,
    )
    return marker_payload(transcript, BACKEND_RECOVERY_MARKER)


def recover_outpost_from_backend(
    outpost_id: str,
    conversation_url: str | None = None,
    *,
    timeout: int = 45,
    poll_interval: int = 5,
    project_url: str | None = None,
    since: float = 0,
    wait_between: float = 60,
    clock=time.monotonic,
    sleep=time.sleep,
) -> dict[str, Any] | None:
    """Wait up to `timeout` for the reply as short lookups with a pause between them."""
    deadline = clock() + max(1, int(timeout))
    while True:
        payload = backend_lookup(
            outpost_id,
            conversation_url,
            timeout=max(1, int(deadline - clock())),
            poll_interval=poll_interval,
            project_url=project_url,
            since=since,
        )
        found = payload if payload and payload.get("ok") else None
        if finished_backend_reply(found) or deadline - clock() <= wait_between:
            return found
        sleep(wait_between)


def locate_outpost_turn(
    outpost_id: str,
    *,
    project_url: str | None = None,
    conversation_url: str | None = None,
    since: float = 0,
    timeout: int = LOCATE_TIMEOUT_SECONDS,
) -> tuple[str, dict[str, Any] | None]:
    """Ground truth for "was it sent": `found`, `absent` or `unknown`.

    `absent` needs a complete read of every place the turn could be — the saved
    conversation for a follow-up, the project list for a new chat — polled long
    enough for a turn that was still committing. Anything less is `unknown`.
    """
    payload = backend_lookup(
        outpost_id,
        conversation_url,
        timeout=timeout,
        poll_interval=5,
        project_url=project_url,
        since=since,
        until_found=True,
    )
    if payload and payload.get("found") and payload.get("conversationUrl"):
        return "found", payload
    if payload and payload.get("searched"):
        return "absent", payload
    return "unknown", payload


def finished_backend_reply(payload: dict[str, Any] | None) -> bool:
    return bool(payload and payload.get("responseText") and payload.get("finished", True))


def confirm_model_slug(
    outpost_id: str,
    conversation_url: str | None,
    *,
    timeout: int = 25,
) -> str:
    """Ask ChatGPT which model produced this outpost turn."""
    payload = recover_outpost_from_backend(
        outpost_id,
        conversation_url=conversation_url,
        timeout=timeout,
        poll_interval=5,
    )
    return str((payload or {}).get("modelSlug") or "")


def required_model_slug(quality: str | None) -> str:
    return QUALITY_MODEL_SLUGS.get(str(quality or ""), QUALITY_MODEL_SLUGS["pro"])


def wrong_model_message(observed: str, response_path: Path, required: str) -> str:
    return (
        f"OUTPOST_WRONG_MODEL required={required} "
        f"observed={observed or 'unknown'} response={response_path}\n"
        "답변은 저장했지만 그 품질이 돌리는 모델이 아닙니다. ChatGPT 피커 "
        "계약을 다시 확인하세요 (outpost doctor)."
    )


# Aside's getByRole(role, {name}) resolves a string name but silently returns
# zero matches for a RegExp, and it matches the aria-label only — never a name
# that comes from the element's own text. The Pro pill and the model radios have
# no aria-label, so the send died at select-tier while doctor's click fallback
# covered for it. snapshot() prints the computed name, so resolve names there
# and act on the ref locator. String names compare exactly; RegExp names test.
# ChatGPT picks the workspace from the `_account` cookie. After the browser
# restarts it can fall back to the first workspace in the login's ordering, where
# the project does not exist (2026-10-01: a team workspace; every project and
# conversation read 404 and a Pro answer could not be recovered). Every script
# that reads or sends pins the workspace that can see the project first.
ACCOUNT_HELPERS = r"""
async function ensureProjectAccount(target, gizmoId) {
  if (!gizmoId) return '';
  var listUrl = 'https://chatgpt.com/backend-api/gizmos/' + gizmoId + '/conversations?cursor=0';
  async function token() {
    var s = await (await fetch('https://chatgpt.com/api/auth/session')).json().catch(() => null);
    return s && s.accessToken ? s : null;
  }
  async function visible(s) {
    var r = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + s.accessToken } }).catch(() => null);
    return r ? r.status : 0;
  }
  async function pin(id) {
    await target.evaluate((value) => {
      var tail = '; path=/; max-age=31536000; secure; samesite=lax';
      document.cookie = '_account=' + value + tail;
      document.cookie = '_account=' + value + '; domain=.chatgpt.com' + tail;
    }, id);
    // The session endpoint answers for the workspace the page was loaded with.
    await target.reload();
    await target.waitForLoadState('domcontentloaded');
  }
  var s = await token();
  if (!s) return '';
  var status = await visible(s);
  // Only "not found / no access" says the workspace is wrong; a rate limit or a
  // network error says nothing about it.
  if (status !== 403 && status !== 404) return '';
  var current = (s.account && s.account.id) || '';
  var check = await fetch('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
    headers: { Authorization: 'Bearer ' + s.accessToken }
  }).catch(() => null);
  var accounts = check && check.ok ? (((await check.json().catch(() => null)) || {}).accounts || {}) : {};
  // The access token is issued for one workspace, so another workspace is only
  // tried by switching the cookie and asking for a fresh session.
  for (var id of Object.keys(accounts)) {
    if (id === 'default' || id === current) continue;
    await pin(id);
    var next = await token();
    if (next && next.account && next.account.id === id && (await visible(next)) === 200) {
      console.log('OUTPOST_ACCOUNT switched from=' + current + ' to=' + id);
      return id;
    }
  }
  if (current) await pin(current);
  throw new Error('project ' + gizmoId + ' is not visible in any ChatGPT workspace of this login');
}
"""

NAME_LOOKUP_HELPERS = r"""
function findRefByName(tree, role, name) {
  var pattern = new RegExp('- ' + role + ' "([^"]*)" \\[ref=(e\\d+)\\]', 'g');
  var matched = null;
  var row;
  while ((row = pattern.exec(tree)) !== null) {
    var label = row[1];
    if (name instanceof RegExp ? name.test(label) : label === name) matched = row[2];
  }
  return matched;
}
async function waitNamedRef(target, role, name, timeoutMs) {
  var refDeadline = Date.now() + timeoutMs;
  while (true) {
    var tree = '';
    try { tree = (await snapshot(target, { interactive: true })).tree; } catch (error) {}
    var ref = findRefByName(tree, role, name);
    if (ref) return target.locator(ref);
    if (Date.now() >= refDeadline) return null;
    await sleep(500);
  }
}
"""


def build_repl_script(
    *,
    project_url: str,
    project_name: str = DEFAULT_PROJECT_NAME,
    quality: str,
    packet_name: str,
    packet_path: str,
    topic: str,
    outpost_id: str,
    response_timeout_ms: int,
    artifact_output: str | None = None,
    conversation_url: str | None = None,
    follow_up: bool = False,
    ui: dict[str, Any] | None = None,
    uploads: Sequence[dict[str, str]] | None = None,
    dry_run: bool = False,
) -> str:
    """`packet_path` and each upload's `path` are files staged by `stage_payload`."""
    ui = ui or UI.load_ui_map()
    target_labels = list(ui["tierLabels"].get(quality) or [])
    if not target_labels:
        raise ValueError(f"screen map has no tier label for quality {quality}")
    target_model = str(ui["modelRadio"])
    tier_pattern = tier_name_pattern(ui["tierButtonNames"])
    model_pattern = r"^" + re.escape(target_model) + r"$"
    composer_labels = composer_aria_labels(project_name, ui)
    enabled = ':not(:disabled):not([aria-disabled="true"]):not([data-visually-disabled])'
    continue_mode = bool(conversation_url)
    start_url = conversation_url or project_url
    expected_conversation_id = conversation_id_from_url(conversation_url) or ""
    return f"""
var projectUrl = {js(project_url)};
var startUrl = {js(start_url)};
var projectGizmoId = {js(project_gizmo_id(project_url))};
var continueMode = {js(continue_mode)};
var expectedConversationId = {js(expected_conversation_id)};
var outpostId = {js(outpost_id)};
var composerLabel = {js(" | ".join(composer_labels))};
var anyComposerSelector = {js(composer_selector(None, ui))};
var projectComposerSelector = {js(composer_selector(composer_labels, ui))};
var chatToggleSelector = {js(UI.css(ui["chatToggle"]))};
var workToggleSelector = {js(UI.css(ui["workToggle"]))};
var fileInputSelector = {js(UI.css(ui["fileInput"]))};
var sendSelector = {js(", ".join(sel + enabled for sel in ui["sendButton"]))};
var stopSelector = {js(UI.css(ui["stopButton"]))};
var copyResponseSelector = {js(UI.css(ui["copyResponse"]))};
var userMessageSelector = {js(UI.css(ui["userMessage"]))};
var assistantMessageSelector = {js(UI.css(ui["assistantMessage"]))};
var modelMenuNames = {js(list(ui["modelMenuNames"]))};
var tierPositionRe = new RegExp({js(ui["tierPositionPattern"])});
var quality = {js(quality)};
var packetName = {js(packet_name)};
var packetStem = {js(packet_name.rsplit(".", 1)[0])};
var packetFile = {js(packet_path)};
var extraUploads = {js(list(uploads or []))};
var artifactRequested = {js(artifact_output is not None)};
var composerPrompt = {js(build_composer_prompt(topic, outpost_id, artifact_output, follow_up=follow_up))};
var targetLabels = {js(target_labels)};
var targetLabel = targetLabels.join(' | ');
var tierSliderNames = {js(list(ui["tierSliderNames"]))};
var targetModel = {js(target_model)};
var tierNameRe = new RegExp({js(tier_pattern)});
var modelNameRe = new RegExp({js(model_pattern)});
var verifiedTier = null;
var dryRun = {js(dry_run)};
var modelRadiosSeen = [];
var submitStartedAt = Date.now();
var submitStage = 'load-staged-files';
var diagPage = null;
var diagEmitted = false;
var presubmitDone = false;
// Aside builds its role/accessible-name index inside snapshot(). getByRole()
// returns zero matches on a page that was never snapshotted in this REPL
// session, so every role lookup below primes the index first.
// waitRole() takes a string name only. Use waitNamedRef() when the name is a
// pattern or when the element carries no aria-label.
async function primeRoles(target) {{
  try {{ await snapshot(target, {{ interactive: true }}); }} catch (error) {{}}
}}
async function waitRole(target, role, name, timeoutMs) {{
  var roleDeadline = Date.now() + timeoutMs;
  while (true) {{
    await primeRoles(target);
    var located = target.getByRole(role, {{ name: name }});
    if ((await located.count()) > 0) return located;
    if (Date.now() >= roleDeadline) return null;
    await sleep(500);
  }}
}}
{NAME_LOOKUP_HELPERS}
{ACCOUNT_HELPERS}
async function bodyTextOf(target) {{
  return await target.evaluate(function () {{
    return (document.body && document.body.innerText || '').trim();
  }}).catch(function () {{ return ''; }});
}}
// A failed step leaves what the page showed at that moment, so doctor can hand
// it to the heal model instead of a person opening the page to look.
async function captureDiag(target) {{
  var diag = {{ stage: submitStage, url: '', title: '', tree: '', outline: [] }};
  try {{ diag.url = target.url(); }} catch (error) {{}}
  try {{ diag.title = await target.title(); }} catch (error) {{}}
  try {{
    // Sidebar conversation links fill the tree and are never a control the
    // send uses; everything else stays, one short line each.
    diag.tree = String((await snapshot(target, {{ interactive: true }})).tree || '')
      .split('\\n')
      .filter((line) => !/^\\s*- link /.test(line))
      .map((line) => line.slice(0, 160))
      .join('\\n')
      .slice(0, {DIAG_TREE_LIMIT});
  }} catch (error) {{}}
  try {{
    diag.outline = await target.evaluate(function () {{
      var seen = new Set();
      var rows = [];
      // The controls the send drives come first, so the size cap below never
      // cuts them: editors and file inputs, then submit and menu buttons and
      // toggles, then the rest of the form and any open menu.
      var groups = [
        '[contenteditable], textarea, input[type="file"]',
        'form button[type="submit"], button[aria-haspopup], [data-tpp-toggle-value]',
        '[role="menu"] [role], [role="menu"] button, [role="dialog"] button, form button, form [role]'
      ];
      groups.forEach(function (selector) {{
        document.querySelectorAll(selector).forEach(function (el) {{
          if (seen.has(el) || rows.length >= 120) return;
          if (el.closest('nav, a[href*="/c/"]')) return;
          seen.add(el);
          var box = el.getBoundingClientRect();
          rows.push({{
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            role: el.getAttribute('role') || undefined,
            aria: el.getAttribute('aria-label') || undefined,
            type: el.getAttribute('type') || undefined,
            accept: el.hasAttribute('accept') ? el.getAttribute('accept') : undefined,
            editable: el.getAttribute('contenteditable') || undefined,
            testid: el.getAttribute('data-testid') || undefined,
            checked: el.getAttribute('aria-checked') || undefined,
            disabled: (el.disabled || el.getAttribute('aria-disabled') === 'true') || undefined,
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30) || undefined,
            text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) || undefined,
            hidden: !(box.width || box.height) || undefined
          }});
        }});
      }});
      return rows;
    }});
  }} catch (error) {{}}
  while (diag.outline.length && JSON.stringify(diag.outline).length > {DIAG_OUTLINE_LIMIT}) {{
    diag.outline.pop();
  }}
  return diag;
}}
async function emitDiag() {{
  if (diagEmitted || !diagPage) return;
  diagEmitted = true;
  var diag = await Promise.race([
    captureDiag(diagPage),
    new Promise((resolve) => setTimeout(() => resolve(null), 15000))
  ]);
  if (diag) console.log({js(DIAG_MARKER)} + JSON.stringify(diag));
}}
async function waitComposer(target, selector, attempts) {{
  for (var composerAttempt = 0; composerAttempt < attempts; composerAttempt += 1) {{
    var candidate = target.locator(selector);
    try {{
      await candidate.waitFor({{ state: 'visible', timeout: 30000 }});
      return candidate;
    }} catch (error) {{}}
    var shown = await bodyTextOf(target);
    if (shown.indexOf('요청이 너무 많습니다') !== -1) {{
      throw new Error('ChatGPT rate-limited the project page');
    }}
    if (composerAttempt + 1 < attempts) {{
      await target.reload();
      await target.waitForLoadState('domcontentloaded');
      await sleep(2000);
      continue;
    }}
    if (/^Try again$/i.test(shown.slice(0, 40))) {{
      throw new Error(
        'ChatGPT did not render the page (client error "Try again") url=' + target.url()
      );
    }}
  }}
  return null;
}}
var submitState = await Promise.race([
  (async () => {{
    try {{
    // The bytes come from staged files, not the script: `aside repl` takes the
    // script as one command-line argument and macOS caps that at 1 MB.
    var uploadFiles = [{{ name: packetName, mimeType: 'text/markdown', buffer: await fs.readFile(packetFile) }}];
    for (var stagedUpload of extraUploads) {{
      uploadFiles.push({{ name: stagedUpload.name, mimeType: stagedUpload.mime, buffer: await fs.readFile(stagedUpload.path) }});
    }}
    submitStage = 'open-isolated-tab';
    var ownershipMarker = 'outpost-owner-' + {js(outpost_id)};
    var ownershipUrl = 'data:text/html,<title>' + ownershipMarker + '</title>';
    var workPage = await openTab(ownershipUrl);
    diagPage = workPage;
    var openedTabs = await listBrowserTabs();
    var ownedTabs = openedTabs.filter(
      (tab) => tab.title === ownershipMarker && tab.url === ownershipUrl
    );
    if (ownedTabs.length !== 1) throw new Error('isolated outpost tab ownership is ambiguous');
    var ownedTab = ownedTabs[0];
    submitStage = continueMode ? 'load-saved-conversation' : 'load-work-project';
    await workPage.goto(startUrl);
    await workPage.waitForLoadState('domcontentloaded');
    submitStage = 'select-account';
    if (await ensureProjectAccount(workPage, projectGizmoId)) {{
      submitStage = continueMode ? 'load-saved-conversation' : 'load-work-project';
      await workPage.goto(startUrl);
      await workPage.waitForLoadState('domcontentloaded');
    }}
    var composer;
    if (continueMode) {{
      submitStage = 'wait-conversation-composer';
      composer = await waitComposer(workPage, anyComposerSelector, 3);
      if (!composer) {{
        throw new Error(
          'saved conversation composer not visible url=' + workPage.url() +
          ' expectedConversationId=' + expectedConversationId +
          ' title=' + (await workPage.title())
        );
      }}
      if (expectedConversationId && workPage.url().indexOf('/c/' + expectedConversationId) === -1) {{
        throw new Error('continue landed off the saved conversation url=' + workPage.url());
      }}
      if (workPage.url().indexOf('/project') !== -1 && workPage.url().indexOf('/c/') === -1) {{
        throw new Error('continue redirected to project home url=' + workPage.url());
      }}
    }} else {{
      submitStage = 'wait-project-composer';
      composer = await waitComposer(workPage, projectComposerSelector, 3);
      if (!composer) {{
        var found = await workPage.locator(anyComposerSelector).evaluateAll((els) =>
          els.map((el) => ({{
            ariaLabel: el.getAttribute('aria-label'),
            contenteditable: el.getAttribute('contenteditable')
          }}))
        ).catch(() => []);
        throw new Error(
          'project composer not visible: expected ' + composerLabel +
          ' found ' + JSON.stringify(found) +
          ' url=' + workPage.url() +
          ' title=' + (await workPage.title())
        );
      }}
    }}
    var assistantCountBefore = await workPage.locator(assistantMessageSelector).count();
    if (!continueMode && assistantCountBefore !== 0) throw new Error('isolated Work composer contains stale assistant turns');
    if ((await bodyTextOf(workPage)).indexOf('요청이 너무 많습니다') !== -1) {{
      throw new Error('ChatGPT rate-limited the project page');
    }}
    submitStage = 'select-chat-surface';
    var chatToggle = workPage.locator(chatToggleSelector);
    var workToggle = workPage.locator(workToggleSelector);
    var chatToggleVisible = false;
    try {{
      await chatToggle.waitFor({{ state: 'visible', timeout: 3000 }});
      chatToggleVisible = true;
    }} catch (error) {{}}
    if (chatToggleVisible) {{
      if ((await chatToggle.getAttribute('aria-checked')) !== 'true') await chatToggle.click();
      var chatSelected = false;
      for (var i = 0; i < 20; i += 1) {{
        if (
          (await chatToggle.getAttribute('aria-checked')) === 'true' &&
          (await workToggle.getAttribute('aria-checked')) !== 'true'
        ) {{
          chatSelected = true;
          break;
        }}
        await sleep(200);
      }}
      if (!chatSelected) throw new Error('Chat surface not selected');
    }} else if (
      await workToggle.isVisible().catch(() => false) &&
      (await workToggle.getAttribute('aria-checked')) === 'true'
    ) {{
      throw new Error('Work mode selected and Chat toggle missing');
    }}
    composer = continueMode
      ? workPage.locator(anyComposerSelector)
      : workPage.locator(projectComposerSelector);
    await composer.waitFor({{ state: 'visible', timeout: 15000 }});
    submitStage = 'select-tier';
    // Closed Pro pill accessible name is quota+label, e.g. "6 Pro" or "6Pro".
    // The pill has no aria-label, so resolve its name off the snapshot tree.
    var tierButton = await waitNamedRef(workPage, 'button', tierNameRe, 20000);
    if (!tierButton) {{
      var foundTiers = await workPage.locator('button[aria-haspopup="menu"]').evaluateAll((els) =>
        els.map((el) => ({{
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
          visible: !!(el.offsetWidth || el.offsetHeight)
        }}))
      ).catch(() => []);
      throw new Error(
        'tier button not visible: expected ' + tierNameRe + ' found ' +
        JSON.stringify(foundTiers) +
        ' url=' + workPage.url()
      );
    }}
    await tierButton.click();
    submitStage = 'open-tier-slider';
    var performance = null;
    var sliderName = null;
    var sliderDeadline = Date.now() + 8000;
    while (!performance && Date.now() < sliderDeadline) {{
      for (var sliderIndex = 0; sliderIndex < tierSliderNames.length; sliderIndex += 1) {{
        performance = await waitRole(workPage, 'menuitem', tierSliderNames[sliderIndex], 0);
        if (performance) {{
          sliderName = tierSliderNames[sliderIndex];
          break;
        }}
      }}
      if (!performance) await sleep(500);
    }}
    if (!performance) throw new Error('performance menuitem not visible: expected ' + tierSliderNames.join(' | '));
    var readTier = (tree) => {{
      var match = tree.match(tierPositionRe);
      if (!match || !match.groups) return null;
      return {{
        label: match.groups.label.replace(/^.*text: "/, '').trim(),
        total: Number(match.groups.total),
        index: Number(match.groups.index)
      }};
    }};
    submitStage = 'read-tier';
    var tierSnapshot = await snapshot(workPage, {{ interactive: true }});
    var current = readTier(tierSnapshot.tree);
    if (!current) throw new Error('tier position not readable');
    submitStage = 'pick-tier';
    if (targetLabels.indexOf(current.label) === -1) {{
      await primeRoles(workPage);
      performance = workPage.getByRole('menuitem', {{ name: sliderName }});
      await performance.focus();
      for (var i = 0; i < current.total; i += 1) {{
        await workPage.keyboard.press('ArrowLeft');
      }}
      var found = false;
      var total = current.total;
      for (var i = 0; i < total; i += 1) {{
        current = readTier((await snapshot(workPage, {{ interactive: true }})).tree);
        if (!current) throw new Error('tier position not readable');
        if (targetLabels.indexOf(current.label) !== -1) {{
          found = true;
          break;
        }}
        if (i < total - 1) await workPage.keyboard.press('ArrowRight');
      }}
      if (!found) throw new Error('requested tier not verified');
    }}
    var selectedSnapshot = await snapshot(workPage, {{ interactive: true }});
    var selected = readTier(selectedSnapshot.tree);
    if (!selected || targetLabels.indexOf(selected.label) === -1) throw new Error('requested tier not verified');
    verifiedTier = selected.label + ' (' + selected.index + ' of ' + selected.total + ')';
    submitStage = 'open-model-menu';
    var modelMenu = null;
    var modelMenuDeadline = Date.now() + 8000;
    while (!modelMenu && Date.now() < modelMenuDeadline) {{
      for (var menuIndex = 0; menuIndex < modelMenuNames.length && !modelMenu; menuIndex += 1) {{
        modelMenu = await waitRole(workPage, 'menuitem', modelMenuNames[menuIndex], 0);
      }}
      if (!modelMenu) await sleep(500);
    }}
    if (!modelMenu) throw new Error('model menu not visible: expected ' + modelMenuNames.join(' | '));
    await modelMenu.click();
    submitStage = 'verify-model';
    // The model radio has no aria-label either; its name is its own text.
    var latest = await waitNamedRef(workPage, 'menuitemradio', modelNameRe, 8000);
    if (!latest) {{
      var foundRadios = await workPage.locator('[role="menuitemradio"]').evaluateAll((els) =>
        els.map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
      ).catch(() => []);
      throw new Error(
        targetModel + ' radio not visible; found ' + JSON.stringify(foundRadios)
      );
    }}
    if ((await latest.getAttribute('aria-checked')) !== 'true') await latest.click();
    if ((await latest.getAttribute('aria-checked')) !== 'true') throw new Error(targetModel + ' not checked');
    if (dryRun) {{
      // The rehearsal reports what the picker actually offers so doctor can
      // refresh the saved contract from the same walk the send performs.
      modelRadiosSeen = await workPage.locator('[role="menuitemradio"]').evaluateAll((els) =>
        els.map((el) => ({{
          name: (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim(),
          checked: el.getAttribute('aria-checked') === 'true'
        }})).filter((row) => row.name)
      ).catch(() => []);
    }}
    await workPage.keyboard.press('Escape');
    submitStage = 'fill-composer';
    await composer.focus();
    await composer.press('Meta+A');
    await composer.press('Backspace');
    await workPage.keyboard.insertText(composerPrompt);
    var composerValue = await composer.evaluate(
      (el) => Array.from(el.children).map((child) => child.textContent || '').join('\\n')
    );
    if (composerValue !== composerPrompt) throw new Error('composer prompt mismatch');
    submitStage = 'attach-packet';
    var fileInput = workPage.locator(fileInputSelector).first();
    var attachmentName = {js(outpost_id)};
    async function attachmentPresent(timeoutMs) {{
      var attachDeadline = Date.now() + timeoutMs;
      while (true) {{
        if (await waitRole(workPage, 'group', attachmentName, 0)) return true;
        // ChatGPT renames a name it has seen before to `outpost-<id>(1).md`,
        // so match the name without its extension.
        if ((await bodyTextOf(workPage)).indexOf(packetStem) !== -1) return true;
        if (Date.now() >= attachDeadline) return false;
        await sleep(1000);
      }}
    }}
    var attached = false;
    for (var attachAttempt = 0; attachAttempt < 2 && !attached; attachAttempt += 1) {{
      await fileInput.setInputFiles(uploadFiles);
      attached = await attachmentPresent(30000);
    }}
    if (!attached) throw new Error('packet attachment missing before send');
    submitStage = 'ready-to-send';
    var send = workPage.locator(sendSelector).first();
    await send.waitFor({{ state: 'visible', timeout: 60000 }});
    if (!(await attachmentPresent(10000))) {{
      await fileInput.setInputFiles(uploadFiles);
      if (!(await attachmentPresent(30000))) {{
        throw new Error('packet attachment missing before send');
      }}
    }}
    return {{ workPage, ownedTargetId: ownedTab.targetId, send, assistantCountBefore, composer }};
    }} catch (error) {{
      await emitDiag().catch(() => {{}});
      var failMessage = String(error && error.message || error);
      if (failMessage.indexOf('OUTPOST_FAIL stage=') === 0) throw error;
      throw new Error('OUTPOST_FAIL stage=' + submitStage + ' ' + failMessage);
    }}
  }})(),
  new Promise((_, reject) => setTimeout(async () => {{
    if (presubmitDone) return;
    var timedOutStage = submitStage;
    await emitDiag().catch(() => {{}});
    reject(new Error('OUTPOST_FAIL stage=' + timedOutStage + ' pre-submit preparation exceeded 110 seconds'));
  }}, 110000))
]);
presubmitDone = true;
var workPage = submitState.workPage;
if (dryRun) {{
  // The rehearsal is the send path minus the click: it proves every locator the
  // send needs, puts the project composer back, and creates no conversation.
  var rehearsal = {{
    ok: true,
    stage: 'ready-to-send',
    url: workPage.url(),
    expectedComposer: composerLabel,
    composerLabels: await workPage.locator(anyComposerSelector).evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label'))
    ).catch(() => []),
    tierInnerText: await workPage.locator('button[aria-haspopup="menu"]').evaluateAll((els) =>
      els.map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
    ).catch(() => []),
    tierLabel: targetLabel,
    tier: verifiedTier,
    model: targetModel,
    modelRadios: modelRadiosSeen,
    latestRadioPresent: modelRadiosSeen.some((row) => row.name === targetModel)
  }};
  try {{
    await submitState.composer.focus();
    await workPage.keyboard.press('Meta+A');
    await workPage.keyboard.press('Backspace');
  }} catch (error) {{}}
  await closeTab(workPage).catch(() => {{}});
  console.log({js(REHEARSAL_MARKER)} + JSON.stringify(rehearsal));
  throw new Error({js(REHEARSAL_STOP)});
}}
var assistantCountBefore = submitState.assistantCountBefore || 0;
var remainingSubmitMs = 120000 - (Date.now() - submitStartedAt);
if (remainingSubmitMs <= 0) throw new Error('pre-submit preparation exceeded 120 seconds');
submitStage = 'commit-user-turn';
// Aside resolves a locator once when it clicks and never waits: a send button
// that is disabled for a moment is "not found" and nothing is clicked.
await submitState.send.waitFor({{
  state: 'visible',
  timeout: Math.max(1, Math.min(30000, 120000 - (Date.now() - submitStartedAt)))
}}).catch(() => {{}});
// A click that throws proves nothing either way: the turn may already be out.
// The page decides below, and the runner asks the backend when it cannot.
var clickError = '';
try {{
  await submitState.send.click({{ timeout: Math.max(1, 120000 - (Date.now() - submitStartedAt)) }});
}} catch (error) {{
  clickError = String(error && error.message || error).slice(0, 300);
}}
remainingSubmitMs = Math.max(1, 120000 - (Date.now() - submitStartedAt));
var userTurn = workPage.locator(userMessageSelector).filter({{ hasText: {js(f"ID: {outpost_id}")} }}).last();
try {{
  await userTurn.waitFor({{
    state: 'visible',
    timeout: clickError ? Math.min({CLICK_ERROR_TURN_WAIT_MS}, remainingSubmitMs) : remainingSubmitMs
  }});
}} catch (error) {{
  if (clickError) {{
    throw new Error(
      'OUTPOST_FAIL stage=commit-user-turn send click failed and no user turn showed on the page: ' +
      clickError + ' url=' + workPage.url()
    );
  }}
  userTurn = workPage.locator(userMessageSelector).last();
  try {{
    await userTurn.waitFor({{ state: 'visible', timeout: 8000 }});
    var userText = await userTurn.innerText();
    if (
      !userText.includes({js(outpost_id)}) &&
      !userText.includes({js(f"outpost-{outpost_id}")})
    ) throw error;
  }} catch (inner) {{
    console.log({js(SUBMIT_UNKNOWN_MARKER)} + JSON.stringify({{
      id: {js(outpost_id)},
      quality,
      reason: 'send clicked but user turn commit was not verified before deadline',
      conversationUrl: workPage.url(),
      targetId: submitState.ownedTargetId
    }}));
    throw new Error('SUBMIT_UNKNOWN');
  }}
}}
var submitElapsedMs = Date.now() - submitStartedAt;
if (submitElapsedMs >= 120000) {{
  console.log({js(SUBMIT_UNKNOWN_MARKER)} + JSON.stringify({{
    id: {js(outpost_id)},
    quality,
    reason: 'user turn committed after 120-second deadline',
    conversationUrl: workPage.url(),
    targetId: submitState.ownedTargetId
  }}));
  throw new Error('SUBMIT_UNKNOWN');
}}
function conversationUrlFrom(url) {{
  var id = (String(url || '').match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
  return id ? ('https://chatgpt.com/c/' + id) : '';
}}
for (var i = 0; i < 80; i += 1) {{
  if (conversationUrlFrom(workPage.url())) break;
  await sleep(250);
}}
var submittedTabs = await listBrowserTabs();
var submittedTab = submittedTabs.find((tab) => tab.targetId === submitState.ownedTargetId);
var stickyConversationUrl = conversationUrlFrom(workPage.url())
  || conversationUrlFrom(submittedTab && submittedTab.url)
  || '';
var conversationId = (stickyConversationUrl.match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
console.log({js(SUBMIT_MARKER)} + JSON.stringify({{
  ok: true,
  quality,
  model: targetModel,
  tier: verifiedTier,
  submitElapsedMs,
  conversationUrl: stickyConversationUrl || (submittedTab ? submittedTab.url : workPage.url()),
  conversationId: conversationId,
  targetId: submitState.ownedTargetId,
  clickError: clickError
}}));
var responseStartedAt = Date.now();
var responseDeadline = responseStartedAt + {response_timeout_ms};
var remainingResponseMs = () => Math.max(1, responseDeadline - Date.now());
var recoveredFromBackend = false;
function messageTextFrom(message) {{
  var parts = message && message.content && message.content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(function (part) {{
    return typeof part === 'string' ? part : (part && part.text) || '';
  }}).join('');
}}
var observedModelSlug = '';
async function readAssistantFromBackend() {{
  if (!conversationId) {{
    conversationId = (conversationUrlFrom(workPage.url()).match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
  }}
  if (!conversationId) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json();
  if (!sess || !sess.accessToken) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  var cr = await fetch(
    'https://chatgpt.com/backend-api/conversation/' + conversationId,
    {{ headers: {{ Authorization: 'Bearer ' + sess.accessToken }} }}
  );
  if (!cr.ok) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  var payload = await cr.json();
  var mapping = payload.mapping || {{}};
  var currentNode = payload.current_node;
  var userTime = 0;
  var userFound = false;
  var childIds = {{}};
  Object.keys(mapping).forEach(function (id) {{
    var node = mapping[id];
    if (node && node.message && node.message.author && node.message.author.role === 'user' && messageTextFrom(node.message).includes(outpostId)) {{
      userTime = node.message.create_time || 0;
      userFound = true;
      (node.children || []).forEach(function (child) {{ childIds[child] = true; }});
    }}
  }});
  if (outpostId && !userFound) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};

  if (currentNode && mapping[currentNode]) {{
    var curr = mapping[currentNode];
    var currMsg = curr && curr.message;
    if (currMsg) {{
      var role = currMsg.author && currMsg.author.role;
      var status = currMsg.status;
      var endTurn = currMsg.end_turn;
      var meta = currMsg.metadata || {{}};
      var isPreamble = meta.is_thinking_preamble_message === true;
      var isComplete = meta.is_complete === true || (meta.finish_details && meta.finish_details.type === 'stop');
      if (role === 'tool' || status === 'in_progress' || endTurn === false || isPreamble) {{
        // in progress or preamble
      }} else if (role === 'assistant' && status === 'finished_successfully') {{
        if (endTurn === true || isComplete) {{
          var txt = messageTextFrom(currMsg).trim();
          if (txt) {{
            observedModelSlug = meta.model_slug || observedModelSlug;
            return {{
              text: txt,
              finished: true,
              writingBlocks: meta.writing_blocks || null,
              attachments: meta.attachments || null
            }};
          }}
        }}
      }}
    }}
  }}

  var hasInProgress = Object.values(mapping).some(function (n) {{
    return n && n.message && n.message.status === 'in_progress';
  }});

  var assistants = Object.keys(mapping).map(function (id) {{
    return {{ id: id, node: mapping[id] }};
  }}).filter(function (entry) {{
    var node = entry.node;
    var meta = (node && node.message && node.message.metadata) || {{}};
    var isPreamble = meta.is_thinking_preamble_message === true;
    var later = userTime && node && node.message && (node.message.create_time || 0) > userTime;
    return node && node.message && node.message.author && node.message.author.role === 'assistant' && !isPreamble && messageTextFrom(node.message).trim() && (childIds[entry.id] || later);
  }}).sort(function (left, right) {{
    return (left.node.message.create_time || 0) - (right.node.message.create_time || 0);
  }});
  if (!assistants.length) return {{ text: '', finished: false, writingBlocks: null, attachments: null }};
  var lastEntry = assistants[assistants.length - 1];
  var lastNode = lastEntry.node;
  var last = lastNode.message;
  var lastMeta = last.metadata || {{}};
  observedModelSlug = lastMeta.model_slug || observedModelSlug;
  if (hasInProgress || last.end_turn === false) {{
    return {{ text: messageTextFrom(last).trim(), finished: false, writingBlocks: lastMeta.writing_blocks || null, attachments: lastMeta.attachments || null }};
  }}
  if (Array.isArray(lastNode.children) && lastNode.children.length > 0) {{
    var hasActiveChild = lastNode.children.some(function (cid) {{
      var cnode = mapping[cid];
      return cnode && cnode.message && (cnode.message.status === 'in_progress' || (cnode.message.author && cnode.message.author.role === 'tool'));
    }});
    if (hasActiveChild) {{
      return {{ text: messageTextFrom(last).trim(), finished: false, writingBlocks: lastMeta.writing_blocks || null, attachments: lastMeta.attachments || null }};
    }}
  }}
  var isFinished = last.status === 'finished_successfully';
  if (last.end_turn !== undefined) {{
    isFinished = isFinished && (last.end_turn === true);
  }} else if (lastMeta.is_complete !== undefined) {{
    isFinished = isFinished && (lastMeta.is_complete === true);
  }}
  return {{
    text: messageTextFrom(last).trim(),
    finished: isFinished,
    writingBlocks: lastMeta.writing_blocks || null,
    attachments: lastMeta.attachments || null
  }};
}}
var stopButton = workPage.locator(stopSelector);
var assistant = workPage.locator(assistantMessageSelector).last();
// Live locators: a RegExp name or a heading name never resolves through
// getByRole() here, and these are re-checked on every poll.
var copyResponse = workPage.locator(copyResponseSelector).last();
var responseText = '';
var backendExtracted = null;
while (Date.now() < responseDeadline) {{
  var isGenerating = await stopButton.isVisible().catch(() => false);
  if (isGenerating) {{
    await sleep(3000);
    continue;
  }}
  var extracted = await readAssistantFromBackend();
  if (extracted && extracted.text && extracted.finished) {{
    responseText = extracted.text;
    backendExtracted = extracted;
    recoveredFromBackend = true;
    break;
  }}
  if ((await bodyTextOf(workPage)).indexOf('요청이 너무 많습니다') !== -1) {{
    await sleep(5000);
    continue;
  }}
  // Only use DOM fallback if backend explicitly finished or if backend extraction failed to find anything
  if (!extracted || (!extracted.text && !extracted.finished)) {{
    if ((await workPage.locator(assistantMessageSelector).count()) > assistantCountBefore) {{
      try {{
        await assistant.waitFor({{ state: 'visible', timeout: 1000 }});
        var liveText = (await assistant.innerText()).trim();
        var copyReady = await copyResponse.isVisible().catch(() => false);
        if (liveText && copyReady && !isGenerating) {{
          responseText = liveText;
          backendExtracted = extracted;
          break;
        }}
      }} catch (error) {{}}
    }}
  }}
  await sleep(3000);
}}
if (!responseText) throw new Error('assistant response text was empty');
var idMatched = responseText.includes({js(f"ID: {outpost_id}")}) || responseText.includes({js(outpost_id)});
var packetUnread = /첨부된 컨텍스트 패킷이|패킷이 현재 대화에 보이지|다시 첨부해/.test(responseText);

var downloadedFiles = [];
try {{
  var downloadCandidates = assistant.locator(
    'a[download], a[href*="/backend-api/files/"], a[href*="files.oaiusercontent.com"], ' +
    'button:has-text(".zip"), button:has-text(".csv"), button:has-text(".xlsx"), ' +
    'button:has-text(".pdf"), button:has-text(".json"), button:has-text(".py"), ' +
    'button:has-text(".txt"), button:has-text(".png"), button:has-text(".tar.gz")'
  );
  var candCount = await downloadCandidates.count().catch(() => 0);
  for (var i = 0; i < candCount; i += 1) {{
    try {{
      var cand = downloadCandidates.nth(i);
      var dlPromise = workPage.waitForEvent('download', {{ timeout: 8000 }});
      await cand.click({{ timeout: 4000 }});
      var dl = await dlPromise;
      var tempPath = await dl.path();
      if (tempPath) {{
        downloadedFiles.push({{
          temporaryPath: tempPath,
          suggestedFilename: dl.suggestedFilename()
        }});
      }}
    }} catch (e) {{}}
  }}
}} catch (e) {{}}

var artifact = null;
if (artifactRequested) {{
  var foundZip = downloadedFiles.find((f) => /\\.zip$/i.test(f.suggestedFilename));
  if (foundZip) {{
    artifact = foundZip;
  }} else if (!recoveredFromBackend) {{
    try {{
      var artifactButton = assistant.locator('button').filter({{ hasText: /\\.zip$/i }}).last();
      await artifactButton.waitFor({{ state: 'visible', timeout: Math.min(10000, remainingResponseMs()) }});
      var downloadPromise = workPage.waitForEvent('download', {{ timeout: Math.min(10000, remainingResponseMs()) }});
      await artifactButton.click({{ timeout: 5000 }});
      var download = await downloadPromise;
      var temporaryPath = await download.path();
      if (temporaryPath) {{
        artifact = {{
          temporaryPath: temporaryPath,
          suggestedFilename: download.suggestedFilename()
        }};
        downloadedFiles.push(artifact);
      }}
    }} catch (e) {{}}
  }}
}}

var writingArtifacts = [];
if (backendExtracted && backendExtracted.writingBlocks) {{
  var wbMap = backendExtracted.writingBlocks;
  Object.keys(wbMap).forEach(function (wid) {{
    var wb = wbMap[wid];
    if (wb && wb.content) {{
      writingArtifacts.push({{
        id: wid,
        title: wb.title || ('artifact-' + wid),
        content: wb.content,
        variant: wb.variant || 'document'
      }});
    }}
  }});
}}

if (backendExtracted && Array.isArray(backendExtracted.attachments)) {{
  for (var ai = 0; ai < backendExtracted.attachments.length; ai += 1) {{
    var att = backendExtracted.attachments[ai];
    if (att && att.id) {{
      try {{
        var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json();
        if (sess && sess.accessToken) {{
          var authH = {{ headers: {{ Authorization: 'Bearer ' + sess.accessToken }} }};
          var dres = await fetch('https://chatgpt.com/backend-api/files/' + att.id + '/download', authH);
          if (dres.ok) {{
            var dj = await dres.json();
            if (dj.download_url) {{
              var fres = await fetch(dj.download_url);
              if (fres.ok) {{
                var ab = await fres.arrayBuffer();
                var b64 = Buffer.from(ab).toString('base64');
                downloadedFiles.push({{
                  suggestedFilename: att.name || (att.id + '.bin'),
                  contentBase64: b64
                }});
              }}
            }}
          }}
        }}
      }} catch (e) {{}}
    }}
  }}
}}

var finalConversationUrl = conversationUrlFrom(workPage.url()) || stickyConversationUrl || workPage.url();
console.log({js(RESPONSE_MARKER)} + JSON.stringify({{
  ok: true,
  responseText,
  idMatched,
  packetUnread,
  recoveredFromBackend,
  artifact,
  downloadedFiles,
  writingArtifacts,
  responseElapsedMs: Date.now() - responseStartedAt,
  conversationUrl: finalConversationUrl,
  conversationId: conversationId,
  modelSlug: observedModelSlug
}}));
await closeTab(workPage).catch(() => {{}});
""".strip()


def zip_is_valid(path: Path) -> bool:
    try:
        with ZipFile(path) as archive:
            if not archive.namelist():
                return False
            bad_file = archive.testzip()
    except (BadZipFile, OSError):
        return False
    return bad_file is None


def aside_repl_ping(timeout: int = 10) -> bool:
    try:
        completed = subprocess.run(
            ["aside", "repl", 'console.log("ASIDE_REPL_PING")'],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return False
    return "ASIDE_REPL_PING" in (completed.stdout or "")


def ensure_aside_daemon() -> str | None:
    subprocess.run(["open", "-a", "Aside"], check=False)
    for _attempt in range(5):
        if aside_repl_ping():
            return wait_for_settled_daemon()
        time.sleep(2)
        subprocess.run(["open", "-a", "Aside"], check=False)
    return "aside daemon is not reachable"


def aside_daemon_health(timeout: float = 3.0) -> dict[str, Any] | None:
    """Aside's own readiness report, or None when the endpoint cannot be read."""
    try:
        with urlopen(ASIDE_HEALTH_URL, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def daemon_uptime_seconds(health: dict[str, Any] | None) -> float | None:
    if not health:
        return None
    started = str(health.get("startedAt") or "").strip()
    if not started:
        return None
    try:
        parsed = datetime.fromisoformat(started.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


def format_daemon_uptime(health: dict[str, Any] | None) -> str:
    if not health:
        return "unknown"
    uptime = daemon_uptime_seconds(health)
    if uptime is None:
        return "unknown"
    if uptime < 90:
        return f"{uptime:.0f}s"
    if uptime < 5400:
        return f"{uptime / 60:.0f}m"
    return f"{uptime / 3600:.1f}h"


def wait_for_settled_daemon(deadline_seconds: float = 90.0) -> str | None:
    """Hold a send until the daemon has been up long enough to be worth using.

    Only blocks on what the health endpoint actually reports: an unreachable
    endpoint is not evidence of an unstable daemon, so the caller proceeds.
    """
    end = time.monotonic() + deadline_seconds
    while True:
        health = aside_daemon_health()
        if health is None:
            return None
        uptime = daemon_uptime_seconds(health)
        if uptime is None or uptime >= DAEMON_SETTLE_SECONDS:
            return None
        if time.monotonic() >= end:
            return (
                f"aside daemon restarted {uptime:.0f}s ago and has not settled; "
                "a send now would race the restart"
            )
        time.sleep(3)


def transcript_lost_aside_daemon(transcript: str) -> bool:
    clean = ANSI_RE.sub("", transcript)
    return (
        "Aside daemon is not reachable" in clean
        or "other side closed" in clean
    )


def failure_reason_from(message: str) -> tuple[str, str]:
    """Stage name and a one-line reason from a failure message or a transcript."""
    text = ANSI_RE.sub("", str(message or ""))
    stage = ""
    detail = ""
    for line in text.splitlines():
        match = FAIL_STAGE_RE.search(line)
        if match:
            stage, detail = match.group(1), match.group(2).strip()
            continue
        if not stage:
            match = STAGE_IN_MESSAGE_RE.search(line)
            if match:
                stage = match.group(1)
    if not detail:
        detail = next((line.strip() for line in text.splitlines() if line.strip()), "")
    return stage, detail[:200]


def describe_pre_submit_failure(transcript: str) -> str:
    stage = ""
    detail = ""
    for line in transcript.splitlines():
        clean = ANSI_RE.sub("", line)
        match = FAIL_STAGE_RE.search(clean)
        if not match:
            continue
        stage = match.group(1)
        detail = match.group(2).strip()
    if not stage:
        header = "exit 75 — 전송 안 됨 (단계 불명)"
        return f"{header}\n\n{transcript}" if transcript else header
    hint = STAGE_HINTS.get(stage, "")
    label = f"{stage} ({hint})" if hint else stage
    header = f"exit 75 — 전송 안 됨\n단계: {label}"
    if detail:
        header += f"\n{detail}"
    return f"{header}\n\n{transcript}"


def run_repl_process(script: str, *, timeout: int) -> str:
    try:
        completed = subprocess.run(
            ["aside", "repl", script],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout + 10,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        return output
    return completed.stdout


def marker_payload(transcript: str, marker: str) -> dict[str, Any] | None:
    for line in transcript.splitlines():
        clean = ANSI_RE.sub("", line)
        if clean.startswith(marker):
            payload: dict[str, Any] = json.loads(clean[len(marker):])
            return payload
    return None


def nothing_typed_yet(stage: str) -> bool:
    """A step before the composer is filled cannot have sent anything."""
    rank = stage_rank(stage)
    return 0 <= rank < stage_rank("fill-composer")


def run_repl_outpost(
    script: str,
    *,
    submit_timeout: int,
    response_timeout: int,
    outpost_id: str = "",
    on_submit: Callable[[dict[str, Any]], None] | None = None,
    project_url: str | None = None,
    conversation_url: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], float, float, str]:
    """Run the send script; decide from the backend, not the error, whether it went out.

    A REPL that ends without the submit marker says nothing about the send by
    itself: a click can throw after the turn left, and the daemon can drop
    mid-click. Unless the script stopped before the composer held the prompt,
    the backend is asked for the turn by its id. Found means sent; a complete
    search that finds nothing means not sent; anything else is unknown.
    """
    timeout = submit_timeout + response_timeout + 30
    transcript = ""
    earlier = ""
    submit_payload = None
    since = time.time() - LOCATE_SINCE_SLACK_SECONDS
    for attempt in range(2):
        transcript = run_repl_process(script, timeout=timeout)
        submit_payload = marker_payload(transcript, SUBMIT_MARKER)
        if submit_payload is not None:
            break
        submit_unknown_payload = marker_payload(transcript, SUBMIT_UNKNOWN_MARKER)
        daemon_lost = transcript_lost_aside_daemon(transcript)
        stage, _detail = failure_reason_from(transcript)
        late_commit = "120-second" in str((submit_unknown_payload or {}).get("reason") or "")
        state, located = "unknown", None
        if submit_unknown_payload is None and nothing_typed_yet(stage):
            state = "absent"
        elif outpost_id and not late_commit:
            if daemon_lost:
                ensure_aside_daemon()
            state, located = locate_outpost_turn(
                outpost_id,
                project_url=project_url,
                conversation_url=conversation_url,
                since=since,
            )
        if state == "found":
            assert located is not None
            submit_payload = {
                "quality": "",
                "model": "GPT-6",
                "tier": "",
                "conversationUrl": located["conversationUrl"],
                "conversationId": located.get("conversationId") or "",
                "targetId": "",
                "submitElapsedMs": 0,
                "foundByBackend": True,
            }
            print(
                f"OUTPOST_SENT_DESPITE_ERROR stage={stage or '-'} url={located['conversationUrl']} "
                "— 보내기 단계가 오류로 끝났지만 백엔드에 이 ID의 턴이 있다. 보낸 것으로 보고 답을 회수한다.",
                file=sys.stderr,
                flush=True,
            )
            if on_submit is not None:
                on_submit(submit_payload)
            if located.get("responseText") and located.get("finished", True):
                return (
                    submit_payload,
                    {
                        "responseText": located["responseText"],
                        "idMatched": bool(located.get("idMatched")),
                        "packetUnread": False,
                        "recoveredFromBackend": True,
                        "responseElapsedMs": 0,
                        "conversationUrl": located["conversationUrl"],
                        "conversationId": located.get("conversationId") or "",
                        "modelSlug": located.get("modelSlug") or "",
                    },
                    0.0,
                    0.0,
                    earlier + transcript,
                )
            raise SubmittedResponseError(submit_payload, 0.0, earlier + transcript)
        if submit_unknown_payload is not None or state == "unknown":
            reason = (
                submit_unknown_payload
                or {
                    "reason": "the send step ended without proof either way and the backend "
                    "could not be searched completely",
                    "stage": stage or "",
                }
            )
            raise SubmitUnknownError(
                "submission state unknown; do not retry\n"
                + json.dumps(reason, ensure_ascii=False)
                + "\n"
                + earlier
                + transcript
            )
        verified = (
            ""
            if located is None
            else "backend: no turn with this id in the project; the packet was not sent\n"
        )
        if attempt == 0 and daemon_lost:
            earlier = transcript + "\n"
            if ensure_aside_daemon() is None:
                continue
        if daemon_lost:
            raise RuntimeError(
                describe_pre_submit_failure(
                    "aside daemon closed before submission; packet was not sent\n"
                    + verified
                    + earlier
                    + transcript
                )
            )
        raise RuntimeError(
            describe_pre_submit_failure(
                "Aside REPL exited before submission marker\n" + verified + transcript
            )
        )
    assert submit_payload is not None
    submit_elapsed = float(submit_payload["submitElapsedMs"]) / 1000
    print(
        f"OUTPOST_SUBMITTED quality={submit_payload['quality']} "
        f"elapsed={submit_elapsed:.3f}s url={submit_payload['conversationUrl']}",
        flush=True,
    )
    if on_submit is not None:
        on_submit(submit_payload)
    response_payload = marker_payload(transcript, RESPONSE_MARKER)
    if response_payload is None:
        raise SubmittedResponseError(
            submit_payload,
            submit_elapsed,
            transcript,
        )
    return (
        submit_payload,
        response_payload,
        submit_elapsed,
        float(response_payload["responseElapsedMs"]) / 1000,
        transcript,
    )



# Doctor checks the send path twice. A Pro rehearsal walks every pre-submit
# step with the Pro stop selected and stops at the click, so it spends no Pro
# quota. An xhigh send then really goes out and comes back — xhigh quota is not
# limited — which proves the click, the commit, and the answer recovery too.
# Any pre-submit step that cannot find its control is handed to the heal loop.
DOCTOR_TOPIC = "outpost 점검"
DOCTOR_PACKET = (
    "# outpost 점검\n\n"
    "전송 경로를 점검하는 패킷이다. 답변 첫 줄에 ID를 쓰고, 둘째 줄에 '점검 완료'라고만 써 달라.\n"
)
DOCTOR_RESPONSE_TIMEOUT_SECONDS = 600
STAGE_ORDER = tuple(STAGE_HINTS)
HEALABLE_STAGES = frozenset(STAGE_ORDER[STAGE_ORDER.index("wait-project-composer") : STAGE_ORDER.index("commit-user-turn")])


def stage_rank(stage: str) -> int:
    return STAGE_ORDER.index(stage) if stage in STAGE_ORDER else -1


def auto_heal_enabled() -> bool:
    return os.environ.get("OUTPOST_AUTO_HEAL", "1") != "0"


def failure_from_transcript(transcript: str) -> dict[str, Any]:
    stage, detail = failure_reason_from(transcript)
    return {
        "ok": False,
        "stage": stage or "rehearsal",
        "detail": detail,
        "diag": marker_payload(transcript, DIAG_MARKER),
        "daemonLost": transcript_lost_aside_daemon(transcript),
    }


def healable(failure: dict[str, Any]) -> bool:
    detail = str(failure.get("detail") or "")
    return (
        str(failure.get("stage") or "") in HEALABLE_STAGES
        and not failure.get("daemonLost")
        and "rate-limited" not in detail
    )


def rehearse(
    *,
    project_url: str,
    project_name: str,
    quality: str,
    conversation_url: str | None = None,
) -> dict[str, Any]:
    """Walk the send path for this quality up to the click; never send."""
    rehearsal_id = secrets.token_hex(8)
    try:
        with staged_payload(rehearsal_id, REHEARSAL_PACKET.encode("utf-8")) as (packet_path, _):
            script = build_repl_script(
                project_url=project_url,
                project_name=project_name,
                quality=quality,
                packet_name=f"outpost-{rehearsal_id}.md",
                packet_path=packet_path,
                topic=REHEARSAL_TOPIC,
                outpost_id=rehearsal_id,
                response_timeout_ms=1000,
                conversation_url=conversation_url,
                follow_up=bool(conversation_url),
                dry_run=True,
            )
            transcript = run_repl_process(script, timeout=SUBMIT_TIMEOUT_SECONDS)
    except (RuntimeError, OSError) as exc:
        return {"ok": False, "stage": "load-staged-files", "detail": str(exc)[:200]}
    payload = marker_payload(transcript, REHEARSAL_MARKER)
    if payload is not None:
        return {**payload, "ok": True, "stage": "ready-to-send"}
    return failure_from_transcript(transcript)


def build_hide_conversation_script(conversation_id: str) -> str:
    return f"""
var page = await openTab('https://chatgpt.com/');
await page.waitForLoadState('domcontentloaded');
var status = 0;
try {{
  var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json();
  var response = await fetch('https://chatgpt.com/backend-api/conversation/' + {js(conversation_id)}, {{
    method: 'PATCH',
    headers: {{ Authorization: 'Bearer ' + sess.accessToken, 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ is_visible: false }})
  }});
  status = response.status;
}} finally {{
  await closeTab(page).catch(() => {{}});
}}
console.log('OUTPOST_HIDE_RESULT ' + JSON.stringify({{ status: status }}));
""".strip()


def live_check(*, project_url: str, project_name: str) -> dict[str, Any]:
    """Send a throwaway packet on xhigh and read the answer back."""
    outpost_id = secrets.token_hex(16)
    try:
        with staged_payload(outpost_id, DOCTOR_PACKET.encode("utf-8")) as (packet_path, _):
            script = build_repl_script(
                project_url=project_url,
                project_name=project_name,
                quality="xhigh",
                packet_name=f"outpost-{outpost_id}.md",
                packet_path=packet_path,
                topic=DOCTOR_TOPIC,
                outpost_id=outpost_id,
                response_timeout_ms=DOCTOR_RESPONSE_TIMEOUT_SECONDS * 1000,
            )
            submit, response, _, response_elapsed, _ = run_repl_outpost(
                script,
                submit_timeout=SUBMIT_TIMEOUT_SECONDS,
                response_timeout=DOCTOR_RESPONSE_TIMEOUT_SECONDS,
                outpost_id=outpost_id,
                project_url=project_url,
            )
    except SubmitUnknownError as exc:
        return {"ok": False, "sent": True, "stage": "commit-user-turn", "detail": str(exc)[:200]}
    except SubmittedResponseError as exc:
        recovered = recover_outpost_from_backend(
            outpost_id,
            conversation_url=str(exc.submit_payload.get("conversationUrl") or "") or None,
            timeout=DOCTOR_RESPONSE_TIMEOUT_SECONDS,
            project_url=project_url,
        )
        if not finished_backend_reply(recovered):
            return {"ok": False, "sent": True, "stage": "await-response", "detail": "answer not recovered"}
        assert recovered is not None
        submit, response, response_elapsed = exc.submit_payload, recovered, 0.0
    except RuntimeError as exc:
        return {**failure_from_transcript(str(exc)), "sent": False}
    conversation_url = str(response.get("conversationUrl") or submit.get("conversationUrl") or "")
    slug = str(response.get("modelSlug") or "") or confirm_model_slug(outpost_id, conversation_url or None)
    required = QUALITY_MODEL_SLUGS["xhigh"]
    result = {
        "ok": slug == required and bool(response.get("idMatched")),
        "sent": True,
        "stage": "answered",
        "tier": str(submit.get("tier") or ""),
        "modelSlug": slug,
        "requiredModel": required,
        "idMatched": bool(response.get("idMatched")),
        "responseElapsedSeconds": round(float(response_elapsed or 0), 1),
    }
    if not result["ok"]:
        result["detail"] = (
            f"answered by {slug or 'unknown'} (want {required}), idMatched={result['idMatched']}"
        )
    conversation_id = conversation_id_from_url(conversation_url)
    if conversation_id:
        hidden = marker_payload(
            run_repl_process(build_hide_conversation_script(conversation_id), timeout=60),
            "OUTPOST_HIDE_RESULT ",
        )
        result["cleanedUp"] = bool(hidden and hidden.get("status") == 200)
    return result


def heal_screen_map(
    failure: dict[str, Any],
    verify: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    return UI.heal(
        failure=failure,
        verify=verify,
        stage_rank=stage_rank,
        stage_hint=lambda stage: STAGE_HINTS.get(stage, ""),
        log=lambda line: print(line, file=sys.stderr, flush=True),
    )


def format_step(name: str, result: dict[str, Any]) -> str:
    state = "ok" if result.get("ok") else "FAIL"
    line = f"{name} {state} stage={result.get('stage') or '-'}"
    if result.get("tier"):
        line += f" tier={result['tier']}"
    if result.get("modelSlug"):
        line += f" model={result['modelSlug']}"
    if result.get("healed"):
        line += f" healed_in={result['healed']}"
    if not result.get("ok") and result.get("detail"):
        line += f"\n  detail={result['detail']}"
    return line


def format_doctor_report(payload: dict[str, Any]) -> str:
    ok = bool(payload.get("ok"))
    lines = [
        f"OUTPOST_DOCTOR ok={'true' if ok else 'false'}",
        f"daemon up={payload.get('daemonUptime') or 'unknown'} "
        f"pid={payload.get('daemonPid') or '-'}",
    ]
    for name in ("pro", "xhigh"):
        step = payload.get(name)
        if step:
            lines.append(format_step("pro-rehearsal" if name == "pro" else "xhigh-send", step))
    if payload.get("uiMap"):
        lines.append(f"screen map {payload['uiMap']}")
    blockers = payload.get("blockers") or []
    if blockers:
        lines.append("blockers=" + ",".join(str(b) for b in blockers))
    if not ok:
        failed = [
            str(step.get("stage") or "")
            for step in (payload.get("pro"), payload.get("xhigh"))
            if step and not step.get("ok")
        ]
        if not failed:
            lines.append("exit 75 — Aside 데몬이 준비되지 않았다. 잠시 뒤 다시 돌려라.")
        elif any(stage_rank(stage) >= 0 or stage in {"answered", "await-response"} for stage in failed):
            lines.append("exit 75 — 전송 경로가 막혀 있고 자동 수리로도 풀리지 않았다. 코드 수정이 필요하다.")
        else:
            lines.append("exit 75 — Aside가 스크립트를 돌리지 못했다. 화면 문제가 아니다; 잠시 뒤 다시 돌려라.")
    return "\n".join(lines)


def run_doctor(args: argparse.Namespace) -> int:
    if not shutil.which("aside"):
        print("aside not found", file=sys.stderr)
        return 127
    config_path = resolve_config_path(args.config)
    project_url = (
        args.url
        or os.environ.get("OUTPOST_CHATGPT_URL")
        or os.environ.get("CONSULT_CHATGPT_URL")
        or read_config_value(config_path, "OUTPOST_CHATGPT_URL")
        or read_config_value(config_path, "CONSULT_CHATGPT_URL")
    )
    if not is_chatgpt_project_url(project_url):
        print("a verified ChatGPT project URL is required", file=sys.stderr)
        return 2
    assert isinstance(project_url, str)
    project_name = resolve_project_name(cli_value=args.project, config_path=config_path)
    if not project_name:
        print("a ChatGPT project name is required", file=sys.stderr)
        return 2
    daemon_error = ensure_aside_daemon()
    if daemon_error is not None:
        print(daemon_error, file=sys.stderr)
        return 75
    health = aside_daemon_health()
    heal = auto_heal_enabled() and not args.no_heal
    payload: dict[str, Any] = {"blockers": []}

    def once_more_if_aside_failed(check: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        result = check()
        # No stage means the script never ran a step: Aside was not answering,
        # not a changed screen. Wait for the daemon and run it once more.
        if (
            not result.get("ok")
            and not result.get("sent")
            and stage_rank(str(result.get("stage") or "")) < 0
            and ensure_aside_daemon() is None
        ):
            result = check()
        return result

    def check_pro() -> dict[str, Any]:
        return once_more_if_aside_failed(
            lambda: rehearse(project_url=project_url, project_name=project_name, quality="pro")
        )

    def check_live() -> dict[str, Any]:
        return once_more_if_aside_failed(
            lambda: live_check(project_url=project_url, project_name=project_name)
        )

    def check_xhigh_dry() -> dict[str, Any]:
        return rehearse(project_url=project_url, project_name=project_name, quality="xhigh")

    pro = check_pro()
    if not pro.get("ok") and heal and healable(pro):
        healed = heal_screen_map(pro, check_pro)
        pro = {**healed["result"], "healed": healed["attempts"]} if healed["ok"] else healed["result"]
    payload["pro"] = {k: v for k, v in pro.items() if k != "diag"}
    if not pro.get("ok"):
        payload["blockers"].append("pro-rehearsal")
    else:
        live = check_live()
        if not live.get("ok") and not live.get("sent") and heal and healable(live):
            healed = heal_screen_map(live, check_xhigh_dry)
            if healed["ok"]:
                live = {**check_live(), "healed": healed["attempts"]}
            else:
                live = healed["result"]
        payload["xhigh"] = {k: v for k, v in live.items() if k != "diag"}
        if not live.get("ok"):
            payload["blockers"].append("xhigh-send")
    payload["uiMap"] = str(UI.ui_map_path())
    payload["daemonUptime"] = format_daemon_uptime(health)
    payload["daemonPid"] = health.get("pid") if health else None
    if health is not None and health.get("ready") is not True:
        payload["blockers"].append("daemon-not-ready")
    payload["ok"] = not payload["blockers"]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(format_doctor_report(payload))
    return 0 if payload["ok"] else 75


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", choices=QUALITIES)
    parser.add_argument("--packet")
    parser.add_argument("--url", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--response-output", default=".outpost/outpost-response.md")
    parser.add_argument("--json-output", default=".outpost/aside-outpost-response.json")
    parser.add_argument("--stderr-output", default=".outpost/aside-outpost-stderr.log")
    parser.add_argument(
        "--artifact-output",
        default=None,
        help="Save one generated zip artifact here; uses the same Aside conversation.",
    )
    parser.add_argument(
        "--attach-input",
        action="append",
        default=None,
        help="Upload an extra input file with the packet; repeatable.",
    )
    parser.add_argument("--response-timeout", type=int, default=DEFAULT_RESPONSE_TIMEOUT_SECONDS)
    parser.add_argument(
        "--recover-from",
        default=None,
        help="Recover a committed outpost from a previous result.json. Never resends.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List stored outpost threads and their running/finished status.",
    )
    parser.add_argument(
        "--doctor",
        action="store_true",
        help="Rehearse Pro, send one xhigh round trip, and heal the screen map on failure.",
    )
    parser.add_argument(
        "--no-heal",
        action="store_true",
        help="Doctor only reports; it does not rewrite the screen map.",
    )
    parser.add_argument(
        "--thread",
        default=None,
        help="Continue a stored thread id, conversation id, result.json, or unique topic.",
    )
    parser.add_argument(
        "--conversation-url",
        default=None,
        help="Continue an existing chatgpt.com /c/ conversation.",
    )
    parser.add_argument("--sessions-file", default=None)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.list:
        if args.quality or args.packet or args.thread or args.conversation_url or args.recover_from or args.doctor:
            parser.error("--list cannot be combined with send, recover, or doctor flags")
        return args
    if args.doctor:
        if args.quality or args.packet or args.thread or args.conversation_url or args.recover_from:
            parser.error("--doctor cannot be combined with send or recover flags")
        return args
    if args.recover_from:
        if args.thread or args.conversation_url:
            parser.error("--recover-from cannot be combined with --thread or --conversation-url")
        return args
    if args.thread and args.conversation_url:
        parser.error("use exactly one of --thread or --conversation-url")
    if not args.quality or not args.packet:
        parser.error("--quality and --packet are required unless --list, --doctor, or --recover-from is set")
    if args.conversation_url and not SESSIONS.is_chatgpt_conversation_url(args.conversation_url):
        parser.error("--conversation-url must be an https://chatgpt.com/.../c/<id> URL")
    return args


def session_store_from_args(args: argparse.Namespace):
    return SESSIONS.SessionStore(SESSIONS.resolve_sessions_path(args.sessions_file))


def record_thread_outcome(
    store,
    thread: dict[str, Any] | None,
    *,
    status: str,
    outpost_id: str | None,
    conversation_url: str | None = None,
    target_id: str | None = None,
    response_output: str = "",
    json_output: str = "",
    submit_elapsed_seconds: float | None = None,
    failure_stage: str = "",
    failure_detail: str = "",
) -> None:
    if store is None or not thread:
        return
    try:
        store.finish_turn(
            thread["threadId"],
            status=status,
            outpost_id=outpost_id,
            conversation_url=conversation_url,
            target_id=target_id,
            response_output=response_output,
            json_output=json_output,
            submit_elapsed_seconds=submit_elapsed_seconds,
            failure_stage=failure_stage,
            failure_detail=failure_detail,
        )
    except SESSIONS.UnknownThreadError:
        return


def persisted_conversation_url(*values: str | None, thread: dict[str, Any] | None = None) -> str:
    extras: tuple[str | None, ...] = ()
    if thread:
        extras = (
            str(thread.get("conversationUrl") or "") or None,
            str(thread.get("conversationId") or "") or None,
        )
    return SESSIONS.preferred_conversation_url(*values, *extras)


def attach_thread_fields(
    evidence: dict[str, Any],
    thread: dict[str, Any] | None,
    mode: str,
) -> dict[str, Any]:
    attached = dict(evidence)
    if thread:
        attached["threadId"] = thread.get("threadId") or ""
        attached["mode"] = mode
    url = persisted_conversation_url(
        attached.get("conversationUrl"),
        attached.get("conversationId"),
        thread=thread,
    )
    if url:
        attached["conversationUrl"] = url
        attached["conversationId"] = SESSIONS.conversation_id_from_url(url) or ""
    return attached


def open_or_continue_thread(
    args: argparse.Namespace,
    *,
    topic: str,
    quality: str,
    project_name: str,
    outpost_id: str,
    packet_path: str,
):
    store = session_store_from_args(args)
    cwd = os.getcwd()
    pid = os.getpid()
    if args.thread or args.conversation_url:
        query = str(args.thread or args.conversation_url)
        thread = None
        try:
            thread = store.resolve(query)
        except SESSIONS.UnknownThreadError:
            if not args.conversation_url:
                raise
        if thread is None:
            thread = store.adopt_conversation(
                conversation_url=str(args.conversation_url),
                topic=topic,
                quality=quality,
                project_name=project_name,
                outpost_id=outpost_id,
                packet_path=packet_path,
                cwd=cwd,
                pid=pid,
            )
            return store, thread, store.thread_lock(thread["threadId"]), True, SESSIONS.thread_conversation_url(thread), False
        conversation_url = SESSIONS.thread_conversation_url(thread)
        if not SESSIONS.is_chatgpt_conversation_url(conversation_url):
            raise ValueError("thread has no saved conversation yet; cannot continue")
        return store, thread, store.thread_lock(thread["threadId"]), True, conversation_url, True
    thread = store.create_thread(
        topic=topic,
        quality=quality,
        project_name=project_name,
        outpost_id=outpost_id,
        packet_path=packet_path,
        cwd=cwd,
        pid=pid,
    )
    return store, thread, store.thread_lock(thread["threadId"]), False, None, False


def configured_project_url(args: argparse.Namespace) -> str | None:
    config_path = resolve_config_path(args.config)
    return (
        args.url
        or os.environ.get("OUTPOST_CHATGPT_URL")
        or os.environ.get("CONSULT_CHATGPT_URL")
        or read_config_value(config_path, "OUTPOST_CHATGPT_URL")
        or read_config_value(config_path, "CONSULT_CHATGPT_URL")
    )


def recover_from_saved_state(args: argparse.Namespace) -> int:
    evidence_path = Path(args.recover_from).expanduser()
    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    outpost_id = str(evidence.get("id") or "")
    if not outpost_id:
        print("recover-from is missing outpost id", file=sys.stderr)
        return 2
    required_slug = required_model_slug(evidence.get("quality"))
    daemon_error = ensure_aside_daemon()
    if daemon_error is not None:
        print(daemon_error, file=sys.stderr)
        return 75
    conversation_url = persisted_conversation_url(
        evidence.get("conversationUrl"),
        evidence.get("conversationId"),
    ) or None
    # A run that ended before its conversation was known (exit 76, or an older
    # run that wrongly said not sent) is found by its id in its project.
    project_url = str(evidence.get("projectUrl") or "") or configured_project_url(args) or None
    started_at = float(evidence.get("startedAt") or 0)
    since = started_at - LOCATE_SINCE_SLACK_SECONDS if started_at else 0
    response_path = Path(args.response_output).expanduser()
    json_path = Path(args.json_output).expanduser()
    stderr_path = Path(args.stderr_output).expanduser()
    for path in (response_path, json_path, stderr_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    if not conversation_url:
        state, located = locate_outpost_turn(outpost_id, project_url=project_url, since=since)
        if state == "found":
            assert located is not None
            conversation_url = str(located["conversationUrl"])
            print(f"OUTPOST_FOUND url={conversation_url} — 이 ID의 턴을 프로젝트에서 찾았다.", flush=True)
        else:
            status = "not_sent" if state == "absent" else "submit_unknown"
            write_result(json_path, {**evidence, "ok": False, "status": status})
            if state == "absent":
                message = (
                    "exit 75 — 프로젝트 어디에도 이 ID의 턴이 없다. 보내지 않은 것이니 "
                    "같은 패킷을 다시 보내도 된다."
                )
            else:
                message = (
                    "exit 76 — 이 ID의 턴을 찾지도, 없다고 확인하지도 못했다. 다시 보내지 말고 "
                    "잠시 뒤 recover를 다시 돌려라 (프로젝트가 다르면 --url)."
                )
            stderr_path.write_text(message + "\n", encoding="utf-8")
            print(message, file=sys.stderr)
            return NOT_SENT_EXIT if state == "absent" else SUBMIT_UNKNOWN_EXIT
    recovered = recover_outpost_from_backend(
        outpost_id,
        conversation_url=conversation_url,
        timeout=args.response_timeout,
        project_url=project_url,
        since=since,
    )
    if finished_backend_reply(recovered):
        assert recovered is not None
        saved_paths = save_outpost_attachments(
            outpost_id,
            recovered.get("downloadedFiles"),
            recovered.get("writingArtifacts"),
        )
        response_text = str(recovered["responseText"]) + format_attachments_section(saved_paths)
        response_path.write_text(response_text + "\n", encoding="utf-8")
        saved = {
            "ok": str(recovered.get("modelSlug") or "") == required_slug,
            "id": outpost_id,
            "topic": evidence.get("topic") or "",
            "quality": evidence.get("quality") or args.quality or "",
            "model": str(recovered.get("modelSlug") or "") or evidence.get("model") or "",
            "modelSlug": str(recovered.get("modelSlug") or ""),
            "modelOk": str(recovered.get("modelSlug") or "") == required_slug,
            "requiredModel": required_slug,
            "tier": evidence.get("tier") or "",
            "conversationUrl": recovered.get("conversationUrl") or conversation_url,
            "conversationId": recovered.get("conversationId") or evidence.get("conversationId") or "",
            "targetId": evidence.get("targetId") or "",
            "submitElapsedSeconds": evidence.get("submitElapsedSeconds") or 0,
            "responseElapsedSeconds": 0,
            "idMatched": bool(recovered.get("idMatched")),
            "packetUnread": False,
            "recoveredFromBackend": True,
            "responseOutput": str(response_path),
            "packetPath": evidence.get("packetPath") or "",
        }
        if saved_paths:
            saved["attachments"] = [str(p) for p in saved_paths]
            saved["attachmentsDir"] = str(Path(f"/tmp/outpost-{outpost_id}"))
        saved = attach_thread_fields(saved, {"threadId": evidence.get("threadId") or ""}, str(evidence.get("mode") or "recover"))
        saved["packetSha"] = str(evidence.get("packetSha") or "")
        if project_url:
            saved["projectUrl"] = project_url
        if evidence.get("startedAt"):
            saved["startedAt"] = evidence["startedAt"]
        write_result(json_path, saved)
        record_thread_outcome(
            session_store_from_args(args),
            {"threadId": evidence.get("threadId") or ""} if evidence.get("threadId") else None,
            status="finished",
            outpost_id=outpost_id,
            conversation_url=str(saved.get("conversationUrl") or ""),
            target_id=str(saved.get("targetId") or ""),
            response_output=str(response_path),
            json_output=str(json_path),
        )
        if saved_paths:
            print(f"OUTPOST_ATTACHMENTS dir=/tmp/outpost-{outpost_id} count={len(saved_paths)}", flush=True)
            for p in saved_paths:
                print(f"  - {p}", flush=True)
        recovered_state_slug = str(recovered.get("modelSlug") or "")
        if recovered_state_slug != required_slug:
            print(
                wrong_model_message(recovered_state_slug, response_path, required_slug),
                file=sys.stderr,
            )
            return WRONG_MODEL_EXIT
        print(
            f"OUTPOST_COMPLETE response={response_path} model={recovered_state_slug}",
            flush=True,
        )
        return 0
    stderr_path.write_text("backend recovery did not finish\n", encoding="utf-8")
    failed = attach_thread_fields(
        {
            **evidence,
            "ok": False,
            "status": "submitted_response_unavailable",
            "id": outpost_id,
        },
        {"threadId": evidence.get("threadId") or ""} if evidence.get("threadId") else None,
        str(evidence.get("mode") or "recover"),
    )
    write_result(json_path, failed)
    print(
        "submission committed but response recovery failed; recover the same conversation and do not resend",
        file=sys.stderr,
    )
    return 77


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if args.list:
        return SESSIONS.print_list(
            path=SESSIONS.resolve_sessions_path(args.sessions_file),
            as_json=args.json,
            limit=args.limit,
        )
    if args.doctor:
        return run_doctor(args)
    if not shutil.which("aside"):
        print("aside not found", file=sys.stderr)
        return 127
    if args.recover_from:
        return recover_from_saved_state(args)
    config_path = resolve_config_path(args.config)
    project_url = (
        args.url
        or os.environ.get("OUTPOST_CHATGPT_URL")
        or os.environ.get("CONSULT_CHATGPT_URL")
        or read_config_value(config_path, "OUTPOST_CHATGPT_URL")
        or read_config_value(config_path, "CONSULT_CHATGPT_URL")
    )
    if not is_chatgpt_project_url(project_url):
        print("a verified ChatGPT project URL is required", file=sys.stderr)
        return 2
    assert isinstance(project_url, str)
    project_name = resolve_project_name(
        cli_value=args.project,
        config_path=config_path,
    )
    if not project_name:
        print("a ChatGPT project name is required", file=sys.stderr)
        return 2
    packet_path = Path(args.packet).expanduser()
    try:
        raw_body = packet_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if not raw_body.strip():
        print("packet is empty", file=sys.stderr)
        return 2
    try:
        topic = extract_topic(raw_body)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    daemon_error = ensure_aside_daemon()
    if daemon_error is not None:
        print(daemon_error, file=sys.stderr)
        return 75
    packet_source = str(packet_path.resolve())
    try:
        uploads, upload_notes = build_uploads(args.attach_input or [])
    except (ValueError, OSError, BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if upload_notes:
        raw_body = (
            raw_body.rstrip()
            + "\n\n## 첨부 파일 이름 (업로드용 ASCII 이름 <- 원래 이름)\n\n"
            + "\n".join(f"- `{note}`" for note in upload_notes)
            + "\n"
        )
    outpost_id = secrets.token_hex(16)
    stderr_path = Path(args.stderr_output).expanduser()
    response_path = Path(args.response_output).expanduser()
    json_path = Path(args.json_output).expanduser()
    artifact_path = (
        Path(args.artifact_output).expanduser().resolve()
        if args.artifact_output
        else None
    )
    for path in (stderr_path, response_path, json_path, artifact_path):
        if path is None:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
    if artifact_path is not None:
        artifact_path.unlink(missing_ok=True)

    store = None
    thread = None
    follow_up = False
    conversation_url = None
    mode = "new"
    packet_sha = hashlib.sha256(raw_body.encode("utf-8")).hexdigest()
    if os.environ.get("OUTPOST_FORCE") != "1" and json_path.is_file():
        try:
            previous = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = None
        if isinstance(previous, dict) and str(previous.get("packetSha") or "") == packet_sha:
            previous_status = str(previous.get("status") or ("finished" if previous.get("ok") else ""))
            if previous.get("ok") or previous_status in {
                "submitted_pending",
                "submit_unknown",
                "submitted_response_unavailable",
                "submitted_artifact_unavailable",
                "finished",
            }:
                print(
                    "이 패킷은 이미 이 실행 디렉터리에서 보냈다 "
                    f"(id={previous.get('id') or '-'}, status={previous_status or 'finished'}). "
                    f"회수는 'outpost recover {json_path.parent}', "
                    "정말 다시 보내려면 OUTPOST_FORCE=1.",
                    file=sys.stderr,
                )
                return DUPLICATE_SEND_EXIT
    try:
        store, thread, thread_lock, follow_up, conversation_url, needs_start = open_or_continue_thread(
            args,
            topic=topic,
            quality=args.quality,
            project_name=project_name,
            outpost_id=outpost_id,
            packet_path=packet_source,
        )
    except SESSIONS.UnknownThreadError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except SESSIONS.AmbiguousThreadError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    except (SESSIONS.ThreadBusyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    mode = "continue" if follow_up else "new"
    started_at = time.time()
    print(
        f"OUTPOST_THREAD thread={thread.get('threadId') if thread else '-'} "
        f"mode={mode} url={conversation_url or '-'}",
        flush=True,
    )
    pending_evidence = {
        "ok": False,
        "status": "submitted_pending",
        "id": outpost_id,
        "topic": topic,
        "quality": args.quality,
        "requiredModel": required_model_slug(args.quality),
        "packetPath": packet_source,
        "packetSha": packet_sha,
        "responseOutput": str(response_path),
        "conversationUrl": conversation_url or "",
        "threadId": (thread or {}).get("threadId") or "",
        "mode": mode,
        # recover finds a turn by its id in this project even when nothing
        # else about the send was saved.
        "projectUrl": project_url,
        "startedAt": round(started_at, 3),
    }

    def write_pending(extra: dict[str, Any] | None = None) -> None:
        if extra:
            pending_evidence.update(extra)
        try:
            write_result(json_path, pending_evidence)
        except OSError:
            pass

    # Written before the send so a dead REPL, daemon restart, or killed parent
    # still leaves enough state for 'outpost recover' to pick the answer up.
    write_pending()

    def mark_submitted(payload: dict[str, Any]) -> None:
        write_pending(
            {
                "conversationUrl": SESSIONS.preferred_conversation_url(
                    str(payload.get("conversationUrl") or "") or None,
                    str(payload.get("conversationId") or "") or None,
                )
                or pending_evidence.get("conversationUrl")
                or "",
                "conversationId": str(payload.get("conversationId") or ""),
                "targetId": str(payload.get("targetId") or ""),
                "tier": str(payload.get("tier") or ""),
            }
        )
        if store is None or thread is None:
            return
        store.mark_submitted(
            thread["threadId"],
            conversation_url=SESSIONS.preferred_conversation_url(
                str(payload.get("conversationUrl") or "") or None,
                str(payload.get("conversationId") or "") or None,
            ) or None,
            target_id=str(payload.get("targetId") or "") or None,
            outpost_id=outpost_id,
        )

    staging: Path | None = None
    try:
        with thread_lock:
            if needs_start and thread is not None and store is not None:
                thread = store.start_turn(
                    thread["threadId"],
                    outpost_id=outpost_id,
                    topic=topic,
                    quality=args.quality,
                    mode=mode,
                    packet_path=packet_source,
                    pid=os.getpid(),
                )
            try:
                staging, staged_packet, staged_uploads = stage_payload(
                    aside_project_root(), outpost_id, raw_body.encode("utf-8"), uploads
                )
            except (RuntimeError, OSError) as exc:
                raise RuntimeError(f"OUTPOST_FAIL stage=load-staged-files {exc}") from exc
            def send_once():
                # The script is rebuilt on every attempt so a healed screen map
                # is what the retry looks up.
                return run_repl_outpost(
                    build_repl_script(
                        project_url=project_url,
                        project_name=project_name,
                        quality=args.quality,
                        packet_name=f"outpost-{outpost_id}.md",
                        packet_path=staged_packet,
                        topic=topic,
                        outpost_id=outpost_id,
                        response_timeout_ms=args.response_timeout * 1000,
                        artifact_output=str(artifact_path) if artifact_path else None,
                        conversation_url=conversation_url,
                        follow_up=follow_up,
                        uploads=staged_uploads,
                    ),
                    submit_timeout=SUBMIT_TIMEOUT_SECONDS,
                    response_timeout=args.response_timeout,
                    outpost_id=outpost_id,
                    on_submit=mark_submitted,
                    project_url=project_url,
                    conversation_url=conversation_url,
                )

            try:
                (
                    submit_payload,
                    response_payload,
                    submit_elapsed,
                    response_elapsed,
                    transcript,
                ) = send_once()
            except RuntimeError as first:
                # A plain RuntimeError here means the packet was not sent, so
                # healing the screen map and sending again cannot double-send.
                if isinstance(first, (SubmitUnknownError, SubmittedResponseError)):
                    raise
                failure = failure_from_transcript(str(first))
                if not (auto_heal_enabled() and healable(failure)):
                    raise
                print(
                    f"OUTPOST_HEAL start stage={failure['stage']} — 전송 전 단계라 보낸 것은 없다. "
                    "화면 지도를 고친 뒤 한 번 다시 보낸다.",
                    file=sys.stderr,
                    flush=True,
                )
                healed = heal_screen_map(
                    failure,
                    lambda: rehearse(
                        project_url=project_url,
                        project_name=project_name,
                        quality=args.quality,
                        conversation_url=conversation_url,
                    ),
                )
                if not healed["ok"]:
                    raise RuntimeError(
                        f"{first}\n\n자동 수리 {healed['attempts']}회로도 풀리지 않았다 "
                        f"(마지막 단계 {healed['result'].get('stage') or '-'})."
                    ) from first
                (
                    submit_payload,
                    response_payload,
                    submit_elapsed,
                    response_elapsed,
                    transcript,
                ) = send_once()
    except SESSIONS.ThreadBusyError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except SubmitUnknownError as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        print(
            f"exit 76 — 보냈는지 확인되지 않았다. 다시 보내지 말고 'outpost recover {json_path.parent}'로 "
            "이 ID의 턴을 프로젝트에서 찾아 회수하라.",
            file=sys.stderr,
        )
        stage, detail = failure_reason_from(exc)
        write_pending({"ok": False, "status": "submit_unknown", "failureStage": stage or "commit-user-turn"})
        record_thread_outcome(
            store,
            thread,
            status="failed",
            outpost_id=outpost_id,
            json_output=str(json_path),
            failure_stage=stage or "commit-user-turn",
            failure_detail=detail,
        )
        return SUBMIT_UNKNOWN_EXIT
    except SubmittedResponseError as exc:
        submitted = exc.submit_payload
        recovered = recover_outpost_from_backend(
            outpost_id,
            conversation_url=persisted_conversation_url(
                submitted.get("conversationUrl"),
                submitted.get("conversationId"),
                thread=thread,
            )
            or None,
            timeout=args.response_timeout,
            project_url=project_url,
            since=started_at - LOCATE_SINCE_SLACK_SECONDS,
        )
        if finished_backend_reply(recovered):
            saved_paths = save_outpost_attachments(
                outpost_id,
                recovered.get("downloadedFiles"),
                recovered.get("writingArtifacts"),
            )
            response_text = str(recovered["responseText"]) + format_attachments_section(saved_paths)
            response_path.write_text(response_text + "\n", encoding="utf-8")
            stderr_path.write_text(exc.transcript, encoding="utf-8")
            recovered_slug = str(recovered.get("modelSlug") or "")
            recovered_model_ok = recovered_slug == required_model_slug(args.quality)
            recovered_evidence = attach_thread_fields(
                {
                    "ok": recovered_model_ok,
                    "id": outpost_id,
                    "topic": topic,
                    "quality": args.quality,
                    "model": recovered_slug or submitted.get("model") or "",
                    "modelSlug": recovered_slug,
                    "modelOk": recovered_model_ok,
                    "requiredModel": required_model_slug(args.quality),
                    "tier": submitted.get("tier") or "",
                    "conversationUrl": persisted_conversation_url(
                        recovered.get("conversationUrl"),
                        submitted.get("conversationUrl"),
                        submitted.get("conversationId"),
                        thread=thread,
                    ),
                    "targetId": submitted.get("targetId") or "",
                    "submitElapsedSeconds": round(exc.submit_elapsed, 3),
                    "responseElapsedSeconds": 0,
                    "idMatched": bool(recovered.get("idMatched")),
                    "packetUnread": False,
                    "recoveredFromBackend": True,
                    "responseOutput": str(response_path),
                    "packetPath": packet_source,
                },
                thread,
                mode,
            )
            if saved_paths:
                recovered_evidence["attachments"] = [str(p) for p in saved_paths]
                recovered_evidence["attachmentsDir"] = str(Path(f"/tmp/outpost-{outpost_id}"))
            recovered_evidence["packetSha"] = packet_sha
            write_result(json_path, recovered_evidence)
            record_thread_outcome(
                store,
                thread,
                status="finished",
                outpost_id=outpost_id,
                conversation_url=persisted_conversation_url(
                    recovered.get("conversationUrl"),
                    submitted.get("conversationUrl"),
                    thread=thread,
                ),
                target_id=str(submitted.get("targetId") or ""),
                response_output=str(response_path),
                json_output=str(json_path),
                submit_elapsed_seconds=round(exc.submit_elapsed, 3),
            )
            if saved_paths:
                print(f"OUTPOST_ATTACHMENTS dir=/tmp/outpost-{outpost_id} count={len(saved_paths)}", flush=True)
                for p in saved_paths:
                    print(f"  - {p}", flush=True)
            if not recovered_model_ok:
                print(
                    wrong_model_message(
                        recovered_slug, response_path, required_model_slug(args.quality)
                    ),
                    file=sys.stderr,
                )
                return WRONG_MODEL_EXIT
            print(
                f"OUTPOST_COMPLETE response={response_path} model={recovered_slug}",
                flush=True,
            )
            return 0
        message = str(exc)
        stderr_path.write_text(
            message,
            encoding="utf-8",
        )
        evidence = attach_thread_fields(
            {
                "ok": False,
                "status": "submitted_response_unavailable",
                "id": outpost_id,
                "topic": topic,
                "quality": args.quality,
                "model": submitted["model"],
                "tier": submitted["tier"],
                "conversationUrl": persisted_conversation_url(
                    submitted.get("conversationUrl"),
                    submitted.get("conversationId"),
                    thread=thread,
                ),
                "targetId": submitted["targetId"],
                "submitElapsedSeconds": round(exc.submit_elapsed, 3),
                "packetPath": packet_source,
            },
            thread,
            mode,
        )
        evidence["packetSha"] = packet_sha
        write_result(json_path, evidence)
        record_thread_outcome(
            store,
            thread,
            status="submitted_response_unavailable",
            outpost_id=outpost_id,
            conversation_url=persisted_conversation_url(
                submitted.get("conversationUrl"),
                submitted.get("conversationId"),
                thread=thread,
            ),
            target_id=str(submitted.get("targetId") or ""),
            json_output=str(json_path),
            submit_elapsed_seconds=round(exc.submit_elapsed, 3),
            failure_stage=failure_reason_from(message)[0] or "recover-response",
            failure_detail=failure_reason_from(message)[1],
        )
        print(message, file=sys.stderr)
        return 77
    except (TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        stage, detail = failure_reason_from(exc)
        # Only a failure the runner proved unsent lands here: the step stopped
        # before the prompt was typed, or the backend has no turn with this id.
        # The run directory must not look sent: a resend is the fix, not a duplicate.
        write_pending({"ok": False, "status": "not_sent", "failureStage": stage or "pre-submit"})
        record_thread_outcome(
            store,
            thread,
            status="failed",
            outpost_id=outpost_id,
            json_output=str(json_path),
            failure_stage=stage or "pre-submit",
            failure_detail=detail,
        )
        return NOT_SENT_EXIT
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
    stderr_path.write_text(transcript, encoding="utf-8")
    saved_paths = save_outpost_attachments(
        outpost_id,
        response_payload.get("downloadedFiles"),
        response_payload.get("writingArtifacts"),
    )
    response_text = str(response_payload["responseText"]) + format_attachments_section(saved_paths)
    response_path.write_text(response_text + "\n", encoding="utf-8")
    artifact_copy_error = None
    if artifact_path is not None:
        try:
            artifact_payload = response_payload.get("artifact")
            if artifact_payload and artifact_payload.get("temporaryPath"):
                temporary_path = Path(str(artifact_payload["temporaryPath"]))
                if not temporary_path.is_file():
                    raise FileNotFoundError(temporary_path)
                shutil.copyfile(temporary_path, artifact_path)
            else:
                zip_saved = next((p for p in saved_paths if p.suffix.lower() == ".zip"), None)
                if zip_saved and zip_saved.is_file():
                    shutil.copyfile(zip_saved, artifact_path)
                else:
                    raise KeyError("artifact")
        except (KeyError, OSError, TypeError) as exc:
            artifact_copy_error = str(exc)
    if artifact_path is not None and (
        artifact_copy_error is not None or not zip_is_valid(artifact_path)
    ):
        message = f"zip verification failed: {artifact_path}"
        if artifact_copy_error is not None:
            message += f" ({artifact_copy_error})"
        stderr_path.write_text(transcript + "\n" + message + "\n", encoding="utf-8")
        evidence = attach_thread_fields(
            {
                "ok": False,
                "status": "submitted_artifact_unavailable",
                "id": outpost_id,
                "topic": topic,
                "quality": args.quality,
                "model": submit_payload["model"],
                "tier": submit_payload["tier"],
                "conversationUrl": persisted_conversation_url(
                    submit_payload.get("conversationUrl"),
                    response_payload.get("conversationUrl"),
                    submit_payload.get("conversationId"),
                    response_payload.get("conversationId"),
                    thread=thread,
                ),
                "targetId": submit_payload["targetId"],
                "submitElapsedSeconds": round(submit_elapsed, 3),
                "responseElapsedSeconds": round(response_elapsed, 3),
                "responseOutput": str(response_path),
                "packetPath": packet_source,
                "artifactOutput": str(artifact_path),
            },
            thread,
            mode,
        )
        evidence["packetSha"] = packet_sha
        write_result(json_path, evidence)
        record_thread_outcome(
            store,
            thread,
            status="submitted_response_unavailable",
            outpost_id=outpost_id,
            conversation_url=persisted_conversation_url(
                submit_payload.get("conversationUrl"),
                response_payload.get("conversationUrl"),
                thread=thread,
            ),
            target_id=str(submit_payload.get("targetId") or ""),
            response_output=str(response_path),
            json_output=str(json_path),
            submit_elapsed_seconds=round(submit_elapsed, 3),
            failure_stage=failure_reason_from(message)[0] or "await-response",
            failure_detail=failure_reason_from(message)[1],
        )
        print(message, file=sys.stderr)
        return 77
    model_slug = str(response_payload.get("modelSlug") or "")
    conversation_for_check = persisted_conversation_url(
        submit_payload.get("conversationUrl"),
        response_payload.get("conversationUrl"),
        submit_payload.get("conversationId"),
        response_payload.get("conversationId"),
        thread=thread,
    )
    if not model_slug:
        model_slug = confirm_model_slug(outpost_id, conversation_for_check or None)
    required_slug = required_model_slug(args.quality)
    model_ok = model_slug == required_slug
    evidence = attach_thread_fields(
        {
            "ok": model_ok,
            "id": outpost_id,
            "topic": topic,
            "quality": args.quality,
            "model": model_slug or submit_payload["model"],
            "modelSlug": model_slug,
            "modelOk": model_ok,
            "requiredModel": required_slug,
            "tier": submit_payload["tier"],
            "conversationUrl": persisted_conversation_url(
                submit_payload.get("conversationUrl"),
                response_payload.get("conversationUrl"),
                submit_payload.get("conversationId"),
                response_payload.get("conversationId"),
                thread=thread,
            ),
            "targetId": submit_payload["targetId"],
            "submitElapsedSeconds": round(submit_elapsed, 3),
            "responseElapsedSeconds": round(response_elapsed, 3),
            "idMatched": bool(response_payload.get("idMatched")),
            "packetUnread": bool(response_payload.get("packetUnread")),
            "recoveredFromBackend": bool(response_payload.get("recoveredFromBackend")),
            "responseOutput": str(response_path),
            "packetPath": packet_source,
        },
        thread,
        mode,
    )
    if artifact_path is not None:
        evidence["artifactOutput"] = str(artifact_path)
    if saved_paths:
        evidence["attachments"] = [str(p) for p in saved_paths]
        evidence["attachmentsDir"] = str(Path(f"/tmp/outpost-{outpost_id}"))
    evidence["packetSha"] = packet_sha
    write_result(json_path, evidence)
    record_thread_outcome(
        store,
        thread,
        status="finished",
        outpost_id=outpost_id,
        conversation_url=persisted_conversation_url(
            submit_payload.get("conversationUrl"),
            response_payload.get("conversationUrl"),
            submit_payload.get("conversationId"),
            response_payload.get("conversationId"),
            thread=thread,
        ),
        target_id=str(submit_payload.get("targetId") or ""),
        response_output=str(response_path),
        json_output=str(json_path),
        submit_elapsed_seconds=round(submit_elapsed, 3),
    )
    if saved_paths:
        print(f"OUTPOST_ATTACHMENTS dir=/tmp/outpost-{outpost_id} count={len(saved_paths)}", flush=True)
        for p in saved_paths:
            print(f"  - {p}", flush=True)
    if not model_ok:
        print(wrong_model_message(model_slug, response_path, required_slug), file=sys.stderr)
        return WRONG_MODEL_EXIT
    print(
        f"OUTPOST_COMPLETE response={response_path} model={model_slug}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
