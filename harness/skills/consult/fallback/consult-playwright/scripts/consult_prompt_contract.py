"""Shared title and light response-preference handling for Consult prompts."""

from __future__ import annotations

import re


TITLE_PREFIX = "# "
LEGACY_TITLE_PREFIX = "# Consult: "
PREFERENCE_HEADING = "## Response preference"
DEFAULT_TITLE = "Repository consultation"
MAX_TITLE_CHARS = 64
KOREAN_UPLOAD_PREAMBLE = (
    "첨부한 독립형 컨텍스트 패킷을 검토하고, 그 안의 질문에 답해 주세요.\n\n"
    "이 패킷 외의 저장소, 터미널, 이전 대화는 볼 수 없다고 가정하세요. "
    "판단에 필요한 근거가 패킷에 부족하면 그 점을 명확히 밝혀 주세요."
)
KOREAN_INLINE_PREAMBLE = (
    "아래 독립형 컨텍스트 패킷을 검토하고, 그 안의 질문에 답해 주세요.\n\n"
    "이 패킷 외의 저장소, 터미널, 이전 대화는 볼 수 없다고 가정하세요. "
    "판단에 필요한 근거가 패킷에 부족하면 그 점을 명확히 밝혀 주세요."
)

_LEGACY_PREAMBLE_REPLACEMENTS = (
    (
        "Please review the uploaded self-contained repository-context packet and answer the question inside it.\n\n"
        "Assume you cannot see the repository, terminal, or earlier conversation beyond the uploaded packet. "
        "If the packet lacks evidence for a claim, say so.",
        KOREAN_UPLOAD_PREAMBLE,
    ),
    (
        "Please review this self-contained repository-context packet and answer the question inside it.\n\n"
        "Assume you cannot see the repository, terminal, or earlier conversation beyond this packet. "
        "If the packet lacks evidence for a claim, say so.",
        KOREAN_INLINE_PREAMBLE,
    ),
    ("--- BEGIN SELF-CONTAINED CONSULT PACKET ---", "--- 독립형 CONSULT 패킷 시작 ---"),
    ("--- END SELF-CONTAINED CONSULT PACKET ---", "--- 독립형 CONSULT 패킷 끝 ---"),
)


def _clean_title(value: str) -> str:
    value = re.sub(r"[`*_#]+", "", value)
    value = re.sub(r"\s+", " ", value).strip(" -:|\t\r\n")
    if not value:
        return DEFAULT_TITLE
    if len(value) > MAX_TITLE_CHARS:
        value = value[: MAX_TITLE_CHARS - 1].rstrip() + "…"
    return value


def extract_consult_title(
    packet: str,
    explicit_title: str | None = None,
    fallback_title: str | None = None,
) -> str:
    """Choose a short topic label from the packet without guessing new content."""
    if explicit_title and explicit_title.strip():
        return _clean_title(explicit_title)

    patterns = (
        r"(?mi)^\s*-\s*Consult question:\s*(.+?)\s*$",
        r"(?mi)^\s*Question:\s*(.+?)\s*$",
    )
    for pattern in patterns:
        match = re.search(pattern, packet)
        if match:
            candidate = match.group(1).strip()
            if candidate and not candidate.startswith("<"):
                return _clean_title(candidate)

    question_section = re.search(
        r"(?ims)^#{1,6}\s+(?:Consult\s+question|Question)\s*$\s*(.+?)(?=^#{1,6}\s+|\Z)",
        packet,
    )
    if question_section:
        for line in question_section.group(1).splitlines():
            candidate = line.strip()
            if candidate and not candidate.startswith(("<!--", "```")):
                return _clean_title(candidate)

    for line in packet.splitlines():
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line.strip())
        if not heading:
            continue
        candidate = _clean_title(heading.group(1))
        if candidate.casefold() not in {
            "gpt consult packet",
            "consult request",
            "consult question",
            "question",
            "current state",
        }:
            return candidate

    if fallback_title and fallback_title.strip():
        return _clean_title(fallback_title.replace("_", " ").replace("-", " "))
    return DEFAULT_TITLE


def add_initial_prompt_contract(prompt: str, title: str) -> str:
    """Put the real topic first so ChatGPT can generate a useful sidebar title."""
    body = localize_known_preamble(prompt).strip("\r\n")
    if body.startswith((TITLE_PREFIX, LEGACY_TITLE_PREFIX)):
        _old_title, separator, rest = body.partition("\n")
        titled = f"{TITLE_PREFIX}{_clean_title(title)}"
        if separator:
            rest = rest.lstrip("\r\n")
            titled += "\n\n" + rest
    else:
        titled = f"{TITLE_PREFIX}{_clean_title(title)}\n\n{body}"
    return add_response_preference(titled)


def localize_known_preamble(prompt: str) -> str:
    """Translate only the helper-owned legacy preamble, preserving custom text."""
    localized = prompt
    for legacy, korean in _LEGACY_PREAMBLE_REPLACEMENTS:
        localized = localized.replace(legacy, korean)
    return localized


def add_response_preference(prompt: str) -> str:
    """Request a Korean report without prescribing one rigid writing template."""
    body = prompt.strip("\r\n")
    if PREFERENCE_HEADING in body:
        return body
    return (
        f"{body}\n\n"
        f"{PREFERENCE_HEADING}\n\n"
        "답변은 한국어 보고서로 작성해 주세요. 문제에 맞는 구조와 표현을 자유롭게 선택하되, "
        "자연스럽고 읽기 쉽게 설명해 주세요. 기술 용어와 영문 표현은 도움이 될 때 자유롭게 사용해도 됩니다."
    )
