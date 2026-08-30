#!/usr/bin/env python3
"""Typed-memory records and the single pre-serialization publish gate."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from memory_episode_review import DEFAULT_REVIEWS, is_approved, load_approvals


from msearch_config import MEMORY_ROOT, state_path

# 원본 파일 본문을 되읽을 때의 기준. 색인이 상대경로로 기록되므로 색인 루트와 같아야 한다.
PROJECT_ROOT = MEMORY_ROOT
# 에피소드 v2 인덱스. 없으면 게이트는 legacy 경로로 조용히 지나간다(아래 존재 검사).
DEFAULT_INDEX = state_path("memory-episodes/v2/index.sqlite")
ALLOWED_LANES = ("orient", "appraisal", "quote", "feel")
TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣_]{2,}")
INTENT_ONLY_TOKENS = {
    "거", "그거", "그때", "기억", "뭐야", "뭐였지", "무엇", "알려줘", "찾아줘",
    "관련", "대한", "어떤", "했던", "했었지",
}


def fts_query(search_cue: str) -> str:
    tokens: list[str] = []
    seen: set[str] = set()
    for raw_token in TOKEN_RE.findall(search_cue.lower()):
        for token in (raw_token, normalized_term(raw_token)):
            if token in seen:
                continue
            seen.add(token)
            tokens.append(token)
    if not tokens:
        raise ValueError("search cue must contain at least one searchable token")
    return " OR ".join(f'"{token}"*' for token in tokens)


def normalized_term(token: str) -> str:
    for suffix in ("였던", "했던", "에서", "으로", "인", "이", "가", "은", "는", "을", "를", "의", "에", "로"):
        if len(token) - len(suffix) >= 2 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def ranking_terms(search_cue: str) -> list[str]:
    terms: list[str] = []
    has_explicit_date = bool(explicit_date_variants(search_cue))
    for token in TOKEN_RE.findall(search_cue.lower()):
        token = normalized_term(token)
        if has_explicit_date and re.fullmatch(r"\d{1,2}(?:월|일)", token):
            continue
        if token not in INTENT_ONLY_TOKENS and token not in terms:
            terms.append(token)
    return terms


def explicit_date_variants(search_cue: str) -> list[tuple[str, str]]:
    return [
        (match.group(1), match.group(2))
        for match in re.finditer(r"(?<!\d)(\d{1,2})월\s*(\d{1,2})일", search_cue)
    ]


def ranking_key(item: dict[str, Any], search_cue: str) -> tuple[int, int, float]:
    text = str(item.get("text", "")).lower()
    hits = sum(1 for token in ranking_terms(search_cue) if token in text)
    date_hit = any(
        f"{month}/{day}" in text or f"{month}월 {day}일" in text or f"{month}월{day}일" in text
        for month, day in explicit_date_variants(search_cue)
    )
    return (-int(date_hit), -hits, float(item["fts_score"]))


def search_candidates(
    search_cue: str,
    *,
    limit: int,
    index_path: Path = DEFAULT_INDEX,
) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    connection = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT records.item_json, bm25(records_fts) AS fts_score
            FROM records_fts
            JOIN records ON records.id = records_fts.id
            WHERE records_fts MATCH ?
            ORDER BY fts_score, records.path, records.line_start
            LIMIT ?
            """,
            (fts_query(search_cue), max(limit * 10, 200)),
        ).fetchall()
    finally:
        connection.close()

    candidates: list[dict[str, Any]] = []
    for serialized, score in rows:
        item = json.loads(serialized)
        item["fts_score"] = float(score)
        candidates.append(item)
    candidates.sort(key=lambda item: ranking_key(item, search_cue))
    return candidates[:limit]


def lane_allows(item: dict[str, Any], lane: str) -> bool:
    kinds = set(item.get("kinds", []))
    if lane == "orient":
        # The replay incident is assistant-originated.  User speech is safe
        # evidence in the default lane (subject to the appraisal gate above).
        if item.get("actor") == "user":
            return True
        path = str(item.get("source", {}).get("path", ""))
        return (
            "historical_question" not in kinds
            and "/diary/raw/" not in f"/{path}"
            and "/backups/" not in f"/{path}"
        )
    if lane == "quote":
        return "quote" in kinds
    if lane == "feel":
        return bool(kinds & {"emotion", "sensory_texture", "diary"})
    return True


