#!/usr/bin/env python3
"""Submit and recover a ChatGPT project consult through deterministic Aside REPL calls."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from typing import Any, Sequence
from urllib.parse import urlparse
from zipfile import BadZipFile, ZipFile


SUBMIT_TIMEOUT_SECONDS = 120
DEFAULT_RESPONSE_TIMEOUT_SECONDS = 3600
DEFAULT_CONFIG = Path.home() / ".codex" / "consult.env"
DEFAULT_PROJECT_NAME = "Work"
PROJECT_NAME_KEY = "CONSULT_PROJECT_NAME"
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
    consult_id: str,
    artifact_output: str | None,
) -> str:
    artifact_instruction = (
        "\n\n요청한 작업 결과는 zip 파일 하나로도 반환해 주세요."
        if artifact_output
        else ""
    )
    return (
        f"{topic}\n"
        f"ID: {consult_id}\n\n"
        "답변 첫 줄에 위 ID를 그대로 써 주세요.\n\n"
        f"{KOREAN_UPLOAD_PREAMBLE}{artifact_instruction}"
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
        or read_config_value(config_path, PROJECT_NAME_KEY)
        or DEFAULT_PROJECT_NAME
    )
    return raw.strip()


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


def assistant_from_conversation_payload(payload: dict[str, Any]) -> dict[str, Any]:
    assistants: list[dict[str, Any]] = []
    mapping = payload.get("mapping")
    if not isinstance(mapping, dict):
        return {"text": "", "finished": False}
    for node in mapping.values():
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
        assistants.append(message)
    assistants.sort(key=lambda item: float(item.get("create_time") or 0))
    if not assistants:
        return {"text": "", "finished": False}
    last = assistants[-1]
    return {
        "text": chatgpt_message_text(last).strip(),
        "finished": last.get("status") != "in_progress",
    }


def user_message_has_consult_id(payload: dict[str, Any], consult_id: str) -> bool:
    mapping = payload.get("mapping")
    if not consult_id or not isinstance(mapping, dict):
        return False
    for node in mapping.values():
        if not isinstance(node, dict):
            continue
        message = node.get("message")
        if not isinstance(message, dict):
            continue
        author = message.get("author") or {}
        if isinstance(author, dict) and author.get("role") == "user":
            if consult_id in chatgpt_message_text(message):
                return True
    return False


def build_backend_recovery_script(
    consult_id: str,
    conversation_url: str | None,
    *,
    timeout_ms: int = 45_000,
    poll_interval_ms: int = 5_000,
) -> str:
    return f"""
