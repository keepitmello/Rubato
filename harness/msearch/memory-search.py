#!/usr/bin/env python3
"""
Search agent memories from Redis Stack.

CLI:
  python3 scripts/memory-search.py "query"
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import os
import re
import subprocess
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
import redis

import memory_affect
import memory_entities


from msearch_config import (
    CHANNEL_ID,
    CHANNEL_KEY_ID,
    EMBEDDING_MODEL,
    INDEX_NAME,
    KEY_PREFIX,
    MAX_VECTOR_DISTANCE,
    MEMORY_ROOT,
    REDIS_URL,
    RETURN_K,
    STATE_DIR,
    TOP_K,
    describe as describe_config,
    state_path,
)

# 원본은 스크립트가 곧 채널이라 PROJECT_ROOT 하나로 코드와 데이터를 함께 가리켰다.
# 여기서는 둘이 갈라진다: 코드는 이 레포, 색인 대상은 사용자의 메모리 저장소.
PROJECT_ROOT = MEMORY_ROOT
INNER_THOUGHTS_PATH = state_path("inner-thoughts.json")
RECALL_LOG_PATH = state_path("recall-log.jsonl")
TERM_ORIGINS_PATH = state_path("term-origins.json")
# 원문 전사 디렉터리는 roo 고유 레이아웃이라 기본으로는 없다. 없으면 verbatim 경로가
# 조용히 건너뛴다(존재 검사를 이미 하고 있다).
RAW_TRANSCRIPT_DIR = MEMORY_ROOT / "diary" / "raw"

# 꿈 신호 (docs/memory/memory-consolidation-design.md)
META_PENALTY = -2.5   # 기억에 대한 기억(검색 체험·골든셋 기록) — recency 보너스(+2.0)를 상쇄하고도 남게
ORIGIN_BOOST = 2.5    # 계보 레지스트리의 원본 청크 — "원본은 최신만큼 강하다"
load_dotenv(STATE_DIR / ".env")  # OPENAI_API_KEY
CONTEXT_MESSAGES = 5
SHORT_QUERY_LENGTH = 10
STRONG_ANCHOR_THRESHOLD = 0.7
RECENT_DAYS_STRONG = 7
RECENT_DAYS_WEAK = 30
MIN_RESULT_RANK_SCORE = 8.0
MIN_PARTIAL_LEXICAL_RANK_SCORE = 10.0
MIN_RESULT_TOKEN_OVERLAP = 0.34
MAX_SEMANTIC_DISTANCE = 0.665
MIN_SEMANTIC_DOCUMENT_GAP = 0.025
RESULT_NEAR_TIE_DELTA = 1.0
RAW_MATCH_LIMIT = 3
RAW_CONTEXT_LINES = 1

QUERY_WORD_RE = re.compile(r"\d{1,4}(?:년|월|일)|[A-Za-z0-9][A-Za-z0-9_.+/#:-]*|[가-힣]+")
REDISEARCH_SPECIAL_CHARS = set(r"\,.<>{}[]\"':;!@#$%^&*()-+=~|")

DEICTIC_HINTS = {"그거", "이거", "저거", "아까", "방금", "전에", "그때", "요즘"}
META_HINTS = {"시스템", "검색", "테스트", "인덱스", "BM25", "bm25", "벡터", "vector", "메모리", "memory"}
SENSITIVE_LIVE_QUEUE_RE = re.compile(r"바람|발정|프사|프로필\s*사진")
LIVE_QUEUE_EXPLICIT_RE = re.compile(r"바람|발정|프사|프로필\s*사진|딸감|능욕|야한|섹스")
VERBATIM_CUE_RE = re.compile(
    r"정확히|원문|뭐라고\s*했|그때\s*말|그\s*말|인용|verbatim|보여줘",
    re.IGNORECASE,
)
ANCHOR_STOPWORDS = {
    "기억", "기억나다", "기억나", "기억해", "기억하",
    "관련", "정도", "오늘", "어제", "내일",
    "어떻게", "괜찮아", "혹시", "그냥", "뭐야", "뭔가", "진짜", "뭐였지", "뭐였더라",
    "뭐였는지", "어땠었지", "어땠는지", "언제였더라", "언제였는지", "했었는지", "였더라",
    "감각", "묘사", "상세", "상세하다", "상세하게", "소개", "소개해봐", "느낌", "쾌감", "대화", "계속",
    "컨텍스트", "스크립트", "실행", "판정", "응답", "출력",
    "언니", "오빠", "친구", "선배",
    "그거", "이거", "저거", "아까", "방금", "전에", "그때", "요즘",
    "생각", "생각나", "생각나다", "생각해", "말", "말해", "말해줘", "해줘", "알려", "요약",
    "무슨", "어느", "어떤", "진짜", "때", "거", "것", "알았",
}
BM25_INTENT_STOPWORDS = {
    "기억", "기억나다", "기억나", "기억해", "기억하", "나다",
    "말", "말하", "말해", "말해줘", "해주", "해줘", "관련",
    "생각", "생각나", "생각나다", "알리", "알려", "설명",
    "요약", "찾아", "찾아줘", "궁금",
    "어떻다", "괜찮다", "혹시", "그냥", "뭐", "뭔가", "이다", "하다",
    "뭐였는지", "어땠었지", "어땠는지", "언제였더라", "언제였는지", "했었는지", "였더라",
    "감각", "묘사", "상세", "상세하게", "소개", "소개해봐", "느낌", "쾌감", "대화", "계속",
    "컨텍스트", "스크립트", "실행", "판정", "응답", "출력",
    "무슨", "어느", "어떤", "진짜", "때", "거", "것", "알았",
}
QUERY_PARTICLE_SUFFIXES = (
    "으로부터", "한테서", "에게서", "에서", "으로", "이랑", "에게", "한테",
    "까지", "부터", "처럼", "보다", "라고", "이라", "이나", "하고", "라도",
)
QUERY_SINGLE_PARTICLES = ("가", "은", "는", "을", "를", "에", "도")
QUERY_ENDING_SUFFIXES = (
    "했었는지", "했더라", "했었지", "했다가", "했는지", "했던", "했어", "했고",
    "하면", "하는", "하다", "였더라", "였는지", "이었지", "였지", "였던", "였다",
    "인지", "었던", "았던", "었지", "던",
)


@dataclass(frozen=True)
class Anchor:
    token: str
    score: float
    kind: str


def dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def normalize_query_token(token: str) -> str:
    if not re.fullmatch(r"[가-힣]+", token):
        return token.lower()
    for suffix in QUERY_ENDING_SUFFIXES + QUERY_PARTICLE_SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 2:
            return token[:-len(suffix)]
    for suffix in QUERY_SINGLE_PARTICLES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 2:
            return token[:-len(suffix)]
    if token.endswith("이") and len(token) >= 3 and token[-2] != "리":
        return token[:-1]
    if token.endswith("인") and len(token) >= 3:
        return token[:-1]
    if token.endswith("로") and len(token) == 3:
        return token[:-1]
    return token


@lru_cache(maxsize=256)
def tokenize_ko_tokens(text: str) -> list[str]:
    tokens = [normalize_query_token(token) for token in QUERY_WORD_RE.findall(text)]
    return dedupe_preserve_order([token for token in tokens if token])


def is_intent_only_token(token: str) -> bool:
    if token in ANCHOR_STOPWORDS or token in BM25_INTENT_STOPWORDS:
        return True
    return bool(re.fullmatch(r"(?:뭐|어때|어땠|언제|기억|했었|였)(?:는지|었지|더라|나)?", token))


def is_conversational_recall(query: str) -> bool:
    return bool(re.search(r"기억나|뭐였(?:는지|지|더라)|어땠(?:었지|는지)|언제였(?:더라|는지)|했었는지|였더라", query))


def escape_redis_token(token: str) -> str:
    return "".join(f"\\{char}" if char in REDISEARCH_SPECIAL_CHARS else char for char in token)


def escape_tag_value(value: str) -> str:
    return escape_redis_token(value).replace(" ", r"\ ")


def channel_filter() -> str:
    return f"@channel:{{{escape_tag_value(CHANNEL_ID)}}}"


def redis_or_query(tokens: list[str]) -> str:
    escaped = [escape_redis_token(token) for token in tokens if token.strip()]
    if not escaped:
        return "*"
    return "@content_tokenized:(" + "|".join(escaped) + ")"


def redis_and_query(tokens: list[str]) -> str:
    escaped = [escape_redis_token(token) for token in tokens if token.strip()]
    if not escaped:
        return "*"
    return " ".join(f"@content_tokenized:({token})" for token in escaped)


def redis_fuzzy_query(token: str) -> str:
    escaped = escape_redis_token(token)
    return f"@content_tokenized:(%{escaped}%)"


def scoped_text_query(tokens: list[str]) -> str:
    text_query = redis_or_query(tokens)
    if text_query == "*":
        return channel_filter()
    return f"{channel_filter()} {text_query}"


def scoped_vector_query(knn_clause: str) -> str:
    return f"({channel_filter()})=>[{knn_clause}]"


def vector_to_bytes(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def extract_anchors(text: str) -> list[Anchor]:
    anchors: list[Anchor] = []
    for token in tokenize_ko_tokens(text):
        if is_intent_only_token(token):
            continue
        if re.fullmatch(r"[가-힣]+", token):
            if len(token) < 2:
                continue
            score = 0.8 if len(token) >= 4 else 0.7
            kind = "surface"
        else:
            if len(token) < 2:
                continue
            score = 0.8 if len(token) >= 3 else 0.55
            kind = "latin"
        anchors.append(Anchor(token=token, score=score, kind=kind))
    return anchors


def anchor_tokens(anchors: list[Anchor]) -> list[str]:
    return [anchor.token for anchor in anchors]


def anchor_strength(anchors: list[Anchor]) -> float:
    return max((anchor.score for anchor in anchors), default=0.0)


def has_deictic_hint(prompt: str) -> bool:
    return any(hint in prompt for hint in DEICTIC_HINTS)


def has_meta_hint(prompt: str) -> bool:
    return any(hint in prompt for hint in META_HINTS)


def should_use_context(prompt: str, anchors: list[Anchor]) -> bool:
    if has_meta_hint(prompt):
        return False
    if has_deictic_hint(prompt):
        return True
    if anchor_strength(anchors) >= STRONG_ANCHOR_THRESHOLD:
        return False
    if not anchors and len(prompt.strip()) <= SHORT_QUERY_LENGTH:
        return True
    return False


def read_recent_user_messages(transcript_path: str) -> list[str]:
    if not transcript_path or not Path(transcript_path).exists():
        return []

    messages: list[str] = []
    with open(transcript_path, "r", encoding="utf-8") as handle:
        for line in handle:
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if data.get("type") != "user":
                continue
            content = data.get("message", {}).get("content", "")
            if isinstance(content, list):
                content = " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
            if isinstance(content, str) and len(content.strip()) > 2:
                messages.append(content.strip())
    return messages


def get_recent_context(transcript_path: str, current_prompt: str, anchors: list[Anchor]) -> str:
    if not should_use_context(current_prompt, anchors):
        return current_prompt

    try:
        messages = read_recent_user_messages(transcript_path)
    except OSError:
        return current_prompt

    recent = messages[-(CONTEXT_MESSAGES + 1):-1] if len(messages) > 1 else []
    if not recent:
        return current_prompt

    tokens = anchor_tokens(anchors)
    if has_deictic_hint(current_prompt):
        filtered = recent[-2:]
    elif tokens:
        filtered = [message for message in recent if any(token in message for token in tokens)] or recent[-2:]
    else:
        filtered = recent[-2:]

    parts = [f"[이전] {message[:200]}" for message in filtered]
    parts.append(f"[현재] {current_prompt}")
    return "\n".join(parts)


def bm25_tokens(text: str, anchors: list[Anchor]) -> list[str]:
    tokens = tokenize_ko_tokens(text)
    anchor_list = anchor_tokens(anchors)
    # 의도어("뭐였지" 등)는 앵커 강도와 무관하게 상시 제거 — 약한 앵커(3글자 고유명사 등)
    # 쿼리에서 의도어가 BM25를 흐려 장기기억 후보가 묻히는 문제 방지.
    tokens = [token for token in tokens if not is_intent_only_token(token)]
    if anchor_strength(anchors) >= STRONG_ANCHOR_THRESHOLD:
        tokens = [token for token in tokens if len(token) > 1 or token in anchor_list]
    date_tokens = [
        day
        for _month, day in re.findall(r"(\d{1,2})월\s*(\d{1,2})일", text)
        if len(day) > 1
    ]
    return dedupe_preserve_order(tokens + anchor_list + date_tokens)


def is_verbatim_query(query: str) -> bool:
    return bool(VERBATIM_CUE_RE.search(query))


def raw_verbatim_anchors(prompt: str) -> list[str]:
    """Keep only literal content anchors; request words are not evidence."""
    stripped = VERBATIM_CUE_RE.sub(" ", prompt)
    anchors = [
        anchor.token
        for anchor in extract_anchors(stripped)
        if anchor.token and len(anchor.token) >= 2 and anchor.score >= STRONG_ANCHOR_THRESHOLD
    ]
    if not anchors:
        anchors = [
            token
            for token in re.findall(r"[A-Za-z0-9가-힣_-]{2,}", stripped)
            if len(token) >= 3
        ]
    return dedupe_preserve_order(anchors)[:4]


def strip_verbatim_cues(prompt: str) -> str:
    return re.sub(r"\s+", " ", VERBATIM_CUE_RE.sub(" ", prompt)).strip()


def raw_verbatim_candidates(prompt: str) -> list[dict[str, object]]:
    """Search excluded raw transcripts only for an explicit verbatim request."""
    anchors = raw_verbatim_anchors(prompt)
    if not anchors or not RAW_TRANSCRIPT_DIR.is_dir():
        return []

    command = ["rg", "--json", "--fixed-strings"]
    for anchor in anchors:
        command.extend(["-e", anchor])
    command.append(str(RAW_TRANSCRIPT_DIR))
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=1.0, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode not in (0, 1):
        return []

    matches: list[tuple[int, Path, int]] = []
    seen: set[tuple[str, int]] = set()
    for raw in proc.stdout.splitlines():
        try:
            event = json.loads(raw)
            if event.get("type") != "match":
                continue
            data = event["data"]
            path = Path(data["path"]["text"])
            line_number = int(data["line_number"])
            line = str(data["lines"]["text"]).strip()
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
        identity = (str(path), line_number)
        if identity in seen:
            continue
        seen.add(identity)
        hit_count = sum(1 for anchor in anchors if anchor in line)
        if len(anchors) > 1 and hit_count < 2:
            continue
        matches.append((hit_count, path, line_number))

    candidates: list[dict[str, object]] = []
    for hit_count, path, line_number in sorted(
        matches, key=lambda item: (-item[0], str(item[1]), item[2])
    )[:RAW_MATCH_LIMIT]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            start = max(0, line_number - 1 - RAW_CONTEXT_LINES)
            end = min(len(lines), line_number + RAW_CONTEXT_LINES)
            excerpt = " / ".join(line.strip() for line in lines[start:end] if line.strip())
            rel_path = str(path.relative_to(PROJECT_ROOT))
        except (OSError, ValueError):
            continue
        candidates.append(
            {
                "title": path.stem,
                "section": f"{rel_path}:L{start + 1}-L{end}",
                "content": excerpt,
                "source": "memory/diary/raw",
                "rel_path": rel_path,
                "key": f"raw-rg:{rel_path}:{line_number}",
                "score": 0.0,
                "rank_score": 20.0 + hit_count,
                "rank_reasons": ["raw_rg", f"literal_anchors={hit_count}/{len(anchors)}"],
            }
        )
    return candidates


def normalize_memory(doc: dict[str, object], score_key: str) -> dict[str, object]:
    score = doc.get(score_key, 0)
    try:
        score_value = float(score)
    except (TypeError, ValueError):
        score_value = 0.0
    content = str(doc.get("content", ""))
    return {
        "title": str(doc.get("title", "")),
        "section": str(doc.get("section", "")),
        "content": content,
        "content_preview": content[:700],
        "source": str(doc.get("source", "")),
        "subtype": str(doc.get("subtype", "")),
        "canonical": str(doc.get("canonical", "")),
        "date": str(doc.get("date", "")),
        "mtime": str(doc.get("mtime", "")),
        "rel_path": str(doc.get("rel_path", "")),
        "key": str(doc.get("_key", "")),
        "score": score_value,
        "meta": str(doc.get("meta", "")),
        "affect_score": str(doc.get("affect_score", "")),
        "affect_flags": str(doc.get("affect_flags", "")),
        "affect_version": str(doc.get("affect_version", "")),
    }


def parse_hash_result(result: list[object], include_score: str = "score") -> list[dict[str, object]]:
    memories: list[dict[str, object]] = []
    if not result or len(result) <= 1:
        return memories

    for index in range(1, len(result), 2):
        if index + 1 >= len(result):
            continue
        doc_key = result[index].decode() if isinstance(result[index], bytes) else str(result[index])
        fields = result[index + 1]
        doc: dict[str, object] = {}
        for field_index in range(0, len(fields), 2):
            key = fields[field_index].decode() if isinstance(fields[field_index], bytes) else fields[field_index]
            value = fields[field_index + 1]
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            doc[str(key)] = value
        doc["_key"] = doc_key
        memories.append(normalize_memory(doc, include_score))
    return memories


def _ft_field(container: object, name: str) -> object:
    """Read one field from an FT reply map whose keys may be bytes or str."""
    if not isinstance(container, dict):
        return None
    if name in container:
        return container[name]
    return container.get(name.encode())


def normalize_ft_search(result: object, with_scores: bool = False) -> object:
    """Return an FT.SEARCH reply in the flat-array shape the parsers expect.

    redis-py 8 hands back a map (`total_results` / `results` / `extra_attributes`)
    instead of the flat `[total, key, fields, ...]` array the older client
    produced, so every parser here raised `KeyError: 1` on a fresh install. The
    package list is unpinned, which means a new machine always lands on the new
    client. Rebuilding the old shape keeps one parser path for both clients
    rather than teaching each parser two layouts. Older replies pass through
    untouched.
    """
    if not isinstance(result, dict):
        return result

    flat: list[object] = [_ft_field(result, "total_results") or 0]
    for item in _ft_field(result, "results") or []:
        flat.append(_ft_field(item, "id"))
        if with_scores:
            flat.append(_ft_field(item, "score"))
        attributes = _ft_field(item, "extra_attributes") or {}
        pairs: list[object] = []
        for key, value in attributes.items():
            pairs.append(key)
            pairs.append(value)
        flat.append(pairs)
    return flat


def parse_bm25_result(result: list[object]) -> list[dict[str, object]]:
    memories: list[dict[str, object]] = []
    if not result or len(result) <= 1:
        return memories

    for index in range(1, len(result), 3):
        if index + 2 >= len(result):
            continue
        doc_key = result[index].decode() if isinstance(result[index], bytes) else str(result[index])
        raw_score = result[index + 1]
        fields = result[index + 2]
        doc: dict[str, object] = {}
        for field_index in range(0, len(fields), 2):
            key = fields[field_index].decode() if isinstance(fields[field_index], bytes) else fields[field_index]
            value = fields[field_index + 1]
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            doc[str(key)] = value
        doc["_key"] = doc_key
        memory = normalize_memory(doc, "score")
        try:
            memory["_bm25_score"] = float(raw_score)
        except (TypeError, ValueError):
            memory["_bm25_score"] = 0.0
        memory["_score_kind"] = "bm25"
        memories.append(memory)
    return memories


def parse_hybrid_result(result: list[object]) -> list[dict[str, object]]:
    if not result:
        return []

    result_dict: dict[str, object] = {}
    for index in range(0, len(result), 2):
        if index + 1 >= len(result):
            continue
        key = result[index].decode() if isinstance(result[index], bytes) else result[index]
        result_dict[str(key)] = result[index + 1]

    memories: list[dict[str, object]] = []
    for item in result_dict.get("results", []) or []:
        doc: dict[str, object] = {}
        for field_index in range(0, len(item), 2):
            key = item[field_index].decode() if isinstance(item[field_index], bytes) else item[field_index]
            value = item[field_index + 1]
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            doc[str(key).removeprefix("@")] = value
        score_field = "rrf_score" if "rrf_score" in doc else "__score"
        memory = normalize_memory(doc, score_field)
        for field in ("rrf_score", "vector_distance", "text_score"):
            try:
                raw_value = doc.get(field, doc.get("__score", 0.0) if field == "rrf_score" else 0.0)
                memory[f"_{field}"] = float(raw_value or 0.0)
            except (TypeError, ValueError):
                memory[f"_{field}"] = 0.0
        memory["_score_kind"] = "hybrid_rrf"
        memories.append(memory)
    return memories


def search_bm25(r: redis.Redis, text_query: str, anchors: list[Anchor], limit: int) -> list[dict[str, object]]:
    tokens = [token for token in bm25_tokens(text_query, anchors) if len(token) > 1]
    if not tokens:
        return []
    strong_tokens = [anchor.token for anchor in anchors if anchor.score >= STRONG_ANCHOR_THRESHOLD]
    queries: list[tuple[str, str]] = []
    if strong_tokens:
        queries.append((f"{channel_filter()} {redis_and_query(strong_tokens)}", ""))
    # A recalled word is often close but not exact (for example a loanword ending).
    # RedisSearch fuzzy matching keeps that approximate clue useful without a
    # project-specific synonym table or a special query syntax.
    for token in strong_tokens:
        if len(token) >= 4 and re.fullmatch(r"[가-힣]+", token):
            queries.append((f"{channel_filter()} {redis_fuzzy_query(token)}", token))
    queries.append((scoped_text_query(tokens), ""))

    memories: list[dict[str, object]] = []
    seen_queries: set[str] = set()
    for query, fuzzy_token in queries:
        if query in seen_queries:
            continue
        seen_queries.add(query)
        result = r.execute_command(
            "FT.SEARCH", INDEX_NAME,
            query,
            "WITHSCORES",
            "RETURN", "14", "title", "section", "content", "source", "subtype", "canonical", "date", "rel_path", "mtime", "score", "meta", "affect_score", "affect_flags", "affect_version",
            "LIMIT", "0", str(limit),
            "DIALECT", "2",
        )
        parsed = parse_bm25_result(normalize_ft_search(result, with_scores=True))
        if fuzzy_token:
            for memory in parsed:
                memory["_fuzzy_tokens"] = [fuzzy_token]
        memories.extend(parsed)
    return dedupe_results(memories, limit * 2)


def high_confidence_vector_results(memories: list[dict[str, object]]) -> list[dict[str, object]]:
    return [memory for memory in memories if float(memory.get("score", 1.0)) <= MAX_VECTOR_DISTANCE]


def apply_semantic_evidence(
    candidates: list[dict[str, object]], vector_results: list[dict[str, object]]
) -> None:
    """Attach calibrated document-level vector evidence to existing candidates.

    Chunk-level runner-up gaps are misleading when adjacent chunks from the same
    document are all good matches. Compare the nearest distinct documents, then
    annotate matching candidates without changing their established hybrid ranking.
    """
    best_by_document: dict[str, float] = {}
    for memory in vector_results:
        rel_path = str(memory.get("rel_path", ""))
        if not rel_path:
            continue
        try:
            distance = float(memory.get("score", 1.0))
        except (TypeError, ValueError):
            continue
        best_by_document[rel_path] = min(distance, best_by_document.get(rel_path, 1.0))
    ordered = sorted(best_by_document.items(), key=lambda item: item[1])
    if not ordered:
        return
    top_path, top_distance = ordered[0]
    runner_distance = ordered[1][1] if len(ordered) > 1 else 1.0
    gap = runner_distance - top_distance
    for memory in candidates:
        if str(memory.get("rel_path", "")) != top_path:
            continue
        memory["_semantic_distance"] = top_distance
        memory["_semantic_document_gap"] = gap


def query_embedding(client, text: str) -> bytes:
    response = client.embeddings.create(model=EMBEDDING_MODEL, input=text[:2000])
    return vector_to_bytes(response.data[0].embedding)


def search_vector(r: redis.Redis, query_bytes: bytes, limit: int) -> list[dict[str, object]]:
    result = r.execute_command(
        "FT.SEARCH", INDEX_NAME,
        scoped_vector_query(f"KNN {limit} @vector $vec AS score"),
        "PARAMS", "2", "vec", query_bytes,
        "RETURN", "14", "title", "section", "content", "source", "subtype", "canonical", "date", "rel_path", "mtime", "score", "meta", "affect_score", "affect_flags", "affect_version",
        "SORTBY", "score",
        "LIMIT", "0", str(limit),
        "DIALECT", "2",
    )
    return parse_hash_result(normalize_ft_search(result))


def search_hybrid(
    r: redis.Redis,
    text_query: str,
    query_bytes: bytes,
    anchors: list[Anchor],
    limit: int,
) -> list[dict[str, object]]:
    tokens = bm25_tokens(text_query, anchors)
    text_filter = scoped_text_query(tokens)
    # FT.HYBRID only exists on newer servers. Redis Stack 7.4 rejects it as an
    # unknown command, and the caller wraps hybrid and vector search in one try
    # block, so that rejection used to take vector search down with it --
    # semantic recall silently disappeared on those servers. Report "no hybrid
    # results" instead so the vector pass still runs.
    try:
        result = r.execute_command(
            "FT.HYBRID", INDEX_NAME,
            "SEARCH", text_filter,
            "VSIM", "@vector", query_bytes,
            "KNN", "2", "K", str(limit),
            "COMBINE", "RRF", "4", "WINDOW", "20", "CONSTANT", "30",
            "LIMIT", "0", str(limit),
            "LOAD", "14", "@title", "@section", "@content", "@source", "@subtype", "@canonical", "@date", "@rel_path", "@mtime", "@__score", "@meta", "@affect_score", "@affect_flags", "@affect_version",
        )
    except redis.ResponseError as exc:
        if "unknown command" in str(exc).lower():
            return []
        raise
    return parse_hybrid_result(result)


def memory_text(memory: dict[str, object]) -> str:
    return "\n".join(
        str(memory.get(key, ""))
        for key in ("title", "section", "content", "rel_path")
        if memory.get(key)
    )


def parse_memory_datetime(memory: dict[str, object]) -> datetime | None:
    for key in ("date", "createdAt"):
        value = str(memory.get(key, "")).strip()
        if not value:
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            value = f"{value}T00:00:00+09:00"
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass

    rel_path = str(memory.get("rel_path", ""))
    match = re.search(r"(\d{4}-\d{2}-\d{2})", rel_path)
    if match:
        try:
            return datetime.fromisoformat(f"{match.group(1)}T00:00:00+09:00")
        except ValueError:
            return None
    return None


def source_weight(memory: dict[str, object]) -> float:
    source = str(memory.get("source", ""))
    rel_path = str(memory.get("rel_path", ""))
    subtype = str(memory.get("subtype", ""))
    if source == "memory/entity" and subtype == "entity_current":
        return 2.8
    if source == "memory/entity":
        return 1.4
    if source == "state/inner-thoughts" or rel_path == "state/inner-thoughts.json":
        return 1.2
    if rel_path.startswith("memory/archive/"):
        return 1.8  # 장기기억: 최근 daily(2.0)보다 살짝 낮게, 충분히 경쟁 가능하게
    if source in ("legacy-roo", "legacy-openclaw") or rel_path.startswith("memory/legacy/"):
        return 1.0  # 오픈클로/roo 시절 장기기억 — 살아있되 최근 기억을 덮지 않게 (memory/ 분기보다 먼저)
    if rel_path.startswith("memory/") and not rel_path.startswith("memory/diary/"):
        return 2.0
    if rel_path.startswith("memory/diary/"):
        return 0.6
    if rel_path.startswith("docs/"):
        return -0.2
    return 0.0


def recency_weight(memory: dict[str, object]) -> float:
    dt = parse_memory_datetime(memory)
    if dt is None:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(dt.tzinfo) - dt).total_seconds() / 86400)
    source = str(memory.get("source", ""))
    rel_path = str(memory.get("rel_path", ""))
    if source == "state/inner-thoughts" or rel_path == "state/inner-thoughts.json":
        if age_days <= RECENT_DAYS_STRONG:
            return 0.6
        if age_days <= RECENT_DAYS_WEAK:
            return 0.3
        return 0.0
    if age_days <= RECENT_DAYS_STRONG:
        return 2.0
    if age_days <= RECENT_DAYS_WEAK:
        return 0.9
    if age_days <= 120:
        return 0.2
    return 0.0


def exact_phrase_hit(query: str, text: str) -> bool:
    compact_query = re.sub(r"\s+", "", query)
    compact_text = re.sub(r"\s+", "", text)
    return len(compact_query) >= 3 and compact_query in compact_text


def date_phrase_hit(query: str, text: str) -> bool:
    for month, day in re.findall(r"(\d{1,2})월\s*(\d{1,2})일", query):
        month_number = int(month)
        day_number = int(day)
        forms = (
            f"{month_number}/{day_number}",
            f"{month_number:02d}/{day_number:02d}",
            f"{month_number}-{day_number}",
            f"{month_number:02d}-{day_number:02d}",
        )
        if any(form in text for form in forms):
            return True
    return False


def month_phrase_hit(query: str, text: str) -> bool:
    for month in re.findall(r"(?<!\d)(\d{1,2})월", query):
        month_number = int(month)
        forms = (
            f"{month_number}월",
            f"-{month_number:02d}-",
            f"/{month_number:02d}/",
        )
        if any(form in text for form in forms):
            return True
    return False


def core_phrase_hit(query: str, anchors: list[Anchor], text: str) -> bool:
    """Match a consecutive content phrase even when recall wording wraps it."""
    compact_text = re.sub(r"[^A-Za-z0-9가-힣]+", "", text).lower()
    content_tokens = [
        token.lower()
        for token in bm25_tokens(query, anchors)
        if len(token) > 1 and not is_intent_only_token(token)
    ]
    for size in (4, 3, 2):
        for start in range(0, len(content_tokens) - size + 1):
            phrase = "".join(content_tokens[start:start + size])
            if len(phrase) >= 4 and phrase in compact_text:
                return True
    return False


def heading_content_hits(query: str, anchors: list[Anchor], memory: dict[str, object]) -> int:
    heading = "\n".join(str(memory.get(key, "")) for key in ("title", "section")).lower()
    hits = 0
    for token in bm25_tokens(query, anchors):
        normalized = token.lower()
        if len(normalized) <= 1 or is_intent_only_token(normalized):
            continue
        if normalized in heading:
            hits += 1
            continue
        if normalized.endswith("다") and len(normalized) >= 4 and normalized[:-1][:2] in heading:
            hits += 1
    return hits


def lexical_score(query: str, anchors: list[Anchor], memory: dict[str, object]) -> tuple[float, list[str]]:
    text = memory_text(memory)
    text_lower = text.lower()
    score = 0.0
    reasons: list[str] = []

    matched_query = False

    fuzzy_tokens = [
        str(token)
        for token in memory.get("_fuzzy_tokens", [])
        if str(token)
    ]
    if fuzzy_tokens:
        score += 4.0 + min(2.0, float(len(fuzzy_tokens)))
        reasons.append("fuzzy_token")
        matched_query = True

    if exact_phrase_hit(query, text):
        score += 7.0
        reasons.append("exact_phrase")
        matched_query = True
    elif is_conversational_recall(query) and core_phrase_hit(
        query,
        anchors,
        "\n".join(str(memory.get(key, "")) for key in ("title", "section")),
    ):
        score += 5.5
        reasons.append("heading_core_phrase")
        matched_query = True
    elif is_conversational_recall(query) and core_phrase_hit(query, anchors, text):
        # A consecutive topic phrase is stronger evidence than the same number
        # of query words scattered across a progress log.
        score += 5.0
        reasons.append("core_phrase")
        matched_query = True
    elif core_phrase_hit(query, anchors, text):
        score += 2.0
        reasons.append("core_phrase")
        matched_query = True

    if date_phrase_hit(query, text):
        score += 7.0
        reasons.append("date_phrase")
        matched_query = True
    elif month_phrase_hit(query, text):
        score += 3.0
        reasons.append("month_phrase")
        matched_query = True

    if is_conversational_recall(query) and heading_content_hits(query, anchors, memory) >= 2:
        score += 1.5
        reasons.append("heading_content")
        matched_query = True

    tokens = bm25_tokens(query, anchors)
    content_tokens = [token for token in tokens if token not in BM25_INTENT_STOPWORDS and len(token) > 1]
    if content_tokens:
        hits = [token for token in content_tokens if token.lower() in text_lower]
        overlap = len(hits) / max(len(content_tokens), 1)
        score += overlap * 5.0
        if hits:
            reasons.append(f"token_overlap={len(hits)}/{len(content_tokens)}")
            matched_query = True

    strong_hits = [anchor.token for anchor in anchors if anchor.score >= STRONG_ANCHOR_THRESHOLD and anchor.token in text]
    if strong_hits:
        score += 2.0 + len(strong_hits)
        reasons.append("strong_anchor")
        matched_query = True

    return score, reasons


def token_overlap_ratio(reasons: list[str]) -> float:
    for reason in reasons:
        match = re.fullmatch(r"token_overlap=(\d+)/(\d+)", reason)
        if not match:
            continue
        hit_count = int(match.group(1))
        total_count = int(match.group(2))
        return hit_count / max(total_count, 1)
    return 0.0


def sufficient_live_overlay_match(reasons: list[str]) -> bool:
    if "exact_phrase" in reasons or "strong_anchor" in reasons:
        return True
    return token_overlap_ratio(reasons) >= 0.25


def live_overlay_allowed(query: str, memory: dict[str, object], reasons: list[str]) -> bool:
    if not sufficient_live_overlay_match(reasons):
        return False
    text = memory_text(memory)
    if SENSITIVE_LIVE_QUEUE_RE.search(text) and not LIVE_QUEUE_EXPLICIT_RE.search(query):
        return False
    return True


def redis_score_weight(
    memory: dict[str, object],
    conversational_recall: bool = False,
    reasons: list[str] | None = None,
) -> float:
    if memory.get("_score_kind") == "bm25":
        evidence = reasons or []
        overlap_hits = 0
        for reason in evidence:
            match = re.fullmatch(r"token_overlap=(\d+)/\d+", reason)
            if match:
                overlap_hits = int(match.group(1))
                break
        if overlap_hits < 2 and not any(
            marker in evidence
            for marker in ("exact_phrase", "heading_core_phrase", "fuzzy_token", "date_phrase")
        ):
            return 0.0
        try:
            return min(4.0, float(memory.get("_bm25_score", 0.0) or 0.0) * 0.25)
        except (TypeError, ValueError):
            return 0.0
    if memory.get("_score_kind") == "hybrid_rrf":
        return min(6.0, float(memory.get("_rrf_score", 0.0) or 0.0) * 80.0)
    raw = float(memory.get("score", 0.0) or 0.0)
    if raw <= 0:
        return 0.0
    # Vector distance: lower is better. BM25 candidates usually arrive with 0 here.
    return max(0.0, (MAX_VECTOR_DISTANCE - raw) * 2.5)


def affect_rank_boost(query: str, memory: dict[str, object], is_entity_lookup: bool) -> tuple[float, list[str]]:
    return memory_affect.affect_boost(
        query,
        memory,
        is_entity_lookup=is_entity_lookup,
        log_path=memory_affect.recall_log_path(RECALL_LOG_PATH),
    )


def entity_lookup_rank_adjustment(memory: dict[str, object], target_canonicals: set[str]) -> tuple[float, list[str]] | None:
    source = str(memory.get("source", ""))
    rel_path = str(memory.get("rel_path", ""))
    subtype = str(memory.get("subtype", ""))
    if subtype == "entity_fantasy":
        return None
    adjustment = 0.0
    reasons: list[str] = []
    canonical = str(memory.get("canonical", ""))
    is_target_entity = source == "memory/entity" and canonical and canonical in target_canonicals
    is_other_entity = source == "memory/entity" and bool(target_canonicals) and not is_target_entity
    if is_target_entity:
        adjustment += 8.0
        reasons.append("entity_canonical_match")
    if subtype == "entity_current":
        if is_other_entity:
            adjustment -= 2.0
            reasons.append("entity_lookup_non_target")
            return adjustment, reasons
        adjustment += 12.0
        reasons.append("entity_lookup")
        return adjustment, reasons
    if source == "memory/entity":
        adjustment -= 2.0
        return adjustment, reasons or ["entity_lookup"]
    if source == "state/inner-thoughts" or rel_path == "state/inner-thoughts.json":
        adjustment -= 6.0
        return adjustment, reasons or ["entity_lookup"]
    return adjustment, reasons


def rank_memories(query: str, memories: list[dict[str, object]], anchors: list[Anchor], limit: int) -> list[dict[str, object]]:
    ranked: list[dict[str, object]] = []
    is_entity_lookup = memory_entities.is_entity_lookup_query(query)
    has_registered_origin = any(float(memory.get("_origin_boost", 0.0) or 0.0) > 0 for memory in memories)
    conversational_recall = is_conversational_recall(query) and not has_registered_origin
    target_canonicals = set(memory_entities.canonical_hits(query)) if is_entity_lookup else set()
    for memory in memories:
        source = str(memory.get("source", ""))
        if not is_entity_lookup and source == "memory/entity":
            continue
        if is_entity_lookup:
            adjustment_result = entity_lookup_rank_adjustment(memory, target_canonicals)
            if adjustment_result is None:
                continue
            adjustment, adjustment_reasons = adjustment_result
        else:
            adjustment = 0.0
            adjustment_reasons = []
        lexical, reasons = lexical_score(query, anchors, memory)
        is_live_overlay = str(memory.get("source", "")) == "state/inner-thoughts"
        if is_live_overlay and not live_overlay_allowed(query, memory, reasons):
            continue
        affect, affect_reasons = affect_rank_boost(query, memory, is_entity_lookup)
        recency = recency_weight(memory) * (0.5 if conversational_recall else 1.0)
        total = lexical + source_weight(memory) + recency + redis_score_weight(memory, conversational_recall, reasons) + adjustment + affect
        if affect_reasons:
            reasons.extend(affect_reasons)
        if is_entity_lookup and adjustment_reasons:
            reasons.extend(reason for reason in adjustment_reasons if reason not in reasons)
        if str(memory.get("meta", "")) == "1":
            total += META_PENALTY
            reasons.append("meta_record")
        origin_boost = float(memory.get("_origin_boost", 0.0) or 0.0)
        if origin_boost:
            total += origin_boost
            reasons.append("term_origin")
        ranked_memory = dict(memory)
        ranked_memory["rank_score"] = round(total, 4)
        ranked_memory["rank_reasons"] = reasons
        ranked.append(ranked_memory)

    ranked.sort(
        key=lambda memory: (
            float(memory.get("rank_score", 0.0)),
            recency_weight(memory),
            source_weight(memory),
        ),
        reverse=True,
    )
    return dedupe_results(ranked, limit)


def load_term_origins() -> dict[str, dict[str, object]]:
    """계보 레지스트리 — maintainer 계보 패스 산출물 (git 추적, 감사 가능)."""
    try:
        data = json.loads(TERM_ORIGINS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def origin_refs_for(query: str) -> list[dict[str, str]]:
    """쿼리에 등장하는 등록 용어의 원본 청크 참조 목록.

    앵커가 아니라 쿼리 원문 매칭 — 라틴 약어(TNCM 등)는 앵커로 안 뽑히므로.
    """
    origins = load_term_origins()
    if not origins:
        return []
    query_lower = query.lower()
    refs: list[dict[str, str]] = []
    for term, info in origins.items():
        if not isinstance(info, dict) or term.lower() not in query_lower:
            continue
        refs.extend(ref for ref in info.get("origins", []) if isinstance(ref, dict))
    return refs


def fetch_origin_memories(r: redis.Redis, refs: list[dict[str, str]]) -> list[dict[str, object]]:
    """원본 직행 — 벡터/BM25 후보에 못 들어도 레지스트리 원본은 후보에 합류시킨다."""
    results: list[dict[str, object]] = []
    for ref in refs:
        rel = str(ref.get("rel_path", ""))
        section = str(ref.get("section", ""))
        if not rel:
            continue
        file_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]  # 인덱서 chunk_key와 동일 공식
        for key in r.scan_iter(match=f"{KEY_PREFIX}{file_id}:*", count=200):
            if r.type(key) not in (b"hash", "hash"):
                continue
            doc: dict[str, object] = {}
            for field in ("title", "section", "content", "source", "subtype", "canonical", "date", "rel_path", "mtime", "meta", "affect_score", "affect_flags", "affect_version"):
                value = r.hget(key, field)
                doc[field] = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
            if not ref_matches(ref, doc):
                continue
            doc["_key"] = key.decode("utf-8") if isinstance(key, bytes) else key
            results.append(normalize_memory(doc, "score"))
    return results


def fetch_canonical_entity_memories(r: redis.Redis, canonicals: list[str]) -> list[dict[str, object]]:
    """정본 엔티티 파일 직행 — 검색 후보풀 누락 시에도 본인 페이지가 랭킹에 들어오게 한다."""
    results: list[dict[str, object]] = []
    for canonical in canonicals:
        rel = f"memory/entities/{canonical}.md"
        path = PROJECT_ROOT / rel
        if not path.exists():
            continue
        file_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
        for key in r.scan_iter(match=f"{KEY_PREFIX}{file_id}:*", count=200):
            if r.type(key) not in (b"hash", "hash"):
                continue
            doc: dict[str, object] = {}
            for field in ("title", "section", "content", "source", "subtype", "canonical", "date", "rel_path", "mtime", "meta", "affect_score", "affect_flags", "affect_version"):
                value = r.hget(key, field)
                doc[field] = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
            section = str(doc.get("section", ""))
            doc["source"] = str(doc.get("source") or "memory/entity")
            doc["subtype"] = str(doc.get("subtype") or memory_entities.entity_subtype(rel, section))
            doc["canonical"] = str(doc.get("canonical") or canonical)
            doc["rel_path"] = str(doc.get("rel_path") or rel)
            doc["_key"] = key.decode("utf-8") if isinstance(key, bytes) else key
            results.append(normalize_memory(doc, "score"))
    return results


def ref_matches(ref: dict[str, str], memory: dict[str, object]) -> bool:
    if str(memory.get("rel_path", "")) != str(ref.get("rel_path", "")):
        return False
    section = str(ref.get("section", ""))
    if section and str(memory.get("section", "")) != section:
        return False
    # archive 행은 section이 비유일(여러 행이 같은 섹션) — title 부분일치로 행을 특정
    title_contains = str(ref.get("title_contains", ""))
    if title_contains and title_contains not in str(memory.get("title", "")):
        return False
    return True


def apply_origin_boost(candidates: list[dict[str, object]], refs: list[dict[str, str]]) -> None:
    for memory in candidates:
        if any(ref_matches(ref, memory) for ref in refs):
            memory["_origin_boost"] = ORIGIN_BOOST


def live_inner_thought_candidates() -> list[dict[str, object]]:
    try:
        thoughts = json.loads(INNER_THOUGHTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(thoughts, list):
        return []

    candidates: list[dict[str, object]] = []
    for index, thought in enumerate(thoughts):
        if not isinstance(thought, dict):
            continue
        content = str(thought.get("thought", "")).strip()
        if not content:
            continue
        context = str(thought.get("context", "")).strip()
        category = str(thought.get("category", "큐")).strip() or "큐"
        voice = str(thought.get("voice", "")).strip()
        candidates.append(
            {
                "title": "inner-thoughts",
                "section": f"{category} - {context}" if context else category,
                "content": content[:700],
                "source": "state/inner-thoughts",
                "date": str(thought.get("createdAt", "")),
                "createdAt": str(thought.get("createdAt", "")),
                "category": category,
                "voice": voice,
                "mtime": "",
                "rel_path": "state/inner-thoughts.json",
                "key": f"inner-thoughts:{index}",
                "score": 0.0,
            }
        )
    return candidates


def dedupe_results(memories: list[dict[str, object]], limit: int) -> list[dict[str, object]]:
    seen: set[tuple[str, str]] = set()
    unique: list[dict[str, object]] = []
    for memory in memories:
        rel_path = str(memory.get("rel_path", ""))
        doc_key = str(memory.get("key", ""))
        if "backups/" in rel_path or "/backups/" in rel_path:
            continue
        if "diary/raw/" in rel_path:
            continue  # 민감 원문은 자동 인출 금지 (인덱스에서도 제외 — 이건 2중 방어)
        if doc_key and not (doc_key.startswith(KEY_PREFIX) or doc_key.startswith("inner-thoughts:")):
            continue
        if not rel_path:
            continue
        # 내용 기반 dedupe — 같은 기억이 memory/와 .openclaw/에 쌍둥이로 존재(이사 때 복사).
        # 경로가 달라도 내용이 같으면 한 슬롯만. 공백 정규화 후 앞 160자로 동일성 판정.
        content_fp = re.sub(r"\s+", "", str(memory.get("content", "")))[:160]
        key = (content_fp, str(memory.get("section", "")))
        if content_fp and key in seen:
            continue
        seen.add(key)
        unique.append(memory)
        if len(unique) >= limit:
            break
    return unique


def search_memories(query: str, transcript_path: str = "", limit: int = RETURN_K) -> list[dict[str, object]]:
    expanded_query = memory_entities.expand_entity_aliases(query)
    is_entity_lookup = memory_entities.is_entity_lookup_query(query)
    target_canonicals = memory_entities.canonical_hits(query) if is_entity_lookup else []
    anchors = extract_anchors(expanded_query)
    # Embeddings need the user's complete clue. Reducing a vague recollection to
    # extracted anchors discards the very context semantic search is meant to use.
    vector_query = get_recent_context(transcript_path, expanded_query, anchors)

    r = redis.from_url(REDIS_URL, decode_responses=False)
    candidates: list[dict[str, object]] = live_inner_thought_candidates()

    bm25_only = search_bm25(r, expanded_query, anchors, TOP_K)
    if bm25_only:
        candidates.extend(bm25_only)

    if target_canonicals:
        candidates.extend(fetch_canonical_entity_memories(r, target_canonicals))

    origin_refs = origin_refs_for(expanded_query)
    if origin_refs:
        candidates.extend(fetch_origin_memories(r, origin_refs))
        apply_origin_boost(candidates, origin_refs)

    rank_limit = max(limit * 4, limit)
    lexical_ranked = rank_memories(expanded_query, candidates, anchors, rank_limit)
    if lexical_result_decisive(lexical_ranked):
        return lexical_ranked

    try:
        from openai import OpenAI

        client = OpenAI()
        query_bytes = query_embedding(client, vector_query)
        memories = search_hybrid(r, expanded_query, query_bytes, anchors, TOP_K)
        vector_results = search_vector(r, query_bytes, TOP_K)
        if not memories:
            memories = high_confidence_vector_results(vector_results)
        apply_semantic_evidence(candidates + memories, vector_results)
    except Exception:
        memories = []

    candidates.extend(memories)

    return rank_memories(expanded_query, candidates, anchors, rank_limit)


def log_recall(query: str, memories: list[dict[str, object]], caller: str) -> None:
    """재인출 신호 적재 — '자주 떠올린 기억은 강해진다'의 데이터 기반.

    CLI가 신뢰 기준을 통과해 실제 반환한 검색만 기록한다. shadow/eval은 기록 안 함.
    maintainer distill이 집계해 자주 인출된 기억을 MEMORY 승격 후보로 검토.
    """
    if os.getenv("ROO_RECALL_LOG", "1") == "0":
        return
    try:
        entry = {
            "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
            "caller": caller,
            "query": query[:200],
            "hits": [
                {
                    "key": str(memory.get("key", "")),
                    "rel_path": str(memory.get("rel_path", "")),
                    "section": str(memory.get("section", ""))[:80],
                    "rank_score": memory.get("rank_score"),
                }
                for memory in memories
            ],
        }
        with open(RECALL_LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 신호 적재 실패가 검색을 막으면 안 됨


def format_context(memories: list[dict[str, object]], include_paths: bool = False) -> str:
    parts: list[str] = []
    for memory in memories:
        section = f" - {memory['section']}" if memory.get("section") else ""
        path = f"\n[{memory['rel_path']}]" if include_paths and memory.get("rel_path") else ""
        content = str(memory.get("content_preview", memory.get("content", "")))
        parts.append(f"**{memory['title']}**{section}{path}\n{content}")
    return "\n\n---\n\n".join(parts)


def json_context(memories: list[dict[str, object]]) -> str:
    serialized: list[dict[str, object]] = []
    for memory in memories:
        item = dict(memory)
        # `score` used to expose the Redis hash/vector field. BM25 candidates do
        # not populate that field, so both exact and unrelated hits commonly
        # reported 0.0. At the CLI boundary score is the final, higher-is-better
        # ranking signal; preserve the backend-specific value for diagnostics.
        item["retrieval_score"] = item.get("score", 0.0)
        item["score"] = item.get("rank_score", 0.0)
        serialized.append(item)
    return json.dumps(serialized, ensure_ascii=False, indent=2)


def output_gate_enabled() -> bool:
    disabled_values = {"0", "false", "off", "no"}
    return os.getenv("ROO_MEMORY_OUTPUT_GATE", "1").strip().lower() not in disabled_values


def output_gate_lane(query: str, requested_lane: str | None = None) -> str:
    """Reuse the established query intent; do not classify memory contents."""
    if requested_lane is not None:
        return requested_lane
    return "quote" if is_verbatim_query(query) else "orient"


def prepare_for_serialization(
    memories: list[dict[str, object]],
    *,
    query: str = "",
    lane: str | None = None,
    enabled: bool | None = None,
) -> tuple[list[dict[str, object]], dict[str, object], str]:
    """Apply the typed gate once, after legacy ranking and selection are complete."""
    should_gate = output_gate_enabled() if enabled is None else enabled
    if not should_gate:
        from memory_episode_adapter import gate_legacy_results

        gated, metrics = gate_legacy_results(memories, content_policy_enabled=False)
        metrics["gate_disabled"] = 1
        return gated, metrics, ""
    from memory_episode_adapter import gate_legacy_results, gate_notice

    resolved_lane = output_gate_lane(query, lane)
    gated, metrics = gate_legacy_results(memories, lane=resolved_lane)
    metrics["lane"] = resolved_lane
    notice = gate_notice(metrics)
    if notice and gated:
        first = dict(gated[0])
        first["memory_gate_notice"] = notice
        gated[0] = first
    return gated, metrics, notice


def result_worthy(memory: dict[str, object]) -> bool:
    try:
        rank_score = float(memory.get("rank_score", 0.0))
    except (TypeError, ValueError):
        rank_score = 0.0
    if rank_score < MIN_RESULT_RANK_SCORE:
        return False

    reasons = [str(reason) for reason in memory.get("rank_reasons", [])]
    # Exact text and registered entity/origin paths are independently strong
    # evidence. Generic Korean fuzzy matches and "strong" anchors are not: an
    # unrelated technical query almost always shares one broad verb or noun.
    if any(reason in reasons for reason in ("raw_rg", "exact_phrase", "entity_canonical_match", "term_origin")):
        return True
    return rank_score >= MIN_PARTIAL_LEXICAL_RANK_SCORE and token_overlap_ratio(reasons) >= MIN_RESULT_TOKEN_OVERLAP


def strong_semantic_match(memory: dict[str, object]) -> bool:
    try:
        distance = float(memory.get("_semantic_distance", 1.0))
        gap = float(memory.get("_semantic_document_gap", 0.0))
    except (TypeError, ValueError):
        return False
    return distance <= MAX_SEMANTIC_DISTANCE and gap >= MIN_SEMANTIC_DOCUMENT_GAP


def trusted_results(memories: list[dict[str, object]]) -> list[dict[str, object]]:
    trusted = [memory for memory in memories if result_worthy(memory)]
    if memories and strong_semantic_match(memories[0]) and memories[0] not in trusted:
        # Strong vector evidence can establish relevance on its own, but only for
        # the result the complete ranker also put first. This keeps an accidental
        # lower-ranked nearest neighbour from becoming the answer.
        trusted.insert(0, memories[0])
    return trusted


def lexical_result_decisive(memories: list[dict[str, object]]) -> bool:
    if not memories or not result_worthy(memories[0]):
        return False
    top = memories[0]
    top_score = float(top.get("rank_score", 0.0) or 0.0)
    next_score = float(memories[1].get("rank_score", 0.0) or 0.0) if len(memories) > 1 else 0.0
    if top_score < 12.0:
        return False
    reasons = [str(reason) for reason in top.get("rank_reasons", [])]
    overlap = token_overlap_ratio(reasons)
    if "exact_phrase" in reasons or "entity_canonical_match" in reasons:
        return True
    if "core_phrase" in reasons and overlap >= 0.75:
        return True
    if top_score - next_score < 2.0:
        return False
    if "heading_core_phrase" in reasons and overlap >= 0.5:
        return True
    if "fuzzy_token" in reasons and overlap >= 0.5:
        return True
    if "date_phrase" in reasons and overlap >= 0.34:
        return True
    return False


def select_result_amount(memories: list[dict[str, object]], limit: int) -> list[dict[str, object]]:
    trusted = trusted_results(memories)
    if not trusted or limit <= 0:
        return []
    selected = [trusted[0]]
    used_groups = {str(trusted[0].get("canonical") or trusted[0].get("rel_path") or trusted[0].get("key", ""))}
    top_score = float(trusted[0].get("rank_score", 0.0) or 0.0)
    for memory in trusted[1:]:
        score = float(memory.get("rank_score", 0.0) or 0.0)
        if top_score - score > RESULT_NEAR_TIE_DELTA:
            break
        group = str(memory.get("canonical") or memory.get("rel_path") or memory.get("key", ""))
        if group and group in used_groups:
            continue
        selected.append(memory)
        if group:
            used_groups.add(group)
        if len(selected) >= limit:
            break
    return selected


def scope_filter(memories: list[dict[str, object]], scope: str | None) -> list[dict[str, object]]:
    """한 저장소로 좁힌다. scope 가 None 이면 전체.

    색인은 메모리 루트를 통째로 훑으므로 rel_path 가 `<identity>/repo/...` 로
    시작한다. 그 첫 조각이 곳 저장소 id 다.
    """
    if scope is None:
        return memories
    kept: list[dict[str, object]] = []
    for memory in memories:
        rel = str(memory.get("rel_path", ""))
        head = rel.split("/", 1)[0]
        if head == scope:
            kept.append(memory)
    return kept


def search_results(
    query: str, limit: int = RETURN_K, scope: str | None = None
) -> list[dict[str, object]]:
    # 좁힐 때는 후보를 떄떄하게 뽑아야 한다. 랭킹을 끝낸 뒤 걸러내면 다른 저장소가
    # 상위를 차지한 만큼 번째 손이가 빈다.
    fetch = limit if scope is None else max(limit * 8, 40)
    if is_verbatim_query(query):
        raw = scope_filter(raw_verbatim_candidates(query), scope)[:limit]
        if raw:
            return raw
        # Literal wording is a fast path, not a requirement. When the user only
        # remembers a topic, locate the memory semantically instead of rejecting it.
        semantic_query = strip_verbatim_cues(query)
        if semantic_query:
            found = scope_filter(search_memories(semantic_query, limit=fetch), scope)
            return select_result_amount(found, limit)
    found = scope_filter(search_memories(query, limit=fetch), scope)
    return select_result_amount(found, limit)


def indexed_scopes() -> list[str]:
    """색인에 실제로 들어있는 저장소 id 목록."""
    client = redis.from_url(REDIS_URL)
    found: set[str] = set()
    for key in client.scan_iter(match=f"{KEY_PREFIX}*", count=500):
        try:
            if client.type(key) != b"hash":
                continue
            rel = client.hget(key, "rel_path")
        except redis.RedisError:
            continue
        if rel:
            found.add(rel.decode("utf-8", "replace").split("/", 1)[0])
    return sorted(found)


def explicit_agent_name() -> str | None:
    """프로젝트 설정에 박힌 memory.agent 값.

    cwd 에서 위로 거슬러 올라가며 <dir>/.rubato/rubato.jsonc 를 찾는다. rubato 의 설정
    탐색과 같은 순서다. 주석이 섞인 jsonc 이므로 정규식으로만 뽑는다 — 이 값은 색인
    스코프일 뿐이라 완전한 파서가 필요없고, 못 찾으면 auto 로 떨어진다.
    """
    here = Path.cwd().resolve()
    for directory in [here, *here.parents]:
        config = directory / ".rubato" / "rubato.jsonc"
        if not config.is_file():
            continue
        try:
            text = config.read_text(encoding="utf-8")
        except OSError:
            return None
        text = re.sub(r"//[^\n]*", "", text)
        match = re.search(r'"agent"\s*:\s*"([^"]+)"', text)
        if match is None:
            return None
        value = match.group(1).strip()
        return None if value in ("", "auto") else value
    return None


def current_scope() -> str | None:
    """현재 디렉터리에 해당하는 저장소 id.

    rubato 의 identity 규칙을 그대로 따른다(`memory-core/src/identity/resolve.ts`).
    명시된 memory.agent 가 있고 그게 이미 slug 안전하면 그 이름 그대로, 아니면 문자열
    해시를 붙인다. 명시값이 없으면 cwd 경로 해시(auto)다. 규칙이 갈라지면 엉뚱한
    저장소를 가리키게 되므로, 결과가 색인에 없으면 None 을 돌려 전체로 떨어트린다.
    """

    def to_slug(value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:40].rstrip("-")
        return slug or "agent"

    explicit = explicit_agent_name()
    if explicit is not None:
        slug = to_slug(explicit)
        if explicit == slug:
            return slug
        digest = hashlib.sha256(explicit.encode("utf-8")).hexdigest()[:8]
        return f"{slug}-{digest}"

    root = str(Path.cwd().resolve())
    digest = hashlib.sha256(root.encode("utf-8")).hexdigest()[:8]
    return f"{to_slug(Path(root).name)}-{digest}"



def resolve_scope(args: argparse.Namespace) -> str | None:
    """None 이면 전체 검색.

    기본은 현재 프로젝트다 — 대개는 지금 있는 곳의 기억을 찾는다. 단, 현재 저장소가
    색인에 없으면(아직 안 쌓였거나 다른 곳에서 실행 중) 조용히 0건을 주는 대신
    전체로 넘어간다. 검색이 안 되는 것보다 넓게 찾아주는 편이 낫다.
    """
    if args.all:
        return None
    if args.scope:
        return args.scope
    scope = current_scope()
    if scope is None:
        return None
    return scope if scope in indexed_scopes() else None


def ensure_index_fresh(quiet: bool = True) -> None:
    """검색 직전에 색인이 메모리보다 뒤처졌는지 보고 따라잡는다.

    메모리는 에이전트가 수시로 고친다. 사람이 색인 명령을 기억해야 한다면 반드시
    잊어버리고, 그때 검색은 조용히 낡은 결과를 준다 — 틀렸다고 말해주지도 않는다.
    평상시 비용은 20ms 안팽이라 매번 물어보는 편이 낫다.
    """
    if os.getenv("MSEARCH_NO_AUTOINDEX", "").strip() not in ("", "0"):
        return
    try:
        import msearch_freshness

        msearch_freshness.ensure_fresh(redis.from_url(REDIS_URL), quiet=quiet)
    except Exception:
        # 갱신은 거듭이다. 실패해도 검색은 기존 색인으로 그대로 진행한다.
        pass


def run_cli(args: argparse.Namespace) -> int:
    if args.list_scopes:
        scopes = indexed_scopes()
        if not scopes:
            print("(색인된 저장소 없음 — msearch --index 를 먼저)")
            return 1
        here = current_scope()
        for scope in scopes:
            print(f"{'* ' if scope == here else '  '}{scope}")
        return 0
    query = " ".join(args.query).strip()
    if not query:
        print("query is required", file=sys.stderr)
        return 2
    ensure_index_fresh(quiet=args.json or args.dual_run)
    memories = search_results(query, limit=args.limit, scope=resolve_scope(args))
    if not memories:
        print("[]" if args.json else "NO RELEVANT MEMORY")
        return 0
    gated, metrics, notice = prepare_for_serialization(memories, query=query, lane=args.lane)
    if args.dual_run:
        print(
            json.dumps(
                {"ungated": memories, "gated": gated, "gate_metrics": metrics},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    log_recall(query, gated, caller="cli")
    if args.json:
        print(json_context(gated))
    else:
        rendered = format_context(gated, include_paths=True)
        if notice:
            rendered = f"{rendered}\n\n{notice}"
        print(rendered)
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search agent memories")
    parser.add_argument("query", nargs="*", help="query string for CLI mode")
    parser.add_argument(
        "--all",
        "-a",
        action="store_true",
        help="search every memory store, not just the current project's",
    )
    parser.add_argument(
        "--scope",
        metavar="ID",
        help="search one memory store by its identity id (see --list-scopes)",
    )
    parser.add_argument(
        "--list-scopes",
        action="store_true",
        help="list the indexed memory stores and exit",
    )
    parser.add_argument("--limit", "-k", type=int, default=RETURN_K, help="number of results")
    parser.add_argument("--json", action="store_true", help="print structured search results")
    parser.add_argument(
        "--dual-run",
        action="store_true",
        help="print the same ranked results before and after the output gate",
    )
    parser.add_argument(
        "--lane",
        choices=("orient", "appraisal", "quote", "feel"),
        default=None,
        help="override the intent-selected typed recall surface for episode-v2",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    # --list-scopes 는 질의가 아니라 조회다. query 검사보다 먼저 통과시킨다.
    if args.list_scopes or args.query:
        return run_cli(args)
    print("query is required", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
