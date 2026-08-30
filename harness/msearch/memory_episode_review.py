#!/usr/bin/env python3
"""Stable review identities and approval-registry helpers for derived memories."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


from msearch_config import state_path

# 승인 레지스트리. 코드가 아니라 사용자 상태라 state 쪽에 둔다. 없으면 빈 승인으로 읽힌다.
DEFAULT_REVIEWS = state_path("memory-episodes/reviews.json")


def item_spans(item: dict[str, Any]) -> list[dict[str, Any]]:
    if "source_spans" in item:
        return list(item["source_spans"])
    if "source" in item:
        return [item["source"]]
    raise ValueError(f"{item.get('id', '<unknown>')}: source span is required")


def _span_identity(span: dict[str, Any]) -> dict[str, Any]:
    relative_path = str(span["path"])
    source_path = PROJECT_ROOT / relative_path
    raw = source_path.read_bytes()

    if "byte_start" in span and "byte_end" in span:
        byte_start = int(span["byte_start"])
        byte_end = int(span["byte_end"])
        source_bytes = raw[byte_start:byte_end]
    else:
        text = raw.decode("utf-8")
        lines = text.splitlines(keepends=True)
        line_start = int(span["line_start"])
        line_end = int(span["line_end"])
        prefix = "".join(lines[: line_start - 1]).encode("utf-8")
        selected = "".join(lines[line_start - 1 : line_end]).rstrip("\r\n")
        source_bytes = selected.encode("utf-8")
        byte_start = len(prefix)
        byte_end = byte_start + len(source_bytes)

    expected = span.get("source_text")
    if expected is not None and source_bytes.decode("utf-8") != expected:
        raise ValueError(f"stale source span: {relative_path}:{byte_start}-{byte_end}")
    return {
        "path": relative_path,
        "byte_start": byte_start,
        "byte_end": byte_end,
        "text_sha256": hashlib.sha256(source_bytes).hexdigest(),
    }


def review_identity(item: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    spans = sorted(
        (_span_identity(span) for span in item_spans(item)),
        key=lambda span: (span["path"], span["byte_start"], span["byte_end"]),
    )
    canonical = json.dumps(spans, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    key = "span-v1:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return key, spans


def load_approvals(path: Path = DEFAULT_REVIEWS) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if payload.get("schema_version") != 1 or not isinstance(payload.get("approvals"), dict):
        raise ValueError(f"invalid review registry: {path}")
    return dict(payload["approvals"])


def is_approved(item: dict[str, Any], approvals: dict[str, dict[str, Any]]) -> bool:
    key, spans = review_identity(item)
    record = approvals.get(key)
    return bool(record and record.get("status") == "approved" and record.get("source_spans") == spans)