var consultId = {js(consult_id)};
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
  var nodes = Object.values(payload.mapping || {{}});
  var assistants = nodes.filter(function (node) {{
    return node && node.message && node.message.author && node.message.author.role === 'assistant' && messageText(node.message).trim();
  }}).sort(function (left, right) {{
    return (left.message.create_time || 0) - (right.message.create_time || 0);
  }});
  if (!assistants.length) return {{ text: '', finished: false }};
  var last = assistants[assistants.length - 1].message;
  return {{ text: messageText(last).trim(), finished: last.status !== 'in_progress' }};
}}
function userHasId(payload) {{
  return Object.values(payload.mapping || {{}}).some(function (node) {{
    return node && node.message && node.message.author && node.message.author.role === 'user' && messageText(node.message).includes(consultId);
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
    last = {{
      ok: true,
      responseText: extracted.text,
      finished: extracted.finished,
      idMatched: extracted.text.includes(consultId),
      conversationUrl: 'https://chatgpt.com/c/' + conversationId
    }};
    if (extracted.text && extracted.finished) break;
  }}
  await sleep(pollIntervalMs);
}}
await closeTab(home).catch(function () {{}});
console.log({js(BACKEND_RECOVERY_MARKER)} + JSON.stringify(last));
""".strip()


def recover_consult_from_backend(
    consult_id: str,
    conversation_url: str | None = None,
    *,
    timeout: int = 45,
    poll_interval: int = 5,
) -> dict[str, Any] | None:
    if not consult_id:
        return None
    transcript = run_repl_process(
        build_backend_recovery_script(
            consult_id,
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
    consult_id: str,
    response_timeout_ms: int,
    artifact_output: str | None = None,
) -> str:
    target_label = "Pro" if quality == "pro" else "매우 높음"
    composer_label = composer_aria_label(project_name)
    return f"""
var projectUrl = {js(project_url)};
var composerLabel = {js(composer_label)};
var quality = {js(quality)};
var packetName = {js(packet_name)};
var packetBase64 = {js(packet_base64)};
var artifactRequested = {js(artifact_output is not None)};
var composerPrompt = {js(build_composer_prompt(topic, consult_id, artifact_output))};
var targetLabel = {js(target_label)};
var verifiedTier = null;
var submitStartedAt = Date.now();
var submitStage = 'open-isolated-tab';
var submitState = await Promise.race([
  (async () => {{
    var ownershipMarker = 'consult-owner-' + {js(consult_id)};
    var ownershipUrl = 'data:text/html,<title>' + ownershipMarker + '</title>';
    var workPage = await openTab(ownershipUrl);
    var openedTabs = await listBrowserTabs();
    var ownedTabs = openedTabs.filter(
      (tab) => tab.title === ownershipMarker && tab.url === ownershipUrl
    );
    if (ownedTabs.length !== 1) throw new Error('isolated consult tab ownership is ambiguous');
    var ownedTab = ownedTabs[0];
    submitStage = 'load-work-project';
    await workPage.goto(projectUrl);
    await workPage.waitForLoadState('domcontentloaded');
    submitStage = 'wait-project-composer';
    var composer = workPage.locator(
      '#prompt-textarea[contenteditable="true"][aria-label="' + composerLabel + '"]'
    );
    var rateLimit = workPage.getByRole('heading', {{ name: '요청이 너무 많습니다' }});
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
    var assistantCountBefore = await workPage.locator('[data-message-author-role="assistant"]').count();
    if (assistantCountBefore !== 0) throw new Error('isolated Work composer contains stale assistant turns');
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
    composer = workPage.locator(
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
    var attachmentChip = workPage.getByRole('group', {{ name: {js(consult_id)} }});
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
    return {{ workPage, ownedTargetId: ownedTab.targetId, send }};
  }})(),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('pre-submit preparation exceeded 110 seconds at ' + submitStage)),
    110000
  ))
]);
var workPage = submitState.workPage;
var remainingSubmitMs = 120000 - (Date.now() - submitStartedAt);
if (remainingSubmitMs <= 0) throw new Error('pre-submit preparation exceeded 120 seconds');
submitStage = 'commit-user-turn';
await submitState.send.click({{ timeout: remainingSubmitMs }});
var userTurn = workPage.locator('[data-message-author-role="user"]').filter({{ hasText: {js(f"ID: {consult_id}")} }}).last();
try {{
  await userTurn.waitFor({{ state: 'visible', timeout: remainingSubmitMs }});
}} catch (error) {{
  userTurn = workPage.locator('[data-message-author-role="user"]').last();
  try {{
    await userTurn.waitFor({{ state: 'visible', timeout: 8000 }});
    var userText = await userTurn.innerText();
    if (
      !userText.includes({js(consult_id)}) &&
      !userText.includes({js(f"consult-{consult_id}")})
    ) throw error;
  }} catch (inner) {{
    console.log({js(SUBMIT_UNKNOWN_MARKER)} + JSON.stringify({{
      id: {js(consult_id)},
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
    id: {js(consult_id)},
    quality,
    reason: 'user turn committed after 120-second deadline',
    conversationUrl: workPage.url(),
    targetId: submitState.ownedTargetId
  }}));
  throw new Error('SUBMIT_UNKNOWN');
}}
for (var i = 0; i < 80; i += 1) {{
  if (workPage.url().indexOf('/c/') !== -1) break;
  await sleep(250);
}}
var submittedTabs = await listBrowserTabs();
var submittedTab = submittedTabs.find((tab) => tab.targetId === submitState.ownedTargetId);
console.log({js(SUBMIT_MARKER)} + JSON.stringify({{
  ok: true,
  quality,
  model: 'GPT-5.6 Sol',
  tier: verifiedTier,
  submitElapsedMs,
  conversationUrl: submittedTab ? submittedTab.url : workPage.url(),
  targetId: submitState.ownedTargetId
}}));
var responseStartedAt = Date.now();
var responseDeadline = responseStartedAt + {response_timeout_ms};
var remainingResponseMs = () => Math.max(1, responseDeadline - Date.now());
var conversationId = (workPage.url().match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
var recoveredFromBackend = false;
async function readAssistantFromBackend() {{
  if (!conversationId) {{
    conversationId = (workPage.url().match(/\\/c\\/([0-9a-fA-F-]{{8,}})/) || [])[1] || '';
  }}
  if (!conversationId) return {{ text: '', finished: false }};
  var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json();
  if (!sess || !sess.accessToken) return {{ text: '', finished: false }};
  var cr = await fetch(
    'https://chatgpt.com/backend-api/conversation/' + conversationId,
    {{ headers: {{ Authorization: 'Bearer ' + sess.accessToken }} }}
  );
  if (!cr.ok) return {{ text: '', finished: false }};
  var payload = await cr.json();
  var nodes = Object.values(payload.mapping || {{}});
  var assistants = nodes.filter(function (node) {{
    var parts = node && node.message && node.message.content && node.message.content.parts;
    return node && node.message && node.message.author && node.message.author.role === 'assistant' && Array.isArray(parts) && parts.join('').trim();
  }}).sort(function (left, right) {{
    return (left.message.create_time || 0) - (right.message.create_time || 0);
  }});
  if (!assistants.length) return {{ text: '', finished: false }};
  var last = assistants[assistants.length - 1].message;
  var parts = last.content && last.content.parts;
  var text = Array.isArray(parts) ? parts.map(function (part) {{
    return typeof part === 'string' ? part : (part && part.text) || '';
  }}).join('').trim() : '';
  return {{ text: text, finished: last.status !== 'in_progress' }};
}}
var assistant = workPage.locator('[data-message-author-role="assistant"]').last();
var copyResponse = workPage.getByRole('button', {{ name: /^(응답 복사|Copy response)$/ }}).last();
var rateLimitAfter = workPage.getByRole('heading', {{ name: '요청이 너무 많습니다' }});
var responseText = '';
while (Date.now() < responseDeadline) {{
  var extracted = await readAssistantFromBackend();
  if (extracted.text && extracted.finished) {{
    responseText = extracted.text;
    recoveredFromBackend = true;
    break;
  }}
  if (await rateLimitAfter.isVisible().catch(() => false)) {{
    await sleep(5000);
    continue;
  }}
  if ((await workPage.locator('[data-message-author-role="assistant"]').count()) > 0) {{
    try {{
      await assistant.waitFor({{ state: 'visible', timeout: 1000 }});
      var liveText = (await assistant.innerText()).trim();
      var copyReady = await copyResponse.isVisible().catch(() => false);
      if (liveText && (copyReady || extracted.finished)) {{
        responseText = liveText;
        break;
      }}
    }} catch (error) {{}}
  }}
  await sleep(3000);
}}
if (!responseText) throw new Error('assistant response text was empty');
var idMatched = responseText.includes({js(f"ID: {consult_id}")}) || responseText.includes({js(consult_id)});
var packetUnread = /첨부된 컨텍스트 패킷이|패킷이 현재 대화에 보이지|다시 첨부해/.test(responseText);
var artifact = null;
if (artifactRequested && !recoveredFromBackend) {{
  var artifactButton = assistant.locator('button').filter({{ hasText: /\\.zip$/i }}).last();
  await artifactButton.waitFor({{ state: 'visible', timeout: remainingResponseMs() }});
  var downloadPromise = workPage.waitForEvent('download', {{ timeout: remainingResponseMs() }});
  await artifactButton.click({{ timeout: remainingResponseMs() }});
  var download = await downloadPromise;
  var temporaryPath = await download.path();
  if (!temporaryPath) throw new Error('artifact download path unavailable');
  artifact = {{
    temporaryPath,
    suggestedFilename: download.suggestedFilename()
  }};
}}
var finalConversationUrl = workPage.url();
console.log({js(RESPONSE_MARKER)} + JSON.stringify({{
  ok: true,
  responseText,
  idMatched,
  packetUnread,
  recoveredFromBackend,
  artifact,
  responseElapsedMs: Date.now() - responseStartedAt,
  conversationUrl: finalConversationUrl
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


def run_repl_consult(
    script: str,
    *,
    submit_timeout: int,
    response_timeout: int,
    consult_id: str = "",
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
        if consult_id and (
            transcript_lost_aside_daemon(transcript) or "/c/" in transcript
        ):
            recovered = recover_consult_from_backend(consult_id)
        if recovered and recovered.get("conversationUrl"):
            submit_payload = {
                "quality": "",
                "model": "GPT-5.6 Sol",
                "tier": "",
                "conversationUrl": recovered["conversationUrl"],
                "targetId": "",
                "submitElapsedMs": 0,
            }
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
        f"CONSULT_SUBMITTED quality={submit_payload['quality']} "
        f"elapsed={submit_elapsed:.3f}s url={submit_payload['conversationUrl']}",
        flush=True,
    )
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
    parser.add_argument("--response-output", default=".consult/consult-response.md")
    parser.add_argument("--json-output", default=".consult/aside-consult-response.json")
    parser.add_argument("--stderr-output", default=".consult/aside-consult-stderr.log")
    parser.add_argument(
        "--artifact-output",
        default=None,
        help="Save one generated zip artifact here; uses the same Aside conversation.",
    )
    parser.add_argument("--response-timeout", type=int, default=DEFAULT_RESPONSE_TIMEOUT_SECONDS)
    parser.add_argument(
        "--recover-from",
        default=None,
        help="Recover a committed consult from a previous result.json. Never resends.",
    )
    args = parser.parse_args(argv)
    if args.recover_from:
        return args
    if not args.quality or not args.packet:
        parser.error("--quality and --packet are required unless --recover-from is set")
    return args


def recover_from_saved_state(args: argparse.Namespace) -> int:
    evidence_path = Path(args.recover_from).expanduser()
    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    consult_id = str(evidence.get("id") or "")
    if not consult_id:
        print("recover-from is missing consult id", file=sys.stderr)
        return 2
    daemon_error = ensure_aside_daemon()
    if daemon_error is not None:
        print(daemon_error, file=sys.stderr)
        return 75
    recovered = recover_consult_from_backend(
        consult_id,
        conversation_url=str(evidence.get("conversationUrl") or "") or None,
        timeout=args.response_timeout,
    )
    response_path = Path(args.response_output).expanduser()
    json_path = Path(args.json_output).expanduser()
    stderr_path = Path(args.stderr_output).expanduser()
    for path in (response_path, json_path, stderr_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    if finished_backend_reply(recovered):
        assert recovered is not None
        response_path.write_text(str(recovered["responseText"]) + "\n", encoding="utf-8")
        saved = {
            "ok": True,
            "id": consult_id,
            "topic": evidence.get("topic") or "",
            "quality": evidence.get("quality") or args.quality or "",
            "model": evidence.get("model") or "GPT-5.6 Sol",
            "tier": evidence.get("tier") or "",
            "conversationUrl": recovered["conversationUrl"],
            "targetId": evidence.get("targetId") or "",
            "submitElapsedSeconds": evidence.get("submitElapsedSeconds") or 0,
            "responseElapsedSeconds": 0,
            "idMatched": bool(recovered.get("idMatched")),
            "packetUnread": False,
            "recoveredFromBackend": True,
            "responseOutput": str(response_path),
            "packetPath": evidence.get("packetPath") or "",
        }
        json_path.write_text(json.dumps(saved, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"CONSULT_COMPLETE response={response_path}", flush=True)
        return 0
    stderr_path.write_text("backend recovery did not finish\n", encoding="utf-8")
    failed = {
        **evidence,
        "ok": False,
        "status": "submitted_response_unavailable",
        "id": consult_id,
    }
    json_path.write_text(json.dumps(failed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "submission committed but response recovery failed; recover the same conversation and do not resend",
        file=sys.stderr,
    )
    return 77


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    if not shutil.which("aside"):
        print("aside not found", file=sys.stderr)
        return 127
    if args.recover_from:
        return recover_from_saved_state(args)
    project_url = (
        args.url
        or os.environ.get("CONSULT_CHATGPT_URL")
        or read_config_value(Path(args.config).expanduser(), "CONSULT_CHATGPT_URL")
    )
    if not is_chatgpt_project_url(project_url):
        print("a verified ChatGPT project URL is required", file=sys.stderr)
        return 2
    assert isinstance(project_url, str)
    project_name = resolve_project_name(
        cli_value=args.project,
        config_path=Path(args.config).expanduser(),
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
    consult_id = secrets.token_hex(16)
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

    try:
        (
            submit_payload,
            response_payload,
            submit_elapsed,
            response_elapsed,
            transcript,
        ) = run_repl_consult(
            build_repl_script(
                project_url=project_url,
                project_name=project_name,
                quality=args.quality,
                packet_name=f"consult-{consult_id}.md",
                packet_base64=packet_base64,
                topic=topic,
                consult_id=consult_id,
                response_timeout_ms=args.response_timeout * 1000,
                artifact_output=str(artifact_path) if artifact_path else None,
            ),
            submit_timeout=SUBMIT_TIMEOUT_SECONDS,
            response_timeout=args.response_timeout,
            consult_id=consult_id,
        )
    except SubmitUnknownError as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        return 76
    except SubmittedResponseError as exc:
        submitted = exc.submit_payload
        recovered = recover_consult_from_backend(
            consult_id,
            conversation_url=str(submitted.get("conversationUrl") or "") or None,
            timeout=args.response_timeout,
        )
        if finished_backend_reply(recovered):
            response_path.write_text(str(recovered["responseText"]) + "\n", encoding="utf-8")
            stderr_path.write_text(exc.transcript, encoding="utf-8")
            json_path.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "id": consult_id,
                        "topic": topic,
                        "quality": args.quality,
                        "model": submitted.get("model") or "GPT-5.6 Sol",
                        "tier": submitted.get("tier") or "",
                        "conversationUrl": recovered["conversationUrl"],
                        "targetId": submitted.get("targetId") or "",
                        "submitElapsedSeconds": round(exc.submit_elapsed, 3),
                        "responseElapsedSeconds": 0,
                        "idMatched": bool(recovered.get("idMatched")),
                        "packetUnread": False,
                        "recoveredFromBackend": True,
                        "responseOutput": str(response_path),
                        "packetPath": packet_source,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            print(f"CONSULT_COMPLETE response={response_path}", flush=True)
            return 0
        message = str(exc)
        stderr_path.write_text(
            message,
            encoding="utf-8",
        )
        evidence = {
            "ok": False,
            "status": "submitted_response_unavailable",
            "id": consult_id,
            "topic": topic,
            "quality": args.quality,
            "model": submitted["model"],
            "tier": submitted["tier"],
            "conversationUrl": submitted["conversationUrl"],
            "targetId": submitted["targetId"],
            "submitElapsedSeconds": round(exc.submit_elapsed, 3),
            "packetPath": packet_source,
        }
        json_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(message, file=sys.stderr)
        return 77
    except (TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        stderr_path.write_text(str(exc), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        return 75
    stderr_path.write_text(transcript, encoding="utf-8")
    response_text = str(response_payload["responseText"])
    response_path.write_text(response_text + "\n", encoding="utf-8")
    artifact_copy_error = None
    if artifact_path is not None:
        try:
            artifact_payload = response_payload["artifact"]
            temporary_path = Path(str(artifact_payload["temporaryPath"]))
            if not temporary_path.is_file():
                raise FileNotFoundError(temporary_path)
            shutil.copyfile(temporary_path, artifact_path)
        except (KeyError, OSError, TypeError) as exc:
            artifact_copy_error = str(exc)
    if artifact_path is not None and (
        artifact_copy_error is not None or not zip_is_valid(artifact_path)
    ):
        message = f"zip verification failed: {artifact_path}"
        if artifact_copy_error is not None:
            message += f" ({artifact_copy_error})"
        stderr_path.write_text(transcript + "\n" + message + "\n", encoding="utf-8")
        evidence = {
            "ok": False,
            "status": "submitted_artifact_unavailable",
            "id": consult_id,
            "topic": topic,
            "quality": args.quality,
            "model": submit_payload["model"],
            "tier": submit_payload["tier"],
            "conversationUrl": response_payload["conversationUrl"],
            "targetId": submit_payload["targetId"],
            "submitElapsedSeconds": round(submit_elapsed, 3),
            "responseElapsedSeconds": round(response_elapsed, 3),
            "responseOutput": str(response_path),
            "packetPath": packet_source,
            "artifactOutput": str(artifact_path),
        }
        json_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(message, file=sys.stderr)
        return 77
    evidence = {
        "ok": True,
        "id": consult_id,
        "topic": topic,
        "quality": args.quality,
        "model": submit_payload["model"],
        "tier": submit_payload["tier"],
        "conversationUrl": response_payload["conversationUrl"],
        "targetId": submit_payload["targetId"],
        "submitElapsedSeconds": round(submit_elapsed, 3),
        "responseElapsedSeconds": round(response_elapsed, 3),
        "idMatched": bool(response_payload.get("idMatched")),
        "packetUnread": bool(response_payload.get("packetUnread")),
        "recoveredFromBackend": bool(response_payload.get("recoveredFromBackend")),
        "responseOutput": str(response_path),
        "packetPath": packet_source,
    }
    if artifact_path is not None:
        evidence["artifactOutput"] = str(artifact_path)
    json_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CONSULT_COMPLETE response={response_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
