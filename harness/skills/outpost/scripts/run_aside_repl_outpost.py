#!/usr/bin/env python3
"""Submit and recover a ChatGPT project outpost through deterministic Aside REPL calls."""

from __future__ import annotations

import argparse
import base64
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
from typing import Any, Callable, Sequence
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile


SUBMIT_TIMEOUT_SECONDS = 120
DEFAULT_RESPONSE_TIMEOUT_SECONDS = 3600
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
CONVERSATION_ID_RE = re.compile(r"/c/([0-9a-fA-F-]{8,})")
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


def composer_aria_label(project_name: str) -> str:
    return f"{project_name}에서 새 채팅"


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
) -> str:
    return f"""
var outpostId = {js(outpost_id)};
var conversationUrl = {js(conversation_url or "")};
var deadline = Date.now() + {int(timeout_ms)};
var pollIntervalMs = {int(poll_interval_ms)};
var home = await openTab('https://chatgpt.com/');
await home.waitForLoadState('domcontentloaded');
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
async function findConversation() {{
  var payload = conversationId ? await readConversation(conversationId) : null;
  if (payload && userHasId(payload)) return payload;
  var list = await fetch('https://chatgpt.com/backend-api/conversations?offset=0&limit=15&order=updated', auth);
  if (!list.ok) return payload && userHasId(payload) ? payload : null;
  var items = (await list.json()).items || [];
  for (var i = 0; i < items.length; i += 1) {{
    payload = await readConversation(items[i].id);
    if (payload && userHasId(payload)) {{
      conversationId = items[i].id;
      return payload;
    }}
  }}
  return null;
}}
var last = {{ ok: false }};
while (Date.now() < deadline) {{
  var payload = await findConversation();
  if (payload && conversationId) {{
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
      responseText: extracted.text,
      finished: extracted.finished,
      idMatched: extracted.text.includes(outpostId),
      conversationUrl: 'https://chatgpt.com/c/' + conversationId,
      conversationId: conversationId,
      writingArtifacts: writingArtifacts,
      downloadedFiles: downloadedFiles
    }};
    if (extracted.text && extracted.finished) break;
  }}
  await sleep(pollIntervalMs);
}}
await closeTab(home).catch(function () {{}});
console.log({js(BACKEND_RECOVERY_MARKER)} + JSON.stringify(last));
""".strip()


def recover_outpost_from_backend(
    outpost_id: str,
    conversation_url: str | None = None,
    *,
    timeout: int = 45,
    poll_interval: int = 5,
) -> dict[str, Any] | None:
    if not outpost_id:
        return None
    transcript = run_repl_process(
        build_backend_recovery_script(
            outpost_id,
            conversation_url,
            timeout_ms=max(1, int(timeout)) * 1000,
            poll_interval_ms=max(1, int(poll_interval)) * 1000,
        ),
        timeout=max(1, int(timeout)) + 15,
    )
    payload = marker_payload(transcript, BACKEND_RECOVERY_MARKER)
    if not payload or not payload.get("ok"):
        return None
    return payload


def finished_backend_reply(payload: dict[str, Any] | None) -> bool:
    return bool(payload and payload.get("responseText") and payload.get("finished", True))


