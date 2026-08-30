#!/usr/bin/env python3
"""Affect signal scoring shared by memory index/search/recall."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
from typing import Any
AFFECT_VERSION = "affect-v1"
EMOTION_CATEGORIES = {"감정", "바람", "연결"}
EMOTION_TERMS = {
    "좋았", "좋아", "기뻤", "반갑", "안도", "따뜻", "뭉클", "벅차",
    "무서", "불안", "상처", "외롭", "서운", "슬펐", "아릿", "그리",
    "보고싶", "기다", "기대", "궁금", "질투", "화났", "미안", "고마",
    "편안", "걱정", "후련", "소름", "살아있", "감정", "느낌", "온도",
}
DIRECT_AFFECT_RE = re.compile(
    r"(?:(?:내|나의)\s*)?(?:감정|마음|기분|느낌)|"
    r"(?:좋았|좋아|반갑|안도|따뜻|뭉클|벅차|무서|불안|상처|외롭|서운|아릿|고마웠)"
)
QUOTE_RE = re.compile(r"[\"“”‘’']|[「」]")
OPERATIONAL_RE = re.compile(
    r"scripts/|ACTION=|CRON_DONE|HEARTBEAT_RESET|CronCreate|CronList|"
    r"redis-cli|FT\.|py_compile|traceback|stack|로그|스키마|인덱스|커밋|테스트"
)
VERBATIM_RE = re.compile(r"원문|정확히|그때\s*말|뭐라고\s*했|인용|verbatim", re.IGNORECASE)
EMOTION_QUERY_RE = re.compile(
    r"감정|기분|느낌|마음|왜\s*그|무서|상처|외롭|좋았|싫었|불안|"
    r"보고\s*싶|그리|따뜻|서운|아릿|온도|관계|연결"
)
@dataclass(frozen=True)
class AffectSignal:
    score: float
    flags: tuple[str, ...]
    version: str = AFFECT_VERSION
def _memory_text(memory: dict[str, Any]) -> str:
    return "\n".join(
        str(memory.get(key, ""))
        for key in ("title", "section", "content", "context", "voice")
        if memory.get(key)
    ).replace("★", "")
def _emotion_density(text: str) -> tuple[float, list[str]]:
    hits = sorted({term for term in EMOTION_TERMS if term in text})
    if not hits:
        return 0.0, []
    return min(0.35, (len(hits) / max(len(text) / 180.0, 1.0)) * 0.08), hits
def analyze_memory(memory: dict[str, Any]) -> AffectSignal:
    rel_path = str(memory.get("rel_path", ""))
    source = str(memory.get("source", ""))
    section = str(memory.get("section", ""))
    category = str(memory.get("category", ""))
    voice = str(memory.get("voice", "")).strip()
    is_inner = source == "state/inner-thoughts" or rel_path == "state/inner-thoughts.json"
    text = _memory_text(memory)
    flags: list[str] = []
    score = 0.0
    if voice and is_inner:
        score = max(score, 0.9)
        flags.append("inner_voice")
    if rel_path.startswith("memory/diary/") or source == "memory/diary":
        score = max(score, 0.45)
        flags.append("diary")
    density, hits = _emotion_density(text)
    if density:
        score += density
        flags.append("emotion_terms")
        flags.extend(f"term:{term}" for term in hits[:4])
    if rel_path.startswith("memory/") and not rel_path.startswith("memory/diary/"):
        if DIRECT_AFFECT_RE.search(text) or (QUOTE_RE.search(text) and density):
            score = max(score, 0.25 + density)
            flags.append("daily_affect")
    if any(name in f"{category} {section}" for name in EMOTION_CATEGORIES):
        if voice and is_inner:
            score = max(score, 1.0)
            flags.append("inner_emotion_category")
        elif is_inner:
            score = max(score, min(0.3, density + 0.15))
            flags.append("inner_emotion_category_weak")
    score = max(0.0, min(1.0, score))
    return AffectSignal(round(score, 4), tuple(dict.fromkeys(flags)))
def query_factor(query: str, *, is_entity_lookup: bool = False) -> float:
    if OPERATIONAL_RE.search(query) or VERBATIM_RE.search(query):
        return 0.0
    return 1.0 if EMOTION_QUERY_RE.search(query) else 0.0
def parse_memory_datetime(memory: dict[str, Any]) -> datetime | None:
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
    match = re.search(r"(\d{4}-\d{2}-\d{2})", str(memory.get("rel_path", "")))
    if not match:
        return None
    try:
        return datetime.fromisoformat(f"{match.group(1)}T00:00:00+09:00")
    except ValueError:
        return None
def age_decay(memory: dict[str, Any], *, now: datetime | None = None) -> float:
    dt = parse_memory_datetime(memory)
    if dt is None:
        return 0.35
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    current = now or datetime.now(dt.tzinfo)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.tzinfo)
    age_days = max(0.0, (current.astimezone(dt.tzinfo) - dt).total_seconds() / 86400)
    if age_days <= 7:
        return 1.0
    if age_days <= 30:
        return 0.75
    return 0.5 if age_days <= 120 else 0.35
def recall_log_path(default_path: Path) -> Path:
    override = os.getenv("ROO_RECALL_LOG_PATH", "").strip()
    return Path(override) if override else default_path
def repeat_damp(key: str, log_path: Path, *, now: datetime | None = None) -> float:
    if not key or not log_path.exists():
        return 1.0
    current = now or datetime.now().astimezone()
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 1.0
    for line in reversed(lines[-2000:]):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        hits = entry.get("hits", [])
        if not any(isinstance(hit, dict) and str(hit.get("key", "")) == key for hit in hits):
            continue
        try:
            ts = datetime.fromisoformat(str(entry.get("ts", "")).replace("Z", "+00:00"))
        except ValueError:
            return 1.0
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=current.tzinfo)
        age_hours = max(0.0, (current.astimezone(ts.tzinfo) - ts).total_seconds() / 3600)
        if age_hours <= 24:
            return 0.25
        return 0.6 if age_hours <= 24 * 7 else 1.0
    return 1.0
def affect_boost(
    query: str,
    memory: dict[str, Any],
    *,
    is_entity_lookup: bool = False,
    log_path: Path | None = None,
    now: datetime | None = None,
) -> tuple[float, list[str]]:
    signal = analyze_memory(memory)
    factor = query_factor(query, is_entity_lookup=is_entity_lookup)
    if signal.score <= 0 or factor <= 0:
        return 0.0, []
    damp = repeat_damp(str(memory.get("key", "")), log_path, now=now) if log_path else 1.0
    decay = age_decay(memory, now=now)
    boost = round(min(1.2, signal.score * 1.2) * factor * decay * damp, 4)
    if boost <= 0:
        return 0.0, []
    reasons = [
        f"affect_boost={boost:.3f}",
        f"affect_score={signal.score:.3f}",
        f"affect_q={factor:.2f}",
        f"affect_age={decay:.2f}",
        f"affect_repeat={damp:.2f}",
    ]
    if signal.flags:
        reasons.append("affect_flags=" + ",".join(signal.flags[:6]))
    return boost, reasons