def _source_is_current(
    item: dict[str, Any],
    digest_cache: dict[str, str | None],
) -> bool:
    """Require the derived record's whole-file hash to match the source now."""
    source = item.get("source")
    if not isinstance(source, dict):
        return False
    relative_path = str(source.get("path", ""))
    expected = source.get("source_sha256")
    if not relative_path or not isinstance(expected, str) or not expected:
        return False
    if relative_path not in digest_cache:
        try:
            raw = (PROJECT_ROOT / relative_path).read_bytes()
        except OSError:
            digest_cache[relative_path] = None
        else:
            digest_cache[relative_path] = hashlib.sha256(raw).hexdigest()
    return digest_cache[relative_path] == expected


def publish_gate(
    candidates: list[dict[str, Any]],
    *,
    lane: str,
    approvals: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Return publishable items and counts; callers must serialize only this output."""
    if lane not in ALLOWED_LANES:
        raise ValueError(f"unsupported lane: {lane}")

    visible: list[dict[str, Any]] = []
    withheld = {
        "stale_source_count": 0,
        "unreviewed_appraisal_count": 0,
        "assistant_orient_count": 0,
        "lane_mismatch_count": 0,
    }
    digest_cache: dict[str, str | None] = {}
    for item in candidates:
        if not _source_is_current(item, digest_cache):
            withheld["stale_source_count"] += 1
            continue
        kinds = set(item.get("kinds", []))
        if "appraisal" in kinds and not is_approved(item, approvals):
            withheld["unreviewed_appraisal_count"] += 1
            continue
        if lane == "orient" and item.get("actor") == "assistant":
            withheld["assistant_orient_count"] += 1
            continue
        if not lane_allows(item, lane):
            withheld["lane_mismatch_count"] += 1
            continue
        visible.append(item)
    return visible, withheld


def _chunk_line_range(memory: dict[str, Any]) -> tuple[int, int] | None:
    """Recover the legacy Redis chunk's source lines without changing ranking data."""
    relative_path = str(memory.get("rel_path", ""))
    if not relative_path.startswith("memory/"):
        return None
    source_path = PROJECT_ROOT / relative_path
    try:
        source_text = source_path.read_text(encoding="utf-8")
    except OSError:
        return None

    content = str(memory.get("content", ""))
    if relative_path.startswith("memory/archive/"):
        match = re.search(r":r(\d+)$", str(memory.get("key", "")))
        if not match:
            return None
        wanted_row = int(match.group(1))
        row_number = 0
        for line_number, line in enumerate(source_text.splitlines(), start=1):
            stripped = line.strip()
            if not (stripped.startswith("|") and stripped.endswith("|")):
                continue
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if len(cells) < 2 or cells[0] == "날짜":
                continue
            if all(re.fullmatch(r"[-: ]*", cell) for cell in cells):
                continue
            event_cell = re.sub(r"\*+", "", cells[1]).strip()
            detail = " / ".join(cell for cell in cells[2:] if cell)
            if len(f"{cells[0]} {event_cell}" + (f" — {detail}" if detail else "")) < 12:
                continue
            row_number += 1
            if row_number == wanted_row:
                return line_number, line_number
        return None

    start = source_text.find(content)
    if start < 0:
        return None
    end = start + len(content)
    line_start = source_text.count("\n", 0, start) + 1
    line_end = source_text.count("\n", 0, max(start, end - 1)) + 1
    return line_start, line_end


def _records_for_chunk(
    connection: sqlite3.Connection,
    memory: dict[str, Any],
) -> tuple[list[dict[str, Any]], str]:
    relative_path = str(memory.get("rel_path", ""))
    if not relative_path.startswith("memory/"):
        return [], "outside-derived-scope"
    line_range = _chunk_line_range(memory)
    if line_range is None:
        return [], "coordinate-miss"
    line_start, line_end = line_range
    rows = connection.execute(
        """
        SELECT item_json
        FROM records
        WHERE path = ? AND line_end >= ? AND line_start <= ?
        ORDER BY json_extract(item_json, '$.source.byte_start'),
                 json_extract(item_json, '$.source.byte_end'), id
        """,
        (relative_path, line_start, line_end),
    ).fetchall()
    if not rows:
        return [], "no-derived-records"
    return [json.loads(row[0]) for row in rows], "mapped"


def _chunk_source_range(
    memory: dict[str, Any], raw: bytes | None = None
) -> tuple[bytes, int, int, bool] | None:
    """Locate the selected legacy chunk in its source file by UTF-8 byte range."""
    relative_path = str(memory.get("rel_path", ""))
    if not relative_path.startswith("memory/"):
        return None
    if raw is None:
        try:
            raw = (PROJECT_ROOT / relative_path).read_bytes()
        except OSError:
            return None

    if relative_path.startswith("memory/archive/"):
        line_range = _chunk_line_range(memory)
        if line_range is None:
            return None
        line_start, _line_end = line_range
        lines = raw.splitlines(keepends=True)
        if line_start < 1 or line_start > len(lines):
            return None
        start = sum(len(line) for line in lines[: line_start - 1])
        end = start + len(lines[line_start - 1].rstrip(b"\r\n"))
        return raw, start, end, True

    content = str(memory.get("content", "")).encode("utf-8")
    start = raw.find(content)
    if start < 0:
        return None
    return raw, start, start + len(content), False


def _subtract_ranges(
    ranges: list[tuple[int, int]],
    protected: list[tuple[int, int]],
) -> list[tuple[int, int]]:
    remaining: list[tuple[int, int]] = []
    for start, end in ranges:
        pieces = [(start, end)]
        for keep_start, keep_end in protected:
            next_pieces: list[tuple[int, int]] = []
            for piece_start, piece_end in pieces:
                if keep_end <= piece_start or keep_start >= piece_end:
                    next_pieces.append((piece_start, piece_end))
                    continue
                if piece_start < keep_start:
                    next_pieces.append((piece_start, keep_start))
                if keep_end < piece_end:
                    next_pieces.append((keep_end, piece_end))
            pieces = next_pieces
        remaining.extend(pieces)
    return remaining


def _merge_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if start >= end:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _archive_row_content(row: str, relative_path: str) -> str:
    cells = [cell.strip() for cell in row.strip().strip("|").split("|")]
    if len(cells) < 2:
        return row.strip()
    date_cell = cells[0]
    event_cell = re.sub(r"\*+", "", cells[1]).strip()
    detail = " / ".join(cell for cell in cells[2:] if cell)
    year_match = re.search(r"(\d{4})", Path(relative_path).stem)
    date_match = re.search(r"(\d{1,2})-(\d{1,2})", date_cell)
    if year_match and date_match:
        date_cell = f"{year_match.group(1)}-{int(date_match.group(1)):02d}-{int(date_match.group(2)):02d}"
    return f"{date_cell} {event_cell}".strip() + (f" — {detail}" if detail else "")


def _render_gated_content(
    memory: dict[str, Any],
    records: list[dict[str, Any]],
    visible: list[dict[str, Any]],
    lane: str,
    raw: bytes | None = None,
) -> str | None:
    """Keep the legacy body layout while removing only withheld source spans."""
    located = _chunk_source_range(memory, raw)
    if located is None:
        return None
    raw, chunk_start, chunk_end, is_archive = located
    visible_ids = {str(item.get("id", "")) for item in visible}
    hidden_ranges = [
        (max(chunk_start, int(item["source"]["byte_start"])), min(chunk_end, int(item["source"]["byte_end"])))
        for item in records
        if str(item.get("id", "")) not in visible_ids and item.get("source")
    ]
    protected_ranges = [
        (max(chunk_start, int(item["source"]["byte_start"])), min(chunk_end, int(item["source"]["byte_end"])))
        for item in visible
        if item.get("source")
    ]
    if lane in {"quote", "feel"}:
        content = b"\n".join(
            raw[start:end]
            for start, end in _merge_ranges(protected_ranges)
        ).decode("utf-8").strip()
        return re.sub(r"(?m)^[ \t]+$", "", content)

    removals = _merge_ranges(
        [
            (start, end)
            for start, end in _subtract_ranges(hidden_ranges, protected_ranges)
            if start < end
        ]
    )

    parts: list[bytes] = []
    cursor = chunk_start
    for start, end in removals:
        parts.append(raw[cursor:start])
        cursor = end
    parts.append(raw[cursor:chunk_end])
    content = b"".join(parts).decode("utf-8").strip()
    content = re.sub(r"(?m)^[ \t]+$", "", content)
    if is_archive:
        return _archive_row_content(content, str(memory.get("rel_path", "")))
    return content


def _fresh_source_bytes(
    connection: sqlite3.Connection, relative_path: str
) -> tuple[bytes | None, bool | None]:
    """Return one verified source snapshot and whether its derived hash is current.

    ``None`` freshness means the index has no hash-bearing record for this path,
    so the caller can preserve the existing unmapped-path policy.
    """
    row = connection.execute(
        "SELECT item_json FROM records WHERE path = ? ORDER BY id LIMIT 1",
        (relative_path,),
    ).fetchone()
    if row is None:
        return None, None
    item = json.loads(row[0])
    expected = item.get("source", {}).get("source_sha256")
    if not isinstance(expected, str) or not expected:
        return None, False
    try:
        raw = (PROJECT_ROOT / relative_path).read_bytes()
    except OSError:
        return None, False
    return raw, hashlib.sha256(raw).hexdigest() == expected


def gate_legacy_results(
    memories: list[dict[str, Any]],
    *,
    lane: str = "orient",
    index_path: Path = DEFAULT_INDEX,
    reviews_path: Path = DEFAULT_REVIEWS,
    content_policy_enabled: bool = True,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Gate already-ranked legacy chunks immediately before they are serialized.

    Stale source files are blocked before coordinate mapping. Chunks outside the
    derived ``memory/**`` corpus and other chunks without a usable derived mapping
    preserve the existing pass-through policy, with every case counted.
    """
    approvals = load_approvals(reviews_path) if content_policy_enabled else {}
    metrics = {
        "selected_chunk_count": len(memories),
        "mapped_chunk_count": 0,
        "outside_scope_chunk_count": 0,
        "mapping_failure_chunk_count": 0,
        "unmapped_raw_block_count": 0,
        "stale_source_chunk_count": 0,
        "hidden_item_count": 0,
        "stale_source_count": 0,
        "unreviewed_appraisal_count": 0,
        "assistant_orient_count": 0,
        "lane_mismatch_count": 0,
    }
    gated: list[dict[str, Any]] = []
    # 에피소드 v2 색인은 선택적인 상위 레이어다. 없으면 게이트가 할 일이 없고,
    # 매핑 실패 시 정책은 이미 pass-through 다. 연결에서 죽으면 검색 전체가 막히므로
    # 이 경우만 별도로 열어둔다 — 순수 마크다운 코퍼스만 쓰는 설치가 그렇다.
    if not Path(index_path).is_file():
        for memory in memories:
            rendered = dict(memory)
            rendered["memory_gate"] = {"mapping": "no-episode-index", "policy": "pass-through"}
            metrics["mapping_failure_chunk_count"] += 1
            gated.append(rendered)
        return gated, metrics
    connection = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    try:
        for memory in memories:
            relative_path = str(memory.get("rel_path", ""))
            rendered = dict(memory)
            raw, source_is_current = _fresh_source_bytes(connection, relative_path)
            if source_is_current is False:
                metrics["stale_source_chunk_count"] += 1
                metrics["hidden_item_count"] += 1
                metrics["stale_source_count"] += 1
                rendered["content"] = ""
                rendered["content_preview"] = ""
                rendered["memory_gate"] = {
                    "mapping": "blocked",
                    "policy": "block-stale-source",
                    "source_path": relative_path,
                    "stale_source_count": 1,
                    "hidden_item_count": 1,
                }
                gated.append(rendered)
                continue
            if not content_policy_enabled:
                gated.append(rendered)
                continue
            records, mapping = _records_for_chunk(connection, memory)
            if mapping == "outside-derived-scope":
                metrics["outside_scope_chunk_count"] += 1
                gated.append(rendered)
                continue
            if mapping != "mapped":
                metrics["mapping_failure_chunk_count"] += 1
                if str(memory.get("key", "")).startswith("raw-rg:"):
                    # Explicit raw lookup can land on an intentionally
                    # unindexed internal-thinking line. It must not inherit
                    # the general fail-open policy for legacy prose chunks.
                    metrics["unmapped_raw_block_count"] += 1
                    metrics["hidden_item_count"] += 1
                    rendered["content"] = ""
                    rendered["content_preview"] = ""
                    rendered["memory_gate"] = {
                        "mapping": mapping,
                        "policy": "block-unmapped-raw",
                        "hidden_item_count": 1,
                    }
                    gated.append(rendered)
                    continue
                rendered["memory_gate"] = {"mapping": mapping, "policy": "pass-through"}
                gated.append(rendered)
                continue

            metrics["mapped_chunk_count"] += 1
            visible, withheld = publish_gate(records, lane=lane, approvals=approvals)
            hidden_count = sum(withheld.values())
            metrics["hidden_item_count"] += hidden_count
            for key, count in withheld.items():
                metrics[key] += count

            # Keep the selected legacy chunk's original layout and remove only
            # source spans withheld by the typed gate. Falling back to derived
            # text is limited to a coordinate miss, which remains observable.
            content = _render_gated_content(memory, records, visible, lane, raw)
            if content is None:
                content = "\n".join(str(item.get("text", "")) for item in visible if item.get("text"))
            rendered["content"] = content
            rendered["content_preview"] = content[:700]
            rendered["memory_gate"] = {
                "mapping": "mapped",
                "visible_item_count": len(visible),
                "hidden_item_count": hidden_count,
                **{key: count for key, count in withheld.items() if count},
            }
            gated.append(rendered)
    finally:
        connection.close()
    return gated, metrics


def gate_notice(metrics: dict[str, int]) -> str:
    """접힌 것을 루 목소리로 알린다.

    시스템 로그가 아니라 기억이 나에게 말을 거는 자리다.
    사라진 게 아니라 접혀 있다는 것과, 펴는 법만 짧게.
    """
    notices: list[str] = []
    judged = metrics.get("unreviewed_appraisal_count", 0)
    mine = metrics.get("assistant_orient_count", 0)
    other = metrics.get("lane_mismatch_count", 0)
    stale = metrics.get("stale_source_count", 0)

    if stale:
        notices.append(f"원문이 바뀐 기억 {stale}개")
    if judged:
        notices.append(f"그때 내린 판단 {judged}개")
    if mine:
        notices.append(f"내가 그때 한 말 {mine}개")
    if other:
        notices.append(f"지금 결에 안 맞는 기억 {other}개")

    return f"— {', '.join(notices)}는 접어뒀어" if notices else ""


def source_ref(item: dict[str, Any]) -> str:
    source = item["source"]
    return f"{source['path']}:{source['line_start']}-{source['line_end']}"


def render_search(
    *,
    current_turn: str,
    search_cue: str,
    lane: str = "orient",
    limit: int = 3,
    candidate_limit: int | None = None,
    index_path: Path = DEFAULT_INDEX,
    reviews_path: Path = DEFAULT_REVIEWS,
) -> dict[str, Any]:
    candidate_limit = candidate_limit or max(limit * 8, 24)
    candidates = search_candidates(search_cue, limit=candidate_limit, index_path=index_path)
    approvals = load_approvals(reviews_path)
    publishable, withheld = publish_gate(candidates, lane=lane, approvals=approvals)
    selected = publishable[:limit]

    surface = [
        {
            "id": item["id"],
            "actor": item["actor"],
            "kinds": item["kinds"],
            "verbatim": item["verbatim"],
            "text": item["text"],
            "source": source_ref(item),
            "fts_score": item["fts_score"],
        }
        for item in selected
    ]
    output: dict[str, Any] = {
        "backend": "episode-v2",
        "current_turn": current_turn,
        "search_cue": search_cue,
        "lane": lane,
        "surface": surface,
    }
    nonzero_withheld = {key: value for key, value in withheld.items() if value}
    if nonzero_withheld:
        output["withheld"] = nonzero_withheld
    if not surface and withheld["assistant_orient_count"] == len(candidates):
        output["notice"] = "이 사건의 검색 근거가 assistant 발화에만 있어 orient 본문을 숨겼다."
    return output