def build_repl_script(
    *,
    project_url: str,
    project_name: str = DEFAULT_PROJECT_NAME,
    quality: str,
    packet_name: str,
    packet_base64: str,
    topic: str,
    outpost_id: str,
    response_timeout_ms: int,
    artifact_output: str | None = None,
    conversation_url: str | None = None,
    follow_up: bool = False,
) -> str:
    target_label = "Pro" if quality == "pro" else "매우 높음"
    composer_label = composer_aria_label(project_name)
    continue_mode = bool(conversation_url)
    start_url = conversation_url or project_url
    expected_conversation_id = conversation_id_from_url(conversation_url) or ""
    return f"""
var projectUrl = {js(project_url)};
var startUrl = {js(start_url)};
var continueMode = {js(continue_mode)};
var expectedConversationId = {js(expected_conversation_id)};
var outpostId = {js(outpost_id)};
var composerLabel = {js(composer_label)};
var quality = {js(quality)};
var packetName = {js(packet_name)};
var packetBase64 = {js(packet_base64)};
var artifactRequested = {js(artifact_output is not None)};
var composerPrompt = {js(build_composer_prompt(topic, outpost_id, artifact_output, follow_up=follow_up))};
var targetLabel = {js(target_label)};
var verifiedTier = null;
var submitStartedAt = Date.now();
var submitStage = 'open-isolated-tab';
var submitState = await Promise.race([
  (async () => {{
    var ownershipMarker = 'outpost-owner-' + {js(outpost_id)};
    var ownershipUrl = 'data:text/html,<title>' + ownershipMarker + '</title>';
    var workPage = await openTab(ownershipUrl);
    var openedTabs = await listBrowserTabs();
    var ownedTabs = openedTabs.filter(
      (tab) => tab.title === ownershipMarker && tab.url === ownershipUrl
    );
    if (ownedTabs.length !== 1) throw new Error('isolated outpost tab ownership is ambiguous');
    var ownedTab = ownedTabs[0];
    submitStage = continueMode ? 'load-saved-conversation' : 'load-work-project';
    await workPage.goto(startUrl);
    await workPage.waitForLoadState('domcontentloaded');
    var rateLimit = workPage.getByRole('heading', {{ name: '요청이 너무 많습니다' }});
    var composer;
    if (continueMode) {{
      submitStage = 'wait-conversation-composer';
      composer = workPage.locator('#prompt-textarea[contenteditable="true"]');
      try {{
        await Promise.race([
          composer.waitFor({{ state: 'visible', timeout: 60000 }}),
          rateLimit.waitFor({{ state: 'visible', timeout: 60000 }}).then(function () {{
            throw new Error('ChatGPT rate-limited the project page');
          }})
        ]);
      }} catch (error) {{
        if (String(error && error.message).indexOf('rate-limited') !== -1) throw error;
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
      composer = workPage.locator(
        '#prompt-textarea[contenteditable="true"][aria-label="' + composerLabel + '"]'
      );
      try {{
        await Promise.race([
          composer.waitFor({{ state: 'visible', timeout: 60000 }}),
          rateLimit.waitFor({{ state: 'visible', timeout: 60000 }}).then(function () {{
            throw new Error('ChatGPT rate-limited the project page');
          }})
        ]);
      }} catch (error) {{
        if (String(error && error.message).indexOf('rate-limited') !== -1) throw error;
        var found = await workPage.locator('#prompt-textarea').evaluateAll((els) =>
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
    var assistantCountBefore = await workPage.locator('[data-message-author-role="assistant"]').count();
    if (!continueMode && assistantCountBefore !== 0) throw new Error('isolated Work composer contains stale assistant turns');
    if (await rateLimit.isVisible().catch(() => false)) {{
      throw new Error('ChatGPT rate-limited the project page');
    }}
    submitStage = 'select-chat-surface';
    var chatToggle = workPage.locator('button[data-tpp-toggle-value="chatgpt"]');
    var workToggle = workPage.locator('button[data-tpp-toggle-value="work"]');
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
      ? workPage.locator('#prompt-textarea[contenteditable="true"]')
      : workPage.locator(
          '#prompt-textarea[contenteditable="true"][aria-label="' + composerLabel + '"]'
        );
    await composer.waitFor({{ state: 'visible', timeout: 15000 }});
    submitStage = 'select-tier';
    var tierButton = workPage.getByRole(
      'button',
      {{ name: /^(추론 수준|즉시|중간|높음|매우 높음|Pro)$/ }}
    ).last();
    await tierButton.waitFor({{ state: 'visible', timeout: 10000 }});
    await tierButton.click();
    var performance = workPage.getByRole('menuitem', {{ name: '성능' }});
    await performance.waitFor({{ state: 'visible', timeout: 5000 }});
    var readTier = (tree) => {{
      var match = tree.match(/([^\\n"]+), (\\d+)개 중 (\\d+)번째/);
      if (!match) return null;
      return {{
        label: match[1].replace(/^.*text: "/, '').trim(),
        total: Number(match[2]),
        index: Number(match[3])
      }};
    }};
    var tierSnapshot = await snapshot(workPage, {{ interactive: true }});
    var current = readTier(tierSnapshot.tree);
    if (!current) throw new Error('tier position not readable');
    if (current.label !== targetLabel) {{
      performance = workPage.getByRole('menuitem', {{ name: '성능' }});
      await performance.focus();
      for (var i = 0; i < current.total; i += 1) {{
        await workPage.keyboard.press('ArrowLeft');
      }}
      var found = false;
      var total = current.total;
      for (var i = 0; i < total; i += 1) {{
        current = readTier((await snapshot(workPage, {{ interactive: true }})).tree);
        if (!current) throw new Error('tier position not readable');
        if (current.label === targetLabel) {{
          found = true;
          break;
        }}
        if (i < total - 1) await workPage.keyboard.press('ArrowRight');
      }}
      if (!found) throw new Error('requested tier not verified');
    }}
    var selectedSnapshot = await snapshot(workPage, {{ interactive: true }});
    var selected = readTier(selectedSnapshot.tree);
    if (!selected || selected.label !== targetLabel) throw new Error('requested tier not verified');
    verifiedTier = selected.label + ' (' + selected.index + ' of ' + selected.total + ')';
    submitStage = 'verify-model';
    await workPage.getByRole('menuitem', {{ name: '모델 선택' }}).click();
    var sol = workPage.getByRole('menuitemradio', {{ name: /^(GPT-5\\.6 Sol|5\\.6 Sol)$/ }});
    await sol.waitFor({{ state: 'visible', timeout: 5000 }});
    if ((await sol.getAttribute('aria-checked')) !== 'true') await sol.click();
    if ((await sol.getAttribute('aria-checked')) !== 'true') throw new Error('5.6 Sol not checked');
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
    var fileInput = workPage.locator('#upload-files');
    var attachmentChip = workPage.getByRole('group', {{ name: {js(outpost_id)} }});
    var attached = false;
    for (var attachAttempt = 0; attachAttempt < 2 && !attached; attachAttempt += 1) {{
      await fileInput.setInputFiles([{{
        name: packetName,
        mimeType: 'text/markdown',
        buffer: Buffer.from(packetBase64, 'base64')
      }}]);
      try {{
        await attachmentChip.waitFor({{ state: 'visible', timeout: 30000 }});
        attached = true;
      }} catch (error) {{}}
    }}
    if (!attached) throw new Error('packet attachment missing before send');
    submitStage = 'ready-to-send';
    var send = workPage.locator(
      '#composer-submit-button:not(:disabled):not([aria-disabled="true"]):not([data-visually-disabled])'
    );
    await send.waitFor({{ state: 'visible', timeout: 60000 }});
    try {{
      await attachmentChip.waitFor({{ state: 'visible', timeout: 10000 }});
    }} catch (error) {{
      await fileInput.setInputFiles([{{
        name: packetName,
        mimeType: 'text/markdown',
        buffer: Buffer.from(packetBase64, 'base64')
      }}]);
      await attachmentChip.waitFor({{ state: 'visible', timeout: 30000 }});
    }}
    return {{ workPage, ownedTargetId: ownedTab.targetId, send, assistantCountBefore }};
  }})(),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('pre-submit preparation exceeded 110 seconds at ' + submitStage)),
    110000
  ))
]);
var workPage = submitState.workPage;
var assistantCountBefore = submitState.assistantCountBefore || 0;
var remainingSubmitMs = 120000 - (Date.now() - submitStartedAt);
if (remainingSubmitMs <= 0) throw new Error('pre-submit preparation exceeded 120 seconds');
submitStage = 'commit-user-turn';
await submitState.send.click({{ timeout: remainingSubmitMs }});
var userTurn = workPage.locator('[data-message-author-role="user"]').filter({{ hasText: {js(f"ID: {outpost_id}")} }}).last();
try {{
  await userTurn.waitFor({{ state: 'visible', timeout: remainingSubmitMs }});
}} catch (error) {{
  userTurn = workPage.locator('[data-message-author-role="user"]').last();
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
  model: 'GPT-5.6 Sol',
  tier: verifiedTier,
  submitElapsedMs,
  conversationUrl: stickyConversationUrl || (submittedTab ? submittedTab.url : workPage.url()),
  conversationId: conversationId,
  targetId: submitState.ownedTargetId
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
var stopButton = workPage.locator(
  'button[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]'
);
var assistant = workPage.locator('[data-message-author-role="assistant"]').last();
var copyResponse = workPage.getByRole('button', {{ name: /^(응답 복사|Copy response)$/ }}).last();
var rateLimitAfter = workPage.getByRole('heading', {{ name: '요청이 너무 많습니다' }});
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
  if (await rateLimitAfter.isVisible().catch(() => false)) {{
    await sleep(5000);
    continue;
  }}
  // Only use DOM fallback if backend explicitly finished or if backend extraction failed to find anything
  if (!extracted || (!extracted.text && !extracted.finished)) {{
    if ((await workPage.locator('[data-message-author-role="assistant"]').count()) > assistantCountBefore) {{
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
  conversationId: conversationId
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
            return None
        time.sleep(2)
        subprocess.run(["open", "-a", "Aside"], check=False)
    return "aside daemon is not reachable"


def transcript_lost_aside_daemon(transcript: str) -> bool:
    clean = ANSI_RE.sub("", transcript)
    return (
        "Aside daemon is not reachable" in clean
        or "other side closed" in clean
    )


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


def run_repl_outpost(
    script: str,
    *,
    submit_timeout: int,
    response_timeout: int,
    outpost_id: str = "",
    on_submit: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], float, float, str]:
    timeout = submit_timeout + response_timeout + 30
    transcript = ""
    earlier = ""
    submit_payload = None
    for attempt in range(2):
        transcript = run_repl_process(script, timeout=timeout)
        submit_unknown_payload = marker_payload(transcript, SUBMIT_UNKNOWN_MARKER)
        if submit_unknown_payload is not None:
            raise SubmitUnknownError(
                "submission state unknown; do not retry\n"
                + json.dumps(submit_unknown_payload, ensure_ascii=False)
                + "\n"
                + earlier
                + transcript
            )
        submit_payload = marker_payload(transcript, SUBMIT_MARKER)
        if submit_payload is not None:
            break
        recovered = None
        if outpost_id and (
            transcript_lost_aside_daemon(transcript) or "/c/" in transcript
        ):
            recovered = recover_outpost_from_backend(outpost_id)
        if recovered and recovered.get("conversationUrl"):
            submit_payload = {
                "quality": "",
                "model": "GPT-5.6 Sol",
                "tier": "",
                "conversationUrl": recovered["conversationUrl"],
                "targetId": "",
                "submitElapsedMs": 0,
            }
            if on_submit is not None:
                on_submit(submit_payload)
            if recovered.get("responseText") and recovered.get("finished", True):
                return (
                    submit_payload,
                    {
                        "responseText": recovered["responseText"],
                        "idMatched": bool(recovered.get("idMatched")),
                        "packetUnread": False,
                        "recoveredFromBackend": True,
                        "responseElapsedMs": 0,
                        "conversationUrl": recovered["conversationUrl"],
                    },
                    0.0,
                    0.0,
                    earlier + transcript,
                )
            raise SubmittedResponseError(submit_payload, 0.0, earlier + transcript)
        if attempt == 0 and transcript_lost_aside_daemon(transcript):
            earlier = transcript + "\n"
            if ensure_aside_daemon() is None:
                continue
        if transcript_lost_aside_daemon(transcript):
            raise RuntimeError(
                "aside daemon closed before submission; packet was not sent\n"
                + earlier
                + transcript
            )
        raise RuntimeError(
            "Aside REPL exited before submission marker\n" + transcript
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


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", choices=("xhigh", "pro"))
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
        if args.quality or args.packet or args.thread or args.conversation_url or args.recover_from:
            parser.error("--list cannot be combined with send or recover flags")
        return args
    if args.recover_from:
        if args.thread or args.conversation_url:
            parser.error("--recover-from cannot be combined with --thread or --conversation-url")
        return args
    if args.thread and args.conversation_url:
        parser.error("use exactly one of --thread or --conversation-url")
    if not args.quality or not args.packet:
        parser.error("--quality and --packet are required unless --list or --recover-from is set")
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
    daemon_error = ensure_aside_daemon()
    if daemon_error is not None:
        print(daemon_error, file=sys.stderr)
        return 75
    conversation_url = persisted_conversation_url(
        evidence.get("conversationUrl"),
        evidence.get("conversationId"),
    ) or None
    recovered = recover_outpost_from_backend(
        outpost_id,
        conversation_url=conversation_url,
        timeout=args.response_timeout,
    )
    response_path = Path(args.response_output).expanduser()
    json_path = Path(args.json_output).expanduser()
    stderr_path = Path(args.stderr_output).expanduser()
    for path in (response_path, json_path, stderr_path):
        path.parent.mkdir(parents=True, exist_ok=True)
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
            "ok": True,
            "id": outpost_id,
            "topic": evidence.get("topic") or "",
            "quality": evidence.get("quality") or args.quality or "",
            "model": evidence.get("model") or "GPT-5.6 Sol",
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
        json_path.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
        print(f"OUTPOST_COMPLETE response={response_path}", flush=True)
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
    json_path.write_text(json.dumps(failed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    packet_base64 = base64.b64encode(raw_body.encode("utf-8")).decode("ascii")
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
    print(
        f"OUTPOST_THREAD thread={thread.get('threadId') if thread else '-'} "
        f"mode={mode} url={conversation_url or '-'}",
        flush=True,
    )

    def mark_submitted(payload: dict[str, Any]) -> None:
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
            (
                submit_payload,
                response_payload,
                submit_elapsed,
                response_elapsed,
                transcript,
            ) = run_repl_outpost(
                build_repl_script(
                    project_url=project_url,
                    project_name=project_name,
                    quality=args.quality,
                    packet_name=f"outpost-{outpost_id}.md",
                    packet_base64=packet_base64,
                    topic=topic,
                    outpost_id=outpost_id,
                    response_timeout_ms=args.response_timeout * 1000,
                    artifact_output=str(artifact_path) if artifact_path else None,
                    conversation_url=conversation_url,
                    follow_up=follow_up,
                ),
                submit_timeout=SUBMIT_TIMEOUT_SECONDS,
                response_timeout=args.response_timeout,
                outpost_id=outpost_id,
                on_submit=mark_submitted,
            )
    except SESSIONS.ThreadBusyError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except SubmitUnknownError as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        record_thread_outcome(
            store,
            thread,
            status="failed",
            outpost_id=outpost_id,
            json_output=str(json_path),
        )
        return 76
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
            recovered_evidence = attach_thread_fields(
                {
                    "ok": True,
                    "id": outpost_id,
                    "topic": topic,
                    "quality": args.quality,
                    "model": submitted.get("model") or "GPT-5.6 Sol",
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
            json_path.write_text(
                json.dumps(recovered_evidence, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
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
            print(f"OUTPOST_COMPLETE response={response_path}", flush=True)
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
        json_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
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
        )
        print(message, file=sys.stderr)
        return 77
    except (TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        record_thread_outcome(
            store,
            thread,
            status="failed",
            outpost_id=outpost_id,
            json_output=str(json_path),
        )
        return 75
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
        json_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
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
        )
        print(message, file=sys.stderr)
        return 77
    evidence = attach_thread_fields(
        {
            "ok": True,
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
    json_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
    print(f"OUTPOST_COMPLETE response={response_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
